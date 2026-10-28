// src/utils.ts

import {
    LIVE_CACHE_PREFIX,
    SHORT_DOWNLOADER_NAMES,
    XHS_DOWNLOADERS
} from './constants';
import {
    AllDownloaderType,
    LivePhotoMediaItem,
    XhsDownloaderType
} from './types';

/**
 * 生成大写 UUID
 * 格式与 iOS 端原生 UUID 字符串完全对齐
 */
export const generateUUID = (): string => {
    if (
        typeof crypto !== 'undefined' &&
        typeof crypto.randomUUID === 'function'
    ) {
        return crypto.randomUUID().toUpperCase();
    }
    const bytes = new Uint8Array(16);
    if (
        typeof crypto !== 'undefined' &&
        typeof crypto.getRandomValues === 'function'
    ) {
        crypto.getRandomValues(bytes);
    } else {
        for (let i = 0; i < 16; i++) {
            bytes[i] = Math.floor(Math.random() * 256);
        }
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase();
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

/**
 * 忽略大小写判定两个记录标识是否一致
 * 防止由于大小写差异造成重复创建或找不到已有记录
 */
export const isSameId = (
    a: string | undefined | null,
    b: string | undefined | null
): boolean => {
    if (!a || !b) {
        return false;
    }
    return a.trim().toUpperCase() === b.trim().toUpperCase();
};

/**
 * 将指定时间转换为包含毫秒的 UTC ISO 8601 字符串
 * 与 iOS 原生格式化器配置对齐
 */
export const toIso8601WithMs = (
    date: Date | number | string = new Date()
): string => {
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) {
        return new Date().toISOString();
    }
    return d.toISOString();
};

/** 解析 ISO 8601 时间戳字符串为 Unix 毫秒数 */
export const parseTimestampMs = (iso: string | undefined | null): number => {
    if (!iso) {
        return 0;
    }
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? 0 : ms;
};

/**
 * 将时间戳格式化为适于界面展示的相对日期与时刻
 * 展示逻辑与移动端历史和收藏模块保持一致
 */
export const formatRelativeDate = (
    iso: string,
    now: Date = new Date()
): string => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
        return iso;
    }

    const pad = (n: number) => String(n).padStart(2, '0');
    const hhmm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;

    const todayStart = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate()
    ).getTime();
    const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
    const targetDayStart = new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate()
    ).getTime();

    if (targetDayStart === todayStart) {
        return `今天 ${hhmm}`;
    }
    if (targetDayStart === yesterdayStart) {
        return `昨天 ${hhmm}`;
    }
    if (date.getFullYear() === now.getFullYear()) {
        return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${hhmm}`;
    }
    return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${hhmm}`;
};

/** 规范化服务端 API 基地址, 移除末尾多余斜杠 */
export const normalizeServerBaseUrl = (rawUrl: string): string => {
    return (rawUrl || '').trim().replace(/\/+$/, '');
};

/**
 * 计算服务端数据空间隔离哈希
 * 依据服务端地址与访问凭证派生独立空间标识, 避免不同服务器实例数据混淆
 */
export const getServerNamespaceHash = (
    serverUrl: string,
    serverToken: string
): string => {
    const normalizedUrl = normalizeServerBaseUrl(serverUrl).toLowerCase();
    const token = (serverToken || '').trim();
    if (!normalizedUrl && !token) {
        return 'default_unconfigured';
    }
    const input = `${normalizedUrl}|${token}`;
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < input.length; i++) {
        const ch = input.charCodeAt(i);
        h1 ^= ch;
        h1 = Math.imul(h1, 0x01000193) >>> 0;
        h2 ^= ch ^ (i & 0xff);
        h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
    }
    return `ns_${h1.toString(16).padStart(8, '0')}_${h2.toString(16).padStart(8, '0')}`;
};

/**
 * 敏感信息脱敏过滤
 * 对服务端令牌以及地址参数中的安全凭证进行遮蔽
 */
