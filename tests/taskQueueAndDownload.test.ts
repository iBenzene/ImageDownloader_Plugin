// tests/taskQueueAndDownload.test.ts

import assert from 'node:assert/strict';
import test from 'node:test';
import { getGmBridge, resetGmBridge } from '../src/gmAdapter';
import { storage } from '../src/storage';
import { taskQueue } from '../src/taskQueue';
import { TaskItem } from '../src/types';

test('Task lookup follows content identity while isolating other notes and video parts', () => {
    resetGmBridge();
    const url = 'https://www.xiaohongshu.com/explore/6afb1b95000000001b01f16a';
    const makeTask = (patch: Partial<TaskItem>): TaskItem => ({
        completedMediaCount: 0,
        createdAt: '2026-11-16T00:00:00Z',
        currentMediaIndex: 0,
        currentNoteIndex: 1,
        downloaderType: '小红书实况图片下载器',
        id: 'preheat',
        mediaSubTasks: [],
        message: '预热成功',
        status: 'completed',
        title: '预热',
        totalMediaCount: 0,
        totalNoteCount: 1,
        type: 'preheat',
        updatedAt: '2026-11-16T00:00:00Z',
        urls: [`${url}?xsec_token=old`],
        ...patch
    });
    const completed = makeTask({});
    const active = makeTask({
        id: 'download',
        status: 'running',
        type: 'download'
    });
    storage.setTasks([completed, active]);
    const reopened = `${url}?xsec_token=new&xsec_source=pc_user`;
    assert.equal(taskQueue.getActiveTaskForUrl(reopened)?.id, 'download');
    assert.equal(
        taskQueue.getLatestTaskForUrl(reopened, 'preheat')?.id,
        'preheat'
    );
    assert.equal(
        taskQueue.getLatestTaskForUrl(url.replace('6afb', '6abc')),
        undefined
    );
    assert.equal(taskQueue.getActiveTaskForUrl(reopened, 'preheat'), undefined);
    const video = 'https://www.bilibili.com/video/BV1xokcBHE5p/';
    storage.setTasks([
        makeTask({
            downloaderType: '哔哩哔哩视频下载器',
            urls: [video + '?p=2']
        })
    ]);
    assert.equal(
        taskQueue.getLatestTaskForUrl(video + '?p=2&spm_id_from=test')?.id,
        'preheat'
    );
    assert.equal(taskQueue.getLatestTaskForUrl(video + '?p=1'), undefined);
    storage.setTasks([]);
});

test.beforeEach(() => {
    resetGmBridge();
    const bridge = getGmBridge();
    // Mock fast HTTP & download responses to avoid real network timeouts in unit tests
    bridge.httpRequest = async options => {
        if (options.url.includes('/sync')) {
            return {
                headers: '',
                responseText: JSON.stringify({
                    records: [],
                    syncedAt: new Date().toISOString()
                }),
                status: 200,
                statusText: 'OK'
            };
        }
        return {
            headers: '',
            responseText: JSON.stringify({
                mediaUrls: ['https://s3.example.com/cache/xhs/1.jpg']
            }),
            status: 200,
            statusText: 'OK'
        };
    };
    bridge.downloadFile = async () => ({
        bytesTransferred: 1024,
        confirmedByManager: true
    });
});

test('Task queue deduplication prevents repeated active tasks', async () => {
    storage.saveSettings({
        serverToken: 'token',
        serverUrl: 'https://server.com/api'
    });
    const url = 'https://www.xiaohongshu.com/explore/555555555555555555555555';

    const res1 = taskQueue.enqueueTask({
        downloaderType: '小红书图片下载器',
        title: '下载笔记',
        type: 'download',
        urls: [url]
    });
    assert.equal(res1.deduplicated, false);

    const res2 = taskQueue.enqueueTask({
        downloaderType: '小红书图片下载器',
        title: '下载笔记再次点击',
        type: 'download',
        urls: [url]
    });
    assert.equal(res2.deduplicated, true);
    assert.equal(res2.task.id, res1.task.id);

    // Await queue finish
    await taskQueue.processQueue();
});

test('Page reload recovery confirms stale tasks before marking interruption', async t => {
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    storage.saveSettings({
        serverToken: 'token',
        serverUrl: 'https://server.com/api'
    });
    const url = 'https://www.xiaohongshu.com/explore/666666666666666666666666';

    // Enqueue a task and manually set it to running under a previous tab ID
    const { task } = taskQueue.enqueueTask({
        downloaderType: '小红书图片下载器',
        title: '未完成的下载',
        type: 'download',
        urls: [url]
    });

    const all = storage.getTasks();
    all[0] = {
        ...all[0],
        executorTabId: 'old_closed_tab',
        mediaSubTasks: [
            {
                filename: '1.jpg',
                index: 1,
                label: '图片 #1',
                status: 'running',
                url: 'https://s3.example.com/1.jpg'
            }
        ],
        status: 'running',
        updatedAt: new Date(now - 120000).toISOString()
    };
    storage.setTasks(all);

    // New page load initializes and runs taskQueue.recoverInterruptedTasks()
    assert.equal(taskQueue.recoverInterruptedTasks(), 0);
    now += 2001;
    const recovered = taskQueue.recoverInterruptedTasks();
    assert.equal(recovered, 1);

    const after = taskQueue.getTaskById(task.id);
    assert.equal(after?.status, 'failed');
    assert.ok(after?.message.includes('中断'));
    assert.equal(after?.mediaSubTasks[0].status, 'failed');
});
