// src/constants.ts

import { AllDownloaderType, LogLevel, PluginSettings, XhsDownloaderType } from './types';

/** 小红书支持的下载器集合 */
export const XHS_DOWNLOADERS: readonly XhsDownloaderType[] = [
    '小红书图片下载器',
    '小红书视频下载器',
    '小红书实况图片下载器',
] as const;

/** 客户端支持的完整下载器列表, 保持与 iOS 端名称对齐 */
export const ALL_DOWNLOADERS: readonly AllDownloaderType[] = [
    '小红书图片下载器',
    '小红书实况图片下载器',
    '小红书视频下载器',
    '米游社图片下载器',
    '微博图片下载器',
    '哔哩哔哩视频下载器',
    'Pixiv 插画下载器',
    'Pixiv 动图下载器',
    'Twitter (X) 图片下载器',
    'Twitter (X) 视频下载器',
] as const;

/** 界面展示使用的下载器短名称映射 */
export const SHORT_DOWNLOADER_NAMES: Record<string, string> = {
    '小红书图片下载器': '小红书图片',
    '小红书实况图片下载器': '小红书实况',
    '小红书视频下载器': '小红书视频',
    '米游社图片下载器': '米游社',
    '微博图片下载器': '微博',
    '哔哩哔哩视频下载器': '哔哩哔哩',
    'Pixiv 插画下载器': 'Pixiv 插画',
    'Pixiv 动图下载器': 'Pixiv 动图',
    'Twitter (X) 图片下载器': 'Twitter (X) 图片',
    'Twitter (X) 视频下载器': 'Twitter (X) 视频',
};

/** 实况图片成对缓存的特征前缀 */
export const LIVE_CACHE_PREFIX = '__LIVE_CACHE__';

/** 增量同步安全时间缓冲, 设为 180 秒以容纳时钟微小偏差, 对齐 iOS 客户端实现 */
export const INCREMENTAL_SYNC_BUFFER_MS = 180 * 1000;

/** 本地持久化列表容量上限, 超出时按策略清理已同步数据 */
export const MAX_SAVED_LINKS = 500;
export const MAX_HISTORY_ITEMS = 500;
export const MAX_LOG_ENTRIES = 500;
export const MAX_TASK_ITEMS = 200;

/** 已同步软删除记录保留期限, 超过 30 天后自动从本地存储移除 */
export const STALE_DELETED_DAYS = 30;

/** 内容去重标识解析超时时间, 设为 20 秒 */
export const IDENTITY_RESOLVE_DEADLINE_MS = 20 * 1000;

/** 解析失败后的重试冷却间隔, 设为 300 秒, 防止对服务端造成持续压力 */
export const IDENTITY_RETRY_COOLDOWN_MS = 300 * 1000;

/** 单个任务内部并发下载媒体文件的最大连接数 */
export const MEDIA_DOWNLOAD_CONCURRENCY = 2;

/** 客户端默认初始设置 */
export const DEFAULT_SETTINGS: PluginSettings = {
    serverUrl: '',
    serverToken: '',
    serverSideProxy: false,
    preheatResources: false,
    incrementalSync: true,
    defaultAction: 'download',
    logDisplayLevel: LogLevel.Info,
};

/** 存储与多标签页通信键名定义 */
export const STORAGE_KEYS = {
    SETTINGS: 'benben_settings_v1',
    LOGS: 'benben_logs_v1',
    TASKS: 'benben_tasks_v1',
    EXECUTOR_LEASE: 'benben_executor_lease_v1',
    SYNC_LEASE: 'benben_sync_lease_v1',
} as const;
