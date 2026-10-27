// src/savedLinks.ts

import { fetchContentKey } from './api';
import {
    IDENTITY_RESOLVE_DEADLINE_MS,
    IDENTITY_RETRY_COOLDOWN_MS,
    MAX_SAVED_LINKS,
    STALE_DELETED_DAYS,
} from './constants';
import { logger } from './logger';
import { storage } from './storage';
import {
    AllDownloaderType,
    PreheatState,
    SavedLinkItem,
    SavedLinkItemAPI,
    SavedLinkStatus,
} from './types';
import {
    extractLocalContentKey,
    generateUUID,
    getIdentityPlatform,
    isSameId,
    parseTimestampMs,
    toIso8601WithMs,
} from './utils';

export interface DuplicateDetail {
    url: string;
    reason: 'same_url_saved' | 'same_key_saved' | 'same_url_batch' | 'same_key_batch';
    matchedUrl?: string;
    contentKey?: string;
}

export interface SavePreparationResult {
    urls: string[];
    hasDuplicate: boolean;
    duplicates: DuplicateDetail[];
    identityCheckIncomplete: boolean;
    resolvedContentKeys: Record<string, string>;
}

/**
 * 将本地收藏记录模型转换为服务端传输结构
 * 保持毫秒时间精度与去重标识字段对齐
 */
export const toSavedLinkAPI = (item: SavedLinkItem): SavedLinkItemAPI => {
    return {
        id: item.id,
        url: item.url,
        downloader: item.downloaderType,
        status: item.status,
        created_at: toIso8601WithMs(item.timestamp),
        updated_at: toIso8601WithMs(item.updatedAt),
        is_deleted: Boolean(item.isDeleted),
        metadata: item.metadata ?? null,
        content_key: item.contentKey ?? null,
        cached_urls: item.cachedUrls && item.cachedUrls.length > 0 ? item.cachedUrls : null,
    };
};

/**
 * 将服务端传输结构还原为本地收藏记录模型
 * 根据远端已缓存直链情况推断预热显示状态
 */
export const fromSavedLinkAPI = (api: SavedLinkItemAPI, existingLocal?: SavedLinkItem): SavedLinkItem => {
    const status: SavedLinkStatus =
        api.status === 'success' || api.status === 'failure' ? api.status : 'none';
    const hasRemoteCache = Array.isArray(api.cached_urls) && api.cached_urls.length > 0;

    let preheatState: PreheatState = 'unpreheated';
    if (hasRemoteCache) {
        // 本机成功预热且缓存匹配则保留预热成功状态, 否则标记为云端同步缓存
        preheatState =
            existingLocal?.preheatState === 'preheated' ? 'preheated' : 'cached_remote';
    }

    return {
        // 严格保留服务端返回的 ID 原始大小写形态
        id: api.id,
        url: api.url,
        timestamp: toIso8601WithMs(api.created_at),
        downloaderType: api.downloader,
        status,
        updatedAt: toIso8601WithMs(api.updated_at),
        isDeleted: Boolean(api.is_deleted),
        isDirty: false,
        contentKey: api.content_key ?? null,
        cachedUrls: hasRemoteCache ? api.cached_urls : null,
        metadata: api.metadata ?? null,
        preheatState,
        preheatError: null,
    };
};

/**
 * 收藏记录管理服务
 * 负责本地收藏列表持久化, 内容去重分析, 增量变更跟踪与远端合并
 */
class SavedLinksManager {
    /** 按命名空间记录内容标识解析失败后的冷却截止时间戳 */
    private identityRetryAfter = new Map<string, number>();

    public getAllItems(): SavedLinkItem[] {
        return storage.getSavedLinks();
    }

    public getVisibleItems(): SavedLinkItem[] {
        return this.getAllItems().filter(item => !item.isDeleted);
    }

    public getItemById(id: string): SavedLinkItem | undefined {
        return this.getAllItems().find(item => isSameId(item.id, id));
    }

    public getActiveItemByUrl(url: string, contentKey?: string | null): SavedLinkItem | undefined {
        const visible = this.getVisibleItems();
        const byUrl = visible.find(item => item.url === url);
        if (byUrl) { return byUrl; }
        if (contentKey) {
            return visible.find(item => item.contentKey && item.contentKey === contentKey);
        }
        return undefined;
    }

