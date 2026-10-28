// src/downloader.ts

import { extractMediaUrls } from './api';
import { MEDIA_DOWNLOAD_CONCURRENCY } from './constants';
import { getGmBridge } from './gmAdapter';
import { historyManager } from './history';
import { logger } from './logger';
import { savedLinksManager } from './savedLinks';
import { storage } from './storage';
import { syncCoordinator } from './sync';
import { AllDownloaderType, LivePhotoMediaItem, MediaSubTask } from './types';
import {
    buildMediaFilename,
    decodeLiveCachedUrls,
    isXhsDownloader,
    unescapeMediaUrl
} from './utils';

export interface NoteDownloadProgress {
    currentNoteIndex: number;
    totalNoteCount: number;
    currentMediaIndex: number;
    totalMediaCount: number;
    completedMediaCount: number;
    mediaSubTasks: MediaSubTask[];
    usedCachedUrls: boolean;
    message: string;
    isError: boolean;
    isWarning: boolean;
}

export interface NoteDownloadOutcome {
    ok: boolean;
    partialSuccess: boolean;
    completedMediaCount: number;
    totalMediaCount: number;
    usedCachedUrls: boolean;
    cacheDownloadFailed: boolean;
    mediaSubTasks: MediaSubTask[];
    error?: string;
}

/**
 * 媒体下载执行服务
 * 负责子任务编排, 并发控制, 落盘验证以及与收藏历史状态同步
 */
class DownloadService {
    /**
     * 构建笔记媒体下载子任务列表
     * 普通图片或视频按单条 URL 生成对应任务
     * 实况图片则按成对的封面与伴随视频拆分为稳定有序的文件子任务
     */
    public buildMediaSubTasks(options: {
        sourceUrl: string;
        downloaderType: AllDownloaderType;
        singleUrls?: string[];
        liveItems?: LivePhotoMediaItem[];
    }): { subTasks: MediaSubTask[]; logicalMediaCount: number } {
        const subTasks: MediaSubTask[] = [];
        const { downloaderType, sourceUrl } = options;

        if (downloaderType === '小红书实况图片下载器' && options.liveItems) {
            const totalGroups = options.liveItems.length;
            let seq = 1;
            options.liveItems.forEach((pair, idx) => {
                const groupNum = idx + 1;
                const coverUrl = unescapeMediaUrl(pair.cover);
                const coverName = buildMediaFilename({
                    downloaderType,
                    mediaIndex: groupNum,
                    mediaUrl: coverUrl,
                    role: 'live-cover',
                    sourceUrl,
                    totalCount: totalGroups
                });
                subTasks.push({
                    filename: coverName,
                    index: seq++,
                    isLiveCover: true,
                    label: `实况 #${groupNum} 封面`,
                    pairIndex: groupNum,
                    status: 'pending',
                    url: coverUrl
                });

                if (pair.video && pair.video.trim()) {
                    const videoUrl = unescapeMediaUrl(pair.video);
                    const videoName = buildMediaFilename({
                        downloaderType,
                        mediaIndex: groupNum,
                        mediaUrl: videoUrl,
                        role: 'live-video',
                        sourceUrl,
                        totalCount: totalGroups
                    });
                    subTasks.push({
                        filename: videoName,
                        index: seq++,
                        isLiveVideo: true,
                        label: `实况 #${groupNum} 视频`,
                        pairIndex: groupNum,
                        status: 'pending',
                        url: videoUrl
                    });
                }
            });

            return { logicalMediaCount: totalGroups, subTasks };
        }

        const urls = options.singleUrls || [];
        const total = urls.length;
        const isVideo = downloaderType === '小红书视频下载器';
        urls.forEach((rawUrl, idx) => {
            const cleanUrl = unescapeMediaUrl(rawUrl);
            const mediaNum = idx + 1;
            const filename = buildMediaFilename({
                downloaderType,
                mediaIndex: mediaNum,
                mediaUrl: cleanUrl,
                role: isVideo ? 'video' : 'image',
                sourceUrl,
                totalCount: total
            });
            subTasks.push({
                filename,
                index: mediaNum,
                label: `${isVideo ? '视频' : '图片'} #${mediaNum}`,
                pairIndex: mediaNum,
                status: 'pending',
                url: cleanUrl
            });
        });

        return { logicalMediaCount: total, subTasks };
    }

