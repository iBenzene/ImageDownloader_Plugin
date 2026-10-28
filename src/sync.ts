// src/sync.ts

import { ApiError, syncHistoryApi, syncSavedLinksApi } from './api';
import { INCREMENTAL_SYNC_BUFFER_MS, STORAGE_KEYS } from './constants';
import { historyManager, toHistoryAPI } from './history';
import { logger } from './logger';
import { savedLinksManager, toSavedLinkAPI } from './savedLinks';
import { storage } from './storage';
import { parseTimestampMs, toIso8601WithMs } from './utils';

export interface SyncSingleOutcome {
    ok: boolean;
    pushedCount: number;
    pulledCount: number;
    syncedAt?: string;
    error?: string;
    skipped?: boolean;
}

export interface SyncAllOutcome {
    savedLinks: SyncSingleOutcome;
    history: SyncSingleOutcome;
}

const SYNC_REASON_LABELS: Record<string, string> = {
    backfill_content_key: '标识回填',
    download_completed: '下载完成',
    manual: '手动触发',
    manual_click: '手动触发',
    network_online: '网络恢复',
    plugin_startup: '启动自动同步',
    preheat_completed: '预热完成',
    save_links: '收藏变更',
    tampermonkey_menu: '菜单触发',
    task_queue_sync: '队列调度'
};

const formatSyncReason = (reason?: string): string => {
    if (!reason) {
        return '手动触发';
    }
    if (SYNC_REASON_LABELS[reason]) {
        return SYNC_REASON_LABELS[reason];
    }
    if (reason.startsWith('backoff_retry_')) {
        return `退避重试 #${reason.slice('backoff_retry_'.length)}`;
    }
    return reason;
};

/**
 * 云端双向同步协调服务
 * 负责本地变更收集, 增量游标计算, 网络自动重连与防抖退避同步
 */
class SyncCoordinator {
    private isSyncingSavedLinks = false;
    private isSyncingHistory = false;
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private retryAttempt = 0;
    private readonly maxBackoffRetries = 3;
    private lastSyncError: string | null = null;

    constructor() {
        if (
            typeof window !== 'undefined' &&
            typeof window.addEventListener === 'function'
        ) {
            window.addEventListener('online', () => {
                logger.info('检测到网络连接恢复，自动调度云端同步');
                this.scheduleSync('network_online', 300);
            });
        }
    }

    public getSyncStatus(): {
        isSyncing: boolean;
        dirtySavedCount: number;
        dirtyHistoryCount: number;
        lastSavedSyncedAt: string | null;
        lastHistorySyncedAt: string | null;
        lastError: string | null;
    } {
        return {
            dirtyHistoryCount: historyManager.getDirtyRecords().length,
            dirtySavedCount: savedLinksManager.getDirtyRecords().length,
            isSyncing: this.isSyncingSavedLinks || this.isSyncingHistory,
            lastError: this.lastSyncError,
            lastHistorySyncedAt: storage.getHistoryLastSyncedAt(),
            lastSavedSyncedAt: storage.getSavedLinksLastSyncedAt()
        };
    }