    public hasActiveLink(url: string): boolean {
        return this.getVisibleItems().some(item => item.url === url);
    }

    public getDirtyRecords(): SavedLinkItem[] {
        return this.getAllItems().filter(item => item.isDirty);
    }

    /** 补充或更新指定链接的内容去重标识 */
    public updateContentKey(url: string, key: string): boolean {
        const items = this.getAllItems();
        let changed = false;
        const now = toIso8601WithMs();

        for (const item of items) {
            if (item.url === url && item.contentKey !== key) {
                item.contentKey = key;
                item.updatedAt = now;
                item.isDirty = true;
                changed = true;
            }
        }

        if (changed) {
            this.saveItems(items);
        }
        return changed;
    }

    /**
     * 收藏入库前的准备工作与全面去重探测
     * 涵盖本地已有收藏对比, 输入列表内部查重, 以及顺带尝试补全历史缺失标识
     */
    public async prepareSaveLinks(
        urls: string[],
        downloaderType: AllDownloaderType,
        options?: { signal?: AbortSignal }
    ): Promise<SavePreparationResult> {
        let identityCheckIncomplete = false;
        const ns = storage.getActiveNamespace();
        const resolvedCache = storage.getResolvedContentKeysCache(ns);
        const platform = getIdentityPlatform(downloaderType);
        const visibleItems = this.getVisibleItems();

        if (platform) {
            const oldItemsMissingKey = visibleItems.filter(
                item => !item.contentKey && getIdentityPlatform(item.downloaderType) === platform
            );

            const candidates: Array<{ url: string; downloader: AllDownloaderType }> = [
                ...urls.map(u => ({ url: u, downloader: downloaderType })),
                ...oldItemsMissingKey.map(item => ({ url: item.url, downloader: item.downloaderType })),
            ];

            const deadline = Date.now() + IDENTITY_RESOLVE_DEADLINE_MS;
            const visited = new Set<string>();
            const settings = storage.getSettings();
            const hasServerConfig = Boolean(settings.serverUrl && settings.serverToken);

            for (const candidate of candidates) {
                if (visited.has(candidate.url)) { continue; }
                visited.add(candidate.url);

                const existingKey = visibleItems.find(i => i.url === candidate.url)?.contentKey;
                if (existingKey) {
                    resolvedCache[candidate.url] = existingKey;
                }

                // 优先检查缓存
                if (resolvedCache[candidate.url]) {
                    this.updateContentKey(candidate.url, resolvedCache[candidate.url]);
                    continue;
                }

                // 尝试本地无需网络请求的正则提取
                const localKey = extractLocalContentKey(candidate.url, candidate.downloader);

                if (Date.now() >= deadline || options?.signal?.aborted) {
                    if (localKey) {
                        resolvedCache[candidate.url] = localKey;
                        this.updateContentKey(candidate.url, localKey);
                    }
                    identityCheckIncomplete = true;
                    break;
                }

                const retryKey = `${ns}|${candidate.url}`;
                const retryAfter = this.identityRetryAfter.get(retryKey) || 0;
                if (retryAfter > Date.now()) {
                    if (localKey) {
                        resolvedCache[candidate.url] = localKey;
                    }
                    identityCheckIncomplete = true;
                    continue;
                }

                if (!hasServerConfig) {
                    if (localKey) {
                        resolvedCache[candidate.url] = localKey;
                        this.updateContentKey(candidate.url, localKey);
                    } else {
                        identityCheckIncomplete = true;
                    }
                    continue;
                }

                try {
                    const remoteKey = await fetchContentKey({
                        url: candidate.url,
                        downloader: candidate.downloader,
                        settings,
                        signal: options?.signal,
                    });
                    const finalKey = remoteKey || localKey;
                    if (finalKey) {
                        resolvedCache[candidate.url] = finalKey;
                        this.updateContentKey(candidate.url, finalKey);
                    } else {
                        identityCheckIncomplete = true;
                        this.identityRetryAfter.set(retryKey, Date.now() + IDENTITY_RETRY_COOLDOWN_MS);
                    }
                } catch {
                    if (localKey) {
                        resolvedCache[candidate.url] = localKey;
                        this.updateContentKey(candidate.url, localKey);
                    }
                    identityCheckIncomplete = true;
                    this.identityRetryAfter.set(retryKey, Date.now() + IDENTITY_RETRY_COOLDOWN_MS);
                }
            }

            storage.setResolvedContentKeysCache(resolvedCache, ns);
        }

        // 重新获取补全最新标识后的可见收藏列表
        const latestVisible = this.getVisibleItems();
        const savedUrlSet = new Set(latestVisible.map(i => i.url));
        const savedKeyMap = new Map<string, string>();
        for (const item of latestVisible) {
            if (item.contentKey) {
                savedKeyMap.set(item.contentKey, item.url);
            }
        }

        const batchSeenUrls = new Set<string>();
        const batchSeenKeys = new Map<string, string>();
        const duplicates: DuplicateDetail[] = [];

        for (const url of urls) {
            const key =
                resolvedCache[url] || extractLocalContentKey(url, downloaderType) || undefined;
            if (key && !resolvedCache[url]) {
                resolvedCache[url] = key;
            }

            if (savedUrlSet.has(url)) {
                duplicates.push({
                    url,
                    reason: 'same_url_saved',
                    matchedUrl: url,
                    contentKey: key,
                });
            } else if (platform && key && savedKeyMap.has(key)) {
                duplicates.push({
                    url,
                    reason: 'same_key_saved',
                    matchedUrl: savedKeyMap.get(key),
                    contentKey: key,
                });
            } else if (batchSeenUrls.has(url)) {
                duplicates.push({
                    url,
                    reason: 'same_url_batch',
                    matchedUrl: url,
                    contentKey: key,
                });
            } else if (platform && key && batchSeenKeys.has(key)) {
                duplicates.push({
                    url,
                    reason: 'same_key_batch',
                    matchedUrl: batchSeenKeys.get(key),
                    contentKey: key,
                });
            }

            batchSeenUrls.add(url);
            if (key) {
                batchSeenKeys.set(key, url);
            }
        }

        return {
            urls,
            hasDuplicate: duplicates.length > 0,
            duplicates,
            identityCheckIncomplete: Boolean(platform && identityCheckIncomplete),
            resolvedContentKeys: resolvedCache,
        };
    }

