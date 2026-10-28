import assert from 'node:assert/strict';
import test from 'node:test';
import { getGmBridge, resetGmBridge } from '../src/gmAdapter';
import { storage } from '../src/storage';
import { taskQueue } from '../src/taskQueue';
import { STORAGE_KEYS } from '../src/constants';
import { savedLinksManager, toSavedLinkAPI } from '../src/savedLinks';

test('Automatic preheat sends proxy requests, resumes pending tasks and survives sync echoes', async () => {
    resetGmBridge();
    storage.saveSettings({
        preheatResources: true,
        serverSideProxy: false,
        serverToken: 'test',
        serverUrl: 'https://audit.invalid/api'
    });
    const requests: URL[] = [];
    let fail = false;
    getGmBridge().httpRequest = async options => {
        const url = new URL(options.url);
        requests.push(url);
        return {
            headers: '',
            responseText: JSON.stringify(
                url.pathname.endsWith('/extract')
                    ? fail
                        ? { error: 'cache write failed' }
                        : {
                              mediaUrls: [
                                  'https://storage.example/cache/xhs/test.jpg'
                              ]
                          }
                    : { records: [], syncedAt: new Date().toISOString() }
            ),
            status: fail && url.pathname.endsWith('/extract') ? 500 : 200,
            statusText: 'OK'
        };
    };
    const save = (id: string) =>
        taskQueue.enqueueTask({
            downloaderType: '小红书图片下载器',
            title: 'test',
            type: 'save',
            urls: [`https://www.xiaohongshu.com/explore/${id}`]
        });
    const settle = () => new Promise<void>(resolve => setImmediate(resolve));
    const extractRequests = () =>
        requests.filter(u => u.pathname.endsWith('/extract'));
    try {
        save('111111111111111111111111');
        await settle();
        assert.equal(extractRequests().length, 1);
        assert.equal(extractRequests()[0].searchParams.get('useProxy'), 'true');
        assert.equal(storage.getSavedLinks()[0].preheatState, 'preheated');
        assert.deepEqual(storage.getSavedLinks()[0].cachedUrls, [
            'https://storage.example/cache/xhs/test.jpg'
        ]);

        const leaseKey = `${STORAGE_KEYS.EXECUTOR_LEASE}_${storage.getActiveNamespace()}`;
        getGmBridge().setValue(leaseKey, {
            acquiredAt: Date.now(),
            expiresAt: Date.now() + 60000,
            tabId: 'other-tab'
        });
        save('222222222222222222222222');
        await settle();
        assert.equal(storage.getTasks()[0].status, 'pending');
        taskQueue.start();
        getGmBridge().deleteValue(leaseKey);
        await new Promise(resolve => setTimeout(resolve, 2100));
        assert.equal(storage.getTasks()[0].status, 'completed');
        assert.equal(extractRequests().length, 2);
        taskQueue.stop();

        getGmBridge().setValue(leaseKey, {
            acquiredAt: Date.now(),
            expiresAt: Date.now() + 60000,
            tabId: 'other-tab'
        });
        save('333333333333333333333333');
        await settle();
        getGmBridge().deleteValue(leaseKey);
        taskQueue.start();
        await settle();
        assert.equal(
            storage.getTasks()[0].status,
            'completed',
            'Startup must resume pending tasks'
        );
        taskQueue.stop();

        fail = true;
        save('444444444444444444444444');
        await settle();
        const failed = storage.getSavedLinks()[0];
        assert.equal(failed.preheatState, 'failed');
        savedLinksManager.mergeRemoteRecords([toSavedLinkAPI(failed)]);
        assert.equal(storage.getSavedLinks()[0].preheatState, 'failed');
        assert.equal(
            storage.getSavedLinks()[0].preheatError,
            'cache write failed'
        );
        savedLinksManager.updatePreheatResult(failed.id, {
            state: 'preheating'
        });
        savedLinksManager.mergeRemoteRecords([toSavedLinkAPI(failed)]);
        assert.equal(storage.getSavedLinks()[0].preheatState, 'preheating');
        savedLinksManager.mergeRemoteRecords([
            {
                ...toSavedLinkAPI(failed),
                cached_urls: ['https://storage.example/cache/new.jpg']
            }
        ]);
        assert.equal(storage.getSavedLinks()[0].preheatState, 'cached_remote');

        storage.saveSettings({ preheatResources: false });
        const count = extractRequests().length;
        save('555555555555555555555555');
        await settle();
        assert.equal(
            extractRequests().length,
            count,
            'Disabled preheat must not issue extraction requests'
        );
    } finally {
        taskQueue.stop();
    }
});
