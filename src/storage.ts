// src/storage.ts

import { DEFAULT_SETTINGS, STORAGE_KEYS } from './constants';
import { getGmBridge } from './gmAdapter';
import {
    HistoryItem,
    LogEntry,
    PluginSettings,
    SavedLinkItem,
    TaskItem
} from './types';
import {
    generateUUID,
    getServerNamespaceHash,
    normalizeServerBaseUrl
} from './utils';

/** 当前标签页实例唯一标识, 用于多标签页协同与执行者选举 */
export const CURRENT_TAB_ID = generateUUID();

export interface LeaseRecord {
    tabId: string;
    acquiredAt: number;
    expiresAt: number;
    taskId?: string;
}

type StateChangeCallback = (reason: string) => void;

/**
 * 本地持久化与跨标签页状态管理器
 * 支持服务端数据空间隔离以及多标签页变更通知
 */
class StorageManager {
    private listeners = new Set<StateChangeCallback>();
    private writeQueue: Promise<unknown> = Promise.resolve();
    private broadcastChannel: BroadcastChannel | null = null;

    constructor() {
        this.initCrossTabSync();
    }

    /** 初始化跨标签页消息通道与监听机制 */
    private initCrossTabSync(): void {
        try {
            if (typeof BroadcastChannel !== 'undefined') {
                this.broadcastChannel = new BroadcastChannel(
                    'benben_image_downloader_channel_v1'
                );
                (
                    this.broadcastChannel as unknown as { unref?: () => void }
                )?.unref?.();
                this.broadcastChannel.onmessage = event => {
                    if (event?.data?.tabId !== CURRENT_TAB_ID) {
                        this.emitChange(
                            event?.data?.reason || 'remote_tab_update'
                        );
                    }
                };
            }
        } catch {
            this.broadcastChannel = null;
        }

        const bridge = getGmBridge();
        bridge.addValueChangeListener(
            STORAGE_KEYS.SETTINGS,
            (...[, , , remote]) => {
                if (remote) {
                    this.emitChange('settings');
                }
            }
        );
        bridge.addValueChangeListener(
            STORAGE_KEYS.TASKS,
            (...[, , , remote]) => {
                if (remote) {
                    this.emitChange('tasks');
                }
            }
        );
        bridge.addValueChangeListener(
            STORAGE_KEYS.LOGS,
            (...[, , , remote]) => {
                if (remote) {
                    this.emitChange('logs');
                }
            }
        );
    }

    /** 订阅本地数据变更通知 */
    public subscribe(cb: StateChangeCallback): () => void {
        this.listeners.add(cb);
        return () => {
            this.listeners.delete(cb);
        };
    }

    /** 触发本页订阅监听回调 */
    public emitChange(reason: string): void {
        for (const cb of this.listeners) {
            try {
                cb(reason);
            } catch {
                // 忽略外部监听器抛出的异常
            }
        }
    }

    /** 通知本页及其他存活的标签页更新数据状态 */
    private notifyTabs(reason: string): void {
        this.emitChange(reason);
        try {
            this.broadcastChannel?.postMessage({
                reason,
                tabId: CURRENT_TAB_ID,
                ts: Date.now()
            });
        } catch {
            // 忽略消息广播通道不可用时的异常
        }
    }

    /**
     * 串行化写入队列
     * 确保并发修改操作依次执行, 防止状态覆盖
     */
    public serializeWrite<T>(fn: () => T | Promise<T>): Promise<T> {
        const next = this.writeQueue.then(fn, fn);
        this.writeQueue = next.then(
            () => undefined,
            () => undefined
        );
        return next;
    }