    /**
     * 新增或恢复收藏记录列表
     * 相同链接再次收藏时复用原有唯一编号
     * 恢复已软删除记录时清空过期缓存
     * 同一链接若存在多个历史记录副本则将其余副本做软删除收敛
     */
    public addLinks(
        urls: string[],
        downloaderType: AllDownloaderType,
        contentKeys: Record<string, string> = {}
    ): SavedLinkItem[] {
        if (urls.length === 0) { return []; }
        const items = this.getAllItems();
        const touchedItems: SavedLinkItem[] = [];
        const platform = getIdentityPlatform(downloaderType);

        for (const rawUrl of urls) {
            const url = rawUrl.trim();
            if (!url) { continue; }

            const now = toIso8601WithMs();
            const resolvedKey =
                platform !== null
                    ? contentKeys[url] || extractLocalContentKey(url, downloaderType) || undefined
                    : undefined;

            // 查找所有匹配当前链接的已有记录 (涵盖有效记录与已软删除记录)
            const matchingIndices: number[] = [];
            items.forEach((item, idx) => {
                if (item.url === url) {
                    matchingIndices.push(idx);
                }
            });

            if (matchingIndices.length > 0) {
                // 优先挑选未删除记录, 无活跃记录时取首条已删除记录复用标识
                const activeIdx = matchingIndices.find(idx => !items[idx].isDeleted);
                const winnerIndex = activeIdx !== undefined ? activeIdx : matchingIndices[0];
                const winner: SavedLinkItem = { ...items[winnerIndex] };

                if (winner.isDeleted) {
                    winner.isDeleted = false;
                    winner.cachedUrls = null;
                    winner.preheatState = 'unpreheated';
                    winner.preheatError = null;
                }

                winner.contentKey = resolvedKey ?? winner.contentKey ?? null;
                winner.timestamp = now;
                winner.updatedAt = now;
                winner.isDirty = true;

                if (winner.downloaderType !== downloaderType) {
                    logger.info(`恢复或更新收藏链接下载器类型为 ${downloaderType}`, {
                        context: url,
                    });
                    winner.downloaderType = downloaderType;
                    winner.status = 'none';
                    winner.cachedUrls = null;
                    winner.preheatState = 'unpreheated';
                    winner.preheatError = null;
                }

                // 将其余重复项置为软删除以保证同一链接唯一有效
                for (const idx of matchingIndices) {
                    if (idx !== winnerIndex && !items[idx].isDeleted) {
                        items[idx] = {
                            ...items[idx],
                            isDeleted: true,
                            cachedUrls: null,
                            updatedAt: now,
                            isDirty: true,
                        };
                    }
                }

                // 调整至列表前列
                items.splice(winnerIndex, 1);
                items.unshift(winner);
                touchedItems.push(winner);
            } else {
                const newItem: SavedLinkItem = {
                    id: generateUUID(),
                    url,
                    timestamp: now,
                    downloaderType,
                    status: 'none',
                    updatedAt: now,
                    isDeleted: false,
                    isDirty: true,
                    contentKey: resolvedKey ?? null,
                    cachedUrls: null,
                    metadata: null,
                    preheatState: 'unpreheated',
                    preheatError: null,
                };
                items.unshift(newItem);
                touchedItems.push(newItem);
            }
        }

        this.saveItems(this.applyCapacityAndCleanupPolicy(items));
        return touchedItems;
    }

