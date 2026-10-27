// src/xhsPageAdapter.ts

import { PageNoteContext, XhsDownloaderType } from './types';
import { normalizeXhsNoteUrl } from './utils';

export interface RawNoteStateInfo {
    noteId?: string;
    title?: string;
    desc?: string;
    type?: string;
    hasVideo?: boolean;
    imageCount?: number;
    hasLivePhoto?: boolean;
    livePhotoKnown?: boolean;
}

/**
 * 从页面全局状态树中解析指定笔记的元数据
 * 纯函数实现, 便于独立单元测试
 */
export const extractNoteInfoFromInitialState = (state: unknown, targetNoteId?: string): RawNoteStateInfo | null => {
    if (!state || typeof state !== 'object') { return null; }
    const noteRoot = (state as { note?: Record<string, unknown> }).note;
    if (!noteRoot || typeof noteRoot !== 'object') { return null; }

    const detailMap = noteRoot.noteDetailMap as Record<string, { note?: Record<string, unknown> }> | undefined;
    let noteObj: Record<string, unknown> | undefined;

    if (detailMap && typeof detailMap === 'object') {
        if (targetNoteId) {
            const exact =
                detailMap[targetNoteId] ||
                Object.entries(detailMap).find(([k]) => k.toLowerCase() === targetNoteId.toLowerCase())?.[1];
            noteObj = exact?.note;
        } else {
            const firstId = typeof noteRoot.firstNoteId === 'string' ? noteRoot.firstNoteId : undefined;
            if (firstId && detailMap[firstId]?.note) {
                noteObj = detailMap[firstId].note;
            } else {
                const firstEntry = Object.values(detailMap).find(v => v && typeof v.note === 'object');
                noteObj = firstEntry?.note;
            }
        }
    }

    if (!noteObj || typeof noteObj !== 'object') { return null; }

    const noteId =
        (typeof noteObj.noteId === 'string' && noteObj.noteId) ||
        (typeof noteObj.id === 'string' && noteObj.id) ||
        targetNoteId;
    const title = typeof noteObj.title === 'string' ? noteObj.title.trim() : '';
    const desc = typeof noteObj.desc === 'string' ? noteObj.desc.trim() : '';
    const type = typeof noteObj.type === 'string' ? noteObj.type : undefined;

    const videoObj = noteObj.video as Record<string, unknown> | undefined;
    const hasVideo = Boolean(
        type === 'video' ||
        (videoObj && (videoObj.media || videoObj.stream || videoObj.mediaV2))
    );

    const imageList = Array.isArray(noteObj.imageList) ? noteObj.imageList : [];
    let hasLivePhoto = false;
    let livePhotoKnown = false;

    if (imageList.length > 0) {
        livePhotoKnown = imageList.some(
            img => img && typeof img === 'object' && ('livePhoto' in img || 'stream' in img)
        );
        hasLivePhoto = imageList.some(img => {
            if (!img || typeof img !== 'object') { return false; }
            const rec = img as Record<string, unknown>;
            return Boolean(rec.livePhoto || rec.stream);
        });
    }

    return {
        noteId,
        title: title || desc.slice(0, 36),
        desc,
        type,
        hasVideo,
        imageCount: imageList.length,
        hasLivePhoto,
        livePhotoKnown,
    };
};

/**
 * 依据笔记内部数据与界面特征综合推导下载器分类
 * 当无法达到高置信度时返回 null 由用户人工裁决, 杜绝静默分类失误
 */
export const determineXhsDownloaderType = (input: {
    stateInfo?: RawNoteStateInfo | null;
    domSignals?: {
        hasVideoPlayer: boolean;
        hasLiveBadge: boolean;
        hasImageCarousel: boolean;
    };
}): { downloader: XhsDownloaderType | null; reason: string } => {
    const { stateInfo, domSignals } = input;

    // 优先依据页面初始状态数据精确识别
    if (stateInfo) {
        if (stateInfo.hasVideo) {
            return {
                downloader: '小红书视频下载器',
                reason: '已识别为视频笔记',
            };
        }
        if (stateInfo.hasLivePhoto) {
            return {
                downloader: '小红书实况图片下载器',
                reason: '已识别包含实况图片',
            };
        }
        if (
            (stateInfo.type === 'normal' || (stateInfo.imageCount ?? 0) > 0) &&
            stateInfo.livePhotoKnown
        ) {
            return {
                downloader: '小红书图片下载器',
                reason: `已识别为图文笔记 (${stateInfo.imageCount} 张)`,
            };
        }
    }

    // 结合页面 DOM 视觉组件标记辅助推断
    if (domSignals) {
        if (domSignals.hasLiveBadge) {
            return {
                downloader: '小红书实况图片下载器',
                reason: '已从页面实况标识识别为实况图片',
            };
        }
        if (domSignals.hasVideoPlayer && !domSignals.hasImageCarousel) {
            return {
                downloader: '小红书视频下载器',
                reason: '已从页面视频播放器识别为视频笔记',
            };
        }
        if (domSignals.hasImageCarousel && stateInfo?.type === 'normal' && !domSignals.hasLiveBadge) {
            return {
                downloader: '小红书图片下载器',
                reason: '已识别为图文笔记',
            };
        }
    }

    // 无法精准区分时交付用户显式决定
    return {
        downloader: null,
        reason: '未能可靠判断媒体类型，请手动选择「图片 / 视频 / 实况」',
    };
};

