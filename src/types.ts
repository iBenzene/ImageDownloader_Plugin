// src/types.ts

/**
 * 核心类型定义
 * 严格对齐 iOS 客户端协议与服务端接口规范
 */

/** 服务端既有下载器名称, 对应固定的平台处理器 */
export type XhsDownloaderType =
    | '小红书图片下载器'
    | '小红书实况图片下载器'
    | '小红书视频下载器';

export type AllDownloaderType =
    | XhsDownloaderType
    | '米游社图片下载器'
    | '微博图片下载器'
    | '哔哩哔哩视频下载器'
    | 'Pixiv 插画下载器'
    | 'Pixiv 动图下载器'
    | 'Twitter (X) 图片下载器'
    | 'Twitter (X) 视频下载器'
    | (string & {});

/** 收藏记录在客户端的下载结果状态, 对齐 iOS SavedLinkStatus */
export type SavedLinkStatus = 'none' | 'success' | 'failure';

/** 资源预热状态, 涵盖本地操作流程与远端已有缓存标识 */
export type PreheatState =
    | 'unpreheated'    // 尚未触发预热
    | 'preheating'     // 正在请求服务端预热并缓存至对象存储
    | 'preheated'      // 本机预热成功并写入对象存储
    | 'cached_remote'  // 其他客户端同步而来的有效云端缓存
    | 'failed';        // 预热流程失败

/** 本地收藏记录模型, 对齐 iOS SavedLinkItem */
export interface SavedLinkItem {
    /** 兼容 iOS 的大写 UUID */
    id: string;
    url: string;
    /** 创建或收藏时间, 格式为 UTC ISO 8601 with ms */
    timestamp: string;
    downloaderType: AllDownloaderType;
    /** 下载结果状态, 值为 none, success 或 failure */
    status: SavedLinkStatus;
    /** 最后修改时间, 格式为 UTC ISO 8601 with ms */
    updatedAt: string;
    /** 软删除标记 */
    isDeleted: boolean;
    /** 本地存在待同步至远端的变更 */
    isDirty: boolean;
    /** 内容去重标识, 例如 xhs 与 24 位十六进制笔记 ID 组合 */
    contentKey?: string | null;
    /** 服务端对象存储已缓存的直链列表 */
    cachedUrls?: string[] | null;
    /** 扩展元数据, 保留服务端返回的附属信息 */
    metadata?: Record<string, string> | null;
    /** 本机可观测的预热状态 */
    preheatState?: PreheatState;
    /** 预热失败时的错误原因 */
    preheatError?: string | null;
}

/** 服务端收藏同步接口单条数据传输模型, 对齐 SavedLinkItemAPI */
export interface SavedLinkItemAPI {
    id: string;
    url: string;
    downloader: string;
    status: SavedLinkStatus;
    created_at: string;
    updated_at: string;
    is_deleted: boolean;
    metadata?: Record<string, string> | null;
    content_key?: string | null;
    cached_urls?: string[] | null;
}

export interface SavedLinksSyncRequest {
    records: SavedLinkItemAPI[];
}

export interface SavedLinksSyncResponse {
    records: SavedLinkItemAPI[];
    syncedAt: string;
}

/** 本地下载历史模型, 对齐 iOS HistoryItem */
export interface HistoryItem {
    /** 兼容 iOS 的大写 UUID */
    id: string;
    url: string;
    downloaderType: AllDownloaderType;
    /** 触发下载的时间戳, 格式为 UTC ISO 8601 with ms */
    timestamp: string;
    isSuccess: boolean;
    mediaCount: number;
    /** 最后修改时间, 格式为 UTC ISO 8601 with ms */
    updatedAt: string;
    isDeleted: boolean;
    isDirty: boolean;
    metadata?: Record<string, string> | null;
}

/** 服务端历史同步接口单条数据传输模型, 对齐 HistoryItemAPI */
export interface HistoryItemAPI {
    id: string;
    url: string;
    downloader: string;
    media_count: number;
    is_success: boolean;
    created_at: string;
    updated_at: string;
    is_deleted: boolean;
    metadata?: Record<string, string> | null;
}

export interface HistorySyncRequest {
    records: HistoryItemAPI[];
}