    /** 更新单条收藏的下载结果状态 */
    public updateStatus(id: string, newStatus: SavedLinkStatus): SavedLinkItem | null {
        const items = this.getAllItems();
        const idx = items.findIndex(item => isSameId(item.id, id));
        if (idx === -1) { return null; }

        items[idx] = {
            ...items[idx],
            status: newStatus,
            updatedAt: toIso8601WithMs(),
            isDirty: true,
        };
        this.saveItems(items);
        return items[idx];
    }

    /** 更新预热执行状态与落盘缓存直链集合 */
    public updatePreheatResult(
        id: string,
        result:
            | { state: 'preheating' }
            | { state: 'preheated'; cachedUrls: string[] }
            | { state: 'failed'; error: string }
            | { state: 'unpreheated' }
    ): SavedLinkItem | null {
        const items = this.getAllItems();
        const idx = items.findIndex(item => isSameId(item.id, id));
        if (idx === -1) { return null; }

        const current = items[idx];
        if (result.state === 'preheating') {
            items[idx] = {
                ...current,
                preheatState: 'preheating',
                preheatError: null,
            };
        } else if (result.state === 'preheated') {
            items[idx] = {
                ...current,
                cachedUrls: result.cachedUrls,
                preheatState: 'preheated',
                preheatError: null,
                updatedAt: toIso8601WithMs(),
                isDirty: true,
            };
        } else if (result.state === 'failed') {
            // 预热未成功时不破坏已有收藏记录, 仅登记失败原因
            items[idx] = {
                ...current,
                preheatState: 'failed',
                preheatError: result.error,
            };
        } else {
            items[idx] = {
                ...current,
                preheatState: 'unpreheated',
                preheatError: null,
            };
        }

        this.saveItems(items);
        return items[idx];
    }

    /** 软删除单条收藏记录 */
    public deleteItem(id: string): boolean {
        return this.deleteItems([id]) > 0;
    }

    /** 批量软删除指定收藏列表 */
    public deleteItems(ids: string[]): number {
        if (ids.length === 0) { return 0; }
        const items = this.getAllItems();
        const now = toIso8601WithMs();
        let count = 0;

        for (let i = 0; i < items.length; i++) {
            if (!items[i].isDeleted && ids.some(id => isSameId(id, items[i].id))) {
                items[i] = {
                    ...items[i],
                    isDeleted: true,
                    cachedUrls: null,
                    preheatState: 'unpreheated',
                    preheatError: null,
                    updatedAt: now,
                    isDirty: true,
                };
                count++;
            }
        }

        if (count > 0) {
            this.saveItems(items);
        }
        return count;
    }

    /** 软删除全部有效收藏记录 */
    public clearAll(): number {
        const items = this.getAllItems();
        const now = toIso8601WithMs();
        let count = 0;

        for (let i = 0; i < items.length; i++) {
            if (!items[i].isDeleted) {
                items[i] = {
                    ...items[i],
                    isDeleted: true,
                    cachedUrls: null,
                    preheatState: 'unpreheated',
                    preheatError: null,
                    updatedAt: now,
                    isDirty: true,
                };
                count++;
            }
        }

        if (count > 0) {
            this.saveItems(items);
        }
        return count;
    }

