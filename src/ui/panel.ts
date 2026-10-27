// src/ui/panel.ts

import { checkConnectionAndFeatures } from '../api';
import { getGmBridge } from '../gmAdapter';
import { historyManager } from '../history';
import { logger } from '../logger';
import { savedLinksManager } from '../savedLinks';
import { storage } from '../storage';
import { syncCoordinator } from '../sync';
import { taskQueue } from '../taskQueue';
import {
    ConnectionCheckResult,
    LogLevel,
    PageNoteContext,
    PluginSettings,
    TaskType,
    XhsDownloaderType,
} from '../types';
import { extractUrlsFromInput, isXhsDownloader } from '../utils';
import { xhsPageAdapter } from '../xhsPageAdapter';
import { EntryPositionState, observeEntryPosition, positionEntryBar, resetEntryPosition } from './entryPosition';
import {
    escapeHtml,
    formatRelativeDate,
    getPlatformBadgeClass,
    renderLogLevelBadge,
    renderSavedItemBadges,
    renderTaskStatusBadge,
    renderTaskTypeLabel,
    renderTypePillsHtml,
} from './helpers';
import { SHADOW_STYLES } from './styles';

type ActiveViewTab = 'saved' | 'tasks' | 'history' | 'settings' | 'logs';

/**
 * 插件视图与交互控制中心
 * 负责 Shadow DOM 挂载, 页面浮层条定位, 多标签页切换及用户操作响应
 */
export class BenbenPluginUI {
    private hostEl: HTMLElement | null = null;
    private shadowRoot: ShadowRoot | null = null;
    private isPanelOpen = false;
    private activeTab: ActiveViewTab = 'saved';
    private savedKeyword = '';
    private historyKeyword = '';
    private taskFilter: TaskType | 'all' = 'all';
    private logKeyword = '';
    private showBatchInput = false;
    private batchInputText = '';
    private diagnosticResult: ConnectionCheckResult | null = null;
    private isRunningDiagnostics = false;
    private settingsDraft: PluginSettings | null = null;
    private settingsSaved = false;
    private entryPosition: EntryPositionState = {};
    private confirmationModal: {
        title: string;
        message: string;
        impactWarning?: string;
        confirmText: string;
        onConfirm: () => void;
    } | null = null;
    private duplicatePrompt: {
        urls: string[];
        downloader: XhsDownloaderType;
        details: string;
        incomplete: boolean;
        resolvedKeys: Record<string, string>;
    } | null = null;

    public init(): void {
        if (typeof document === 'undefined') { return; }
        if (document.getElementById('benben-xhs-host')) { return; }

        this.hostEl = document.createElement('div');
        this.hostEl.id = 'benben-xhs-host';
        this.hostEl.setAttribute('data-platform', this.detectPlatform());
        this.shadowRoot = this.hostEl.attachShadow({ mode: 'open' });

        const styleEl = document.createElement('style');
        styleEl.textContent = SHADOW_STYLES;
        this.shadowRoot.appendChild(styleEl);

        const container = document.createElement('div');
        container.className = 'bb-container';
        this.shadowRoot.appendChild(container);

        document.body.appendChild(this.hostEl);

        this.detectTheme();
        if (this.hostEl && !this.hostEl.hasAttribute('data-platform')) {
            this.hostEl.setAttribute('data-platform', this.detectPlatform());
        }
        this.bindEvents();
        observeEntryPosition(this.shadowRoot, this.entryPosition);

        storage.subscribe(() => this.render());
        xhsPageAdapter.onContextChange(() => this.render());

        this.render();
    }

    private detectTheme(): void {
        if (!this.hostEl) { return; }
        const isDark =
            document.documentElement.getAttribute('data-theme') === 'dark' ||
            document.body.classList.contains('dark') ||
            (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
        if (isDark) {
            this.hostEl.setAttribute('data-theme', 'dark');
        } else {
            this.hostEl.removeAttribute('data-theme');
        }
    }

    private detectPlatform(): string {
        const host = typeof window !== 'undefined' ? window.location.hostname.toLowerCase() : '';
        if (host.includes('xiaohongshu.com') || host.includes('xhslink.com') || host.includes('xhslink.cn')) {
            return 'xhs';
        }
        if (host.includes('weibo.com') || host.includes('weibo.cn')) {
            return 'wb';
        }
        if (host.includes('bilibili.com')) {
            return 'bili';
        }
        if (host.includes('pixiv.net')) {
            return 'pixiv';
        }
        if (host.includes('twitter.com') || host.includes('x.com')) {
            return 'x';
        }
        if (host.includes('miyoushe.com') || host.includes('hoyolab.com')) {
            return 'mys';
        }
        return 'xhs';
    }

    private bindEvents(): void {
        const captureSettings = (e: Event) => {
            const form = (e.target as HTMLElement).closest<HTMLFormElement>('form[data-form="settings"]');
            if (!form) { return; }
            this.settingsDraft = this.readSettingsForm(form);
            this.settingsSaved = false;
            this.diagnosticResult = null;
        };
        this.shadowRoot?.addEventListener('input', captureSettings);
        this.shadowRoot?.addEventListener('change', captureSettings);
        this.shadowRoot?.addEventListener('submit', e => {
            const form = e.target as HTMLFormElement;
            if (!form.matches('form[data-form="settings"]')) { return; }
            e.preventDefault();
            const settings = this.readSettingsForm(form);
            this.settingsDraft = settings;
            storage.saveSettings(settings);
            this.settingsDraft = null;
            this.settingsSaved = true;
            this.render();
        });
        if (typeof window !== 'undefined') {
            window.addEventListener('keydown', e => {
                if (e.key === 'Escape' && this.isPanelOpen) {
                    this.closePanel();
                }
            });
            window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => {
                this.detectTheme();
                if (this.hostEl && !this.hostEl.hasAttribute('data-platform')) {
                    this.hostEl.setAttribute('data-platform', this.detectPlatform());
                }
            });
        }

        this.shadowRoot?.addEventListener('click', e => {
            const target = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
            if (!target) { return; }
            const action = target.getAttribute('data-action');
            this.handleAction(action, target);
        });
    }