export interface HistorySyncResponse {
    records: HistoryItemAPI[];
    syncedAt: string;
}

/** 实况图片成对媒体资源模型 */
export interface LivePhotoMediaItem {
    cover: string;
    video: string;
}

/** 日志严重级别, 对齐 iOS LogLevel */
export enum LogLevel {
    Debug = 0,
    Info = 1,
    Warn = 2,
    Error = 3,
}

export interface LogEntry {
    id: string;
    timestamp: string;
    level: LogLevel;
    message: string;
    taskId?: string;
    context?: string;
}

/** 页面主动作默认类型 */
export type DefaultActionType = 'download' | 'save';

/** 插件持久化配置模型 */
export interface PluginSettings {
    /** 服务端 API 基地址, 自动兼容末尾斜杠 */
    serverUrl: string;
    /** 服务端访问令牌 */
    serverToken: string;
    /** 普通下载解析是否通过服务端代理 */
    serverSideProxy: boolean;
    /** 收藏成功后是否自动触发服务端资源预热 */
    preheatResources: boolean;
    /** 是否启用增量同步游标 */
    incrementalSync: boolean;
    /** 页面快捷操作栏默认按钮动作 */
    defaultAction: DefaultActionType;
    /** 界面日志展示过滤级别 */
    logDisplayLevel: LogLevel;
}

/** 单个媒体文件下载子任务详情 */
export interface MediaSubTask {
    index: number; // 从 1 开始编号
    label: string;
    url: string;
    filename: string;
    isLiveCover?: boolean;
    isLiveVideo?: boolean;
    pairIndex?: number; // 实况所属成对组编号
    status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
    progressPercent?: number;
    error?: string;
}

/** 队列任务分类 */
export type TaskType = 'save' | 'preheat' | 'download' | 'sync';

/** 任务生命周期状态 */
export type TaskStatus =
    | 'pending'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'interrupted';

/** 统一调度任务模型 */
export interface TaskItem {
    id: string;
    type: TaskType;
    title: string;
    urls: string[];
    downloaderType: AllDownloaderType;
    savedLinkId?: string;
    /** 是否强制穿透缓存重新解析下载 */
    forceReExtract?: boolean;
    status: TaskStatus;
    createdAt: string;
    updatedAt: string;
    /** 笔记处理进度, 指示当前正在处理第几个笔记 */
    currentNoteIndex: number;
    totalNoteCount: number;
    /** 媒体文件下载进度, 指示当前处理第几个媒体文件 */
    currentMediaIndex: number;
    totalMediaCount: number;
    /** 成功落地的媒体文件总数 */
    completedMediaCount: number;
    /** 子任务拆解明细, 支持断点与多文件状态溯源 */
    mediaSubTasks: MediaSubTask[];
    /** 运行时是否使用了预热缓存链接 */
    usedCachedUrls?: boolean;
    /** 状态简要提示文案 */
    message: string;
    /** 详细错误堆栈或提示信息 */
    error?: string;
    /** 认领该任务的标签页唯一标识 */
    executorTabId?: string;
}

/** 页面笔记上下文提取结果 */
export interface PageNoteContext {
    /** 24 位十六进制笔记唯一标识 */
    noteId: string;
    /** 附带必要安全鉴权凭据的完整访问地址 */
    url: string;
    /** 笔记标题或前置摘要 */
    title: string;
    /** 页面展现形态, standalone 为独立页, modal 为浮层弹窗 */
    viewMode: 'standalone' | 'modal';
    /** 自动推断出的下载器分类, 置信度不足时为 null */
    detectedDownloader: XhsDownloaderType | null;
    /** 判定依据与规则说明 */
    detectionReason: string;
    /** 用户手动指定的下载器分类 */
    selectedDownloader: XhsDownloaderType | null;
}

/** 服务端连通性与配置诊断单项结果 */
export interface DiagnosticCheckItem {
    key: 'config' | 'connection';
    title: string;
    status: 'ok' | 'warn' | 'error';
    detail: string;
}

export interface ConnectionCheckResult {
    overallOk: boolean;
    checkedAt: string;
    items: DiagnosticCheckItem[];
}
