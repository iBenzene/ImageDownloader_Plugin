import assert from 'node:assert/strict';
import test from 'node:test';
import { getGmBridge, resetGmBridge } from '../src/gmAdapter';
import { savedLinksManager } from '../src/savedLinks';
import { storage } from '../src/storage';

test('Legacy records stay untouched while new links receive identity and deduplicate', async () => {
    resetGmBridge();
    storage.saveSettings({
        serverToken: 'test',
        serverUrl: 'https://identity.test/api'
    });
    const downloader = '小红书图片下载器';
    const oldUrls = Array.from(
        { length: 200 },
        (...[, i]) => `https://xhslink.cn/legacy-${i}`
    );
    savedLinksManager.addLinks(oldUrls, downloader);
    storage.setSavedLinks(
        storage.getSavedLinks().map(item => ({ ...item, isDirty: false }))
    );
    const before = storage.getSavedLinks();
    const requests: string[] = [];
    getGmBridge().httpRequest = async ({ url }) => {
        requests.push(new URL(url).searchParams.get('url')!);
        return {
            headers: '',
            responseText: JSON.stringify({ contentKey: 'xhs:same-note' }),
            status: 200,
            statusText: ''
        };
    };
    const url = 'https://xhslink.cn/new-note';
    const prep = await savedLinksManager.prepareSaveLinks([url], downloader);
    assert.deepEqual(requests, [url]);
    assert.equal(prep.hasDuplicate, false);
    assert.equal(prep.identityCheckIncomplete, false);
    assert.deepEqual(storage.getSavedLinks(), before);
    savedLinksManager.addLinks([url], downloader, prep.resolvedContentKeys);
    const firstSaved = savedLinksManager.getActiveItemByUrl(url);
    assert.equal(firstSaved?.contentKey, 'xhs:same-note');
    const anotherUrl = 'https://xhslink.cn/another-share';
    const duplicate = await savedLinksManager.prepareSaveLinks(
        [anotherUrl],
        downloader
    );
    assert.equal(duplicate.hasDuplicate, true);
    // Insisting on saving duplicate content with a new shortlink reuses the item and updates its URL
    const [reused] = savedLinksManager.addLinks(
        [anotherUrl],
        downloader,
        duplicate.resolvedContentKeys
    );
    assert.equal(reused.id, firstSaved?.id);
    assert.equal(reused.url, anotherUrl);
    assert.equal(savedLinksManager.getActiveItemByUrl(url), undefined);
    assert.equal(
        savedLinksManager.getActiveItemByUrl(anotherUrl)?.id,
        firstSaved?.id
    );
    assert.equal(
        (await savedLinksManager.prepareSaveLinks([oldUrls[0]], downloader))
            .hasDuplicate,
        true
    );
    assert.deepEqual(
        storage.getSavedLinks().filter(item => oldUrls.includes(item.url)),
        before
    );

    getGmBridge().httpRequest = async () => {
        throw new Error('offline');
    };
    const failedUrl = 'https://xhslink.cn/unresolved-new';
    const failed = await savedLinksManager.prepareSaveLinks(
        [failedUrl],
        downloader
    );
    assert.equal(failed.identityCheckIncomplete, true);
    savedLinksManager.addLinks(
        [failedUrl],
        downloader,
        failed.resolvedContentKeys
    );
    assert.equal(
        savedLinksManager.getActiveItemByUrl(failedUrl)?.contentKey,
        null
    );
    resetGmBridge();
});