    private readSettingsForm(form: HTMLFormElement): PluginSettings {
        const data = new FormData(form);
        return {
            ...storage.getSettings(),
            serverUrl: String(data.get('serverUrl') ?? '').trim(),
            serverToken: String(data.get('serverToken') ?? '').trim(),
            serverSideProxy: data.has('serverSideProxy'),
            preheatResources: data.has('preheatResources'),
            incrementalSync: data.has('incrementalSync'),
            defaultAction: data.get('defaultAction') === 'save' ? 'save' : 'download',
            logDisplayLevel: Number(data.get('logDisplayLevel')) as LogLevel,
        };
    }

    public openPanel(tab: ActiveViewTab = 'saved'): void {
        this.isPanelOpen = true;
        this.activeTab = tab;
        this.render();
        if (tab === 'saved' || tab === 'history') {
            void syncCoordinator.syncNow({ reason: 'open_panel' });
        }
    }

    public closePanel(): void {
        this.isPanelOpen = false;
        this.confirmationModal = null;
        this.duplicatePrompt = null;
        this.render();
    }

    private render(): void {
        if (!this.shadowRoot) { return; }
        const container = this.shadowRoot.querySelector('.bb-container');
        if (!container) { return; }

        this.detectTheme();
        if (this.hostEl && !this.hostEl.hasAttribute('data-platform')) {
            this.hostEl.setAttribute('data-platform', this.detectPlatform());
        }
        const ctx = xhsPageAdapter.getCurrentContext();
        resetEntryPosition(this.entryPosition, ctx ? `${ctx.noteId}:${ctx.viewMode}` : undefined);
        const settings = storage.getSettings();
        const syncStatus = syncCoordinator.getSyncStatus();

        const entryBarHtml = this.renderEntryBar(ctx, settings);
        const panelHtml = this.renderPanel(ctx, settings, syncStatus);

        container.innerHTML = `
      ${entryBarHtml}
      <div class="bb-backdrop ${this.isPanelOpen ? 'is-open' : ''}" data-action="close-panel"></div>
      ${panelHtml}
    `;
        const bar = container.querySelector<HTMLElement>('.bb-entry-bar');
        if (bar && !bar.hidden) { positionEntryBar(bar, document, window, this.entryPosition); }
    }

    private renderEntryBar(ctx: PageNoteContext | null, settings: PluginSettings): string {
        if (!ctx) { return '<div class="bb-entry-bar" hidden></div>'; }

        const effectiveType = xhsPageAdapter.getEffectiveDownloader(ctx);
        const needsChoice = !effectiveType;
        const typePills = renderTypePillsHtml(effectiveType, needsChoice);

        const isPrimaryDownload = settings.defaultAction === 'download';
        const primaryLabel = isPrimaryDownload ? '下载媒体' : '收藏链接';
        const secondaryLabel = isPrimaryDownload ? '收藏' : '下载';
        const primaryAction = isPrimaryDownload ? 'entry-download' : 'entry-save';
        const secondaryAction = isPrimaryDownload ? 'entry-save' : 'entry-download';

        const activeTask = taskQueue.getActiveTaskForUrl(ctx.url);
        const taskRunning = Boolean(activeTask);
        const statusMsg = activeTask ? activeTask.message : ctx.detectionReason;
        const disabledAttr = taskRunning ? 'disabled' : '';

        return `
      <div class="bb-entry-bar" role="region" aria-label="苯苯存图当前笔记操作栏">
        <span class="bb-entry-drag" title="拖动工具条" aria-label="拖动工具条">
          <svg width="12" height="18" viewBox="0 0 12 18" fill="currentColor" aria-hidden="true">
            <circle cx="3" cy="3" r="1.5"/><circle cx="9" cy="3" r="1.5"/>
            <circle cx="3" cy="9" r="1.5"/><circle cx="9" cy="9" r="1.5"/>
            <circle cx="3" cy="15" r="1.5"/><circle cx="9" cy="15" r="1.5"/>
          </svg>
        </span>
        ${typePills}
        <button type="button" class="bb-btn bb-btn-primary bb-btn-sm" data-action="${primaryAction}" ${disabledAttr}>
          ${primaryLabel}
        </button>
        <button type="button" class="bb-btn bb-btn-sm" data-action="${secondaryAction}" ${disabledAttr}>
          ${secondaryLabel}
        </button>
        <button type="button" class="bb-btn bb-btn-sm" data-action="open-panel" title="打开客户端面板">
          更多
        </button>
        <span class="bb-entry-status ${needsChoice ? 'is-warn' : ''}" title="${escapeHtml(statusMsg)}">
          ${escapeHtml(statusMsg)}
        </span>
      </div>
    `;
    }

