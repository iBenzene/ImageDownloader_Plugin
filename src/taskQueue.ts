// src/taskQueue.ts

import { MAX_TASK_ITEMS, STORAGE_KEYS } from './constants';
import { downloadService } from './downloader';
import { logger } from './logger';
import { preheatService } from './preheat';
import { savedLinksManager } from './savedLinks';
import { CURRENT_TAB_ID, storage } from './storage';
import { syncCoordinator } from './sync';
import { AllDownloaderType, TaskItem, TaskStatus, TaskType } from './types';
import { generateUUID, isSameId, toIso8601WithMs } from './utils';

export interface EnqueueTaskOptions {
    type: TaskType;
    title: string;
    urls: string[];
    downloaderType: AllDownloaderType;
    savedLinkId?: string;
    forceReExtract?: boolean;
    /** 针对收藏任务附带已提前解析好的去重标识集合 */
    resolvedContentKeys?: Record<string, string>;
    /** 针对收藏任务标记去重检查是否因超时而不完整 */
    identityCheckIncomplete?: boolean;
}

/**
 * 统一调度任务队列管理器
 * 负责任务持久化, 防抖去重, 页面刷新中断判定以及跨标签页单执行者串行调度
 */
class TaskQueueManager {
    private isProcessingLoop = false;
    private activeAbortControllers = new Map<string, AbortController>();
    private leaseHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