export const redactSensitive = (text: string, serverToken?: string): string => {
    if (!text) {
        return '';
    }
    let result = text;

    if (serverToken && serverToken.trim().length > 0) {
        const escaped = serverToken
            .trim()
            .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        result = result.replace(new RegExp(escaped, 'g'), '***');
        const encoded = encodeURIComponent(serverToken.trim()).replace(
            /[.*+?^${}()|[\]\\]/g,
            '\\$&'
        );
        if (encoded !== escaped) {
            result = result.replace(new RegExp(encoded, 'g'), '***');
        }
    }

    // 遮蔽链接查询参数中的敏感校验字段
    result = result.replace(
        /([?&](?:token|xsec_token|access_token|signature|sign|X-Amz-Signature|X-Amz-Credential)=)([^&#\s]+)/gi,
        '$1***'
    );

    return result;
};

/** 批量提取链接的解析结果结构 */
export interface ExtractedUrlsResult {
    urls: string[];
    skippedLines: number[];
    warning?: string;
}

const LINK_PATTERN = /https?:\/\/[^\s，]+/;

/**
 * 从多行文本输入中逐行提取合法网络链接
 * 遇到不包含链接的无效行时记录行号并产生提示
 */
export const extractUrlsFromInput = (
    input: string,
    invalidLineHandling: 'ignore' | 'skipWithWarning' = 'skipWithWarning'
): ExtractedUrlsResult => {
    const lines = (input || '').split(/\r?\n/);
    const urls: string[] = [];
    const skippedLines: number[] = [];
    let warning: string | undefined;

    lines.forEach((rawLine, index) => {
        const line = rawLine.trim();
        if (!line) {
            return;
        }
        const match = line.match(LINK_PATTERN);
        if (match && match[0]) {
            urls.push(match[0]);
        } else {
            skippedLines.push(index + 1);
            if (invalidLineHandling === 'skipWithWarning') {
                warning = `第 ${index + 1} 行不包含链接，跳过`;
            }
        }
    });

    return { skippedLines, urls, warning };
};

/**
 * 判断指定下载器所属的去重识别平台
 * 与服务端内容识别规则保持同步
 */
export const getIdentityPlatform = (
    downloader: string
): 'xhs' | 'bilibili' | null => {
    if ((XHS_DOWNLOADERS as readonly string[]).includes(downloader)) {
        return 'xhs';
    }
    if (downloader === '哔哩哔哩视频下载器') {
        return 'bilibili';
    }
    return null;
};

export const isXhsDownloader = (
    downloader: string
): downloader is XhsDownloaderType => {
    return (XHS_DOWNLOADERS as readonly string[]).includes(downloader);
};

export const getShortDownloaderName = (
    downloader: AllDownloaderType
): string => {
    return SHORT_DOWNLOADER_NAMES[downloader] || downloader;
};

/**
 * 本地同步提取内容去重标识 contentKey
 * 仅用于去重判定, 不可替换原链接中包含的关键校验参数
 */
export const extractLocalContentKey = (
    rawUrl: string,
    downloader: string
): string | null => {
    const platform = getIdentityPlatform(downloader);
    if (!platform) {
        return null;
    }

    try {
        const url = new URL(rawUrl.trim());
        if (
            platform === 'xhs' &&
            (url.hostname === 'www.xiaohongshu.com' ||
                url.hostname === 'xiaohongshu.com')
        ) {
            // 兼容发现页, 笔记详情页与个人主页下属的笔记路径
            const directMatch = url.pathname.match(
                /^\/(?:explore|discovery\/item)\/([a-f\d]{24})\/?$/i
            );
            if (directMatch) {
                return `xhs:${directMatch[1].toLowerCase()}`;
            }
            const profileNoteMatch = url.pathname.match(
                /^\/user\/profile\/[a-f\d]{24}\/([a-f\d]{24})\/?$/i
            );
            if (profileNoteMatch) {
                return `xhs:${profileNoteMatch[1].toLowerCase()}`;
            }
        }
        if (
            platform === 'bilibili' &&
            ['www.bilibili.com', 'bilibili.com', 'm.bilibili.com'].includes(
                url.hostname
            )
        ) {
            const match = url.pathname.match(
                /^\/video\/(BV[0-9A-Za-z]{10})\/?$/
            );
            const page = url.searchParams.get('p') || '1';
            if (
                match &&
                /^[1-9]\d*$/.test(page) &&
                Number.isSafeInteger(Number(page))
            ) {
                return `bilibili:${match[1]}:p${Number(page)}`;
            }
        }
    } catch {
        return null;
    }
    return null;
};

/**
 * 将个人主页嵌套弹层链接规范化为标准笔记链接
 * 规范化过程中必须完整保留原有查询参数
 */
export const normalizeXhsNoteUrl = (
    rawUrl: string
): { noteId: string; url: string } | null => {
    try {
        const parsed = new URL(rawUrl, 'https://www.xiaohongshu.com');
        if (
            parsed.hostname !== 'www.xiaohongshu.com' &&
            parsed.hostname !== 'xiaohongshu.com'
        ) {
            return null;
        }

        const exploreMatch = parsed.pathname.match(
            /^\/(?:explore|discovery\/item)\/([a-f\d]{24})\/?$/i
        );
        if (exploreMatch) {
            return {
                noteId: exploreMatch[1].toLowerCase(),
                url: parsed.toString()
            };
        }

        const profileMatch = parsed.pathname.match(
            /^\/user\/profile\/[a-f\d]{24}\/([a-f\d]{24})\/?$/i
        );
        if (profileMatch) {
            const noteId = profileMatch[1].toLowerCase();
            const canonical = new URL(
                `https://www.xiaohongshu.com/explore/${noteId}`
            );
            parsed.searchParams.forEach((value, key) => {
                canonical.searchParams.set(key, value);
            });
            return {
                noteId,
                url: canonical.toString()
            };
        }
    } catch {
        return null;
    }
    return null;
};

/**
 * 反转义服务端下发的斜杠字符
 * 保持与移动端字符串处理逻辑完全对齐
 */
export const unescapeMediaUrl = (url: string): string => {
    return (url || '').replace(/\\u002F/gi, '/');
};

/**
 * 编码实况图片预热缓存载荷为特征字符串
 * 包含成对的封面图片与伴随视频地址
 */
export const encodeLiveCachedUrl = (cover: string, video: string): string => {
    const payload = {
        cover: unescapeMediaUrl(cover),
        video: unescapeMediaUrl(video || '')
    };
    return `${LIVE_CACHE_PREFIX}${JSON.stringify(payload)}`;
};

/**
 * 解码实况图片缓存特征数组为成对数据结构
 * 任一项数据格式异常则返回 null, 从而触发实时降级解析
 */
export const decodeLiveCachedUrls = (
    cachedUrls: string[]
): LivePhotoMediaItem[] | null => {
    if (!Array.isArray(cachedUrls) || cachedUrls.length === 0) {
        return null;
    }
    const result: LivePhotoMediaItem[] = [];
    for (const item of cachedUrls) {
        if (typeof item !== 'string' || !item.startsWith(LIVE_CACHE_PREFIX)) {
            return null;
        }
        const jsonPart = item.slice(LIVE_CACHE_PREFIX.length);
        try {
            const parsed = JSON.parse(jsonPart);
            if (
                !parsed ||
                typeof parsed !== 'object' ||
                typeof parsed.cover !== 'string' ||
                !parsed.cover
            ) {
                return null;
            }
            result.push({
                cover: unescapeMediaUrl(parsed.cover),
                video:
                    typeof parsed.video === 'string'
                        ? unescapeMediaUrl(parsed.video)
                        : ''
            });
        } catch {
            return null;
        }
    }
    return result;
};

/**
 * 判定媒体直链是否属于服务端对象存储所产生的持久化缓存链接
 * 校验路径特征, 排除源站原始 CDN 临时直链
 */
export const isConfirmableS3CachedUrl = (rawUrl: string): boolean => {
    if (!rawUrl || typeof rawUrl !== 'string') {
        return false;
    }
    try {
        const u = new URL(unescapeMediaUrl(rawUrl));
        const host = u.hostname.toLowerCase();
        // 排除小红书官方源站临时直链
        if (
            host.endsWith('.xhscdn.com') ||
            host === 'xhscdn.com' ||
            host.endsWith('.xiaohongshu.com') ||
            host === 'xiaohongshu.com'
        ) {
            return false;
        }
        // 服务端写入对象存储后固定包含该路径特征
        if (u.pathname.includes('/cache/')) {
            return true;
        }
        // 排除其余已知平台源站原始直链
        const rawOriginHosts = [
            'sinaimg.cn',
            'pximg.net',
            'twimg.com',
            'bilivideo.com',
            'hdslb.com',
            'miyoushe.com',
            'hoyolab.com'
        ];
        if (rawOriginHosts.some(d => host === d || host.endsWith(`.${d}`))) {
            return false;
        }
        return true;
    } catch {
        return false;
    }
};

/**
 * 校验预热响应结果是否完整写入对象存储
 * 任何资源未进入缓存均标记为未达成预热
 */
export const verifyPreheatCacheResult = (
    mediaUrls: unknown[],
    downloaderType: AllDownloaderType
): {
    confirmed: boolean;
    cachedUrls: string[];
    unconfirmedCount: number;
    reason?: string;
} => {
    if (!Array.isArray(mediaUrls) || mediaUrls.length === 0) {
        return {
            cachedUrls: [],
            confirmed: false,
            reason: '未提取到任何图片或视频链接',
            unconfirmedCount: 0
        };
    }

    const cachedUrls: string[] = [];
    let unconfirmedCount = 0;

    if (downloaderType === '小红书实况图片下载器') {
        for (const item of mediaUrls) {
            if (!item || typeof item !== 'object') {
                return {
                    cachedUrls: [],
                    confirmed: false,
                    reason: '实况图片预热响应格式异常',
                    unconfirmedCount: mediaUrls.length
                };
            }
            const obj = item as {
                cover?: string | null;
                video?: string | null;
            };
            const cover =
                typeof obj.cover === 'string'
                    ? unescapeMediaUrl(obj.cover)
                    : '';
            const video =
                typeof obj.video === 'string'
                    ? unescapeMediaUrl(obj.video)
                    : '';
            if (!cover) {
                return {
                    cachedUrls: [],
                    confirmed: false,
                    reason: '实况图片缺少封面链接',
                    unconfirmedCount: mediaUrls.length
                };
            }
            const coverCached = isConfirmableS3CachedUrl(cover);
            const videoCached = !video || isConfirmableS3CachedUrl(video);
            if (!coverCached || !videoCached) {
                unconfirmedCount++;
            }
            cachedUrls.push(encodeLiveCachedUrl(cover, video));
        }
    } else {
        for (const item of mediaUrls) {
            if (typeof item !== 'string' || !item) {
                return {
                    cachedUrls: [],
                    confirmed: false,
                    reason: '预热响应包含无效的资源链接',
                    unconfirmedCount: mediaUrls.length
                };
            }
            const clean = unescapeMediaUrl(item);
            if (!isConfirmableS3CachedUrl(clean)) {
                unconfirmedCount++;
            }
            cachedUrls.push(clean);
        }
    }

    if (unconfirmedCount > 0) {
        return {
            cachedUrls: [],
            confirmed: false,
            reason: `服务端返回了原始直链（${unconfirmedCount}/${mediaUrls.length} 个资源未写入对象存储，请检查服务端 S3 配置或网络状态）`,
            unconfirmedCount
        };
    }

    return {
        cachedUrls,
        confirmed: true,
        unconfirmedCount: 0
    };
};

/**
 * 推断媒体文件的扩展名
 * 若链接无法推断或不受支持则使用安全备选项
 */
export const inferFileExtension = (
    mediaUrl: string,
    fallback: 'jpg' | 'mp4'
): string => {
    try {
        const u = new URL(mediaUrl);
        const pathname = u.pathname;
        const lastSeg = pathname.split('/').pop() || '';
        const dotIndex = lastSeg.lastIndexOf('.');
        if (dotIndex !== -1 && dotIndex < lastSeg.length - 1) {
            const ext = lastSeg
                .slice(dotIndex + 1)
                .toLowerCase()
                .replace(/[^a-z0-9]/g, '');
            if (
                [
                    'jpg',
                    'jpeg',
                    'png',
                    'webp',
                    'gif',
                    'heic',
                    'avif',
                    'mp4',
                    'mov',
                    'm4v'
                ].includes(ext)
            ) {
                return ext;
            }
        }
    } catch {
        // 链接解析异常时直接采用回退扩展名
    }
    return fallback;
};

/**
 * 构建规范的文件保存名称
 * 保持命名有序且具备笔记唯一性, 便于文件管理与重复校验
 */
export const buildMediaFilename = (options: {
    sourceUrl: string;
    downloaderType: AllDownloaderType;
    mediaIndex: number; // 从 1 开始编号
    totalCount: number;
    mediaUrl: string;
    role?: 'image' | 'video' | 'live-cover' | 'live-video';
}): string => {
    const {
        downloaderType,
        mediaIndex,
        mediaUrl,
        role,
        sourceUrl,
        totalCount
    } = options;
    const localKey = extractLocalContentKey(sourceUrl, downloaderType);
    let noteTag = localKey ? localKey.replace(':', '-') : '';
    if (!noteTag) {
        // 尝试从短链接或路径尾部提取标识符
        try {
            const u = new URL(sourceUrl);
            const seg =
                u.pathname.replace(/\/+$/, '').split('/').pop() || 'item';
            noteTag = `xhs-${seg.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'media'}`;
        } catch {
            noteTag = 'xhs-media';
        }
    }

    const indexPad = String(mediaIndex).padStart(totalCount >= 10 ? 2 : 2, '0');
    const isVideo =
        role === 'video' ||
        role === 'live-video' ||
        downloaderType === '小红书视频下载器' ||
        downloaderType === '哔哩哔哩视频下载器' ||
        downloaderType === 'Twitter (X) 视频下载器' ||
        downloaderType === 'Pixiv 动图下载器';

    const ext = inferFileExtension(mediaUrl, isVideo ? 'mp4' : 'jpg');

    if (role === 'live-cover') {
        return `benben-${noteTag}-${indexPad}-cover.${ext}`;
    }
    if (role === 'live-video') {
        return `benben-${noteTag}-${indexPad}-live.${ext}`;
    }
    return `benben-${noteTag}-${indexPad}.${ext}`;
};