    /**
     * 防抖聚合短时间内的同步触发指令
     * 避免高频操作导致重复请求服务端
     */
    public scheduleSync(
        reason: string,
        delayMs = 600,
        targets: { savedLinks?: boolean; history?: boolean } = {
            history: true,
            savedLinks: true
        }
    ): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            void this.syncNow({
                history: targets.history ?? true,
                reason,
                savedLinks: targets.savedLinks ?? true
            });
        }, delayMs);
        this.debounceTimer?.unref?.();
    }

    /**
     * 计算增量同步的安全时间起始点
     * 依据上次同步时间戳减去 180 秒时钟容差缓冲, 全量模式或首次同步返回 null
     */
    public computeBufferedSince(
        lastSyncedAt: string | null,
        incrementalSync: boolean
    ): string | null {
        if (!incrementalSync || !lastSyncedAt) {
            return null;
        }
        const ms = parseTimestampMs(lastSyncedAt);
        if (!ms) {
            return null;
        }
        return toIso8601WithMs(ms - INCREMENTAL_SYNC_BUFFER_MS);
    }

    /**
     * 执行收藏记录的远端双向同步
     * 向远端提交本地变更快照, 随后接收远端更新并持久化游标
     */
    public async syncSavedLinks(options?: {
        forceFull?: boolean;
        reason?: string;
        signal?: AbortSignal;
    }): Promise<SyncSingleOutcome> {
        if (this.isSyncingSavedLinks) {
            return { ok: true, pulledCount: 0, pushedCount: 0, skipped: true };
        }

        const settings = storage.getSettings();
        if (!settings.serverUrl || !settings.serverToken) {
            logger.debug('跳过收藏同步，未配置服务端地址或令牌');
            return {
                error: '请先在设置中配置服务端地址与服务端令牌',
                ok: false,
                pulledCount: 0,
                pushedCount: 0,
                skipped: true
            };
        }

        const leaseKey = `${STORAGE_KEYS.SYNC_LEASE}_saved_${storage.getActiveNamespace(settings)}`;
        if (!storage.tryAcquireLease(leaseKey, 20000)) {
            logger.debug('跳过收藏同步，其他标签页正在执行同步');
            return { ok: true, pulledCount: 0, pushedCount: 0, skipped: true };
        }

        this.isSyncingSavedLinks = true;
        const targetNamespace = storage.getActiveNamespace(settings);
        storage.emitChange('sync_state');

        try {
            // 获取当前未同步脏记录的本地快照
            const dirtyItems = storage
                .getSavedLinks(targetNamespace)
                .filter(i => i.isDirty);
            const snapshotUpdatedAtById = new Map<string, string>();
            for (const item of dirtyItems) {
                snapshotUpdatedAtById.set(item.id, item.updatedAt);
            }
            const apiItems = dirtyItems.map(toSavedLinkAPI);

            // 计算增量查询起始时间
            const lastSyncedAt =
                storage.getSavedLinksLastSyncedAt(targetNamespace);
            const useIncremental = options?.forceFull
                ? false
                : settings.incrementalSync;
            const since = this.computeBufferedSince(
                lastSyncedAt,
                useIncremental
            );

            logger.debug(
                `开始同步收藏（${formatSyncReason(options?.reason)}），待推送 ${apiItems.length} 条，${since ? '增量模式' : '全量模式'}`,
                since ? { context: `游标起点 ${since}` } : undefined
            );

            const response = await syncSavedLinksApi({
                records: apiItems,
                settings,
                signal: options?.signal,
                since
            });

            // 串行写入持久化, 先释放无冲突脏标记, 再合并远端结果并推进同步游标
            await storage.serializeWrite(() => {
                savedLinksManager.markSnapshotAsSynced(
                    snapshotUpdatedAtById,
                    targetNamespace
                );
                savedLinksManager.mergeRemoteRecords(
                    response.records,
                    targetNamespace
                );
                if (
                    response.syncedAt &&
                    parseTimestampMs(response.syncedAt) > 0
                ) {
                    storage.setSavedLinksLastSyncedAt(
                        toIso8601WithMs(response.syncedAt),
                        targetNamespace
                    );
                }
            });

            this.lastSyncError = null;
            this.clearRetryTimer();

            if (apiItems.length > 0 || response.records.length > 0) {
                logger.info(
                    `收藏同步完成，推送 ${apiItems.length} 条，拉取 ${response.records.length} 条`
                );
            } else {
                logger.debug('收藏同步完成，无新增变更');
            }

            // 若合并过程发现远端缺失去重标识而标记了新的回填记录, 则延迟安排回传
            const remainingDirty = storage
                .getSavedLinks(targetNamespace)
                .filter(i => i.isDirty);
            if (remainingDirty.length > 0 && apiItems.length === 0) {
                this.scheduleSync('backfill_content_key', 1200, {
                    history: false,
                    savedLinks: true
                });
            }

            return {
                ok: true,
                pulledCount: response.records.length,
                pushedCount: apiItems.length,
                syncedAt: response.syncedAt
            };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.lastSyncError = msg;
            logger.error(`收藏同步失败，${msg}`);
            this.scheduleBackoffRetry(err);
            return {
                error: msg,
                ok: false,
                pulledCount: 0,
                pushedCount: 0
            };
        } finally {
            this.isSyncingSavedLinks = false;
            storage.releaseLease(leaseKey);
            storage.emitChange('sync_state');
        }
    }

    /**
     * 执行下载历史记录的远端双向同步
     * 向远端提交本地历史快照并拉取远端更新
     */
    public async syncHistory(options?: {
        forceFull?: boolean;
        reason?: string;
        signal?: AbortSignal;
    }): Promise<SyncSingleOutcome> {
        if (this.isSyncingHistory) {
            return { ok: true, pulledCount: 0, pushedCount: 0, skipped: true };
        }

        const settings = storage.getSettings();
        if (!settings.serverUrl || !settings.serverToken) {
            logger.debug('跳过历史同步，未配置服务端地址或令牌');
            return {
                error: '请先在设置中配置服务端地址与服务端令牌',
                ok: false,
                pulledCount: 0,
                pushedCount: 0,
                skipped: true
            };
        }

        const leaseKey = `${STORAGE_KEYS.SYNC_LEASE}_history_${storage.getActiveNamespace(settings)}`;
        if (!storage.tryAcquireLease(leaseKey, 20000)) {
            logger.debug('跳过历史同步，其他标签页正在执行同步');
            return { ok: true, pulledCount: 0, pushedCount: 0, skipped: true };
        }

        this.isSyncingHistory = true;
        const targetNamespace = storage.getActiveNamespace(settings);
        storage.emitChange('sync_state');

        try {
            const dirtyItems = storage
                .getHistoryItems(targetNamespace)
                .filter(i => i.isDirty);
            const snapshotUpdatedAtById = new Map<string, string>();
            for (const item of dirtyItems) {
                snapshotUpdatedAtById.set(item.id, item.updatedAt);
            }
            const apiItems = dirtyItems.map(toHistoryAPI);

            const lastSyncedAt =
                storage.getHistoryLastSyncedAt(targetNamespace);
            const useIncremental = options?.forceFull
                ? false
                : settings.incrementalSync;
            const since = this.computeBufferedSince(
                lastSyncedAt,
                useIncremental
            );

            logger.debug(
                `开始同步历史（${formatSyncReason(options?.reason)}），待推送 ${apiItems.length} 条，${since ? '增量模式' : '全量模式'}`,
                since ? { context: `游标起点 ${since}` } : undefined
            );

            const response = await syncHistoryApi({
                records: apiItems,
                settings,
                signal: options?.signal,
                since
            });

            await storage.serializeWrite(() => {
                historyManager.markSnapshotAsSynced(
                    snapshotUpdatedAtById,
                    targetNamespace
                );
                historyManager.mergeRemoteRecords(
                    response.records,
                    targetNamespace
                );
                if (
                    response.syncedAt &&
                    parseTimestampMs(response.syncedAt) > 0
                ) {
                    storage.setHistoryLastSyncedAt(
                        toIso8601WithMs(response.syncedAt),
                        targetNamespace
                    );
                }
            });

            this.lastSyncError = null;
            this.clearRetryTimer();

            if (apiItems.length > 0 || response.records.length > 0) {
                logger.info(
                    `历史同步完成，推送 ${apiItems.length} 条，拉取 ${response.records.length} 条`
                );
            } else {
                logger.debug('历史同步完成，无新增变更');
            }

            return {
                ok: true,
                pulledCount: response.records.length,
                pushedCount: apiItems.length,
                syncedAt: response.syncedAt
            };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.lastSyncError = msg;
            logger.error(`历史同步失败，${msg}`);
            this.scheduleBackoffRetry(err);
            return {
                error: msg,
                ok: false,
                pulledCount: 0,
                pushedCount: 0
            };
        } finally {
            this.isSyncingHistory = false;
            storage.releaseLease(leaseKey);
            storage.emitChange('sync_state');
        }
    }

    /** 并发触发收藏与历史的双向同步 */
    public async syncNow(options?: {
        savedLinks?: boolean;
        history?: boolean;
        forceFull?: boolean;
        reason?: string;
        signal?: AbortSignal;
    }): Promise<SyncAllOutcome> {
        const doSaved = options?.savedLinks ?? true;
        const doHistory = options?.history ?? true;

        const [savedRes, historyRes] = await Promise.all([
            doSaved
                ? this.syncSavedLinks({
                      forceFull: options?.forceFull,
                      reason: options?.reason,
                      signal: options?.signal
                  })
                : Promise.resolve<SyncSingleOutcome>({
                      ok: true,
                      pulledCount: 0,
                      pushedCount: 0,
                      skipped: true
                  }),
            doHistory
                ? this.syncHistory({
                      forceFull: options?.forceFull,
                      reason: options?.reason,
                      signal: options?.signal
                  })
                : Promise.resolve<SyncSingleOutcome>({
                      ok: true,
                      pulledCount: 0,
                      pushedCount: 0,
                      skipped: true
                  })
        ]);

        return {
            history: historyRes,
            savedLinks: savedRes
        };
    }

    /** 异常情况下按指数退避算法调度重试 */
    private scheduleBackoffRetry(err: unknown): void {
        if (
            err instanceof ApiError &&
            (err.category === 'auth' || err.category === 'unconfigured')
        ) {
            return;
        }
        if (this.retryAttempt >= this.maxBackoffRetries) {
            logger.warn(
                `云端同步自动重试已达上限（${this.maxBackoffRetries} 次），可稍后手动重试`
            );
            return;
        }
        if (this.retryTimer) {
            return;
        }

        this.retryAttempt++;
        const delayMs = Math.min(30000, Math.pow(2, this.retryAttempt) * 2000);
        logger.debug(
            `将在 ${(delayMs / 1000).toFixed(0)} 秒后进行第 ${this.retryAttempt} 次同步退避重试`
        );

        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            void this.syncNow({ reason: `backoff_retry_${this.retryAttempt}` });
        }, delayMs);
        this.retryTimer?.unref?.();
    }

    private clearRetryTimer(): void {
        this.retryAttempt = 0;
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
    }
}

export const syncCoordinator = new SyncCoordinator();