    /**
     * 执行单条笔记的媒体下载
     * 优先尝试预热缓存, 遇异常自动回退实时解析, 并支持单媒体子任务断点重试
     */
    public async downloadSingleNote(options: {
        url: string;
        downloaderType: AllDownloaderType;
        savedLinkId?: string;
        cachedUrls?: string[] | null;
        forceReExtract?: boolean;
        existingSubTasksToRetry?: MediaSubTask[];
        currentNoteIndex?: number;
        totalNoteCount?: number;
        taskId?: string;
        signal?: AbortSignal;
        onProgress?: (p: NoteDownloadProgress) => void;
    }): Promise<NoteDownloadOutcome> {
        const currentNoteIndex = options.currentNoteIndex ?? 1;
        const totalNoteCount = options.totalNoteCount ?? 1;
        const settings = storage.getSettings();

        if (!isXhsDownloader(options.downloaderType)) {
            const msg = `仅支持小红书下载器（${options.downloaderType}暂不支持在浏览器端下载）`;
            logger.warn(msg, { context: options.url, taskId: options.taskId });
            return {
                cacheDownloadFailed: false,
                completedMediaCount: 0,
                error: msg,
                mediaSubTasks: [],
                ok: false,
                partialSuccess: false,
                totalMediaCount: 0,
                usedCachedUrls: false
            };
        }

        if (!settings.serverUrl) {
            const msg = '请在设置中配置服务端地址';
            logger.error(`下载失败，${msg}`, { taskId: options.taskId });
            return {
                cacheDownloadFailed: false,
                completedMediaCount: 0,
                error: msg,
                mediaSubTasks: [],
                ok: false,
                partialSuccess: false,
                totalMediaCount: 0,
                usedCachedUrls: false
            };
        }

        const matchedSaved =
            (options.savedLinkId
                ? savedLinksManager.getItemById(options.savedLinkId)
                : undefined) ||
            savedLinksManager.getActiveItemByUrl(options.url);

        let subTasks: MediaSubTask[] = [];
        let logicalMediaCount = 0;
        let usedCachedUrls = false;

        // 若传入失败子任务列表则只对未完成项进行针对性重试
        if (
            options.existingSubTasksToRetry &&
            options.existingSubTasksToRetry.length > 0
        ) {
            subTasks = options.existingSubTasksToRetry.map(st =>
                st.status === 'completed'
                    ? { ...st }
                    : {
                          ...st,
                          error: undefined,
                          progressPercent: 0,
                          status: 'pending'
                      }
            );
            const pairSet = new Set(subTasks.map(s => s.pairIndex ?? s.index));
            logicalMediaCount = pairSet.size;
        } else {
            const candidateCache = !options.forceReExtract
                ? options.cachedUrls && options.cachedUrls.length > 0
                    ? options.cachedUrls
                    : matchedSaved?.cachedUrls
                : null;

            if (candidateCache && candidateCache.length > 0) {
                if (options.downloaderType === '小红书实况图片下载器') {
                    const decodedLive = decodeLiveCachedUrls(candidateCache);
                    if (decodedLive && decodedLive.length > 0) {
                        logger.info(
                            `[${currentNoteIndex} / ${totalNoteCount}] 使用预热缓存的 ${decodedLive.length} 个实况资源链接`,
                            { context: options.url, taskId: options.taskId }
                        );
                        const built = this.buildMediaSubTasks({
                            downloaderType: options.downloaderType,
                            liveItems: decodedLive,
                            sourceUrl: options.url
                        });
                        subTasks = built.subTasks;
                        logicalMediaCount = built.logicalMediaCount;
                        usedCachedUrls = true;
                    } else {
                        // 实况缓存格式不兼容时平滑回退至实时解析接口
                        logger.warn(
                            `[${currentNoteIndex} / ${totalNoteCount}] 实况预热缓存格式无法解析，回退实时解析`,
                            { context: options.url, taskId: options.taskId }
                        );
                    }
                } else {
                    const validStrings = candidateCache.every(
                        u =>
                            typeof u === 'string' &&
                            /^https?:\/\//i.test(unescapeMediaUrl(u))
                    );
                    if (validStrings) {
                        logger.info(
                            `[${currentNoteIndex} / ${totalNoteCount}] 使用预热缓存的 ${candidateCache.length} 个资源链接`,
                            { context: options.url, taskId: options.taskId }
                        );
                        const built = this.buildMediaSubTasks({
                            downloaderType: options.downloaderType,
                            singleUrls: candidateCache,
                            sourceUrl: options.url
                        });
                        subTasks = built.subTasks;
                        logicalMediaCount = built.logicalMediaCount;
                        usedCachedUrls = true;
                    } else {
                        logger.warn(
                            `[${currentNoteIndex} / ${totalNoteCount}] 预热缓存链接格式无效，回退实时解析`,
                            { context: options.url, taskId: options.taskId }
                        );
                    }
                }
            }

            // 无缓存或回退时请求服务端解析接口
            if (subTasks.length === 0) {
                options.onProgress?.({
                    completedMediaCount: 0,
                    currentMediaIndex: 0,
                    currentNoteIndex,
                    isError: false,
                    isWarning: false,
                    mediaSubTasks: [],
                    message: `【${currentNoteIndex} / ${totalNoteCount}】正在解析媒体链接...`,
                    totalMediaCount: 0,
                    totalNoteCount,
                    usedCachedUrls: false
                });

                try {
                    const extracted = await extractMediaUrls({
                        downloaderType: options.downloaderType,
                        requestLogName: '解析',
                        settings,
                        signal: options.signal,
                        taskId: options.taskId,
                        url: options.url,
                        useProxy: settings.serverSideProxy
                    });

                    if (extracted.kind === 'live') {
                        const built = this.buildMediaSubTasks({
                            downloaderType: options.downloaderType,
                            liveItems: extracted.items,
                            sourceUrl: options.url
                        });
                        subTasks = built.subTasks;
                        logicalMediaCount = built.logicalMediaCount;
                    } else {
                        const built = this.buildMediaSubTasks({
                            downloaderType: options.downloaderType,
                            singleUrls: extracted.urls,
                            sourceUrl: options.url
                        });
                        subTasks = built.subTasks;
                        logicalMediaCount = built.logicalMediaCount;
                    }
                } catch (err) {
                    const rawErr =
                        err instanceof Error ? err.message : String(err);
                    const errMsg = `【${currentNoteIndex} / ${totalNoteCount}】${rawErr}`;
                    this.recordOutcomeToHistoryAndSaved({
                        downloaderType: options.downloaderType,
                        isSuccess: false,
                        mediaCount: 0,
                        savedLinkId: matchedSaved?.id,
                        url: options.url
                    });
                    options.onProgress?.({
                        completedMediaCount: 0,
                        currentMediaIndex: 0,
                        currentNoteIndex,
                        isError: true,
                        isWarning: false,
                        mediaSubTasks: [],
                        message: errMsg,
                        totalMediaCount: 0,
                        totalNoteCount,
                        usedCachedUrls: false
                    });
                    return {
                        cacheDownloadFailed: false,
                        completedMediaCount: 0,
                        error: errMsg,
                        mediaSubTasks: [],
                        ok: false,
                        partialSuccess: false,
                        totalMediaCount: 0,
                        usedCachedUrls: false
                    };
                }
            }
        }

        if (subTasks.length === 0) {
            const emptyMsg = `[${currentNoteIndex} / ${totalNoteCount}] 未提取到图片或视频的链接`;
            this.recordOutcomeToHistoryAndSaved({
                downloaderType: options.downloaderType,
                isSuccess: false,
                mediaCount: 0,
                savedLinkId: matchedSaved?.id,
                url: options.url
            });
            logger.error(emptyMsg, {
                context: options.url,
                taskId: options.taskId
            });
            options.onProgress?.({
                completedMediaCount: 0,
                currentMediaIndex: 0,
                currentNoteIndex,
                isError: true,
                isWarning: false,
                mediaSubTasks: [],
                message: emptyMsg,
                totalMediaCount: 0,
                totalNoteCount,
                usedCachedUrls
            });
            return {
                cacheDownloadFailed: false,
                completedMediaCount: 0,
                error: emptyMsg,
                mediaSubTasks: [],
                ok: false,
                partialSuccess: false,
                totalMediaCount: 0,
                usedCachedUrls
            };
        }

        // 并发执行媒体文件直接落盘并依据宿主环境事件校验结果
        const pendingIndices = subTasks
            .map((st, idx) => (st.status === 'completed' ? -1 : idx))
            .filter(idx => idx !== -1);

        let pointer = 0;
        const concurrency = Math.min(
            MEDIA_DOWNLOAD_CONCURRENCY,
            Math.max(1, pendingIndices.length)
        );

        const emitSubTaskProgress = (
            activeIdx: number,
            warning = false,
            error = false,
            customMsg?: string
        ) => {
            const completedFiles = subTasks.filter(
                s => s.status === 'completed'
            ).length;
            const msg =
                customMsg ||
                `【${currentNoteIndex} / ${totalNoteCount}】下载中...（${completedFiles} / ${subTasks.length}）`;
            options.onProgress?.({
                completedMediaCount: completedFiles,
                currentMediaIndex: activeIdx + 1,
                currentNoteIndex,
                isError: error,
                isWarning: warning,
                mediaSubTasks: subTasks.map(s => ({ ...s })),
                message: msg,
                totalMediaCount: subTasks.length,
                totalNoteCount,
                usedCachedUrls
            });
        };

        const worker = async () => {
            while (pointer < pendingIndices.length) {
                const subIdx = pendingIndices[pointer++];
                if (subIdx === undefined) {
                    break;
                }
                const subTask = subTasks[subIdx];

                if (options.signal?.aborted) {
                    subTask.status = 'cancelled';
                    subTask.error = '已取消';
                    continue;
                }

                subTask.status = 'running';
                subTask.error = undefined;
                emitSubTaskProgress(subIdx);

                try {
                    const dlRes = await getGmBridge().downloadFile({
                        name: subTask.filename,
                        onProgress: (loaded, totalBytes) => {
                            if (totalBytes > 0) {
                                subTask.progressPercent = Math.min(
                                    100,
                                    Math.round((loaded / totalBytes) * 100)
                                );
                            }
                        },
                        signal: options.signal,
                        timeout: 180000,
                        url: subTask.url
                    });

                    if (!dlRes.confirmedByManager) {
                        throw new Error(
                            '未能确认浏览器或脚本管理器已完成文件落盘'
                        );
                    }

                    subTask.status = 'completed';
                    subTask.progressPercent = 100;
                    emitSubTaskProgress(subIdx);
                } catch (err) {
                    const errMsg =
                        err instanceof Error ? err.message : String(err);
                    subTask.status = options.signal?.aborted
                        ? 'cancelled'
                        : 'failed';
                    subTask.error = errMsg;
                    logger.error(
                        `[${currentNoteIndex} / ${totalNoteCount}] 媒体下载失败（${subTask.label}），${errMsg}`,
                        { context: subTask.url, taskId: options.taskId }
                    );
                    emitSubTaskProgress(subIdx, true, false);
                }
            }
        };

        await Promise.all(Array.from({ length: concurrency }, () => worker()));

        // 计算逻辑媒体成对完成数, 确保实况封面和视频均落地才算一组成功
        const pairGroups = new Map<number, MediaSubTask[]>();
        for (const st of subTasks) {
            const pIdx = st.pairIndex ?? st.index;
            const arr = pairGroups.get(pIdx) || [];
            arr.push(st);
            pairGroups.set(pIdx, arr);
        }

        let completedLogicalCount = 0;
        for (const group of pairGroups.values()) {
            if (group.every(g => g.status === 'completed')) {
                completedLogicalCount++;
            }
        }

        const failedSubTasks = subTasks.filter(s => s.status !== 'completed');
        const allCompleted = failedSubTasks.length === 0;
        const partialSuccess =
            !allCompleted && subTasks.some(s => s.status === 'completed');
        const cacheDownloadFailed = usedCachedUrls && !allCompleted;

        // 落地记录至下载历史并更新本地收藏记录的状态
        this.recordOutcomeToHistoryAndSaved({
            downloaderType: options.downloaderType,
            isSuccess: allCompleted,
            mediaCount: completedLogicalCount,
            savedLinkId: matchedSaved?.id,
            url: options.url
        });

        if (allCompleted) {
            const doneMsg = `下载完成，共保存 ${logicalMediaCount} 个媒体`;
            logger.info(
                `[${currentNoteIndex} / ${totalNoteCount}] ${doneMsg}`,
                {
                    context: options.url,
                    taskId: options.taskId
                }
            );
            options.onProgress?.({
                completedMediaCount: subTasks.length,
                currentMediaIndex: subTasks.length,
                currentNoteIndex,
                isError: false,
                isWarning: false,
                mediaSubTasks: subTasks.map(s => ({ ...s })),
                message: doneMsg,
                totalMediaCount: subTasks.length,
                totalNoteCount,
                usedCachedUrls
            });
            return {
                cacheDownloadFailed: false,
                completedMediaCount: logicalMediaCount,
                mediaSubTasks: subTasks,
                ok: true,
                partialSuccess: false,
                totalMediaCount: logicalMediaCount,
                usedCachedUrls
            };
        }

        let failSummary = partialSuccess
            ? `部分下载完成（成功 ${completedLogicalCount}/${logicalMediaCount}，失败 ${failedSubTasks.length} 个文件，可针对失败项重试）`
            : `下载失败：${failedSubTasks[0]?.error || '未知错误'}`;

        if (cacheDownloadFailed) {
            failSummary +=
                '。检测到预热缓存地址下载失败，可点击「重新解析并重试」（若原笔记已删除或失效则无法恢复）';
        }

        options.onProgress?.({
            completedMediaCount: subTasks.filter(s => s.status === 'completed')
                .length,
            currentMediaIndex: subTasks.length,
            currentNoteIndex,
            isError: !partialSuccess,
            isWarning: partialSuccess,
            mediaSubTasks: subTasks.map(s => ({ ...s })),
            message: failSummary,
            totalMediaCount: subTasks.length,
            totalNoteCount,
            usedCachedUrls
        });

        return {
            cacheDownloadFailed,
            completedMediaCount: completedLogicalCount,
            error: failSummary,
            mediaSubTasks: subTasks,
            ok: false,
            partialSuccess,
            totalMediaCount: logicalMediaCount,
            usedCachedUrls
        };
    }

    private recordOutcomeToHistoryAndSaved(options: {
        url: string;
        downloaderType: AllDownloaderType;
        savedLinkId?: string;
        isSuccess: boolean;
        mediaCount: number;
    }): void {
        historyManager.addRecord({
            downloaderType: options.downloaderType,
            isSuccess: options.isSuccess,
            mediaCount: options.mediaCount,
            url: options.url
        });

        if (options.savedLinkId) {
            savedLinksManager.updateStatus(
                options.savedLinkId,
                options.isSuccess ? 'success' : 'failure'
            );
        } else {
            const activeSaved = savedLinksManager.getActiveItemByUrl(
                options.url
            );
            if (activeSaved) {
                savedLinksManager.updateStatus(
                    activeSaved.id,
                    options.isSuccess ? 'success' : 'failure'
                );
            }
        }

        syncCoordinator.scheduleSync('download_completed', 500, {
            history: true,
            savedLinks: true
        });
    }
}

export const downloadService = new DownloadService();