    constructor() {
        this.recoverInterruptedTasks();
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener('beforeunload', () => {
                this.markCurrentTabTasksInterruptedOnUnload();
            });
        }
    }

    private getLeaseKey(): string {
        return `${STORAGE_KEYS.EXECUTOR_LEASE}_${storage.getActiveNamespace()}`;
    }

    /**
     * 页面加载或刷新时核查并恢复队列状态
     * 将失去执行租约的运行中任务安全转置为中断待确认状态, 绝不盲目重下或误报完成
     */
    public recoverInterruptedTasks(): number {
        const tasks = storage.getTasks();
        const activeLease = storage.getActiveLease(this.getLeaseKey());
        let recoveredCount = 0;
        const now = toIso8601WithMs();

        for (let i = 0; i < tasks.length; i++) {
            const task = tasks[i];
            if (task.status === 'running') {
                const isHeldByOtherLiveTab =
                    activeLease &&
                    activeLease.tabId !== CURRENT_TAB_ID &&
                    activeLease.taskId === task.id;

                if (!isHeldByOtherLiveTab) {
                    tasks[i] = {
                        ...task,
                        status: 'interrupted',
                        updatedAt: now,
                        message: '页面刷新或关闭导致任务中断，结果待确认（可手动重试）',
                        mediaSubTasks: (task.mediaSubTasks || []).map(st =>
                            st.status === 'running' || st.status === 'pending'
                                ? { ...st, status: 'interrupted', error: '任务中断待确认' }
                                : st
                        ),
                    };
                    recoveredCount++;
                }
            }
        }

        if (recoveredCount > 0) {
            storage.setTasks(tasks);
            logger.warn(`恢复任务队列，已将 ${recoveredCount} 个未确认结果的任务标记为中断待确认`);
        }
        return recoveredCount;
    }

    private markCurrentTabTasksInterruptedOnUnload(): void {
        const tasks = storage.getTasks();
        let changed = false;
        const now = toIso8601WithMs();

        for (let i = 0; i < tasks.length; i++) {
            const t = tasks[i];
            if (t.status === 'running' && t.executorTabId === CURRENT_TAB_ID) {
                tasks[i] = {
                    ...t,
                    status: 'interrupted',
                    updatedAt: now,
                    message: '页面关闭或刷新导致任务中断，结果待确认',
                    mediaSubTasks: (t.mediaSubTasks || []).map(st =>
                        st.status === 'running' || st.status === 'pending'
                            ? { ...st, status: 'interrupted', error: '页面卸载中断' }
                            : st
                    ),
                };
                changed = true;
            }
        }

        if (changed) {
            storage.setTasks(tasks);
        }
        storage.releaseLease(this.getLeaseKey());
    }

    public getTasks(filterType?: TaskType | 'all'): TaskItem[] {
        const all = storage.getTasks();
        if (!filterType || filterType === 'all') {
            return all;
        }
        return all.filter(t => t.type === filterType);
    }

    public getTaskById(id: string): TaskItem | undefined {
        return storage.getTasks().find(t => isSameId(t.id, id));
    }

    /**
     * 查询指定链接是否处于待执行或正在执行的任务中
     * 用于页面按钮与列表项的状态防抖显示
     */
    public getActiveTaskForUrl(url: string, type?: TaskType): TaskItem | undefined {
        return storage.getTasks().find(
            t =>
                (t.status === 'pending' || t.status === 'running') &&
                (!type || t.type === type) &&
                t.urls.includes(url)
        );
    }

    /**
     * 投递新任务入队
     * 具备自动防抖去重能力, 若队列中已存在同类型同链接的活动任务则复用该任务
     */
    public enqueueTask(options: EnqueueTaskOptions): {
        task: TaskItem;
        deduplicated: boolean;
    } {
        const tasks = storage.getTasks();
        const urlSignature = options.urls.map(u => u.trim()).join('|');

        const existingActive = tasks.find(
            t =>
                (t.status === 'pending' || t.status === 'running') &&
                t.type === options.type &&
                t.downloaderType === options.downloaderType &&
                t.urls.map(u => u.trim()).join('|') === urlSignature
        );

        if (existingActive) {
            logger.debug(`忽略重复提交，复用队列中的活动任务（${options.title}）`, {
                taskId: existingActive.id,
            });
            void this.processQueue();
            return { task: existingActive, deduplicated: true };
        }

        // 针对收藏任务立即落盘持久化, 随后依据配置决定是否自动联动预热与同步
        if (options.type === 'save') {
            const savedItems = savedLinksManager.addLinks(
                options.urls,
                options.downloaderType,
                options.resolvedContentKeys || {}
            );
            const settings = storage.getSettings();
            const incompleteWarning = options.identityCheckIncomplete
                ? '，部分新链接或旧收藏未完成内容去重，仍可能存在重复，可稍后重试补全'
                : '';

            const now = toIso8601WithMs();
            const saveTask: TaskItem = {
                id: generateUUID(),
                type: 'save',
                title: options.title,
                urls: options.urls,
                downloaderType: options.downloaderType,
                savedLinkId: savedItems[0]?.id,
                status: 'completed',
                createdAt: now,
                updatedAt: now,
                currentNoteIndex: options.urls.length,
                totalNoteCount: options.urls.length,
                currentMediaIndex: 0,
                totalMediaCount: 0,
                completedMediaCount: 0,
                mediaSubTasks: [],
                message: `已保存 ${options.urls.length} 个链接${incompleteWarning}`,
            };

            tasks.unshift(saveTask);
            storage.setTasks(this.trimTasks(tasks));
            logger.info(saveTask.message, { taskId: saveTask.id });

            // 调度一次后台收藏同步
            syncCoordinator.scheduleSync('save_links', 400, {
                savedLinks: true,
                history: false,
            });

            // 若开启了自动预热选项且存在链接则追加预热任务
            if (settings.preheatResources && options.urls.length > 0) {
                this.enqueueTask({
                    type: 'preheat',
                    title: `预热收藏资源 (${options.urls.length} 个链接)`,
                    urls: options.urls,
                    downloaderType: options.downloaderType,
                    savedLinkId: savedItems.length === 1 ? savedItems[0].id : undefined,
                });
            }

            return { task: saveTask, deduplicated: false };
        }

        const now = toIso8601WithMs();
        const newTask: TaskItem = {
            id: generateUUID(),
            type: options.type,
            title: options.title,
            urls: options.urls,
            downloaderType: options.downloaderType,
            savedLinkId: options.savedLinkId,
            forceReExtract: options.forceReExtract,
            status: 'pending',
            createdAt: now,
            updatedAt: now,
            currentNoteIndex: 0,
            totalNoteCount: Math.max(1, options.urls.length),
            currentMediaIndex: 0,
            totalMediaCount: 0,
            completedMediaCount: 0,
            mediaSubTasks: [],
            message: '等待执行...',
        };

        tasks.unshift(newTask);
        storage.setTasks(this.trimTasks(tasks));

        void this.processQueue();
        return { task: newTask, deduplicated: false };
    }

    /**
     * 取消等待中或运行中的队列任务
     * 取消客户端网络请求并更新本地记录为取消状态
     */
    public cancelTask(taskId: string): boolean {
        const controller = this.activeAbortControllers.get(taskId);
        if (controller) {
            controller.abort();
            this.activeAbortControllers.delete(taskId);
        }

        const tasks = storage.getTasks();
        const idx = tasks.findIndex(t => isSameId(t.id, taskId));
        if (idx === -1) { return false; }

        const current = tasks[idx];
        if (current.status !== 'pending' && current.status !== 'running') {
            return false;
        }

        const extraHint =
            current.type === 'preheat'
                ? '（注：已发往服务端的缓存操作可能仍在服务端后台继续完成）'
                : '';

        tasks[idx] = {
            ...current,
            status: 'cancelled',
            updatedAt: toIso8601WithMs(),
            message: `已取消任务${extraHint}`,
            mediaSubTasks: (current.mediaSubTasks || []).map(st =>
                st.status === 'running' || st.status === 'pending'
                    ? { ...st, status: 'cancelled', error: '用户取消' }
                    : st
            ),
        };
        storage.setTasks(tasks);
        logger.info(`已取消任务（${current.title}）`, { taskId: current.id });
        return true;
    }

    /**
     * 重试中断, 失败或已取消的任务
     * 支持传入仅重试失败媒体项或强制重新解析缓存的选项
     */
    public retryTask(
        taskId: string,
        options?: { onlyFailedSubTasks?: boolean; forceReExtract?: boolean }
    ): TaskItem | null {
        const tasks = storage.getTasks();
        const idx = tasks.findIndex(t => isSameId(t.id, taskId));
        if (idx === -1) { return null; }

        const target = tasks[idx];
        if (target.status === 'running' || target.status === 'pending') {
            return target;
        }

        const keepCompletedSubTasks =
            options?.onlyFailedSubTasks &&
            !options?.forceReExtract &&
            target.mediaSubTasks &&
            target.mediaSubTasks.some(s => s.status === 'completed');

        tasks[idx] = {
            ...target,
            status: 'pending',
            forceReExtract: options?.forceReExtract ?? target.forceReExtract,
            updatedAt: toIso8601WithMs(),
            error: undefined,
            message: options?.forceReExtract
                ? '等待重新解析并重试...'
                : keepCompletedSubTasks
                    ? '等待重试失败的媒体项...'
                    : '等待重试...',
            mediaSubTasks: keepCompletedSubTasks
                ? target.mediaSubTasks.map(s =>
                    s.status === 'completed'
                        ? s
                        : { ...s, status: 'pending', error: undefined, progressPercent: 0 }
                )
                : [],
        };

        storage.setTasks(tasks);
        void this.processQueue();
        return tasks[idx];
    }

    /** 清理已完成或已取消的历史任务项 */
    public clearFinishedTasks(): number {
        const tasks = storage.getTasks();
        const remaining = tasks.filter(
            t => t.status !== 'completed' && t.status !== 'cancelled'
        );
        const removedCount = tasks.length - remaining.length;
        if (removedCount > 0) {
            storage.setTasks(remaining);
        }
        return removedCount;
    }

    /** 移除单条非活跃任务 */
    public removeTask(taskId: string): boolean {
        const tasks = storage.getTasks();
        const target = tasks.find(t => isSameId(t.id, taskId));
        if (!target) { return false; }
        if (target.status === 'running') {
            this.cancelTask(taskId);
        }
        const next = storage.getTasks().filter(t => !isSameId(t.id, taskId));
        storage.setTasks(next);
        return true;
    }

    /**
     * 单任务串行执行调度循环
     * 依靠跨标签页租约锁确保多标签页环境下仅单实例消费执行
     */
    public async processQueue(): Promise<void> {
        if (this.isProcessingLoop) { return; }
        this.isProcessingLoop = true;

        try {
            while (true) {
                const allTasks = storage.getTasks();
                // 按照创建时间正序获取待处理任务
                const nextTask = [...allTasks]
                    .reverse()
                    .find(t => t.status === 'pending');

                if (!nextTask) {
                    break;
                }

                const leaseKey = this.getLeaseKey();
                if (!storage.tryAcquireLease(leaseKey, 15000, nextTask.id)) {
                    logger.debug('其他标签页正在执行队列任务，本标签页转为等待');
                    break;
                }

                this.startLeaseHeartbeat(leaseKey, nextTask.id);
                try {
                    await this.executeSingleTask(nextTask.id);
                } finally {
                    this.stopLeaseHeartbeat();
                    storage.releaseLease(leaseKey);
                }
            }
        } finally {
            this.isProcessingLoop = false;
        }
    }

    private startLeaseHeartbeat(leaseKey: string, taskId: string): void {
        this.stopLeaseHeartbeat();
        this.leaseHeartbeatTimer = setInterval(() => {
            storage.renewLease(leaseKey, 15000, taskId);
        }, 4000);
        this.leaseHeartbeatTimer?.unref?.();
    }

    private stopLeaseHeartbeat(): void {
        if (this.leaseHeartbeatTimer) {
            clearInterval(this.leaseHeartbeatTimer);
            this.leaseHeartbeatTimer = null;
        }
    }

    private updateTaskState(
        taskId: string,
        updater: (prev: TaskItem) => Partial<TaskItem>
    ): TaskItem | null {
        const tasks = storage.getTasks();
        const idx = tasks.findIndex(t => isSameId(t.id, taskId));
        if (idx === -1) { return null; }
        const patch = updater(tasks[idx]);
        tasks[idx] = {
            ...tasks[idx],
            ...patch,
            updatedAt: toIso8601WithMs(),
        };
        storage.setTasks(tasks);
        return tasks[idx];
    }

    private async executeSingleTask(taskId: string): Promise<void> {
        const task = this.getTaskById(taskId);
        if (!task || task.status !== 'pending') { return; }

        const controller = new AbortController();
        this.activeAbortControllers.set(task.id, controller);

        this.updateTaskState(task.id, () => ({
            status: 'running',
            executorTabId: CURRENT_TAB_ID,
            message: '正在执行...',
            error: undefined,
        }));

        try {
            if (task.type === 'sync') {
                const res = await syncCoordinator.syncNow({
                    reason: 'task_queue_sync',
                    signal: controller.signal,
                });
                const ok = res.savedLinks.ok && res.history.ok;
                const errMsg = [res.savedLinks.error, res.history.error].filter(Boolean).join('；');
                const syncSummary =
                    `同步完成（收藏推送 ${res.savedLinks.pushedCount}/拉取 ${res.savedLinks.pulledCount}，` +
                    `历史推送 ${res.history.pushedCount}/拉取 ${res.history.pulledCount}）`;
                this.updateTaskState(task.id, () => ({
                    status: ok ? 'completed' : 'failed',
                    currentNoteIndex: 1,
                    totalNoteCount: 1,
                    message: ok ? syncSummary : `同步失败：${errMsg}`,
                    error: ok ? undefined : errMsg,
                }));
                return;
            }

            if (task.type === 'preheat') {
                const outcome = await preheatService.preheatLinks({
                    items: task.urls.map(u => ({
                        url: u,
                        savedLinkId: task.urls.length === 1 ? task.savedLinkId : undefined,
                        downloaderType: task.downloaderType,
                    })),
                    taskId: task.id,
                    signal: controller.signal,
                    onProgress: p => {
                        this.updateTaskState(task.id, () => ({
                            currentNoteIndex: p.currentUrlIndex,
                            totalNoteCount: p.totalUrlCount,
                            message: p.message,
                        }));
                    },
                });

                if (controller.signal.aborted) {
                    this.updateTaskState(task.id, () => ({
                        status: 'cancelled',
                        message: '已取消预热（已发往服务端的缓存操作可能仍在继续）',
                    }));
                    return;
                }

                this.updateTaskState(task.id, () => ({
                    status: outcome.ok ? 'completed' : 'failed',
                    completedMediaCount: outcome.totalCachedCount,
                    totalMediaCount: outcome.totalCachedCount,
                    message: outcome.ok
                        ? `预热成功，共缓存 ${outcome.totalCachedCount} 个资源`
                        : `预热未完成：${outcome.error || '请检查服务端 S3 配置'}`,
                    error: outcome.ok ? undefined : outcome.error,
                }));
                return;
            }

            if (task.type === 'download') {
                let totalCompletedNotes = 0;
                let totalCompletedMedia = 0;
                let lastError: string | undefined;
                let anyPartial = false;

                for (let i = 0; i < task.urls.length; i++) {
                    if (controller.signal.aborted) { break; }
                    const url = task.urls[i];
                    const noteIdx = i + 1;

                    // 若单链接下载任务带有待重试子任务列表则传给单任务下载服务
                    const retrySubTasks =
                        task.urls.length === 1 &&
                            task.mediaSubTasks &&
                            task.mediaSubTasks.length > 0 &&
                            !task.forceReExtract
                            ? task.mediaSubTasks
                            : undefined;

                    const dlOutcome = await downloadService.downloadSingleNote({
                        url,
                        downloaderType: task.downloaderType,
                        savedLinkId: task.urls.length === 1 ? task.savedLinkId : undefined,
                        forceReExtract: task.forceReExtract,
                        existingSubTasksToRetry: retrySubTasks,
                        currentNoteIndex: noteIdx,
                        totalNoteCount: task.urls.length,
                        taskId: task.id,
                        signal: controller.signal,
                        onProgress: p => {
                            this.updateTaskState(task.id, () => ({
                                currentNoteIndex: p.currentNoteIndex,
                                totalNoteCount: p.totalNoteCount,
                                currentMediaIndex: p.currentMediaIndex,
                                totalMediaCount: p.totalMediaCount,
                                completedMediaCount: p.completedMediaCount,
                                mediaSubTasks: p.mediaSubTasks,
                                usedCachedUrls: p.usedCachedUrls,
                                message: p.message,
                            }));
                        },
                    });

                    totalCompletedMedia += dlOutcome.completedMediaCount;
                    if (dlOutcome.ok) {
                        totalCompletedNotes++;
                    } else {
                        lastError = dlOutcome.error;
                        if (dlOutcome.partialSuccess) {
                            anyPartial = true;
                        }
                    }
                }

                if (controller.signal.aborted) {
                    this.updateTaskState(task.id, () => ({
                        status: 'cancelled',
                        message: '下载已取消',
                    }));
                    return;
                }

                const allSuccess = totalCompletedNotes === task.urls.length;
                const finalStatus: TaskStatus = allSuccess ? 'completed' : 'failed';
                const finalMsg = allSuccess
                    ? `下载完成，共保存 ${totalCompletedMedia} 个图片或视频`
                    : lastError || (anyPartial ? '部分媒体下载失败，可点击重试' : '下载失败');

                this.updateTaskState(task.id, () => ({
                    status: finalStatus,
                    message: finalMsg,
                    error: allSuccess ? undefined : finalMsg,
                }));
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.updateTaskState(task.id, () => ({
                status: controller.signal.aborted ? 'cancelled' : 'failed',
                message: controller.signal.aborted ? '已取消' : `任务异常：${msg}`,
                error: msg,
            }));
        } finally {
            this.activeAbortControllers.delete(task.id);
        }
    }

    private trimTasks(tasks: TaskItem[]): TaskItem[] {
        if (tasks.length <= MAX_TASK_ITEMS) { return tasks; }
        const active = tasks.filter(t => t.status === 'pending' || t.status === 'running');
        const inactive = tasks.filter(t => t.status !== 'pending' && t.status !== 'running');
        return [...active, ...inactive.slice(0, Math.max(0, MAX_TASK_ITEMS - active.length))];
    }
}

export const taskQueue = new TaskQueueManager();
