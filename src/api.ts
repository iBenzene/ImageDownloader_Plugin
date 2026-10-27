// src/api.ts

import { getGmBridge } from './gmAdapter';
import { logger } from './logger';
import { storage } from './storage';
import {
    AllDownloaderType,
    ConnectionCheckResult,
    DiagnosticCheckItem,
    HistoryItemAPI,
    HistorySyncResponse,
    LivePhotoMediaItem,
    PluginSettings,
    SavedLinkItemAPI,
    SavedLinksSyncResponse,
} from './types';
import { normalizeServerBaseUrl, toIso8601WithMs, unescapeMediaUrl } from './utils';

/** 统一 API 调用异常类 */
export class ApiError extends Error {
    public readonly statusCode: number;
    public readonly category:
        | 'unconfigured'
        | 'auth'
        | 's3_config'
        | 'rate_limit'
        | 'timeout'
        | 'network'
        | 'parse'
        | 'server';

    constructor(
        message: string,
        statusCode = 0,
        category: ApiError['category'] = 'server'
    ) {
        super(message);
        this.name = 'ApiError';
        this.statusCode = statusCode;
        this.category = category;
    }
}

/** 归类 HTTP 响应错误并生成结构化错误对象 */
const classifyHttpError = (status: number, errorText: string): ApiError => {
    const msg = errorText || `HTTP ${status}`;
    if (status === 401 || status === 403 || msg.includes('认证失败')) {
        return new ApiError(`鉴权失败，服务端令牌不正确（${msg}）`, status, 'auth');
    }
    if (status === 429) {
        return new ApiError('请求过于频繁（触发限流 HTTP 429），请稍后重试', status, 'rate_limit');
    }
    if (
        msg.includes('S3 配置缺失') ||
        msg.includes('S3_ENDPOINT') ||
        msg.includes('S3 configuration missing') ||
        msg.includes('NoSuchBucket') ||
        msg.includes('InvalidAccessKeyId') ||
        msg.includes('SignatureDoesNotMatch')
    ) {
        return new ApiError(`服务端对象存储（S3）未配置或凭证错误（${msg}）`, status, 's3_config');
    }
    return new ApiError(msg, status, 'server');
};

/** 从响应体中提取可读的错误文本提示 */
const parseErrorFromBody = (responseText: string, status: number): string => {
    if (!responseText) { return `HTTP ${status}`; }
    try {
        const parsed = JSON.parse(responseText) as { error?: string; message?: string };
        if (typeof parsed?.error === 'string' && parsed.error) {
            return parsed.error;
        }
        if (typeof parsed?.message === 'string' && parsed.message) {
            return parsed.message;
        }
    } catch {
        // 响应体非 JSON 格式时采用纯文本截断
    }
    return responseText.slice(0, 200);
};

/** 构建完整的服务端接口请求 URL */
const buildEndpointUrl = (baseUrl: string, path: string, queryParams: Record<string, string | undefined>): string => {
    const normalizedBase = normalizeServerBaseUrl(baseUrl);
    if (!normalizedBase) {
        throw new ApiError('请在设置中配置服务端地址', 0, 'unconfigured');
    }
    let urlObj: URL;
    try {
        urlObj = new URL(`${normalizedBase}${path.startsWith('/') ? path : `/${path}`}`);
    } catch {
        throw new ApiError('服务端地址格式无效，请填写完整 http(s) 地址', 0, 'unconfigured');
    }

    for (const [k, v] of Object.entries(queryParams)) {
        if (v !== undefined && v !== null) {
            urlObj.searchParams.set(k, v);
        }
    }
    return urlObj.toString();
};

/**
 * 请求服务端解析内容唯一标识 contentKey
 * 用于在跨终端和跨格式链接下准确去重
 */
export const fetchContentKey = async (options: {
    url: string;
    downloader: AllDownloaderType;
    settings?: PluginSettings;
    signal?: AbortSignal;
}): Promise<string | null> => {
    const settings = options.settings ?? storage.getSettings();
    const token = settings.serverToken || 'default_token';
    const endpoint = buildEndpointUrl(settings.serverUrl, '/v1/resolve', {
        url: options.url,
        downloader: options.downloader,
        token,
    });

    try {
        const res = await getGmBridge().httpRequest({
            method: 'GET',
            url: endpoint,
            timeout: 10000,
            signal: options.signal,
        });

        if (res.status === 422) {
            return null;
        }
        if (res.status !== 200) {
            const errMsg = parseErrorFromBody(res.responseText, res.status);
            throw classifyHttpError(res.status, errMsg);
        }

        const data = JSON.parse(res.responseText) as { contentKey?: string | null };
        return typeof data.contentKey === 'string' && data.contentKey ? data.contentKey : null;
    } catch (err) {
        if (err instanceof ApiError) { throw err; }
        const msg = err instanceof Error ? err.message : String(err);
        throw new ApiError(msg, 0, msg.includes('超时') ? 'timeout' : 'network');
    }
};