    /** 读取插件当前配置 */
    public getSettings(): PluginSettings {
        const raw = getGmBridge().getValue<Partial<PluginSettings>>(
            STORAGE_KEYS.SETTINGS,
            {}
        );
        return {
            defaultAction:
                raw.defaultAction === 'save' || raw.defaultAction === 'download'
                    ? raw.defaultAction
                    : DEFAULT_SETTINGS.defaultAction,
            incrementalSync:
                typeof raw.incrementalSync === 'boolean'
                    ? raw.incrementalSync
                    : DEFAULT_SETTINGS.incrementalSync,
            logDisplayLevel:
                typeof raw.logDisplayLevel === 'number'
                    ? raw.logDisplayLevel
                    : DEFAULT_SETTINGS.logDisplayLevel,
            preheatResources:
                typeof raw.preheatResources === 'boolean'
                    ? raw.preheatResources
                    : DEFAULT_SETTINGS.preheatResources,
            serverSideProxy:
                typeof raw.serverSideProxy === 'boolean'
                    ? raw.serverSideProxy
                    : DEFAULT_SETTINGS.serverSideProxy,
            serverToken:
                typeof raw.serverToken === 'string'
                    ? raw.serverToken.trim()
                    : DEFAULT_SETTINGS.serverToken,
            serverUrl:
                typeof raw.serverUrl === 'string'
                    ? normalizeServerBaseUrl(raw.serverUrl)
                    : DEFAULT_SETTINGS.serverUrl
        };
    }

    /** 保存配置并自动判定数据空间命名空间是否发生变更 */
    public saveSettings(patch: Partial<PluginSettings>): {
        settings: PluginSettings;
        namespaceChanged: boolean;
        previousNamespace: string;
        currentNamespace: string;
    } {
        const prev = this.getSettings();
        const previousNamespace = this.getActiveNamespace(prev);
        const next: PluginSettings = {
            ...prev,
            ...patch,
            serverToken:
                patch.serverToken !== undefined
                    ? patch.serverToken.trim()
                    : prev.serverToken,
            serverUrl:
                patch.serverUrl !== undefined
                    ? normalizeServerBaseUrl(patch.serverUrl)
                    : prev.serverUrl
        };
        getGmBridge().setValue(STORAGE_KEYS.SETTINGS, next);
        const currentNamespace = this.getActiveNamespace(next);
        const namespaceChanged = previousNamespace !== currentNamespace;
        this.notifyTabs(namespaceChanged ? 'namespace_changed' : 'settings');
        return {
            currentNamespace,
            namespaceChanged,
            previousNamespace,
            settings: next
        };
    }

    /** 获取当前服务端配置对应的数据隔离命名空间标识 */
    public getActiveNamespace(
        settings: PluginSettings = this.getSettings()
    ): string {
        return getServerNamespaceHash(settings.serverUrl, settings.serverToken);
    }

    /** 构造按命名空间隔离的存储键名 */
    private nsKey(suffix: string, namespace?: string): string {
        const ns = namespace || this.getActiveNamespace();
        return `benben_${ns}_${suffix}`;
    }

    // 收藏数据持久化操作 (按服务端空间隔离)

    public getSavedLinks(namespace?: string): SavedLinkItem[] {
        const items = getGmBridge().getValue<SavedLinkItem[]>(
            this.nsKey('saved_links', namespace),
            []
        );
        return Array.isArray(items) ? items : [];
    }

    public setSavedLinks(items: SavedLinkItem[], namespace?: string): void {
        getGmBridge().setValue(this.nsKey('saved_links', namespace), items);
        this.notifyTabs('saved_links');
    }

    public getSavedLinksLastSyncedAt(namespace?: string): string | null {
        return getGmBridge().getValue<string | null>(
            this.nsKey('saved_links_last_synced_at', namespace),
            null
        );
    }

    public setSavedLinksLastSyncedAt(
        iso: string | null,
        namespace?: string
    ): void {
        getGmBridge().setValue(
            this.nsKey('saved_links_last_synced_at', namespace),
            iso
        );
        this.notifyTabs('saved_links_sync_cursor');
    }

    public getResolvedContentKeysCache(
        namespace?: string
    ): Record<string, string> {
        const map = getGmBridge().getValue<Record<string, string>>(
            this.nsKey('content_keys_cache', namespace),
            {}
        );
        return map && typeof map === 'object' ? map : {};
    }

