import assert from 'node:assert/strict';
import test from 'node:test';
import { getGmBridge, resetGmBridge } from '../src/gmAdapter';
import { storage } from '../src/storage';
import { taskQueue } from '../src/taskQueue';

test.beforeEach(() => {
    resetGmBridge();
    const bridge = getGmBridge();
    // Mock fast HTTP & download responses to avoid real network timeouts in unit tests
    bridge.httpRequest = async options => {
        if (options.url.includes('/sync')) {
            return {
                status: 200,
                statusText: 'OK',
                responseText: JSON.stringify({ records: [], syncedAt: new Date().toISOString() }),
                headers: '',
            };
        }
        return {
            status: 200,
            statusText: 'OK',
            responseText: JSON.stringify({ mediaUrls: ['https://s3.example.com/cache/xhs/1.jpg'] }),
            headers: '',
        };
    };
    bridge.downloadFile = async () => ({
        confirmedByManager: true,
        bytesTransferred: 1024,
    });
});

test('Task queue deduplication prevents repeated active tasks', async () => {
    storage.saveSettings({ serverUrl: 'https://server.com/api', serverToken: 'token' });
    const url = 'https://www.xiaohongshu.com/explore/555555555555555555555555';

    const res1 = taskQueue.enqueueTask({
        type: 'download',
        title: '下载笔记',
        urls: [url],
        downloaderType: '小红书图片下载器',
    });
    assert.equal(res1.deduplicated, false);

    const res2 = taskQueue.enqueueTask({
        type: 'download',
        title: '下载笔记再次点击',
        urls: [url],
        downloaderType: '小红书图片下载器',
    });
    assert.equal(res2.deduplicated, true);
    assert.equal(res2.task.id, res1.task.id);

    // Await queue finish
    await taskQueue.processQueue();
});

test('Page reload recovery marks running tasks as interrupted rather than blind completion', async () => {
    storage.saveSettings({ serverUrl: 'https://server.com/api', serverToken: 'token' });
    const url = 'https://www.xiaohongshu.com/explore/666666666666666666666666';

    // Enqueue a task and manually set it to running under a previous tab ID
    const { task } = taskQueue.enqueueTask({
        type: 'download',
        title: '未完成的下载',
        urls: [url],
        downloaderType: '小红书图片下载器',
    });

    const all = storage.getTasks();
    all[0] = {
        ...all[0],
        status: 'running',
        executorTabId: 'old_closed_tab',
        mediaSubTasks: [
            {
                index: 1,
                label: '图片 #1',
                url: 'https://s3.example.com/1.jpg',
                filename: '1.jpg',
                status: 'running',
            },
        ],
    };
    storage.setTasks(all);

    // New page load initializes and runs taskQueue.recoverInterruptedTasks()
    const recovered = taskQueue.recoverInterruptedTasks();
    assert.equal(recovered, 1);

    const after = taskQueue.getTaskById(task.id);
    assert.equal(after?.status, 'interrupted');
    assert.ok(after?.message.includes('中断'));
    assert.equal(after?.mediaSubTasks[0].status, 'interrupted');
});