/**
 * 从页面地址栏与 DOM 节点中补全可直接请求的完整笔记地址
 * 包含参数找回与浮层弹窗场景识别
 */
export const resolveFullNoteUrlFromPage = (
    locationHref: string,
    doc?: Document
): { noteId: string; url: string; viewMode: 'standalone' | 'modal' } | null => {
    const normalizedFromLoc = normalizeXhsNoteUrl(locationHref);

    const noteContainer = doc
        ? (doc.querySelector('#noteContainer, .note-container, .note-detail-mask') as HTMLElement | null)
        : null;

    let isModal: boolean;
    try {
        const locUrl = new URL(locationHref);
        const isProfilePath = /^\/user\/profile\/[a-f\d]{24}\/[a-f\d]{24}/i.test(locUrl.pathname);
        const hasModalMask = Boolean(
            doc?.querySelector('.note-detail-mask, .close-circle, .close-box, [class*="note-detail-mask"]')
        );
        isModal = isProfilePath || hasModalMask;
    } catch {
        isModal = false;
    }

    if (normalizedFromLoc) {
        let finalUrl = normalizedFromLoc.url;
        // 若地址栏缺少鉴权参数则尝试从对应卡片链接找回
        if (doc && !finalUrl.includes('xsec_token=')) {
            const anchor = doc.querySelector(
                `a[href*="${normalizedFromLoc.noteId}"][href*="xsec_token="]`
            ) as HTMLAnchorElement | null;
            if (anchor) {
                const rawHref = anchor.getAttribute('href') || anchor.href;
                const recovered = normalizeXhsNoteUrl(rawHref);
                if (recovered && recovered.url.includes('xsec_token=')) {
                    finalUrl = recovered.url;
                }
            }
        }
        return {
            noteId: normalizedFromLoc.noteId,
            url: finalUrl,
            viewMode: isModal ? 'modal' : 'standalone',
        };
    }

    // 处理地址栏尚未更新但弹层已打开的情形
    if (doc && noteContainer) {
        const activeLink = doc.querySelector(
            'a[href*="/explore/"][href*="xsec_token="], a[href*="/discovery/item/"][href*="xsec_token="]'
        ) as HTMLAnchorElement | null;
        if (activeLink) {
            const candidate = normalizeXhsNoteUrl(activeLink.getAttribute('href') || activeLink.href);
            if (candidate) {
                return {
                    noteId: candidate.noteId,
                    url: candidate.url,
                    viewMode: 'modal',
                };
            }
        }
    }

    return null;
};

declare const unsafeWindow: (Window & { __INITIAL_STATE__?: unknown }) | undefined;

type NoteContextChangeListener = (ctx: PageNoteContext | null) => void;

/**
 * 小红书页面状态与路由监听适配器
 * 负责监听页面 DOM 突变, 单页路由跳转以及提取当前可见笔记上下文
 */
export class XhsPageAdapter {
    private currentContext: PageNoteContext | null = null;
    private manualTypeOverrides = new Map<string, XhsDownloaderType>();
    private listeners = new Set<NoteContextChangeListener>();
    private observer: MutationObserver | null = null;
    private checkTimer: ReturnType<typeof setTimeout> | null = null;