    public setResolvedContentKeysCache(
        cache: Record<string, string>,
        namespace?: string
    ): void {
        getGmBridge().setValue(
            this.nsKey('content_keys_cache', namespace),
            cache
        );
    }

    // 下载历史持久化操作 (按服务端空间隔离)

    public getHistoryItems(namespace?: string): HistoryItem[] {
        const items = getGmBridge().getValue<HistoryItem[]>(
            this.nsKey('history_items', namespace),
            []
        );
        return Array.isArray(items) ? items : [];
    }

    public setHistoryItems(items: HistoryItem[], namespace?: string): void {
        getGmBridge().setValue(this.nsKey('history_items', namespace), items);
        this.notifyTabs('history_items');
    }

    public getHistoryLastSyncedAt(namespace?: string): string | null {
        return getGmBridge().getValue<string | null>(
            this.nsKey('history_last_synced_at', namespace),
            null
        );
    }

    public setHistoryLastSyncedAt(
        iso: string | null,
        namespace?: string
    ): void {
        getGmBridge().setValue(
            this.nsKey('history_last_synced_at', namespace),
            iso
        );
        this.notifyTabs('history_sync_cursor');
    }

    // 本地任务队列持久化操作 (按服务端空间隔离)

    public getTasks(namespace?: string): TaskItem[] {
        const items = getGmBridge().getValue<TaskItem[]>(
            this.nsKey('tasks', namespace),
            []
        );
        return Array.isArray(items) ? items : [];
    }

    public setTasks(items: TaskItem[], namespace?: string): void {
        getGmBridge().setValue(this.nsKey('tasks', namespace), items);
        this.notifyTabs('tasks');
    }

    // 运行日志持久化操作

    public getLogs(): LogEntry[] {
        const logs = getGmBridge().getValue<LogEntry[]>(STORAGE_KEYS.LOGS, []);
        return Array.isArray(logs) ? logs : [];
    }

    public setLogs(logs: LogEntry[]): void {
        getGmBridge().setValue(STORAGE_KEYS.LOGS, logs);
        this.notifyTabs('logs');
    }

    // 多标签页执行租约锁机制

    public tryAcquireLease(
        leaseKey: string,
        ttlMs = 12000,
        taskId?: string
    ): boolean {
        const now = Date.now();
        const current = getGmBridge().getValue<LeaseRecord | null>(
            leaseKey,
            null
        );
        if (
            current &&
            current.tabId !== CURRENT_TAB_ID &&
            current.expiresAt > now
        ) {
            return false;
        }
        const next: LeaseRecord = {
            acquiredAt:
                current?.tabId === CURRENT_TAB_ID ? current.acquiredAt : now,
            expiresAt: now + ttlMs,
            tabId: CURRENT_TAB_ID,
            taskId
        };
        getGmBridge().setValue(leaseKey, next);
        return true;
    }

    public renewLease(
        leaseKey: string,
        ttlMs = 12000,
        taskId?: string
    ): boolean {
        const now = Date.now();
        const current = getGmBridge().getValue<LeaseRecord | null>(
            leaseKey,
            null
        );
        if (
            current &&
            current.tabId !== CURRENT_TAB_ID &&
            current.expiresAt > now
        ) {
            return false;
        }
        getGmBridge().setValue(leaseKey, {
            acquiredAt: current?.acquiredAt ?? now,
            expiresAt: now + ttlMs,
            tabId: CURRENT_TAB_ID,
            taskId: taskId ?? current?.taskId
        });
        return true;
    }

    public releaseLease(leaseKey: string): void {
        const current = getGmBridge().getValue<LeaseRecord | null>(
            leaseKey,
            null
        );
        if (current && current.tabId === CURRENT_TAB_ID) {
            getGmBridge().deleteValue(leaseKey);
        }
    }

    public getActiveLease(leaseKey: string): LeaseRecord | null {
        const current = getGmBridge().getValue<LeaseRecord | null>(
            leaseKey,
            null
        );
        if (!current || current.expiresAt <= Date.now()) {
            return null;
        }
        return current;
    }
}

export const storage = new StorageManager();