    private renderPanel(
        ctx: PageNoteContext | null,
        settings: PluginSettings,
        syncStatus: ReturnType<typeof syncCoordinator.getSyncStatus>
    ): string {
        const isDirty = syncStatus.dirtySavedCount > 0 || syncStatus.dirtyHistoryCount > 0;
        const syncPillClass = syncStatus.lastError ? 'is-error' : isDirty ? 'is-dirty' : '';
        const syncPillText = syncStatus.isSyncing
            ? '同步中...'
            : syncStatus.lastError
                ? '同步失败'
                : isDirty
                    ? `待同步 (${syncStatus.dirtySavedCount + syncStatus.dirtyHistoryCount})`
                    : '已同步';

        let contentHtml = '';
        switch (this.activeTab) {
            case 'saved':
                contentHtml = this.renderSavedTab();
                break;
            case 'tasks':
                contentHtml = this.renderTasksTab();
                break;
            case 'history':
                contentHtml = this.renderHistoryTab();
                break;
            case 'settings':
                contentHtml = this.renderSettingsTab(settings);
                break;
            case 'logs':
                contentHtml = this.renderLogsTab();
                break;
        }

        const panelCls = this.isPanelOpen ? 'is-open' : '';
        const settingsAct = this.activeTab === 'settings' ? 'is-active' : '';
        const logsAct = this.activeTab === 'logs' ? 'is-active' : '';
        const savedAct = this.activeTab === 'saved' ? 'is-active' : '';
        const tasksAct = this.activeTab === 'tasks' ? 'is-active' : '';
        const historyAct = this.activeTab === 'history' ? 'is-active' : '';

        return `
      <div class="bb-panel ${panelCls}" role="dialog" aria-modal="true" aria-label="苯苯存图浏览器客户端">
        <div class="bb-panel-header">
          <div class="bb-panel-title-wrap">
            <h2 class="bb-panel-title">苯苯存图</h2>
            <span class="bb-sync-pill ${syncPillClass}" title="云端同步状态">${syncPillText}</span>
          </div>
          <div class="bb-header-actions">
            <button type="button" class="bb-icon-btn" data-action="trigger-sync" title="立即同步云端数据">刷新</button>
            <button type="button" class="bb-icon-btn ${settingsAct}"
              data-action="nav-tab" data-tab="settings" title="设置">设置</button>
            <button type="button" class="bb-icon-btn ${logsAct}"
              data-action="nav-tab" data-tab="logs" title="查看日志">日志</button>
            <button type="button" class="bb-icon-btn" data-action="close-panel" title="关闭面板 (Esc)">✕</button>
          </div>
        </div>

        ${this.renderCurrentBox(ctx)}

        <nav class="bb-nav-tabs">
          <button type="button" class="bb-tab-btn ${savedAct}" data-action="nav-tab" data-tab="saved">收藏</button>
          <button type="button" class="bb-tab-btn ${tasksAct}" data-action="nav-tab" data-tab="tasks">任务</button>
          <button type="button" class="bb-tab-btn ${historyAct}" data-action="nav-tab" data-tab="history">历史</button>
        </nav>

        <div class="bb-panel-body">
          ${this.confirmationModal ? this.renderConfirmationModal() : ''}
          ${this.duplicatePrompt ? this.renderDuplicatePrompt() : ''}
          ${contentHtml}
        </div>
      </div>
    `;
    }

    private renderCurrentBox(ctx: PageNoteContext | null): string {
        const batchToggleText = this.showBatchInput ? '收起批量' : '手动输入/批量';
        const noteRow = ctx
            ? `
        <div class="bb-current-row">
          <div class="bb-current-note-title" title="${escapeHtml(ctx.title)}">当前笔记：${escapeHtml(ctx.title)}</div>
          <button type="button" class="bb-btn bb-btn-sm" data-action="current-download">下载</button>
          <button type="button" class="bb-btn bb-btn-sm" data-action="current-save">收藏</button>
        </div>
      `
            : `
        <div class="bb-current-row">
          <span class="bb-current-note-sub">未在笔记详情页，可从下方或手动粘贴链接执行操作</span>
        </div>
      `;

        const batchBox = this.showBatchInput
            ? `
        <div style="margin-top: 6px; display: flex; flex-direction: column; gap: 6px;">
          <textarea class="bb-textarea" placeholder="每行一个链接，支持短链接或含文字的分享文案..."
            data-input="batch-text">${escapeHtml(this.batchInputText)}</textarea>
          <div style="display: flex; gap: 6px; justify-content: flex-end;">
            <select class="bb-select" style="width: auto;" data-input="batch-downloader">
              <option value="小红书图片下载器">小红书图片</option>
              <option value="小红书实况图片下载器">小红书实况</option>
              <option value="小红书视频下载器">小红书视频</option>
            </select>
            <button type="button" class="bb-btn bb-btn-sm" data-action="submit-batch-save">批量收藏</button>
            <button type="button" class="bb-btn bb-btn-primary bb-btn-sm"
              data-action="submit-batch-download">批量下载</button>
          </div>
        </div>
      `
            : '';

        return `
      <div class="bb-current-box">
        ${noteRow}
        <div style="display: flex; justify-content: flex-end;">
          <button type="button" class="bb-btn bb-btn-sm" data-action="toggle-batch-input">${batchToggleText}</button>
        </div>
        ${batchBox}
      </div>
    `;
    }

    private renderConfirmationModal(): string {
        if (!this.confirmationModal) { return ''; }
        const warnHtml = this.confirmationModal.impactWarning
            ? `<div style="font-size: 11px; opacity: 0.9;">⚠️ ${escapeHtml(this.confirmationModal.impactWarning)}</div>`
            : '';
        return `
      <div class="bb-Banner is-warn">
        <strong>${escapeHtml(this.confirmationModal.title)}</strong>
        <div>${escapeHtml(this.confirmationModal.message)}</div>
        ${warnHtml}
        <div style="display: flex; gap: 6px; justify-content: flex-end; margin-top: 4px;">
          <button type="button" class="bb-btn bb-btn-sm" data-action="cancel-confirm">取消</button>
          <button type="button" class="bb-btn bb-btn-danger bb-btn-sm"
            data-action="execute-confirm">${escapeHtml(this.confirmationModal.confirmText)}</button>
        </div>
      </div>
    `;
    }