    public start(): void {
        if (typeof window === 'undefined' || typeof document === 'undefined') { return; }

        this.hookHistoryNavigation();
        this.observer = new MutationObserver(() => {
            this.scheduleCheck(150);
        });
        this.observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
        });

        this.evaluateCurrentPage();
    }

    public stop(): void {
        this.observer?.disconnect();
        this.observer = null;
        if (this.checkTimer) {
            clearTimeout(this.checkTimer);
            this.checkTimer = null;
        }
    }

    public onContextChange(cb: NoteContextChangeListener): () => void {
        this.listeners.add(cb);
        return () => {
            this.listeners.delete(cb);
        };
    }

    public getCurrentContext(): PageNoteContext | null {
        return this.currentContext;
    }

    /** 记录用户针对当前笔记手动指定的下载器选项 */
    public setManualDownloaderForCurrentNote(downloader: XhsDownloaderType): void {
        if (!this.currentContext) { return; }
        this.manualTypeOverrides.set(this.currentContext.noteId, downloader);
        this.currentContext = {
            ...this.currentContext,
            selectedDownloader: downloader,
        };
        this.emitContext();
    }

    public getEffectiveDownloader(ctx: PageNoteContext | null = this.currentContext): XhsDownloaderType | null {
        if (!ctx) { return null; }
        return ctx.selectedDownloader || ctx.detectedDownloader;
    }

    public scheduleCheck(delayMs = 100): void {
        if (this.checkTimer) {
            clearTimeout(this.checkTimer);
        }
        this.checkTimer = setTimeout(() => {
            this.checkTimer = null;
            this.evaluateCurrentPage();
        }, delayMs);
    }

    public evaluateCurrentPage(): PageNoteContext | null {
        if (typeof window === 'undefined' || typeof document === 'undefined') {
            return null;
        }

        const host = window.location.hostname.toLowerCase();
        if (host !== 'www.xiaohongshu.com' && host !== 'xiaohongshu.com') {
            this.updateContext(null);
            return null;
        }

        const resolved = resolveFullNoteUrlFromPage(window.location.href, document);
        if (!resolved) {
            this.updateContext(null);
            return null;
        }

        const pageState = this.readPageInitialState();
        const stateInfo = extractNoteInfoFromInitialState(pageState, resolved.noteId);
        const domSignals = this.inspectNoteDomSignals();
        const detection = determineXhsDownloaderType({ stateInfo, domSignals });

        const domTitle =
            (
                document.querySelector(
                    '#detail-title, .note-content .title, #noteContainer .title'
                ) as HTMLElement | null
            )?.textContent?.trim() || '';

        const title = stateInfo?.title || domTitle || `笔记 ${resolved.noteId.slice(0, 8)}`;
        const override = this.manualTypeOverrides.get(resolved.noteId) ?? null;

        const nextCtx: PageNoteContext = {
            noteId: resolved.noteId,
            url: resolved.url,
            title,
            viewMode: resolved.viewMode,
            detectedDownloader: detection.downloader,
            detectionReason: detection.reason,
            selectedDownloader: override,
        };

        this.updateContext(nextCtx);
        return nextCtx;
    }

    private readPageInitialState(): unknown {
        try {
            if (typeof unsafeWindow !== 'undefined' && unsafeWindow?.__INITIAL_STATE__) {
                return unsafeWindow.__INITIAL_STATE__;
            }
            const win = window as Window & { __INITIAL_STATE__?: unknown };
            if (win.__INITIAL_STATE__) {
                return win.__INITIAL_STATE__;
            }
        } catch {
            // 忽略跨上下文读取受限时的异常
        }
        return null;
    }

    private inspectNoteDomSignals(): {
        hasVideoPlayer: boolean;
        hasLiveBadge: boolean;
        hasImageCarousel: boolean;
        } {
        const scope =
            (document.querySelector('#noteContainer, .note-container, .note-detail-mask') as ParentNode | null) ||
            document;

        const hasLiveBadge = Boolean(
            scope.querySelector(
                '.live-photo-contain, [class*="live-photo"], [class*="livePhoto"], [data-live-photo="true"]'
            )
        );

        const hasVideoPlayer = Boolean(
            scope.querySelector(
                '.player-container video, .xgplayer video, [class*="video-player"] video, .media-container video'
            ) && !hasLiveBadge
        );

        const hasImageCarousel = Boolean(
            scope.querySelector(
                '.note-slider-img, .swiper-slide img, .media-container img, [class*="slider"] img'
            )
        );

        return {
            hasVideoPlayer,
            hasLiveBadge,
            hasImageCarousel,
        };
    }

    private updateContext(next: PageNoteContext | null): void {
        const prev = this.currentContext;
        const isUnchanged =
            prev?.noteId === next?.noteId &&
            prev?.url === next?.url &&
            prev?.viewMode === next?.viewMode &&
            prev?.detectedDownloader === next?.detectedDownloader &&
            prev?.selectedDownloader === next?.selectedDownloader &&
            prev?.title === next?.title;

        if (isUnchanged) { return; }
        this.currentContext = next;
        this.emitContext();
    }

    private emitContext(): void {
        for (const cb of this.listeners) {
            try {
                cb(this.currentContext);
            } catch {
                // 忽略外部事件通知异常
            }
        }
    }

    private hookHistoryNavigation(): void {
        const origPush = history.pushState;
        const origReplace = history.replaceState;

        history.pushState = (...args) => {
            const res = origPush.apply(history, args);
            this.scheduleCheck(60);
            return res;
        };

        history.replaceState = (...args) => {
            const res = origReplace.apply(history, args);
            this.scheduleCheck(60);
            return res;
        };

        window.addEventListener('popstate', () => {
            this.scheduleCheck(60);
        });
    }
}

export const xhsPageAdapter = new XhsPageAdapter();
