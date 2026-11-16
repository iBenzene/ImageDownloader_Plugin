// tests/interruptedRecovery.test.ts

import assert from 'node:assert/strict';
import test from 'node:test';
import { STORAGE_KEYS } from '../src/constants';
import { getGmBridge, resetGmBridge } from '../src/gmAdapter';
import { savedLinksManager } from '../src/savedLinks';
import { CURRENT_TAB_ID, storage } from '../src/storage';
import { taskQueue } from '../src/taskQueue';
import { TaskItem } from '../src/types';

const url = 'https://www.xiaohongshu.com/explore/123456789012345678901234';
const runningTask = (now: number): TaskItem => ({
    completedMediaCount: 0,
    createdAt: new Date(now - 120000).toISOString(),
    currentMediaIndex: 0,
    currentNoteIndex: 1,
    downloaderType: '小红书图片下载器',
    executorTabId: 'other-tab',
    id: 'recovery',
    mediaSubTasks: [],
    message: '预热中',
    status: 'running',
    title: '预热测试',
    totalMediaCount: 0,
    totalNoteCount: 1,
    type: 'preheat',
    updatedAt: new Date(now - 120000).toISOString(),
    urls: [url]
});

test.beforeEach(() => resetGmBridge());

test('Live leases protect both local and remote executors; expiry needs grace and a second check', t => {
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const task = runningTask(now);
    storage.setTasks([task]);
    const leaseKey = `${STORAGE_KEYS.EXECUTOR_LEASE}_${storage.getActiveNamespace()}`;
    const bridge = getGmBridge();
    const lease = {
        acquiredAt: now,
        expiresAt: now + 15000,
        tabId: 'other-tab',
        taskId: task.id
    };
    bridge.setValue(leaseKey, lease);
    assert.equal(taskQueue.recoverInterruptedTasks(), 0);
    now += 59000;
    assert.equal(taskQueue.recoverInterruptedTasks(), 0);
    now += 2000;
    assert.equal(taskQueue.recoverInterruptedTasks(), 0);
    bridge.setValue(leaseKey, { ...lease, expiresAt: now + 15000 });
    now += 2001;
    assert.equal(taskQueue.recoverInterruptedTasks(), 0);
    storage.setTasks([{ ...task, executorTabId: CURRENT_TAB_ID }]);
    bridge.setValue(leaseKey, {
        ...lease,
        expiresAt: now + 15000,
        tabId: CURRENT_TAB_ID
    });
    assert.equal(taskQueue.recoverInterruptedTasks(), 0);
    now += 61000;
    assert.equal(taskQueue.recoverInterruptedTasks(), 0);
    now += 2001;
    assert.equal(taskQueue.recoverInterruptedTasks(), 1);
    assert.equal(taskQueue.getUnresolvedTasks().length, 1);
    assert.equal(taskQueue.getTaskById(task.id)!.status, 'failed');
});

test('Recovery updates preheating favorites without losing cache or completed items', t => {
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const [item] = savedLinksManager.addLinks([url], '小红书图片下载器');
    savedLinksManager.updatePreheatResult(item.id, {
        cachedUrls: ['https://s3.example.com/kept.jpg'],
        state: 'preheated'
    });
    savedLinksManager.updatePreheatResult(item.id, { state: 'preheating' });
    const completedUrl =
        'https://www.xiaohongshu.com/explore/223456789012345678901234';
    const [completed] = savedLinksManager.addLinks(
        [completedUrl],
        '小红书图片下载器'
    );
    savedLinksManager.updatePreheatResult(completed.id, {
        cachedUrls: ['https://s3.example.com/completed.jpg'],
        state: 'preheated'
    });
    storage.setTasks([
        { ...runningTask(now), savedLinkId: item.id, urls: [url, completedUrl] }
    ]);
    assert.equal(taskQueue.recoverInterruptedTasks(), 0);
    assert.equal(
        savedLinksManager.getItemById(item.id)!.preheatState,
        'preheating'
    );
    now += 2001;
    assert.equal(taskQueue.recoverInterruptedTasks(), 1);
    assert.equal(
        savedLinksManager.getItemById(item.id)!.preheatState,
        'failed'
    );
    assert.deepEqual(savedLinksManager.getItemById(item.id)!.cachedUrls, [
        'https://s3.example.com/kept.jpg'
    ]);
    assert.equal(
        savedLinksManager.getItemById(completed.id)!.preheatState,
        'preheated'
    );
    taskQueue.ignoreFailure('recovery');
    taskQueue.recoverInterruptedTasks();
    assert.equal(taskQueue.getUnresolvedTasks().length, 0);
    assert.equal(
        savedLinksManager.getItemById(item.id)!.preheatState,
        'failed'
    );
});