    /**
     * 将快照中已确认完成同步且同步期间未再变更的记录清除待同步标记
     * 防止同步进行过程中产生的新修改被意外冲掉
     */
    public markSnapshotAsSynced(snapshotUpdatedAtById: Map<string, string>, namespace?: string): void {
        const items = storage.getSavedLinks(namespace);
        let changed = false;

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (!item.isDirty) { continue; }

            for (const [snapId, snapUpdatedAt] of snapshotUpdatedAtById.entries()) {
                if (isSameId(item.id, snapId)) {
                    if (parseTimestampMs(item.updatedAt) === parseTimestampMs(snapUpdatedAt)) {
                        items[i] = { ...item, isDirty: false };
                        changed = true;
                    }
                    break;
                }
            }
        }

        if (changed) {
            storage.setSavedLinks(items, namespace);
        }
    }

    /**
     * 合并远端收藏记录集合
     * 保持远端标识原始大小写, 依据更新时间戳决胜
     * 同链接若远端缺失去重标识而本地已存在, 则保留本地标识并标记待同步回填
     */
    public mergeRemoteRecords(remoteApiRecords: SavedLinkItemAPI[], namespace?: string): {
        updatedCount: number;
        insertedCount: number;
    } {
        const items = storage.getSavedLinks(namespace);
        let updatedCount = 0;
        let insertedCount = 0;

        for (const remoteApi of remoteApiRecords) {
            const localIdx = items.findIndex(item => isSameId(item.id, remoteApi.id));

            if (localIdx !== -1) {
                const local = items[localIdx];
                const remoteTime = parseTimestampMs(remoteApi.updated_at);
                const localTime = parseTimestampMs(local.updatedAt);

                if (remoteTime >= localTime) {
                    const merged = fromSavedLinkAPI(remoteApi, local);
                    // 同链接且远端缺少去重标识时保留本地已有标识并标记回传
                    if (merged.url === local.url && !merged.contentKey && local.contentKey) {
                        merged.contentKey = local.contentKey;
                        merged.updatedAt = toIso8601WithMs(Math.max(Date.now(), remoteTime + 1));
                        merged.isDirty = true;
                    }
                    items[localIdx] = merged;
                    updatedCount++;
                }
            } else {
                const newLocal = fromSavedLinkAPI(remoteApi);
                items.push(newLocal);
                insertedCount++;
            }
        }

        // 按收藏时间戳降序排序
        items.sort((a, b) => parseTimestampMs(b.timestamp) - parseTimestampMs(a.timestamp));

        const cleaned = this.applyCapacityAndCleanupPolicy(items);
        storage.setSavedLinks(cleaned, namespace);
        return { updatedCount, insertedCount };
    }

    /**
     * 执行本地容量控制与软删除清理
     * 严禁淘汰未同步变更数据, 仅清除超期墓碑与淘汰多余的已同步旧记录
     */
    private applyCapacityAndCleanupPolicy(items: SavedLinkItem[]): SavedLinkItem[] {
        const cutoffMs = Date.now() - STALE_DELETED_DAYS * 24 * 60 * 60 * 1000;

        // 清理已同步且超过三十天的软删除墓碑记录
        const afterStaleCleanup = items.filter(item => {
            if (item.isDeleted && !item.isDirty && parseTimestampMs(item.updatedAt) < cutoffMs) {
                return false;
            }
            return true;
        });

        if (afterStaleCleanup.length <= MAX_SAVED_LINKS) {
            return afterStaleCleanup;
        }

        // 优先保留所有待同步记录, 剩余配额分配给已同步记录
        const dirtyItems = afterStaleCleanup.filter(i => i.isDirty);
        const syncedItems = afterStaleCleanup.filter(i => !i.isDirty);
        const remainingQuota = Math.max(0, MAX_SAVED_LINKS - dirtyItems.length);
        const keptSynced = syncedItems.slice(0, remainingQuota);

        const combined = [...dirtyItems, ...keptSynced];
        combined.sort((a, b) => parseTimestampMs(b.timestamp) - parseTimestampMs(a.timestamp));
        return combined;
    }

    private saveItems(items: SavedLinkItem[]): void {
        storage.setSavedLinks(items);
    }
}

export const savedLinksManager = new SavedLinksManager();