    private renderDuplicatePrompt(): string {
        if (!this.duplicatePrompt) { return ''; }
        const incHtml = this.duplicatePrompt.incomplete
            ? '<div style="font-size: 11px;">⚠️ 部分链接内容去重解析未完成，仍可能存在重复。</div>'
            : '';
        return `
      <div class="bb-Banner is-warn">
        <strong>发现重复收藏</strong>
        <div>${escapeHtml(this.duplicatePrompt.details)}</div>
        ${incHtml}
        <div style="display: flex; gap: 6px; justify-content: flex-end; margin-top: 4px;">
          <button type="button" class="bb-btn bb-btn-sm" data-action="cancel-duplicate-save">放弃收藏</button>
          <button type="button" class="bb-btn bb-btn-primary bb-btn-sm"
            data-action="proceed-duplicate-save">仍然继续收藏</button>
        </div>
      </div>
    `;
    }

    private renderSavedTab(): string {
        const all = savedLinksManager.getVisibleItems();
        const kw = this.savedKeyword.toLowerCase();
        const filtered = this.savedKeyword
            ? all.filter(
                i =>
                    i.url.toLowerCase().includes(kw) ||
                    Boolean(i.contentKey && i.contentKey.includes(this.savedKeyword))
            )
            : all;

        const cardsHtml =
            filtered.length === 0
                ? '<div class="bb-empty">暂无收藏记录</div>'
                : filtered
                    .map(item => {
                        const badges = renderSavedItemBadges(item);
                        const supported = isXhsDownloader(item.downloaderType);
                        const safeUrl = escapeHtml(item.url);
                        const resetBtn =
                            item.status !== 'none'
                                ? '<button type="button" class="bb-btn bb-btn-sm" data-action="reset-saved-status" ' +
                                  `data-id="${item.id}" title="重置下载状态为未下载">重置</button>`
                                : '';
                        const preheatBtn =
                            supported && (!item.cachedUrls || item.cachedUrls.length === 0)
                                ? '<button type="button" class="bb-btn bb-btn-sm" data-action="preheat-saved-item" ' +
                                  `data-id="${item.id}" title="提前把媒体缓存到服务端对象存储">预热</button>`
                                : '';
                        const downloadBtn = supported
                            ? '<button type="button" class="bb-btn bb-btn-sm" ' +
                              `data-action="download-saved-item" data-id="${item.id}">下载</button>`
                            : '';

                        return `
                <div class="bb-card">
                  <div class="bb-card-top">
                    <div class="bb-card-url" title="${safeUrl}">${safeUrl}</div>
                  </div>
                  <div class="bb-badge-row">${badges}</div>
                  <div class="bb-card-footer">
                    <span class="bb-card-time">${formatRelativeDate(item.timestamp)}</span>
                    <div class="bb-card-actions">
                      ${downloadBtn}
                      ${preheatBtn}
                      ${resetBtn}
                      <button type="button" class="bb-btn bb-btn-sm"
                        data-action="copy-saved-url" data-url="${safeUrl}">复制</button>
                      <button type="button" class="bb-btn bb-btn-sm"
                        data-action="open-url" data-url="${safeUrl}">打开</button>
                      <button type="button" class="bb-btn bb-btn-danger bb-btn-sm"
                        data-action="delete-saved-item" data-id="${item.id}">删除</button>
                    </div>
                  </div>
                </div>
              `;
                    })
                    .join('');

        return `
      <div class="bb-toolbar">
        <div class="bb-filter-row" style="flex: 1;">
          <input type="text" class="bb-input" placeholder="搜索收藏链接或 key..."
            value="${escapeHtml(this.savedKeyword)}" data-input="saved-search" />
        </div>
        <button type="button" class="bb-btn bb-btn-sm"
          data-action="download-all-saved" ${filtered.length === 0 ? 'disabled' : ''}>下载全部</button>
        <button type="button" class="bb-btn bb-btn-danger bb-btn-sm"
          data-action="clear-all-saved" ${all.length === 0 ? 'disabled' : ''}>清空</button>
      </div>
      <div class="bb-card-list">${cardsHtml}</div>
    `;
    }

