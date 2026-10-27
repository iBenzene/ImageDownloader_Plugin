// src/ui/helpers.ts

import { XHS_DOWNLOADERS } from '../constants';
import { LogLevel, SavedLinkItem, TaskItem, XhsDownloaderType } from '../types';
import { formatRelativeDate, getShortDownloaderName, isXhsDownloader } from '../utils';

export const escapeHtml = (str: string | undefined | null): string => {
    if (!str) { return ''; }
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
};

/** 兼容旧任务文案, 仅调整插件生成的前缀和已废弃提示 */
export const formatTaskTitle = (title: string): string => title
    .replace(/^(收藏|下载|下载收藏|预热收藏|重新下载):\s*/, '$1：')
    .replace(/^(批量收藏|批量下载|预热收藏资源|收藏) \((\d+ 个链接)\)$/, '$1（$2）');

export const formatTaskMessage = (task: TaskItem): string => {
    if (task.type !== 'save' || task.status !== 'completed') { return task.message || ''; }
    const warning = task.identityCheckIncomplete
        ? '，部分新链接未能识别内容，已按链接收藏，可能存在重复'
        : '';
    return `已保存 ${task.urls.length} 个链接${warning}`;
};

/** 根据平台类型匹配专属徽章样式类名 */
export const getPlatformBadgeClass = (downloaderType: string | undefined | null): string => {
    if (!downloaderType) { return 'bb-badge-platform-default'; }
    if (downloaderType.includes('小红书')) { return 'bb-badge-platform-xhs'; }
    if (downloaderType.includes('微博')) { return 'bb-badge-platform-wb'; }
    if (downloaderType.includes('哔哩哔哩') || downloaderType.includes('bilibili')) { return 'bb-badge-platform-bili'; }
    if (downloaderType.includes('Pixiv') || downloaderType.includes('pixiv')) { return 'bb-badge-platform-pixiv'; }
    if (downloaderType.includes('Twitter') || downloaderType.includes('(X)')) { return 'bb-badge-platform-x'; }
    if (downloaderType.includes('米游社')) { return 'bb-badge-platform-mys'; }
    return 'bb-badge-platform-default';
};

/**
 * 渲染收藏项的三类独立状态徽标
 * 分别呈现云端同步状态, 预热与缓存状态, 以及本机下载落地状态
 */
export const renderSavedItemBadges = (item: SavedLinkItem): string => {
    const shortName = escapeHtml(getShortDownloaderName(item.downloaderType));
    const supported = isXhsDownloader(item.downloaderType);
    const platformClass = getPlatformBadgeClass(item.downloaderType);

    // 同步状态徽标
    const syncBadge = item.isDirty
        ? '<span class="bb-badge bb-badge-warn" title="本地修改尚未同步至服务端">待同步</span>'
        : '<span class="bb-badge" title="已与云端同步">已同步</span>';

    // 预热与云端缓存状态徽标
    const hasCachedUrls = Array.isArray(item.cachedUrls) && item.cachedUrls.length > 0;
    let preheatBadge = '<span class="bb-badge">未预热</span>';
    if (item.preheatState === 'preheating') {
        preheatBadge = '<span class="bb-badge bb-badge-warn">预热中...</span>';
    } else if (item.preheatState === 'failed') {
        const errTip = escapeHtml(item.preheatError || '预热失败');
        preheatBadge = `<span class="bb-badge bb-badge-error" title="${errTip}">预热失败</span>`;
    } else if (item.preheatState === 'preheated' && hasCachedUrls) {
        const count = item.cachedUrls!.length;
        preheatBadge =
            `<span class="bb-badge bb-badge-info" title="已预热 ${count} 个资源">预热成功（${count}）</span>`;
    } else if (hasCachedUrls) {
        const count = item.cachedUrls!.length;
        preheatBadge =
            `<span class="bb-badge bb-badge-info" title="云端已有缓存 ${count} 个资源">已有缓存（${count}）</span>`;
    }

    // 下载结果状态徽标
    let downloadBadge = '<span class="bb-badge">未下载</span>';
    if (item.status === 'success') {
        downloadBadge = '<span class="bb-badge bb-badge-ok">已下载</span>';
    } else if (item.status === 'failure') {
        downloadBadge = '<span class="bb-badge bb-badge-error">下载失败</span>';
    }

    const platformBadge = supported
        ? `<span class="bb-badge ${platformClass}">${shortName}</span>`
        : `<span class="bb-badge ${platformClass}" title="仅支持小红书下载，其他平台记录仅供查看">${shortName}（仅查看）</span>`;

    return `${platformBadge}${syncBadge}${preheatBadge}${downloadBadge}`;
};

export const renderTaskStatusBadge = (task: TaskItem): string => {
    switch (task.status) {
        case 'pending':
            return '<span class="bb-badge">等待中</span>';
        case 'running':
            return '<span class="bb-badge bb-badge-warn">运行中</span>';
        case 'completed':
            return '<span class="bb-badge bb-badge-ok">已完成</span>';
        case 'failed':
            return '<span class="bb-badge bb-badge-error">失败</span>';
        case 'cancelled':
            return '<span class="bb-badge">已取消</span>';
        case 'interrupted':
            return '<span class="bb-badge bb-badge-warn" title="页面刷新或关闭导致状态未确认，未自动重新下载">已中断/待确认</span>';
        default:
            return `<span class="bb-badge">${escapeHtml(task.status)}</span>`;
    }
};

export const renderTaskTypeLabel = (type: TaskItem['type']): string => {
    switch (type) {
        case 'save':
            return '收藏';
        case 'preheat':
            return '预热';
        case 'download':
            return '下载';
        case 'sync':
            return '同步';
    }
};

export const renderLogLevelBadge = (level: LogLevel): string => {
    switch (level) {
        case LogLevel.Debug:
            return '<span class="bb-badge">调试</span>';
        case LogLevel.Info:
            return '<span class="bb-badge bb-badge-accent">信息</span>';
        case LogLevel.Warn:
            return '<span class="bb-badge bb-badge-warn">警告</span>';
        case LogLevel.Error:
            return '<span class="bb-badge bb-badge-error">错误</span>';
        default:
            return '<span class="bb-badge">信息</span>';
    }
};

export const renderTypePillsHtml = (activeType: XhsDownloaderType | null, needsChoice: boolean): string => {
    const shortLabels: Record<XhsDownloaderType, string> = {
        '小红书图片下载器': '图片',
        '小红书视频下载器': '视频',
        '小红书实况图片下载器': '实况',
    };

    const buttons = XHS_DOWNLOADERS.map(t => {
        const isAct = activeType === t ? 'is-active' : '';
        const dl = escapeHtml(t);
        return (
            `<button type="button" class="bb-type-pill ${isAct}" ` +
            `data-action="select-note-type" data-downloader="${dl}">${shortLabels[t]}</button>`
        );
    }).join('');

    const groupCls = needsChoice ? 'bb-needs-choice' : '';
    const tip = needsChoice
        ? '未能自动确认媒体类型，请手动选择后再操作'
        : '当前识别类型（可点击切换）';
    return `<div class="bb-entry-type-group ${groupCls}" title="${tip}">${buttons}</div>`;
};

export { formatRelativeDate };