export type ExtractedMediaPayload =
    | { kind: 'single'; urls: string[]; rawMediaUrls: unknown[] }
    | { kind: 'live'; items: LivePhotoMediaItem[]; rawMediaUrls: unknown[] };

/**
 * 请求服务端解析或预热缓存媒体直链列表
 * 行为与移动端 MediaExtractService 对齐
 */
export const extractMediaUrls = async (options: {
    url: string;
    downloaderType: AllDownloaderType;
    useProxy: boolean;
    requestLogName?: string;
    settings?: PluginSettings;
    signal?: AbortSignal;
    taskId?: string;
}): Promise<ExtractedMediaPayload> => {
    const settings = options.settings ?? storage.getSettings();
    const logName = options.requestLogName || '解析';
    if (!normalizeServerBaseUrl(settings.serverUrl)) {
        throw new ApiError('请在设置中配置服务端地址', 0, 'unconfigured');
    }

    const token = settings.serverToken || 'default_token';
    const endpoint = buildEndpointUrl(settings.serverUrl, '/v1/extract', {
        url: options.url,
        downloader: options.downloaderType,
        token,
        useProxy: String(Boolean(options.useProxy)),
    });

    const proxyMode = options.useProxy ? '服务端代理' : '直连提取';
    logger.info(
        `发起${logName}请求（${options.downloaderType}，${proxyMode}）`,
        { taskId: options.taskId, context: options.url }
    );

    let res;
    try {
        res = await getGmBridge().httpRequest({
            method: 'GET',
            url: endpoint,
            timeout: 300000, // 与 iOS 端 300 秒长超时设定对齐
            signal: options.signal,
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`${logName}请求网络异常，${msg}`, {
            taskId: options.taskId,
            context: options.url,
        });
        throw new ApiError(msg, 0, msg.includes('超时') ? 'timeout' : 'network');
    }

    if (res.status !== 200) {
        const errMsg = parseErrorFromBody(res.responseText, res.status);
        logger.error(`服务端${logName}失败（HTTP ${res.status}），${errMsg}`, {
            taskId: options.taskId,
            context: options.url,
        });
        throw classifyHttpError(res.status, errMsg);
    }

    let json: { mediaUrls?: unknown };
    try {
        json = JSON.parse(res.responseText) as { mediaUrls?: unknown };
    } catch {
        logger.error(`服务端${logName}响应 JSON 解析失败`, {
            taskId: options.taskId,
            context: options.url,
        });
        throw new ApiError(`服务端${logName}响应格式无法解析`, 200, 'parse');
    }

    if (!Array.isArray(json.mediaUrls)) {
        logger.error(`服务端${logName}响应缺少 mediaUrls 数组`, {
            taskId: options.taskId,
            context: options.url,
        });
        throw new ApiError(`服务端${logName}响应缺少 mediaUrls 字段`, 200, 'parse');
    }

    if (options.downloaderType === '小红书实况图片下载器') {
        const items: LivePhotoMediaItem[] = [];
        for (const rawItem of json.mediaUrls) {
            if (!rawItem || typeof rawItem !== 'object') {
                throw new ApiError('「小红书实况图片下载器」响应格式错误：预期为对象数组', 200, 'parse');
            }
            const obj = rawItem as { cover?: unknown; video?: unknown };
            if (typeof obj.cover !== 'string' || !obj.cover) {
                continue;
            }
            items.push({
                cover: unescapeMediaUrl(obj.cover),
                video: typeof obj.video === 'string' && obj.video ? unescapeMediaUrl(obj.video) : '',
            });
        }
        return {
            kind: 'live',
            items,
            rawMediaUrls: json.mediaUrls,
        };
    }

    const urls: string[] = [];
    for (const rawItem of json.mediaUrls) {
        if (typeof rawItem !== 'string') {
            throw new ApiError('下载器响应解析失败：预期媒体项为字符串数组', 200, 'parse');
        }
        urls.push(unescapeMediaUrl(rawItem));
    }

    return {
        kind: 'single',
        urls,
        rawMediaUrls: json.mediaUrls,
    };
};

/**
 * 收藏记录双向增量或全量同步接口
 * 向远端推送本地变更并拉取云端更新
 */
export const syncSavedLinksApi = async (options: {
    records: SavedLinkItemAPI[];
    since?: string | null;
    settings?: PluginSettings;
    signal?: AbortSignal;
}): Promise<SavedLinksSyncResponse> => {
    const settings = options.settings ?? storage.getSettings();
    if (!normalizeServerBaseUrl(settings.serverUrl) || !settings.serverToken) {
        throw new ApiError('缺少服务端地址或服务端令牌', 0, 'unconfigured');
    }

    const endpoint = buildEndpointUrl(settings.serverUrl, '/v1/saved-links/sync', {
        token: settings.serverToken,
        since: options.since || undefined,
    });

    let res;
    try {
        res = await getGmBridge().httpRequest({
            method: 'POST',
            url: endpoint,
            headers: {
                'Content-Type': 'application/json',
            },
            data: JSON.stringify({ records: options.records }),
            timeout: 30000,
            signal: options.signal,
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new ApiError(msg, 0, msg.includes('超时') ? 'timeout' : 'network');
    }

    if (res.status !== 200) {
        const errMsg = parseErrorFromBody(res.responseText, res.status);
        throw classifyHttpError(res.status, errMsg);
    }

    try {
        const parsed = JSON.parse(res.responseText) as SavedLinksSyncResponse;
        if (!Array.isArray(parsed.records) || typeof parsed.syncedAt !== 'string') {
            throw new Error('响应缺少 records 或 syncedAt');
        }
        return parsed;
    } catch (err) {
        throw new ApiError(
            `解析收藏同步响应失败：${err instanceof Error ? err.message : String(err)}`,
            200,
            'parse'
        );
    }
};

/**
 * 下载历史记录双向增量或全量同步接口
 * 向远端推送本地记录并拉取服务端更新
 */
export const syncHistoryApi = async (options: {
    records: HistoryItemAPI[];
    since?: string | null;
    settings?: PluginSettings;
    signal?: AbortSignal;
}): Promise<HistorySyncResponse> => {
    const settings = options.settings ?? storage.getSettings();
    if (!normalizeServerBaseUrl(settings.serverUrl) || !settings.serverToken) {
        throw new ApiError('缺少服务端地址或服务端令牌', 0, 'unconfigured');
    }

    const endpoint = buildEndpointUrl(settings.serverUrl, '/v1/history/sync', {
        token: settings.serverToken,
        since: options.since || undefined,
    });

    let res;
    try {
        res = await getGmBridge().httpRequest({
            method: 'POST',
            url: endpoint,
            headers: {
                'Content-Type': 'application/json',
            },
            data: JSON.stringify({ records: options.records }),
            timeout: 30000,
            signal: options.signal,
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new ApiError(msg, 0, msg.includes('超时') ? 'timeout' : 'network');
    }

    if (res.status !== 200) {
        const errMsg = parseErrorFromBody(res.responseText, res.status);
        throw classifyHttpError(res.status, errMsg);
    }

    try {
        const parsed = JSON.parse(res.responseText) as HistorySyncResponse;
        if (!Array.isArray(parsed.records) || typeof parsed.syncedAt !== 'string') {
            throw new Error('响应缺少 records 或 syncedAt');
        }
        return parsed;
    } catch (err) {
        throw new ApiError(
            `解析历史同步响应失败：${err instanceof Error ? err.message : String(err)}`,
            200,
            'parse'
        );
    }
};

/**
 * 测试服务端连通性与鉴权配置
 * 校验本地配置格式并发送空数据同步探测, 不产生任何持久化写入或资源下载
 */
export const checkConnectionAndFeatures = async (
    customSettings?: Partial<PluginSettings>
): Promise<ConnectionCheckResult> => {
    const settings = { ...storage.getSettings(), ...customSettings };
    const items: DiagnosticCheckItem[] = [];
    try {
        const url = new URL(normalizeServerBaseUrl(settings.serverUrl));
        const isInvalid =
            !['http:', 'https:'].includes(url.protocol) ||
            Boolean(url.username || url.password || url.search || url.hash);
        if (isInvalid) {
            throw new Error('invalid URL');
        }
    } catch {
        items.push({ key: 'config', title: '服务端地址', status: 'error', detail: '请检查服务端地址' });
    }
    if (!settings.serverToken.trim()) {
        items.push({ key: 'config', title: '服务端令牌', status: 'error', detail: '未填写令牌' });
    }
    if (!items.length) {
        try {
            await syncSavedLinksApi({ records: [], since: '2099-01-01T00:00:00.000Z', settings });
            items.push({
                key: 'connection',
                title: '云端收藏读取',
                status: 'ok',
                detail: '读取检查通过，未测试写入、媒体下载或预热',
            });
        } catch (err) {
            let detail = '云端读取失败';
            if (err instanceof ApiError) {
                if (err.category === 'auth') {
                    detail = '令牌无效或权限不足';
                } else if (err.category === 'timeout') {
                    detail = '请求超时';
                } else if (err.category === 'network') {
                    detail = '无法访问服务端';
                } else if (err.category === 'parse' || err.statusCode === 404) {
                    detail = '接口地址或版本不匹配';
                } else if (err.category === 'rate_limit') {
                    detail = '请求过于频繁';
                } else if (err.category === 's3_config') {
                    detail = '云端存储不可用';
                }
            }
            items.push({ key: 'connection', title: '连接检查', status: 'error', detail });
        }
    }
    const overallOk = items.every(item => item.status === 'ok');
    const summaryContext = items.map(item => `${item.title}（${item.detail}）`).join('，');
    if (overallOk) {
        logger.info('服务端连接检查通过', { context: summaryContext });
    } else {
        logger.warn('服务端连接检查未通过', { context: summaryContext });
    }
    return { overallOk, checkedAt: toIso8601WithMs(), items };
};
