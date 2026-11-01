// src/bilibiliPageAdapter.ts

import { PageNoteContext, SupportedDownloaderType } from './types';
import { XhsPageAdapter } from './xhsPageAdapter';

/** 提取 B 站普通视频详情页标准链接, 保留分 P 参数并剔除分享追踪参数 */
export const resolveBilibiliVideoUrl = (
    href: string
): { noteId: string; url: string } | null => {
    try {
        const url = new URL(href);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') {
            return null;
        }
        if (
            !['www.bilibili.com', 'bilibili.com', 'm.bilibili.com'].includes(
                url.hostname
            )
        ) {
            return null;
        }
        const match = url.pathname.match(
            /^\/video\/(BV[0-9A-Za-z]{10}|av[1-9]\d*)\/?$/
        );
        if (!match) {
            return null;
        }
        const page = url.searchParams.get('p') ?? '1';
        if (!/^[1-9]\d*$/.test(page) || !Number.isSafeInteger(Number(page))) {
            return null;
        }
        const part = Number(page);
        return {
            noteId: `${match[1]}:p${part}`,
            url: `https://www.bilibili.com/video/${match[1]}/${part > 1 ? `?p=${part}` : ''}`
        };
    } catch {
        return null;
    }
};

/** B 站视频页上下文监听与提取 */
export class BilibiliPageAdapter extends XhsPageAdapter {
    public override evaluateCurrentPage(): PageNoteContext | null {
        if (typeof window === 'undefined' || typeof document === 'undefined') {
            return null;
        }
        const resolved = resolveBilibiliVideoUrl(window.location.href);
        if (!resolved) {
            this.updateContext(null);
            return null;
        }
        const title = document
            .querySelector('h1.video-title, .video-info-title, h1')
            ?.textContent?.trim();
        const context: PageNoteContext = {
            ...resolved,
            detectedDownloader: '哔哩哔哩视频下载器',
            detectionReason: '已识别为哔哩哔哩视频',
            selectedDownloader: null,
            title: title || `哔哩哔哩视频 ${resolved.noteId}`,
            viewMode: 'standalone'
        };
        this.updateContext(context);
        return context;
    }

    public override setManualDownloaderForCurrentNote(
        _downloader: SupportedDownloaderType
    ): void {
        // B 站仅支持单一视频下载器, 忽略手动切换
        void _downloader;
    }
}
