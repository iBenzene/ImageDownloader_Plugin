// src/history.ts

import { MAX_HISTORY_ITEMS, STALE_DELETED_DAYS } from './constants';
import { storage } from './storage';
import { AllDownloaderType, HistoryItem, HistoryItemAPI } from './types';
import {
    generateUUID,
    isSameId,
    parseTimestampMs,
    toIso8601WithMs
} from './utils';

/**
 * 将本地历史记录模型转换为服务端传输结构
 * 保持时间字段精度与布尔类型对齐
 */
export const toHistoryAPI = (item: HistoryItem): HistoryItemAPI => {
    return {
        created_at: toIso8601WithMs(item.timestamp),
        downloader: item.downloaderType,
        id: item.id,
        is_deleted: Boolean(item.isDeleted),
        is_success: Boolean(item.isSuccess),
        media_count: item.mediaCount,
        metadata: item.metadata ?? null,
        updated_at: toIso8601WithMs(item.updatedAt),
        url: item.url
    };
};

/**
 * 将服务端传输结构还原为本地历史模型
 * 远端拉取记录默认置为未修改状态
 */
export const fromHistoryAPI = (api: HistoryItemAPI): HistoryItem => {
    return {
        downloaderType: api.downloader,
        id: api.id,
        isDeleted: Boolean(api.is_deleted),
        isDirty: false,
        isSuccess: Boolean(api.is_success),
        mediaCount: typeof api.media_count === 'number' ? api.media_count : 0,
        metadata: api.metadata ?? null,
        timestamp: toIso8601WithMs(api.created_at),
        updatedAt: toIso8601WithMs(api.updated_at),
        url: api.url
    };
};

/**
 * 下载历史记录管理服务
 * 维护本地持久化列表, 变更标记及合并淘汰策略
 */
class HistoryManager {
    public getAllItems(): HistoryItem[] {
        return storage.getHistoryItems();
    }

    public getVisibleItems(): HistoryItem[] {
        return this.getAllItems().filter(item => !item.isDeleted);
    }

    public getDirtyRecords(): HistoryItem[] {
        return this.getAllItems().filter(item => item.isDirty);
    }

    /**
     * 追加单条下载历史记录
     * 写入新记录后按容量策略自动淘汰已同步的旧记录
     */
    public addRecord(options: {
        url: string;
        downloaderType: AllDownloaderType;
        isSuccess: boolean;
        mediaCount: number;
    }): HistoryItem {
        const now = toIso8601WithMs();
        const newItem: HistoryItem = {
            downloaderType: options.downloaderType,
            id: generateUUID(),
            isDeleted: false,
            isDirty: true,
            isSuccess: options.isSuccess,
            mediaCount: Math.max(0, Math.floor(options.mediaCount)),
            metadata: null,
            timestamp: now,
            updatedAt: now,
            url: options.url
        };

        const items = this.getAllItems();
        items.unshift(newItem);
        storage.setHistoryItems(this.applyCapacityAndCleanupPolicy(items));
        return newItem;
    }

    /** 软删除单条历史记录 */
    public deleteItem(id: string): boolean {
        return this.deleteItems([id]) > 0;
    }

    /** 批量软删除指定历史记录列表 */
    public deleteItems(ids: string[]): number {
        if (ids.length === 0) {
            return 0;
        }
        const items = this.getAllItems();
        const now = toIso8601WithMs();
        let count = 0;

        for (let i = 0; i < items.length; i++) {
            if (
                !items[i].isDeleted &&
                ids.some(id => isSameId(id, items[i].id))
            ) {
                items[i] = {
                    ...items[i],
                    isDeleted: true,
                    isDirty: true,
                    updatedAt: now
                };
                count++;
            }
        }

        if (count > 0) {
            storage.setHistoryItems(items);
        }
        return count;
    }