test('Orphan preheating records become actionable failed tasks only once', () => {
    const [item] = savedLinksManager.addLinks([url], '小红书图片下载器');
    savedLinksManager.updatePreheatResult(item.id, { state: 'preheating' });
    taskQueue.recoverInterruptedTasks();
    assert.equal(
        savedLinksManager.getItemById(item.id)!.preheatState,
        'failed'
    );
    assert.equal(taskQueue.getUnresolvedTasks().length, 1);
    taskQueue.recoverInterruptedTasks();
    assert.equal(storage.getTasks().length, 1);
});

test('Late preheat response cannot overwrite a task or favorite marked failed after interruption', async () => {
    storage.saveSettings({ serverUrl: 'https://server.example/api' });
    const [item] = savedLinksManager.addLinks([url], '小红书图片下载器');
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
        release = resolve;
    });
    getGmBridge().httpRequest = async () => {
        await gate;
        return {
            headers: '',
            responseText: JSON.stringify({
                mediaUrls: ['https://s3.example.com/cache/xhs/1.jpg']
            }),
            status: 200,
            statusText: 'OK'
        };
    };
    const { task } = taskQueue.enqueueTask({
        downloaderType: '小红书图片下载器',
        savedLinkId: item.id,
        title: '预热测试',
        type: 'preheat',
        urls: [url]
    });
    assert.equal(
        savedLinksManager.getItemById(item.id)!.preheatState,
        'preheating'
    );
    storage.setTasks(
        storage.getTasks().map(record => ({
            ...record,
            downloadFailurePending: true,
            status: 'failed'
        }))
    );
    savedLinksManager.updatePreheatResult(item.id, {
        error: '预热中断',
        state: 'failed'
    });
    release();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(taskQueue.getTaskById(task.id)!.status, 'failed');
    assert.equal(
        savedLinksManager.getItemById(item.id)!.preheatState,
        'failed'
    );
    assert.equal(
        savedLinksManager.getItemById(item.id)!.cachedUrls?.length || 0,
        0
    );
});

test('Legacy interruption states migrate to failure without losing completed files, caches or ignored alerts', () => {
    const bridge = getGmBridge();
    const namespace = storage.getActiveNamespace();
    const taskKey = `benben_${namespace}_tasks`;
    const savedKey = `benben_${namespace}_saved_links`;
    const task = {
        ...runningTask(Date.now()),
        mediaSubTasks: [
            {
                filename: '1.jpg',
                index: 1,
                label: '图片 1',
                status: 'completed',
                url: 'https://s3.example.com/1.jpg'
            },
            {
                filename: '2.jpg',
                index: 2,
                label: '图片 2',
                status: 'interrupted',
                url: 'https://s3.example.com/2.jpg'
            }
        ],
        message: '已中断，结果待确认',
        status: 'interrupted'
    };
    bridge.setValue(taskKey, [
        task,
        { ...task, downloadFailurePending: false, id: 'ignored' }
    ]);
    const [item] = savedLinksManager.addLinks([url], '小红书图片下载器');
    bridge.setValue(savedKey, [
        {
            ...item,
            cachedUrls: ['https://s3.example.com/kept.jpg'],
            preheatError: '结果待确认',
            preheatState: 'interrupted'
        }
    ]);
    const migrated = storage.getTasks();
    assert.equal(migrated[0].status, 'failed');
    assert.equal(migrated[0].message, '页面关闭或刷新，任务中断');
    assert.equal(migrated[0].mediaSubTasks[0].status, 'completed');
    assert.equal(migrated[0].mediaSubTasks[1].status, 'failed');
    assert.equal(taskQueue.getUnresolvedTasks().length, 1);
    assert.equal(migrated[1].downloadFailurePending, false);
    assert.equal(bridge.getValue<TaskItem[]>(taskKey, [])[0].status, 'failed');
    const saved = storage.getSavedLinks()[0];
    assert.equal(saved.preheatState, 'failed');
    assert.equal(saved.preheatError, '预热中断');
    assert.deepEqual(saved.cachedUrls, ['https://s3.example.com/kept.jpg']);
    assert.equal(
        bridge.getValue<Array<{ preheatState: string }>>(savedKey, [])[0]
            .preheatState,
        'failed'
    );
});
