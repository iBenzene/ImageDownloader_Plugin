// src/preheat.ts

import { extractMediaUrls } from './api';
import { logger } from './logger';
import { savedLinksManager } from './savedLinks';
import { storage } from './storage';
import { syncCoordinator } from './sync';
import { AllDownloaderType } from './types';
import { isXhsDownloader, verifyPreheatCacheResult } from './utils';

export interface PreheatItemProgress {
    currentUrlIndex: number;
    totalUrlCount: number;
    message: string;
    isError: boolean;
}

export interface PreheatBatchOutcome {
    ok: boolean;
    cachedUrlsBySourceUrl: Record<string, string[]>;
    totalCachedCount: number;
    failedUrls: Array<{ url: string; error: string }>;
    error?: string;
}

/**
 * 资源预热服务
 * 负责通过服务端代理将远端媒体转存至对象存储, 并检验是否真实落盘
 */
class PreheatService {
    /**
     * 批量执行指定链接的媒体资源预热缓存
     * 强制开启服务端代理选项, 预热成功后将缓存直链写回收藏并调度多端同步
     * 预热失败不会删除已有收藏记录, 仅保留错误信息供后续重试
     */
    public async preheatLinks(options: {
        items: Array<{ url: string; savedLinkId?: string; downloaderType: AllDownloaderType }>;
        taskId?: string;
        signal?: AbortSignal;
        onProgress?: (p: PreheatItemProgress) => void;
    }): Promise<PreheatBatchOutcome> {
        const settings = storage.getSettings();
        if (!settings.serverUrl) {
            const msg = '请在设置中配置服务端地址';
            logger.error(`预热失败，${msg}`, { taskId: options.taskId });
            return {
                ok: false,
                cachedUrlsBySourceUrl: {},
                totalCachedCount: 0,
                failedUrls: options.items.map(i => ({ url: i.url, error: msg })),
                error: msg,
            };
        }

        const total = options.items.length;
        const cachedUrlsBySourceUrl: Record<string, string[]> = {};
        const failedUrls: Array<{ url: string; error: string }> = [];
        let totalCachedCount = 0;

        logger.info(`开始预热 ${total} 个链接`, { taskId: options.taskId });

        for (let idx = 0; idx < total; idx++) {
            const item = options.items[idx];
            const currentLine = idx + 1;

            if (options.signal?.aborted) {
                if (item.savedLinkId) {
                    savedLinksManager.updatePreheatResult(item.savedLinkId, {
                        state: 'failed',
                        error: '预热已取消',
                    });
                }
                failedUrls.push({ url: item.url, error: '预热已取消' });
                break;
            }

            if (!isXhsDownloader(item.downloaderType)) {
                const unsupMsg = `首期仅支持小红书资源预热（当前类型：${item.downloaderType}）`;
                if (item.savedLinkId) {
                    savedLinksManager.updatePreheatResult(item.savedLinkId, {
                        state: 'failed',
                        error: unsupMsg,
                    });
                }
                failedUrls.push({ url: item.url, error: unsupMsg });
                options.onProgress?.({
                    currentUrlIndex: currentLine,
                    totalUrlCount: total,
                    message: `【${currentLine} / ${total}】${unsupMsg}`,
                    isError: true,
                });
                continue;
            }

            const targetSaved =
                (item.savedLinkId ? savedLinksManager.getItemById(item.savedLinkId) : undefined) ||
                savedLinksManager.getActiveItemByUrl(item.url);

            if (targetSaved) {
                savedLinksManager.updatePreheatResult(targetSaved.id, { state: 'preheating' });
            }

            options.onProgress?.({
                currentUrlIndex: currentLine,
                totalUrlCount: total,
                message: `【${currentLine} / ${total}】预热中...`,
                isError: false,
            });

            try {
                const extracted = await extractMediaUrls({
                    url: item.url,
                    downloaderType: item.downloaderType,
                    useProxy: true, // 预热流程始终强制开启服务端代理写入 S3
                    requestLogName: '预热',
                    settings,
                    signal: options.signal,
                    taskId: options.taskId,
                });

                // 核实服务端返回的直链是否真正落入对象存储路径
                const verification = verifyPreheatCacheResult(
                    extracted.rawMediaUrls,
                    item.downloaderType
                );

                if (!verification.confirmed) {
                    const errMsg = verification.reason || '未能确认资源已写入服务端对象存储';
                    if (targetSaved) {
                        savedLinksManager.updatePreheatResult(targetSaved.id, {
                            state: 'failed',
                            error: errMsg,
                        });
                    }
                    failedUrls.push({ url: item.url, error: errMsg });
                    logger.warn(`[${currentLine} / ${total}] 预热未确认成功，${errMsg}`, {
                        taskId: options.taskId,
                        context: item.url,
                    });
                    options.onProgress?.({
                        currentUrlIndex: currentLine,
                        totalUrlCount: total,
                        message: `【${currentLine} / ${total}】${errMsg}`,
                        isError: true,
                    });
                    continue;
                }

                cachedUrlsBySourceUrl[item.url] = verification.cachedUrls;
                totalCachedCount += verification.cachedUrls.length;

                if (targetSaved) {
                    savedLinksManager.updatePreheatResult(targetSaved.id, {
                        state: 'preheated',
                        cachedUrls: verification.cachedUrls,
                    });
                }

                logger.info(
                    `[${currentLine} / ${total}] 预热成功，已缓存 ${verification.cachedUrls.length} 个资源`,
                    { taskId: options.taskId, context: item.url }
                );

                options.onProgress?.({
                    currentUrlIndex: currentLine,
                    totalUrlCount: total,
                    message: `【${currentLine} / ${total}】预热成功（${verification.cachedUrls.length} 个资源）`,
                    isError: false,
                });
            } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                if (targetSaved) {
                    savedLinksManager.updatePreheatResult(targetSaved.id, {
                        state: 'failed',
                        error: errMsg,
                    });
                }
                failedUrls.push({ url: item.url, error: errMsg });
                logger.error(`[${currentLine} / ${total}] 预热过程发生错误，${errMsg}`, {
                    taskId: options.taskId,
                    context: item.url,
                });
                options.onProgress?.({
                    currentUrlIndex: currentLine,
                    totalUrlCount: total,
                    message: `【${currentLine} / ${total}】${errMsg}`,
                    isError: true,
                });
            }
        }

        if (totalCachedCount > 0) {
            // 预热成功后调度一次收藏同步, 将已缓存直链及时同步至其他终端
            syncCoordinator.scheduleSync('preheat_completed', 300, {
                savedLinks: true,
                history: false,
            });
        }

        const allOk = failedUrls.length === 0 && totalCachedCount > 0;
        return {
            ok: allOk,
            cachedUrlsBySourceUrl,
            totalCachedCount,
            failedUrls,
            error:
                failedUrls.length > 0
                    ? failedUrls.map(f => f.error).join('；')
                    : undefined,
        };
    }
}

export const preheatService = new PreheatService();
