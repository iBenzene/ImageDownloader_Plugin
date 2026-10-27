// src/ui/styles.ts

/**
 * 界面层 Shadow DOM 隔离样式定义
 * 适配浅色与深色主题, 窄屏响应式布局以及降低动态效果无障碍模式
 */

export const SHADOW_STYLES = `
:host {
    all: initial;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
        "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    font-size: 13px;
    line-height: 1.5;
    color: var(--bb-text);
    --bb-bg: #ffffff;
    --bb-bg-subtle: #f6f7f8;
    --bb-bg-elevated: #ffffff;
    --bb-border: #e5e7eb;
    --bb-border-strong: #d1d5db;
    --bb-text: #1f2328;
    --bb-text-secondary: #59636e;
    --bb-text-muted: #8b949e;
    --bb-accent: #f4b007;
    --bb-accent-hover: #d99b06;
    --bb-accent-soft: rgba(244, 176, 7, 0.14);
    --bb-accent-fg: #1f2328;
    --bb-accent-text: #b47800;
    --bb-success: #15803d;
    --bb-success-soft: rgba(21, 128, 61, 0.1);
    --bb-info: #0284c7;
    --bb-info-soft: rgba(2, 132, 199, 0.1);
    --bb-warn: #b45309;
    --bb-warn-soft: rgba(180, 83, 9, 0.11);
    --bb-danger: #b91c1c;
    --bb-danger-soft: rgba(185, 28, 28, 0.1);
    --bb-shadow-sm: 0 2px 8px rgba(15, 23, 42, 0.07);
    --bb-shadow-lg: -4px 0 24px rgba(15, 23, 42, 0.12);
    --bb-radius-sm: 6px;
    --bb-radius-md: 10px;
    --bb-radius-lg: 12px;
    --bb-transition: 160ms cubic-bezier(0.2, 0, 0, 1);
}

:host([data-theme="dark"]) {
    --bb-bg: #16181d;
    --bb-bg-subtle: #1f2229;
    --bb-bg-elevated: #232730;
    --bb-border: #2d323e;
    --bb-border-strong: #3d4454;
    --bb-text: #e6edf3;
    --bb-text-secondary: #9ca3af;
    --bb-text-muted: #6b7280;
    --bb-accent: #f4b007;
    --bb-accent-hover: #f5ba23;
    --bb-accent-soft: rgba(244, 176, 7, 0.18);
    --bb-accent-fg: #16181d;
    --bb-accent-text: #f4b007;
    --bb-success: #4ade80;
    --bb-success-soft: rgba(74, 222, 128, 0.14);
    --bb-info: #38bdf8;
    --bb-info-soft: rgba(56, 189, 248, 0.15);
    --bb-warn: #fbbf24;
    --bb-warn-soft: rgba(251, 191, 36, 0.15);
    --bb-danger: #f87171;
    --bb-danger-soft: rgba(248, 113, 113, 0.15);
    --bb-shadow-sm: 0 2px 10px rgba(0, 0, 0, 0.35);
    --bb-shadow-lg: -4px 0 28px rgba(0, 0, 0, 0.5);
}

/* 宿主平台主题色联动定制 */
/* 小红书宿主 (标志性小红书红 #ff2442) */
:host([data-platform="xhs"]) {
    --bb-accent: #ff2442;
    --bb-accent-hover: #e01936;
    --bb-accent-soft: rgba(255, 36, 66, 0.1);
    --bb-accent-fg: #ffffff;
    --bb-accent-text: #e01936;
}

/* 微博宿主 (官方经典微博橙 #ff8200) */
:host([data-platform="wb"]) {
    --bb-accent: #ff8200;
    --bb-accent-hover: #e67500;
    --bb-accent-soft: rgba(255, 130, 0, 0.12);
    --bb-accent-fg: #ffffff;
    --bb-accent-text: #e67500;
}

/* 哔哩哔哩宿主 (B站交互蓝 #00aeec) */
:host([data-platform="bili"]) {
    --bb-accent: #00aeec;
    --bb-accent-hover: #009cd3;
    --bb-accent-soft: rgba(0, 174, 236, 0.12);
    --bb-accent-fg: #ffffff;
    --bb-accent-text: #009cd3;
}

/* Pixiv 宿主 (Pixiv官方蓝 #0096fa) */
:host([data-platform="pixiv"]) {
    --bb-accent: #0096fa;
    --bb-accent-hover: #007cd0;
    --bb-accent-soft: rgba(0, 150, 250, 0.12);
    --bb-accent-fg: #ffffff;
    --bb-accent-text: #0077c8;
}

/* X (Twitter) 宿主 (极简纯黑 #0f1419) */
:host([data-platform="x"]) {
    --bb-accent: #0f1419;
    --bb-accent-hover: #272c30;
    --bb-accent-soft: rgba(15, 20, 25, 0.08);
    --bb-accent-fg: #ffffff;
    --bb-accent-text: #0f1419;
}

/* 米游社宿主 (米游社科技蓝 #2485e0) */
:host([data-platform="mys"]) {
    --bb-accent: #2485e0;
    --bb-accent-hover: #1976d2;
    --bb-accent-soft: rgba(36, 133, 224, 0.12);
    --bb-accent-fg: #ffffff;
    --bb-accent-text: #1976d2;
}

/* 深色模式下的平台主题色定制 */
:host([data-theme="dark"][data-platform="xhs"]) {
    --bb-accent: #ff4760;
    --bb-accent-hover: #ff6b80;
    --bb-accent-soft: rgba(255, 71, 96, 0.18);
    --bb-accent-fg: #ffffff;
    --bb-accent-text: #ff4760;
}

:host([data-theme="dark"][data-platform="wb"]) {
    --bb-accent: #ff9933;
    --bb-accent-hover: #ffa84d;
    --bb-accent-soft: rgba(255, 153, 51, 0.18);
    --bb-accent-fg: #16181d;
    --bb-accent-text: #ff9933;
}

:host([data-theme="dark"][data-platform="bili"]) {
    --bb-accent: #23c2fa;
    --bb-accent-hover: #4ed0fb;
    --bb-accent-soft: rgba(35, 194, 250, 0.2);
    --bb-accent-fg: #16181d;
    --bb-accent-text: #23c2fa;
}

:host([data-theme="dark"][data-platform="pixiv"]) {
    --bb-accent: #38b2ff;
    --bb-accent-hover: #60c1ff;
    --bb-accent-soft: rgba(56, 178, 255, 0.2);
    --bb-accent-fg: #16181d;
    --bb-accent-text: #38b2ff;
}

:host([data-theme="dark"][data-platform="x"]) {
    --bb-accent: #eff3f4;
    --bb-accent-hover: #d7dbdc;
    --bb-accent-soft: rgba(239, 243, 244, 0.15);
    --bb-accent-fg: #0f1419;
    --bb-accent-text: #eff3f4;
}

:host([data-theme="dark"][data-platform="mys"]) {
    --bb-accent: #4fa3e0;
    --bb-accent-hover: #6bb4e5;
    --bb-accent-soft: rgba(79, 163, 224, 0.2);
    --bb-accent-fg: #16181d;
    --bb-accent-text: #4fa3e0;
}

@media (prefers-reduced-motion: reduce) {
    :host {
    --bb-transition: 0ms;
    }
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    }
}

* {
    box-sizing: border-box;
}

button, input, select, textarea {
    font: inherit;
    color: inherit;
}

/* ==================== 页面笔记附近轻量入口 ==================== */
.bb-entry-bar {
    position: fixed;
    left: 50%;
    top: 16px;
    transform: translate(-50%, -50%);
    visibility: hidden;
    z-index: 2147483640;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    background: var(--bb-bg-elevated);
    border: 1px solid var(--bb-border);
    border-radius: var(--bb-radius-md);
    box-shadow: var(--bb-shadow-sm);
    color: var(--bb-text);
    max-width: calc(100vw - 32px);
    flex-wrap: wrap;
    justify-content: center;
}

.bb-entry-bar[ hidden ] {
    display: none !important;
}

.bb-entry-drag {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    align-self: stretch;
    min-width: 22px;
    min-height: 28px;
    color: var(--bb-text-secondary);
    border-radius: 4px;
    cursor: grab;
    touch-action: none;
    user-select: none;
}

.bb-entry-drag:hover {
    background: var(--bb-bg-subtle);
}

.bb-entry-bar.is-dragging .bb-entry-drag {
    cursor: grabbing;
}

.bb-entry-type-group {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 2px;
    background: var(--bb-bg-subtle);
    border-radius: var(--bb-radius-sm);
    border: 1px solid transparent;
}

.bb-entry-type-group.bb-needs-choice {
    border-color: var(--bb-warn);
    background: var(--bb-warn-soft);
}

.bb-type-pill {
    border: none;
    background: transparent;
    padding: 3px 7px;
    border-radius: 4px;
    font-size: 12px;
    color: var(--bb-text-secondary);
    cursor: pointer;
    transition: background var(--bb-transition), color var(--bb-transition);
}

.bb-type-pill:hover {
    color: var(--bb-text);
}

.bb-type-pill.is-active {
    background: var(--bb-bg-elevated);
    color: var(--bb-text);
    font-weight: 600;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
}

.bb-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 5px 10px;
    border-radius: var(--bb-radius-sm);
    border: 1px solid var(--bb-border);
    background: var(--bb-bg-elevated);
    color: var(--bb-text);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
    transition: background var(--bb-transition), border-color var(--bb-transition), opacity var(--bb-transition);
}

.bb-btn:hover:not(:disabled) {
    background: var(--bb-bg-subtle);
    border-color: var(--bb-border-strong);
}

.bb-btn:focus-visible,
.bb-type-pill:focus-visible,
.bb-tab-btn:focus-visible,
.bb-input:focus-visible,
.bb-textarea:focus-visible,
.bb-select:focus-visible {
    outline: 2px solid var(--bb-accent);
    outline-offset: 1px;
}

.bb-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.bb-btn-primary {
    background: var(--bb-accent);
    border-color: var(--bb-accent);
    color: var(--bb-accent-fg);
    font-weight: 600;
}

.bb-btn-primary:hover:not(:disabled) {
    background: var(--bb-accent-hover);
    border-color: var(--bb-accent-hover);
}

.bb-btn-danger {
    color: var(--bb-danger);
    border-color: var(--bb-border);
}

.bb-btn-danger:hover:not(:disabled) {
    background: var(--bb-danger-soft);
    border-color: var(--bb-danger);
}

.bb-btn-sm {
    padding: 3px 8px;
    font-size: 11px;
}

.bb-entry-status {
    font-size: 11px;
    color: var(--bb-text-secondary);
    max-width: 190px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 0 4px;
}

.bb-entry-status.is-error {
    color: var(--bb-danger);
}

.bb-entry-status.is-warn {
    color: var(--bb-warn);
}

.bb-entry-status.is-ok {
    color: var(--bb-success);
}

/* ==================== 按需展开的侧边面板 ==================== */
.bb-backdrop {
    position: fixed;
    inset: 0;
    z-index: 2147483645;
    background: rgba(0, 0, 0, 0.18);
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--bb-transition);
}

.bb-backdrop.is-open {
    opacity: 1;
    pointer-events: auto;
}

.bb-panel {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: 420px;
    max-width: 100vw;
    z-index: 2147483646;
    background: var(--bb-bg);
    border-left: 1px solid var(--bb-border);
    box-shadow: var(--bb-shadow-lg);
    display: flex;
    flex-direction: column;
    transform: translateX(102%);
    transition: transform var(--bb-transition);
}

.bb-panel.is-open {
    transform: translateX(0);
}

@media (max-width: 520px) {
    .bb-panel {
    width: 100vw;
    }
    .bb-entry-bar {
    justify-content: space-between;
    }
}

.bb-panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--bb-border);
}

.bb-panel-title-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
}

.bb-panel-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--bb-text);
    margin: 0;
}

.bb-sync-pill {
    font-size: 11px;
    padding: 2px 7px;
    border-radius: 999px;
    background: var(--bb-bg-subtle);
    color: var(--bb-text-secondary);
}

.bb-sync-pill.is-dirty {
    color: var(--bb-warn);
    background: var(--bb-warn-soft);
}

.bb-sync-pill.is-error {
    color: var(--bb-danger);
    background: var(--bb-danger-soft);
}

.bb-header-actions {
    display: flex;
    align-items: center;
    gap: 4px;
}

.bb-icon-btn {
    border: 1px solid transparent;
    background: transparent;
    color: var(--bb-text-secondary);
    padding: 5px 8px;
    border-radius: var(--bb-radius-sm);
    font-size: 12px;
    cursor: pointer;
}

.bb-icon-btn:hover {
    background: var(--bb-bg-subtle);
    color: var(--bb-text);
}

.bb-icon-btn.is-active {
    background: var(--bb-accent-soft);
    color: var(--bb-accent-text);
    font-weight: 600;
}

/* ==================== 当前笔记与手动输入卡片 ==================== */
.bb-current-box {
    padding: 10px 16px;
    background: var(--bb-bg-subtle);
    border-bottom: 1px solid var(--bb-border);
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.bb-current-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
}

.bb-current-note-title {
    font-size: 12px;
    font-weight: 500;
    color: var(--bb-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
}

.bb-current-note-sub {
    font-size: 11px;
    color: var(--bb-text-secondary);
}

/* ==================== 导航标签 ==================== */
.bb-nav-tabs {
    display: flex;
    align-items: center;
    padding: 0 16px;
    border-bottom: 1px solid var(--bb-border);
    background: var(--bb-bg);
    gap: 16px;
}

.bb-tab-btn {
    border: none;
    background: transparent;
    padding: 10px 2px;
    font-size: 13px;
    font-weight: 500;
    color: var(--bb-text-secondary);
    border-bottom: 2px solid transparent;
    cursor: pointer;
}

.bb-tab-btn:hover {
    color: var(--bb-text);
}

.bb-tab-btn.is-active {
    color: var(--bb-accent-text);
    border-bottom-color: var(--bb-accent);
    font-weight: 600;
}

/* ==================== 内容滚动区与通用控件 ==================== */
.bb-panel-body {
    flex: 1;
    overflow-y: auto;
    padding: 12px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.bb-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
}

.bb-input,
.bb-select,
.bb-textarea {
    width: 100%;
    padding: 6px 9px;
    border: 1px solid var(--bb-border);
    border-radius: var(--bb-radius-sm);
    background: var(--bb-bg-elevated);
    color: var(--bb-text);
    font-size: 12px;
}

.bb-textarea {
    min-height: 68px;
    resize: vertical;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.bb-filter-row {
    display: flex;
    gap: 6px;
    align-items: center;
}

.bb-filter-row .bb-input {
    flex: 1;
}

.bb-filter-row .bb-select {
    width: auto;
    min-width: 108px;
}

/* ==================== 列表卡片与三类独立状态标签 ==================== */
.bb-card-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.bb-card {
    border: 1px solid var(--bb-border);
    border-radius: var(--bb-radius-md);
    background: var(--bb-bg-elevated);
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.bb-card-top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
}

.bb-card-url {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 11.5px;
    color: var(--bb-text);
    word-break: break-all;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    flex: 1;
}

.bb-badge-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 5px;
}

.bb-badge {
    display: inline-flex;
    align-items: center;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 500;
    background: var(--bb-bg-subtle);
    color: var(--bb-text-secondary);
}

.bb-badge-accent {
    background: var(--bb-accent-soft);
    color: var(--bb-accent-text);
}

/* 专属媒体平台标签颜色 (浅色模式) */
.bb-badge-platform-xhs {
    background: rgba(255, 36, 66, 0.11);
    color: #e01936;
}

.bb-badge-platform-wb {
    background: rgba(255, 130, 0, 0.12);
    color: #e67500;
}

.bb-badge-platform-bili {
    background: rgba(0, 174, 236, 0.12);
    color: #009cd3;
}

.bb-badge-platform-pixiv {
    background: rgba(0, 150, 250, 0.12);
    color: #0077c8;
}

.bb-badge-platform-x {
    background: rgba(15, 20, 25, 0.08);
    color: #0f1419;
}

.bb-badge-platform-mys {
    background: rgba(36, 133, 224, 0.12);
    color: #1976d2;
}

.bb-badge-platform-default {
    background: var(--bb-accent-soft);
    color: var(--bb-accent-text);
}

/* 深色模式下的平台标签颜色 */
:host([data-theme="dark"]) .bb-badge-platform-xhs {
    background: rgba(255, 71, 96, 0.18);
    color: #ff4760;
}

:host([data-theme="dark"]) .bb-badge-platform-wb {
    background: rgba(255, 153, 51, 0.2);
    color: #ff9933;
}

:host([data-theme="dark"]) .bb-badge-platform-bili {
    background: rgba(35, 194, 250, 0.2);
    color: #23c2fa;
}

:host([data-theme="dark"]) .bb-badge-platform-pixiv {
    background: rgba(56, 178, 255, 0.2);
    color: #38b2ff;
}

:host([data-theme="dark"]) .bb-badge-platform-x {
    background: rgba(239, 243, 244, 0.16);
    color: #eff3f4;
}

:host([data-theme="dark"]) .bb-badge-platform-mys {
    background: rgba(79, 163, 224, 0.2);
    color: #4fa3e0;
}

.bb-badge-ok {
    background: var(--bb-success-soft);
    color: var(--bb-success);
}

.bb-badge-info {
    background: var(--bb-info-soft);
    color: var(--bb-info);
}

.bb-badge-warn {
    background: var(--bb-warn-soft);
    color: var(--bb-warn);
}

.bb-badge-error {
    background: var(--bb-danger-soft);
    color: var(--bb-danger);
}

.bb-card-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-top: 2px;
    flex-wrap: wrap;
}

.bb-card-time {
    font-size: 11px;
    color: var(--bb-text-muted);
}

.bb-card-actions {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
}

/* ==================== 内联确认框与反馈条 ==================== */
.bb-Banner {
    padding: 9px 11px;
    border-radius: var(--bb-radius-sm);
    border: 1px solid var(--bb-border);
    background: var(--bb-bg-subtle);
    font-size: 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.bb-Banner summary {
    list-style: none;
    cursor: pointer;
    display: flex;
    justify-content: space-between;
    align-items: center;
    user-select: none;
}

.bb-Banner summary::-webkit-details-marker {
    display: none;
}

details.bb-Banner summary::after {
    content: '▾ 详情';
    font-size: 11px;
    opacity: 0.75;
    font-weight: normal;
}

details.bb-Banner[open] summary::after {
    content: '▴ 收起';
}

.bb-Banner.is-warn {
    border-color: var(--bb-warn);
    background: var(--bb-warn-soft);
}

.bb-Banner.is-error {
    border-color: var(--bb-danger);
    background: var(--bb-danger-soft);
}

.bb-Banner.is-ok {
    border-color: var(--bb-success);
    background: var(--bb-success-soft);
}

.bb-empty {
    padding: 32px 16px;
    text-align: center;
    color: var(--bb-text-muted);
    font-size: 12.5px;
}

/* ==================== 设置表单 ==================== */
.bb-settings-section {
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.bb-settings-section + .bb-settings-section {
    padding-top: 16px;
    border-top: 1px solid var(--bb-border);
}

.bb-settings-heading {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--bb-text);
}

.bb-settings-section .bb-form-group {
    padding-bottom: 0;
    border-bottom: none;
}

.bb-form-group {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--bb-border);
}

.bb-form-label {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--bb-text);
}

.bb-form-desc {
    font-size: 11px;
    color: var(--bb-text-secondary);
}

.bb-switch-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 0;
}

.bb-subtask-list {
    margin-top: 4px;
    padding-top: 6px;
    border-top: 1px dashed var(--bb-border);
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 11px;
}

.bb-subtask-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    color: var(--bb-text-secondary);
}

/* ==================== 日志条目卡片与排版 ==================== */
.bb-log-card {
    padding: 8px 11px;
    gap: 4px;
}

.bb-log-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
}

.bb-log-meta {
    display: flex;
    align-items: center;
    gap: 6px;
}

.bb-log-time {
    color: var(--bb-text-muted);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
}

.bb-log-task {
    padding: 0 5px;
    border-radius: 3px;
    background: var(--bb-bg-subtle);
    color: var(--bb-text-muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 10.5px;
}

.bb-log-msg {
    margin-top: 1px;
    color: var(--bb-text);
    font-size: 12px;
    line-height: 1.5;
    font-variant-numeric: tabular-nums;
    word-break: break-word;
}

.bb-log-ctx {
    margin-top: 2px;
    padding: 4px 7px;
    border-radius: 4px;
    background: var(--bb-bg-subtle);
    color: var(--bb-text-secondary);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
        "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    font-size: 11px;
    line-height: 1.45;
    word-break: break-all;
}
`;