    private renderTasksTab(): string {
        const tasks = taskQueue.getTasks(this.taskFilter);
        const cardsHtml =
            tasks.length === 0
                ? '<div class="bb-empty">暂无任务</div>'
                : tasks
                    .map(task => {
                        const statusBadge = renderTaskStatusBadge(task);
                        const typeLabel = renderTaskTypeLabel(task.type);
                        const cancelBtn =
                            task.status === 'pending' || task.status === 'running'
                                ? '<button type="button" class="bb-btn bb-btn-sm" ' +
                                  `data-action="cancel-task" data-id="${task.id}">取消</button>`
                                : '';
                        const retryBtn =
                            task.status === 'failed' || task.status === 'cancelled' || task.status === 'interrupted'
                                ? '<button type="button" class="bb-btn bb-btn-sm" ' +
                                  `data-action="retry-task" data-id="${task.id}">重试</button>`
                                : '';
                        const reExtractBtn =
                            (task.status === 'failed' || task.status === 'interrupted') && task.type === 'download'
                                ? '<button type="button" class="bb-btn bb-btn-sm" data-action="retry-task-reextract" ' +
                                  `data-id="${task.id}" title="忽略缓存重新解析重试">重新解析</button>`
                                : '';

                        const subtasksHtml =
                            task.mediaSubTasks && task.mediaSubTasks.length > 0
                                ? `
                    <div class="bb-subtask-list">
                      ${task.mediaSubTasks
        .map(st => {
            const stText =
                st.status === 'completed'
                    ? '✓ 完成'
                    : st.status === 'running'
                        ? `${st.progressPercent || 0}%`
                        : escapeHtml(st.error || st.status);
            return `
                        <div class="bb-subtask-item">
                          <span>${escapeHtml(st.label)}</span>
                          <span>${stText}</span>
                        </div>
                      `;
        })
        .join('')}
                    </div>
                  `
                                : '';

                        const pfClass = getPlatformBadgeClass(task.downloaderType);
                        return `
                <div class="bb-card">
                  <div class="bb-card-top">
                    <div style="font-weight: 600; font-size: 12.5px;">${escapeHtml(task.title)}</div>
                    <div>${statusBadge}</div>
                  </div>
                  <div class="bb-badge-row">
                    <span class="bb-badge bb-badge-accent">${typeLabel}</span>
                    <span class="bb-badge ${pfClass}">${escapeHtml(task.downloaderType)}</span>
                  </div>
                  <div style="font-size: 11.5px; color: var(--bb-text-secondary);">${escapeHtml(task.message)}</div>
                  ${subtasksHtml}
                  <div class="bb-card-footer">
                    <span class="bb-card-time">${formatRelativeDate(task.createdAt)}</span>
                    <div class="bb-card-actions">
                      ${reExtractBtn}
                      ${retryBtn}
                      ${cancelBtn}
                      <button type="button" class="bb-btn bb-btn-sm"
                        data-action="remove-task" data-id="${task.id}">移除</button>
                    </div>
                  </div>
                </div>
              `;
                    })
                    .join('');

        return `
      <div class="bb-toolbar">
        <select class="bb-select" data-input="task-filter">
          <option value="all" ${this.taskFilter === 'all' ? 'selected' : ''}>全部类型</option>
          <option value="download" ${this.taskFilter === 'download' ? 'selected' : ''}>下载任务</option>
          <option value="preheat" ${this.taskFilter === 'preheat' ? 'selected' : ''}>预热任务</option>
          <option value="save" ${this.taskFilter === 'save' ? 'selected' : ''}>收藏任务</option>
          <option value="sync" ${this.taskFilter === 'sync' ? 'selected' : ''}>同步任务</option>
        </select>
        <button type="button" class="bb-btn bb-btn-sm" data-action="clear-finished-tasks">清理已完成</button>
      </div>
      <div class="bb-card-list">${cardsHtml}</div>
    `;
    }

    private renderHistoryTab(): string {
        const all = historyManager.getVisibleItems();
        const filtered = this.historyKeyword
            ? all.filter(i => i.url.toLowerCase().includes(this.historyKeyword.toLowerCase()))
            : all;

        const cardsHtml =
            filtered.length === 0
                ? '<div class="bb-empty">暂无下载历史</div>'
                : filtered
                    .map(item => {
                        const resBadge = item.isSuccess
                            ? `<span class="bb-badge bb-badge-ok">成功 (${item.mediaCount})</span>`
                            : '<span class="bb-badge bb-badge-error">失败</span>';
                        const safeUrl = escapeHtml(item.url);
                        const safeDl = escapeHtml(item.downloaderType);
                        const pfClass = getPlatformBadgeClass(item.downloaderType);

                        return `
                <div class="bb-card">
                  <div class="bb-card-top">
                    <div class="bb-card-url" title="${safeUrl}">${safeUrl}</div>
                  </div>
                  <div class="bb-badge-row">
                    <span class="bb-badge ${pfClass}">${safeDl}</span>
                    ${resBadge}
                  </div>
                  <div class="bb-card-footer">
                    <span class="bb-card-time">${formatRelativeDate(item.timestamp)}</span>
                    <div class="bb-card-actions">
                      <button type="button" class="bb-btn bb-btn-sm" data-action="redownload-history"
                        data-url="${safeUrl}" data-downloader="${safeDl}">重新下载</button>
                      <button type="button" class="bb-btn bb-btn-sm"
                        data-action="copy-saved-url" data-url="${safeUrl}">复制</button>
                      <button type="button" class="bb-btn bb-btn-sm"
                        data-action="open-url" data-url="${safeUrl}">打开</button>
                      <button type="button" class="bb-btn bb-btn-danger bb-btn-sm"
                        data-action="delete-history-item" data-id="${item.id}">删除</button>
                    </div>
                  </div>
                </div>
              `;
                    })
                    .join('');

        return `
      <div class="bb-toolbar">
        <input type="text" class="bb-input" style="flex: 1;" placeholder="搜索历史链接..."
          value="${escapeHtml(this.historyKeyword)}" data-input="history-search" />
        <button type="button" class="bb-btn bb-btn-danger bb-btn-sm"
          data-action="clear-all-history" ${all.length === 0 ? 'disabled' : ''}>清空历史</button>
      </div>
      <div class="bb-card-list">${cardsHtml}</div>
    `;
    }

