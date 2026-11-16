// tests/downloadFailure.test.ts

import assert from 'node:assert/strict';
import test from 'node:test';
import { Window, HTMLButtonElement } from 'happy-dom';
import { MAX_TASK_ITEMS } from '../src/constants';
import { downloadService } from '../src/downloader';
import { resetGmBridge } from '../src/gmAdapter';
import { preheatService } from '../src/preheat';
import { storage } from '../src/storage';
import { taskQueue } from '../src/taskQueue';
import { TaskItem } from '../src/types';
import { BenbenPluginUI } from '../src/ui/panel';

const failedTask = (id = 'failed'): TaskItem => ({
    completedMediaCount: 1,
    createdAt: new Date().toISOString(),
    currentMediaIndex: 1,
    currentNoteIndex: 1,
    downloaderType: '小红书图片下载器',
    id,
    mediaSubTasks: [],
    message: '部分下载失败',
    status: 'failed',
    title: '下载测试',
    totalMediaCount: 2,
    totalNoteCount: 1,
    type: 'download',
    updatedAt: new Date().toISOString(),
    urls: ['https://www.xiaohongshu.com/explore/123456789012345678901234']
});

test.beforeEach(() => resetGmBridge());

test('Failure survives retry, repeats with a new alert, and clears only on success or ignore', async () => {
    storage.setTasks([failedTask()]);
    const original = downloadService.downloadSingleNote;
    let succeed = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
        release = resolve;
    });
    downloadService.downloadSingleNote = async () => {
        await gate;
        return {
            cacheDownloadFailed: false,
            completedMediaCount: 1,
            error: succeed ? undefined : '网络错误',
            mediaSubTasks: [],
            ok: succeed,
            partialSuccess: !succeed,
            totalMediaCount: succeed ? 1 : 2,
            usedCachedUrls: false
        };
    };
    try {
        assert.equal(taskQueue.getUnresolvedTasks().length, 1);
        taskQueue.retryTask('failed');
        assert.equal(taskQueue.getUnresolvedTasks().length, 1);
        release();
        while (taskQueue.getTaskById('failed')!.status === 'running') {
            await new Promise<void>(resolve => setImmediate(resolve));
        }
        const firstFailureId =
            taskQueue.getTaskById('failed')!.downloadFailureId;
        assert.ok(firstFailureId);
        taskQueue.ignoreFailure('failed');
        assert.equal(taskQueue.getUnresolvedTasks().length, 0);
        taskQueue.retryTask('failed');
        while (taskQueue.getTaskById('failed')!.status === 'running') {
            await new Promise<void>(resolve => setImmediate(resolve));
        }
        assert.notEqual(
            taskQueue.getTaskById('failed')!.downloadFailureId,
            firstFailureId
        );
        assert.equal(taskQueue.getUnresolvedTasks().length, 1);
        succeed = true;
        taskQueue.retryTask('failed');
        while (taskQueue.getTaskById('failed')!.status === 'running') {
            await new Promise<void>(resolve => setImmediate(resolve));
        }
        assert.equal(taskQueue.getTaskById('failed')!.status, 'completed');
        assert.equal(taskQueue.getUnresolvedTasks().length, 0);
    } finally {
        downloadService.downloadSingleNote = original;
    }
});

test('Unresolved failures survive task limits and cancellation cleanup; namespaces stay separate', () => {
    storage.setTasks([
        ...Array.from(Array(MAX_TASK_ITEMS).keys()).map(i => ({
            ...failedTask(String(i)),
            status: 'completed' as const
        })),
        failedTask(),
        {
            ...failedTask('cancelled'),
            downloadFailurePending: true,
            status: 'cancelled'
        },
        { ...failedTask('preheat'), type: 'preheat' },
        { ...failedTask('sync'), type: 'sync' },
        { ...failedTask('save'), type: 'save' }
    ]);
    taskQueue.enqueueTask({
        downloaderType: '小红书图片下载器',
        title: '收藏',
        type: 'save',
        urls: []
    });
    assert.equal(taskQueue.getUnresolvedTasks().length, 3);
    taskQueue.clearFinishedTasks();
    assert.ok(taskQueue.getTaskById('cancelled'));
    storage.saveSettings({ serverUrl: 'https://other.example' });
    assert.equal(taskQueue.getUnresolvedTasks().length, 0);
});

