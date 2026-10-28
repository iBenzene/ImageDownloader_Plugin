import assert from 'node:assert/strict';
import test from 'node:test';
import { resetGmBridge } from '../src/gmAdapter';
import { savedLinksManager } from '../src/savedLinks';
import { storage } from '../src/storage';
import { syncCoordinator } from '../src/sync';
import { toIso8601WithMs } from '../src/utils';

test.beforeEach(() => {
    resetGmBridge();
});

test('Server namespace isolation switches local spaces and cursors cleanly', () => {
    storage.saveSettings({
        serverToken: 'token_a',
        serverUrl: 'https://server-a.com/api'
    });
    const nsA = storage.getActiveNamespace();

    savedLinksManager.addLinks(
        ['https://www.xiaohongshu.com/explore/111111111111111111111111'],
        '小红书图片下载器'
    );
    storage.setSavedLinksLastSyncedAt('2026-10-27T00:00:00.000Z');
    assert.equal(savedLinksManager.getVisibleItems().length, 1);
    assert.equal(
        storage.getSavedLinksLastSyncedAt(),
        '2026-10-27T00:00:00.000Z'
    );

    // Switch to server B
    storage.saveSettings({
        serverToken: 'token_b',
        serverUrl: 'https://server-b.com/api'
    });
    const nsB = storage.getActiveNamespace();
    assert.notEqual(nsA, nsB);
    assert.equal(
        savedLinksManager.getVisibleItems().length,
        0,
        'Server B namespace should be clean'
    );
    assert.equal(
        storage.getSavedLinksLastSyncedAt(),
        null,
        'Server B cursor should be null'
    );

    // Switch back to server A
    storage.saveSettings({
        serverToken: 'token_a',
        serverUrl: 'https://server-a.com/api'
    });
    assert.equal(
        savedLinksManager.getVisibleItems().length,
        1,
        'Previous server data preserved in its namespace'
    );
    assert.equal(
        storage.getSavedLinksLastSyncedAt(),
        '2026-10-27T00:00:00.000Z'
    );
});

test('180-second buffered since calculation', () => {
    const lastSynced = '2026-10-27T01:00:00.000Z';
    const since = syncCoordinator.computeBufferedSince(lastSynced, true);
    // 180 seconds earlier is 00:57:00.000Z
    assert.equal(since, '2026-10-27T00:57:00.000Z');

    // Disabled incremental returns null
    assert.equal(syncCoordinator.computeBufferedSince(lastSynced, false), null);
});