    /** 软删除所有未删除的历史记录 */
    public clearAll(): number {
        const items = this.getAllItems();
        const now = toIso8601WithMs();
        let count = 0;

        for (let i = 0; i < items.length; i++) {
            if (!items[i].isDeleted) {
                items[i] = {
                    ...items[i],
                    isDeleted: true,
                    isDirty: true,
                    updatedAt: now
                };
                count++;
            }
        }

        if (count > 0) {
            storage.setHistoryItems(items);
        }
        return count;
    }

    /**
     * 将快照中已确认完成同步的记录清除未同步标记
     * 若记录在网络请求期间发生二次修改则保留待同步状态
     */
    public markSnapshotAsSynced(
        snapshotUpdatedAtById: Map<string, string>,
        namespace?: string
    ): void {
        const items = storage.getHistoryItems(namespace);
        let changed = false;

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (!item.isDirty) {
                continue;
            }

            for (const [
                snapId,
                snapUpdatedAt
            ] of snapshotUpdatedAtById.entries()) {
                if (isSameId(item.id, snapId)) {
                    if (
                        parseTimestampMs(item.updatedAt) ===
                        parseTimestampMs(snapUpdatedAt)
                    ) {
                        items[i] = { ...item, isDirty: false };
                        changed = true;
                    }
                    break;
                }
            }
        }

        if (changed) {
            storage.setHistoryItems(items, namespace);
        }
    }

    /**
     * 合并远端下发的历史记录集合
     * 依据更新时间戳对比胜出规则进行覆盖或插入
     */
    public mergeRemoteRecords(
        remoteApiRecords: HistoryItemAPI[],
        namespace?: string
    ): {
        updatedCount: number;
        insertedCount: number;
    } {
        const items = storage.getHistoryItems(namespace);
        let updatedCount = 0;
        let insertedCount = 0;

        for (const remoteApi of remoteApiRecords) {
            const localIdx = items.findIndex(item =>
                isSameId(item.id, remoteApi.id)
            );
            if (localIdx !== -1) {
                const local = items[localIdx];
                const remoteTime = parseTimestampMs(remoteApi.updated_at);
                const localTime = parseTimestampMs(local.updatedAt);

                if (remoteTime >= localTime) {
                    items[localIdx] = fromHistoryAPI(remoteApi);
                    updatedCount++;
                }
            } else {
                items.push(fromHistoryAPI(remoteApi));
                insertedCount++;
            }
        }

        items.sort(
            (a, b) =>
                parseTimestampMs(b.timestamp) - parseTimestampMs(a.timestamp)
        );
        const cleaned = this.applyCapacityAndCleanupPolicy(items);
        storage.setHistoryItems(cleaned, namespace);
        return { insertedCount, updatedCount };
    }

    /**
     * 应用本地容量上限与软删除归档清理策略
     * 优先保护未同步的脏数据记录, 淘汰已同步且超期的旧数据
     */
    private applyCapacityAndCleanupPolicy(items: HistoryItem[]): HistoryItem[] {
        const cutoffMs = Date.now() - STALE_DELETED_DAYS * 24 * 60 * 60 * 1000;
        const afterStaleCleanup = items.filter(item => {
            if (
                item.isDeleted &&
                !item.isDirty &&
                parseTimestampMs(item.updatedAt) < cutoffMs
            ) {
                return false;
            }
            return true;
        });

        if (afterStaleCleanup.length <= MAX_HISTORY_ITEMS) {
            return afterStaleCleanup;
        }

        const dirtyItems = afterStaleCleanup.filter(i => i.isDirty);
        const syncedItems = afterStaleCleanup.filter(i => !i.isDirty);
        const remainingQuota = Math.max(
            0,
            MAX_HISTORY_ITEMS - dirtyItems.length
        );
        const keptSynced = syncedItems.slice(0, remainingQuota);

        const combined = [...dirtyItems, ...keptSynced];
        combined.sort(
            (a, b) =>
                parseTimestampMs(b.timestamp) - parseTimestampMs(a.timestamp)
        );
        return combined;
    }
}

export const historyManager = new HistoryManager();