test('Preheat failures stay pending during retry and clear on success; ignored failures notify again', async () => {
    storage.setTasks([{ ...failedTask('preheat'), type: 'preheat' }]);
    const original = preheatService.preheatLinks;
    let succeed = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
        release = resolve;
    });
    preheatService.preheatLinks = async () => {
        await gate;
        return {
            cachedUrlsBySourceUrl: {},
            error: succeed ? undefined : 'HTTP 502',
            failedUrls: succeed ? [] : [{ error: 'HTTP 502', url: 'test' }],
            ok: succeed,
            totalCachedCount: succeed ? 1 : 0
        };
    };
    try {
        assert.equal(taskQueue.getUnresolvedTasks().length, 1);
        taskQueue.retryTask('preheat');
        assert.equal(taskQueue.getUnresolvedTasks().length, 1);
        release();
        while (taskQueue.getTaskById('preheat')!.status === 'running') {
            await new Promise<void>(resolve => setImmediate(resolve));
        }
        const failureId = taskQueue.getTaskById('preheat')!.downloadFailureId;
        assert.ok(failureId);
        taskQueue.ignoreFailure('preheat');
        assert.equal(taskQueue.getUnresolvedTasks().length, 0);
        taskQueue.retryTask('preheat');
        while (taskQueue.getTaskById('preheat')!.status === 'running') {
            await new Promise<void>(resolve => setImmediate(resolve));
        }
        assert.notEqual(
            taskQueue.getTaskById('preheat')!.downloadFailureId,
            failureId
        );
        assert.equal(taskQueue.getUnresolvedTasks().length, 1);
        succeed = true;
        taskQueue.retryTask('preheat');
        while (taskQueue.getTaskById('preheat')!.status === 'running') {
            await new Promise<void>(resolve => setImmediate(resolve));
        }
        assert.equal(taskQueue.getTaskById('preheat')!.status, 'completed');
        assert.equal(taskQueue.getUnresolvedTasks().length, 0);
    } finally {
        preheatService.preheatLinks = original;
    }
});

test('Viewing and collapsing preheat failures keep badges; ignoring updates persisted state', async () => {
    const browser = new Window({ url: 'https://www.xiaohongshu.com/' });
    const original = new Map<string, PropertyDescriptor | undefined>();
    for (const key of ['window', 'document']) {
        original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
        Object.defineProperty(globalThis, key, {
            configurable: true,
            value: (browser as unknown as Record<string, unknown>)[key],
            writable: true
        });
    }
    try {
        storage.setTasks([{ ...failedTask(), type: 'preheat' }]);
        const ui = new BenbenPluginUI();
        ui.init();
        const root =
            browser.document.getElementById('benben-xhs-host')!.shadowRoot!;
        const click = (action: string) =>
            root
                .querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!
                .click();
        assert.ok(root.querySelector('.bb-failure-toast'));
        assert.match(
            root.querySelector('.bb-failure-toast strong')!.textContent!,
            /失败/
        );
        click('dismiss-failure-toast');
        assert.ok(root.querySelector('.bb-failure-reminder'));
        assert.equal(taskQueue.getUnresolvedTasks().length, 1);
        click('view-task-failures');
        assert.ok(root.querySelector('.bb-failure-banner'));
        assert.equal(taskQueue.getUnresolvedTasks().length, 1);
        assert.equal(
            root.querySelector('[data-action="toggle-unresolved-tasks"]'),
            null
        );
        assert.ok(
            root
                .querySelector('[data-input="task-filter"]')!
                .hasAttribute('hidden')
        );
        click('show-all-tasks');
        assert.equal(
            root
                .querySelector('[data-input="task-filter"]')!
                .hasAttribute('hidden'),
            false
        );
        click('view-task-failures');
        click('ignore-task-failure');
        assert.equal(root.querySelector('.bb-failure-banner'), null);
        assert.equal(root.querySelector('.bb-failure-count'), null);
        assert.equal(storage.getTasks()[0].downloadFailurePending, false);
        assert.equal(
            root
                .querySelector('[data-input="task-filter"]')!
                .hasAttribute('hidden'),
            false
        );
        ui.closePanel();
        assert.equal(root.querySelector('.bb-failure-toast'), null);
    } finally {
        await browser.happyDOM.close();
        for (const [key, descriptor] of original) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
    }
});
