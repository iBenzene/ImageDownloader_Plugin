// src/index.ts

import { getGmBridge } from './gmAdapter';
import { logger } from './logger';
import { syncCoordinator } from './sync';
import { taskQueue } from './taskQueue';
import { pluginUI } from './ui/panel';
import { xhsPageAdapter } from './xhsPageAdapter';

/**
 * 客户端核心初始化入口
 * 挂载隔离视图层, 启动页面路由监听, 恢复中断队列并注册宿主菜单
 */
const initUserscript = (): void => {
    logger.debug('《苯苯存图》插件已加载');

    // 初始化并挂载 Shadow DOM 隔离界面
    pluginUI.init();

    // 启动页面单页路由监听与笔记上下文识别
    xhsPageAdapter.start();

    // 恢复中断状态并启动尚未执行的排队任务
    taskQueue.start();

    // 注册油猴脚本管理器快速菜单项
    const bridge = getGmBridge();
    bridge.registerMenuCommand('打开苯苯存图面板', () => {
        pluginUI.openPanel('saved');
    });
    bridge.registerMenuCommand('设置与诊断', () => {
        pluginUI.openPanel('settings');
    });
    bridge.registerMenuCommand('立即同步云端数据', () => {
        void syncCoordinator.syncNow({ reason: 'tampermonkey_menu' });
    });
    bridge.registerMenuCommand('查看运行日志', () => {
        pluginUI.openPanel('logs');
    });

    // 启动后调度一次静默双向增量同步
    syncCoordinator.scheduleSync('plugin_startup', 1200);
};

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initUserscript);
    } else {
        initUserscript();
    }
}