    private renderSettingsTab(settings: PluginSettings): string {
        settings = this.settingsDraft ?? settings;
        let diagHtml = '';
        if (this.diagnosticResult) {
            const errDetails =
                this.diagnosticResult.items
                    .filter(item => item.status === 'error')
                    .map(item => item.detail)
                    .join('、') || '未知原因';
            const statusColor = this.diagnosticResult.overallOk ? '--bb-success' : '--bb-danger';
            const statusText = this.diagnosticResult.overallOk
                ? '🎉 连接正常！'
                : `❌ 连接异常（${escapeHtml(errDetails)}）`;
            diagHtml = `
        <div role="status" style="color: var(${statusColor}); font-size: 13px;">
          ${statusText}
        </div>
      `;
        }

        return `
      <form class="bb-card" data-form="settings" style="gap: 12px;">
        <section class="bb-settings-section" aria-label="服务端">
        <h3 class="bb-settings-heading">服务端</h3>
        <div class="bb-form-group">
          <label class="bb-form-label">服务端地址</label>
          <div class="bb-form-desc">填写已部署的服务端地址。</div>
          <input type="text" class="bb-input" name="serverUrl"
            value="${escapeHtml(settings.serverUrl)}" placeholder="https://example.com/api" />
        </div>

        <div class="bb-form-group">
          <label class="bb-form-label">服务端令牌</label>
          <div class="bb-form-desc">令牌必须与服务端中的设置保持一致。</div>
          <input type="password" class="bb-input" name="serverToken"
            value="${escapeHtml(settings.serverToken)}" placeholder="请输入服务端令牌" />
        </div>
        <div>
          <button type="button" class="bb-btn bb-btn-sm"
            data-action="run-diagnostics" ${this.isRunningDiagnostics ? 'disabled' : ''}>
            ${this.isRunningDiagnostics ? '正在检查...' : '测试连接'}
          </button>
        </div>
        ${diagHtml}
        </section>

        <section class="bb-settings-section" aria-label="下载与收藏">
        <h3 class="bb-settings-heading">下载与收藏</h3>
        <div class="bb-form-group">
          <label class="bb-form-label">默认操作</label>
          <div class="bb-form-desc">选择页面工具条主按钮的操作。</div>
          <select class="bb-select" name="defaultAction">
            <option value="download" ${settings.defaultAction === 'download' ? 'selected' : ''}>下载媒体</option>
            <option value="save" ${settings.defaultAction === 'save' ? 'selected' : ''}>收藏链接</option>
          </select>
        </div>
        <div class="bb-switch-row">
          <div>
            <div class="bb-form-label">服务端代理</div>
            <div class="bb-form-desc">开启后，由服务端代为下载图片和视频。</div>
          </div>
          <input type="checkbox" name="serverSideProxy" ${settings.serverSideProxy ? 'checked' : ''} />
        </div>

        <div class="bb-switch-row">
          <div>
            <div class="bb-form-label">资源预热</div>
            <div class="bb-form-desc">开启后，收藏链接时会自动将图片和视频缓存到服务端。</div>
          </div>
          <input type="checkbox" name="preheatResources" ${settings.preheatResources ? 'checked' : ''} />
        </div>
        </section>

        <section class="bb-settings-section" aria-label="同步">
        <h3 class="bb-settings-heading">同步</h3>
        <div class="bb-switch-row">
          <div>
            <div class="bb-form-label">增量同步</div>
            <div class="bb-form-desc">仅获取自上次同步以来的更新，节省流量，建议保持开启。</div>
          </div>
          <input type="checkbox" name="incrementalSync" ${settings.incrementalSync ? 'checked' : ''} />
        </div>
        </section>

        <section class="bb-settings-section" aria-label="日志">
        <h3 class="bb-settings-heading">日志</h3>
        <div class="bb-form-group">
          <label class="bb-form-label">日志等级</label>
          <select class="bb-select" name="logDisplayLevel">
            <option value="0" ${settings.logDisplayLevel === LogLevel.Debug ? 'selected' : ''}>调试</option>
            <option value="1" ${settings.logDisplayLevel === LogLevel.Info ? 'selected' : ''}>信息</option>
            <option value="2" ${settings.logDisplayLevel === LogLevel.Warn ? 'selected' : ''}>警告</option>
            <option value="3" ${settings.logDisplayLevel === LogLevel.Error ? 'selected' : ''}>错误</option>
          </select>
        </div>
        </section>

        <div style="display: flex; justify-content: flex-end; margin-top: 4px;">
          <button type="submit" class="bb-btn bb-btn-primary bb-btn-sm">保存设置</button>
        </div>
        ${this.settingsSaved ? '<div role="status">设置已保存</div>' : ''}
      </form>
    `;
    }