test('SavedLinks duplicate handling and restoring deleted links', () => {
    storage.saveSettings({
        serverToken: 'token',
        serverUrl: 'https://server.com/api'
    });
    const urlA =
        'https://www.xiaohongshu.com/explore/222222222222222222222222?xsec_token=old';
    const urlB =
        'https://www.xiaohongshu.com/explore/222222222222222222222222?xsec_token=new';

    const [item1] = savedLinksManager.addLinks([urlA], '小红书图片下载器');
    assert.ok(item1);
    savedLinksManager.updateStatus(item1.id, 'success');
    savedLinksManager.updatePreheatResult(item1.id, {
        cachedUrls: ['https://s3.example.com/cache/xhs/cached.jpg'],
        state: 'preheated'
    });

    // Re-add same contentKey with a new URL and same downloaderType:
    // Should reuse ID, update URL, reset status to 'none', and preserve cachedUrls
    const [reusedSameType] = savedLinksManager.addLinks(
        [urlB],
        '小红书图片下载器'
    );
    assert.equal(savedLinksManager.getVisibleItems().length, 1);
    assert.equal(
        reusedSameType.id,
        item1.id,
        'Should reuse existing record ID for same contentKey'
    );
    assert.equal(
        reusedSameType.url,
        urlB,
        'Should update URL to the latest saved URL'
    );
    assert.equal(
        reusedSameType.status,
        'none',
        'Should reset status to none on re-save'
    );
    assert.deepEqual(
        reusedSameType.cachedUrls,
        ['https://s3.example.com/cache/xhs/cached.jpg'],
        'Should preserve existing cachedUrls when downloaderType is unchanged'
    );
    assert.equal(reusedSameType.preheatState, 'preheated');

    // Re-add with a different downloaderType: should clear cachedUrls
    const [reusedDiffType] = savedLinksManager.addLinks(
        [urlB],
        '小红书视频下载器'
    );
    assert.equal(reusedDiffType.id, item1.id);
    assert.equal(reusedDiffType.downloaderType, '小红书视频下载器');
    assert.equal(
        reusedDiffType.cachedUrls,
        null,
        'Should clear cachedUrls when downloaderType changes'
    );
    assert.equal(reusedDiffType.preheatState, 'unpreheated');

    // Soft delete item
    savedLinksManager.deleteItem(item1.id);
    assert.equal(savedLinksManager.getVisibleItems().length, 0);
    assert.equal(savedLinksManager.getAllItems().length, 1);
    assert.ok(savedLinksManager.getAllItems()[0].isDeleted);

    // Re-add via original URL (same contentKey): should reuse ID and restore
    const [restored] = savedLinksManager.addLinks([urlA], '小红书视频下载器');
    assert.equal(restored.id, item1.id, 'Should reuse existing record ID');
    assert.ok(!restored.isDeleted, 'Should be active again');
    assert.equal(restored.url, urlA, 'Should update URL to latest saved URL');
    assert.equal(restored.downloaderType, '小红书视频下载器');
    assert.equal(
        restored.status,
        'none',
        'Status should be reset when restored'
    );
});

test('Merge remote records preserves local content_key when remote lacks it', () => {
    storage.saveSettings({
        serverToken: 'token',
        serverUrl: 'https://server.com/api'
    });
    const url = 'https://www.xiaohongshu.com/explore/333333333333333333333333';
    const [localItem] = savedLinksManager.addLinks([url], '小红书图片下载器', {
        [url]: 'xhs:333333333333333333333333'
    });
    assert.equal(localItem.contentKey, 'xhs:333333333333333333333333');

    // Remote sends updated record with newer updatedAt but null content_key
    const remoteApi = {
        cached_urls: null,
        content_key: null,
        created_at: localItem.timestamp,
        downloader: '小红书图片下载器',
        id: localItem.id,
        is_deleted: false,
        status: 'none' as const,
        updated_at: toIso8601WithMs(Date.now() + 5000),
        url
    };

    savedLinksManager.mergeRemoteRecords([remoteApi]);
    const merged = savedLinksManager.getItemById(localItem.id);
    assert.ok(merged);
    assert.equal(
        merged?.contentKey,
        'xhs:333333333333333333333333',
        'Must retain local contentKey'
    );
    assert.ok(
        merged?.isDirty,
        'Must mark dirty so contentKey will be pushed back to server'
    );
});

test('Snapshot dirty clearing avoids wiping in-flight local modifications', async () => {
    storage.saveSettings({
        serverToken: 'token',
        serverUrl: 'https://server.com/api'
    });
    const url = 'https://www.xiaohongshu.com/explore/444444444444444444444444';
    const [item] = savedLinksManager.addLinks([url], '小红书图片下载器');

    // Snapshot taken at T1
    const snapshot = new Map<string, string>([[item.id, item.updatedAt]]);

    // User modifies item locally at T2 while request is in flight
    await new Promise(r => setTimeout(r, 15));
    savedLinksManager.updateStatus(item.id, 'success');
    const modified = savedLinksManager.getItemById(item.id);
    assert.notEqual(modified?.updatedAt, snapshot.get(item.id));

    // Sync completion callback tries to clear snapshot
    savedLinksManager.markSnapshotAsSynced(snapshot);
    const afterSync = savedLinksManager.getItemById(item.id);
    assert.ok(
        afterSync?.isDirty,
        'Dirty flag must NOT be cleared because item was modified during sync'
    );
});