    private renderLogsTab(): string {
        const logs = logger.getFilteredLogs({ keyword: this.logKeyword });
        const itemsHtml =
            logs.length === 0
                ? '<div class="bb-empty">暂无日志</div>'
                : logs
                    .map(e => {
                        const badge = renderLogLevelBadge(e.level);
                        const timeStr = formatRelativeDate(e.timestamp);
                        return `
                <div class="bb-card bb-log-card">
                  <div class="bb-log-header">
                    <div class="bb-log-meta">${badge}<span class="bb-log-time">${timeStr}</span></div>
                    ${e.taskId ? `<span class="bb-log-task">#${e.taskId.slice(0, 6)}</span>` : ''}
                  </div>
                  <div class="bb-log-msg">${escapeHtml(e.message)}</div>
                  ${e.context ? `<div class="bb-log-ctx">${escapeHtml(e.context)}</div>` : ''}
                </div>
              `;
                    })
                    .join('');

        return `
      <div class="bb-toolbar">
        <input type="text" class="bb-input" style="flex: 1;" placeholder="筛选日志..."
          value="${escapeHtml(this.logKeyword)}" data-input="log-search" />
        <button type="button" class="bb-btn bb-btn-sm" data-action="copy-logs">复制日志</button>
        <button type="button" class="bb-btn bb-btn-danger bb-btn-sm" data-action="clear-logs">清空</button>
      </div>
      <div class="bb-card-list">${itemsHtml}</div>
    `;
    }

    private async handleAction(action: string | null, target: HTMLElement): Promise<void> {
        if (!action) { return; }

        if (action === 'close-panel') {
            this.closePanel();
            return;
        }

        if (action === 'open-panel') {
            this.openPanel();
            return;
        }

        if (action === 'nav-tab') {
            const tab = target.getAttribute('data-tab') as ActiveViewTab;
            if (tab) { this.openPanel(tab); }
            return;
        }

        if (action === 'trigger-sync') {
            void syncCoordinator.syncNow({ reason: 'manual_click' });
            return;
        }

        if (action === 'select-note-type') {
            const dt = target.getAttribute('data-downloader') as XhsDownloaderType;
            if (dt) { xhsPageAdapter.setManualDownloaderForCurrentNote(dt); }
            return;
        }

        if (action === 'toggle-batch-input') {
            this.showBatchInput = !this.showBatchInput;
            this.render();
            return;
        }

        if (action === 'entry-download' || action === 'current-download') {
            const ctx = xhsPageAdapter.getCurrentContext();
            if (!ctx) { return; }
            const downloader = xhsPageAdapter.getEffectiveDownloader(ctx);
            if (!downloader) {
                this.openPanel();
                alert('无法确认当前笔记类型，请先选择「图片 / 视频 / 实况」');
                return;
            }
            taskQueue.enqueueTask({
                type: 'download',
                title: `下载: ${ctx.title}`,
                urls: [ctx.url],
                downloaderType: downloader,
            });
            return;
        }

        if (action === 'entry-save' || action === 'current-save') {
            const ctx = xhsPageAdapter.getCurrentContext();
            if (!ctx) { return; }
            const downloader = xhsPageAdapter.getEffectiveDownloader(ctx);
            if (!downloader) {
                this.openPanel();
                alert('无法确认当前笔记类型，请先选择「图片 / 视频 / 实况」');
                return;
            }
            await this.handleSaveFlow([ctx.url], downloader, `收藏: ${ctx.title}`);
            return;
        }

        if (action === 'submit-batch-save' || action === 'submit-batch-download') {
            const textarea =
                this.shadowRoot?.querySelector('[data-input="batch-text"]') as HTMLTextAreaElement | null;
            const select =
                this.shadowRoot?.querySelector('[data-input="batch-downloader"]') as HTMLSelectElement | null;
            const text = textarea?.value || '';
            const downloader = (select?.value || '小红书图片下载器') as XhsDownloaderType;
            const extraction = extractUrlsFromInput(text, 'skipWithWarning');
            if (extraction.urls.length === 0) {
                alert('未找到有效链接，请输入至少一行链接');
                return;
            }
            if (action === 'submit-batch-save') {
                await this.handleSaveFlow(extraction.urls, downloader, `批量收藏 (${extraction.urls.length} 个链接)`);
                if (textarea) { textarea.value = ''; }
            } else {
                taskQueue.enqueueTask({
                    type: 'download',
                    title: `批量下载 (${extraction.urls.length} 个链接)`,
                    urls: extraction.urls,
                    downloaderType: downloader,
                });
                if (textarea) { textarea.value = ''; }
            }
            return;
        }

        if (action === 'download-saved-item') {
            const id = target.getAttribute('data-id');
            const item = id ? savedLinksManager.getItemById(id) : null;
            if (!item) { return; }
            taskQueue.enqueueTask({
                type: 'download',
                title: `下载收藏: ${item.url.slice(0, 32)}...`,
                urls: [item.url],
                downloaderType: item.downloaderType,
                savedLinkId: item.id,
            });
            return;
        }

        if (action === 'preheat-saved-item') {
            const id = target.getAttribute('data-id');
            const item = id ? savedLinksManager.getItemById(id) : null;
            if (!item) { return; }
            taskQueue.enqueueTask({
                type: 'preheat',
                title: `预热收藏: ${item.url.slice(0, 32)}...`,
                urls: [item.url],
                downloaderType: item.downloaderType,
                savedLinkId: item.id,
            });
            return;
        }

        if (action === 'reset-saved-status') {
            const id = target.getAttribute('data-id');
            if (id) { savedLinksManager.updateStatus(id, 'none'); }
            return;
        }

        if (action === 'delete-saved-item') {
            const id = target.getAttribute('data-id');
            if (id) {
                this.confirmationModal = {
                    title: '删除已收藏链接',
                    message: '确定要删除此条收藏链接吗？',
                    impactWarning: '此操作将通过云端同步影响其他客户端（如 iOS 端）。',
                    confirmText: '删除',
                    onConfirm: () => {
                        savedLinksManager.deleteItem(id);
                        syncCoordinator.scheduleSync('delete_saved', 300, { savedLinks: true, history: false });
                    },
                };
                this.render();
            }
            return;
        }

        if (action === 'clear-all-saved') {
            this.confirmationModal = {
                title: '清空所有已收藏链接',
                message: '确定要清空全部收藏记录吗？此操作无法撤销。',
                impactWarning: '此操作将通过云端同步删除其他客户端（如 iOS 端）的所有收藏！',
                confirmText: '确认清空',
                onConfirm: () => {
                    savedLinksManager.clearAll();
                    syncCoordinator.scheduleSync('clear_saved', 300, { savedLinks: true, history: false });
                },
            };
            this.render();
            return;
        }

        if (action === 'download-all-saved') {
            const itemsToDownload = savedLinksManager
                .getVisibleItems()
                .filter(i => i.status !== 'success' && isXhsDownloader(i.downloaderType));
            if (itemsToDownload.length === 0) {
                alert('当前没有待下载的小红书收藏项');
                return;
            }
            for (const item of itemsToDownload) {
                taskQueue.enqueueTask({
                    type: 'download',
                    title: `下载收藏: ${item.url.slice(0, 24)}...`,
                    urls: [item.url],
                    downloaderType: item.downloaderType,
                    savedLinkId: item.id,
                });
            }
            return;
        }

        if (action === 'cancel-task') {
            const id = target.getAttribute('data-id');
            if (id) { taskQueue.cancelTask(id); }
            return;
        }

        if (action === 'retry-task') {
            const id = target.getAttribute('data-id');
            if (id) { taskQueue.retryTask(id, { onlyFailedSubTasks: true }); }
            return;
        }

        if (action === 'retry-task-reextract') {
            const id = target.getAttribute('data-id');
            if (id) { taskQueue.retryTask(id, { forceReExtract: true }); }
            return;
        }

        if (action === 'remove-task') {
            const id = target.getAttribute('data-id');
            if (id) { taskQueue.removeTask(id); }
            return;
        }

        if (action === 'clear-finished-tasks') {
            taskQueue.clearFinishedTasks();
            return;
        }

        if (action === 'redownload-history') {
            const url = target.getAttribute('data-url');
            const dt = target.getAttribute('data-downloader') as XhsDownloaderType;
            if (url && dt) {
                taskQueue.enqueueTask({
                    type: 'download',
                    title: `重新下载: ${url.slice(0, 24)}...`,
                    urls: [url],
                    downloaderType: dt,
                });
            }
            return;
        }

        if (action === 'delete-history-item') {
            const id = target.getAttribute('data-id');
            if (id) {
                historyManager.deleteItem(id);
                syncCoordinator.scheduleSync('delete_history', 300, { savedLinks: false, history: true });
            }
            return;
        }

        if (action === 'clear-all-history') {
            this.confirmationModal = {
                title: '清空下载历史',
                message: '确定要清空全部下载历史吗？',
                impactWarning: '此操作将通过云端同步清空其他客户端的历史记录。',
                confirmText: '确认清空',
                onConfirm: () => {
                    historyManager.clearAll();
                    syncCoordinator.scheduleSync('clear_history', 300, { savedLinks: false, history: true });
                },
            };
            this.render();
            return;
        }

        if (action === 'copy-saved-url') {
            const url = target.getAttribute('data-url');
            if (url) {
                await getGmBridge().setClipboard(url);
                target.textContent = '已复制';
                setTimeout(() => {
                    target.textContent = '复制';
                }, 1500);
            }
            return;
        }

        if (action === 'open-url') {
            const url = target.getAttribute('data-url');
            if (url && typeof window !== 'undefined') {
                window.open(url, '_blank', 'noopener,noreferrer');
            }
            return;
        }

        if (action === 'copy-logs') {
            const text = logger.formatLogsForExport();
            await getGmBridge().setClipboard(text);
            target.textContent = '已复制';
            setTimeout(() => {
                target.textContent = '复制日志';
            }, 1500);
            return;
        }

        if (action === 'clear-logs') {
            logger.clearLogs();
            return;
        }

        if (action === 'run-diagnostics') {
            if (this.isRunningDiagnostics) { return; }
            const form = target.closest<HTMLFormElement>('form[data-form="settings"]');
            if (!form) { return; }
            const settings = this.readSettingsForm(form);
            this.settingsDraft = settings;
            this.isRunningDiagnostics = true;
            this.render();
            try {
                const result = await checkConnectionAndFeatures(settings);
                if (this.settingsDraft === settings) { this.diagnosticResult = result; }
            } finally {
                this.isRunningDiagnostics = false;
                this.render();
            }
            return;
        }

        if (action === 'cancel-confirm') {
            this.confirmationModal = null;
            this.render();
            return;
        }

        if (action === 'execute-confirm') {
            if (this.confirmationModal?.onConfirm) {
                this.confirmationModal.onConfirm();
            }
            this.confirmationModal = null;
            this.render();
            return;
        }

        if (action === 'cancel-duplicate-save') {
            this.duplicatePrompt = null;
            this.render();
            return;
        }

        if (action === 'proceed-duplicate-save') {
            if (this.duplicatePrompt) {
                const { urls, downloader, resolvedKeys, incomplete } = this.duplicatePrompt;
                taskQueue.enqueueTask({
                    type: 'save',
                    title: `收藏 (${urls.length} 个链接)`,
                    urls,
                    downloaderType: downloader,
                    resolvedContentKeys: resolvedKeys,
                    identityCheckIncomplete: incomplete,
                });
            }
            this.duplicatePrompt = null;
            this.render();
            return;
        }
    }

    private async handleSaveFlow(urls: string[], downloader: XhsDownloaderType, title: string): Promise<void> {
        const prep = await savedLinksManager.prepareSaveLinks(urls, downloader);
        if (prep.hasDuplicate) {
            const duplicateLines = prep.duplicates
                .map(d => `• ${d.url} (${d.reason.includes('key') ? '相同笔记内容' : '相同链接'})`)
                .join('\n');
            this.duplicatePrompt = {
                urls,
                downloader,
                details: duplicateLines,
                incomplete: prep.identityCheckIncomplete,
                resolvedKeys: prep.resolvedContentKeys,
            };
            this.openPanel('saved');
            return;
        }

        taskQueue.enqueueTask({
            type: 'save',
            title,
            urls,
            downloaderType: downloader,
            resolvedContentKeys: prep.resolvedContentKeys,
            identityCheckIncomplete: prep.identityCheckIncomplete,
        });
    }
}

export const pluginUI = new BenbenPluginUI();
