import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from 'happy-dom';
import {
    BilibiliPageAdapter,
    resolveBilibiliVideoUrl
} from '../src/bilibiliPageAdapter';
import { getGmBridge, resetGmBridge } from '../src/gmAdapter';
import { preheatService } from '../src/preheat';
import { storage } from '../src/storage';
import { downloadService } from '../src/downloader';
import { renderTypePillsHtml } from '../src/ui/helpers';
import { isSupportedDownloader } from '../src/utils';

const videoUrl = 'https://www.bilibili.com/video/BV1xx411c7mD/';

test('Bilibili URL recognition preserves part and case, strips tracking and rejects unrelated pages', () => {
    assert.deepEqual(
        resolveBilibiliVideoUrl(`${videoUrl}?p=2&spm_id_from=share`),
        {
            noteId: 'BV1xx411c7mD:p2',
            url: `${videoUrl}?p=2`
        }
    );
    assert.equal(
        resolveBilibiliVideoUrl('https://m.bilibili.com/video/av123')?.noteId,
        'av123:p1'
    );
    for (const url of [
        'https://www.bilibili.com/',
        'https://www.bilibili.com/bangumi/play/ep123',
        'https://t.bilibili.com/123',
        'https://evil.bilibili.com/video/BV1xx411c7mD',
        `${videoUrl}?p=0`,
        `${videoUrl}?p=-1`,
        `${videoUrl}?p=1.5`,
        `${videoUrl}?p=9007199254740992`
    ]) {
        assert.equal(resolveBilibiliVideoUrl(url), null, url);
    }
});

test('Bilibili context follows navigation and clears on non-video pages', () => {
    const win = new Window({ url: videoUrl });
    const previousWindow = Object.getOwnPropertyDescriptor(
        globalThis,
        'window'
    );
    const previousDocument = Object.getOwnPropertyDescriptor(
        globalThis,
        'document'
    );
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: win
    });
    Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: win.document
    });
    try {
        win.document.body.innerHTML = '<h1 class="video-title">测试视频</h1>';
        const adapter = new BilibiliPageAdapter();
        let changes = 0;
        adapter.onContextChange(() => changes++);
        assert.equal(adapter.evaluateCurrentPage()?.title, '测试视频');
        assert.equal(adapter.getEffectiveDownloader(), '哔哩哔哩视频下载器');
        adapter.evaluateCurrentPage();
        assert.equal(changes, 1);
        adapter.setManualDownloaderForCurrentNote('小红书图片下载器');
        assert.equal(adapter.getEffectiveDownloader(), '哔哩哔哩视频下载器');
        win.history.pushState({}, '', '?p=2');
        assert.equal(adapter.evaluateCurrentPage()?.url, `${videoUrl}?p=2`);
        win.history.pushState({}, '', '/');
        assert.equal(adapter.evaluateCurrentPage(), null);
        assert.equal(changes, 3);
    } finally {
        if (previousWindow) {
            Object.defineProperty(globalThis, 'window', previousWindow);
        } else {
            Reflect.deleteProperty(globalThis, 'window');
        }
        if (previousDocument) {
            Object.defineProperty(globalThis, 'document', previousDocument);
        } else {
            Reflect.deleteProperty(globalThis, 'document');
        }
        win.happyDOM.abort();
    }
});

test('Bilibili downloads use the server and produce video subtasks', async () => {
    resetGmBridge();
    storage.saveSettings({
        serverToken: 'test',
        serverUrl: 'https://test.invalid/api'
    });
    const requests: string[] = [];
    getGmBridge().httpRequest = async options => {
        requests.push(options.url);
        return {
            headers: '',
            responseText: JSON.stringify({
                mediaUrls: ['https://storage.example/bilibili/clip.mp4']
            }),
            status: 200,
            statusText: 'OK'
        };
    };
    getGmBridge().downloadFile = async () => ({
        bytesTransferred: 1024,
        confirmedByManager: true
    });
    const result = await downloadService.downloadSingleNote({
        downloaderType: '哔哩哔哩视频下载器',
        url: `${videoUrl}?p=2`
    });
    assert.equal(result.ok, true);
    assert.equal(result.mediaSubTasks[0].label, '视频 #1');
    assert.match(
        result.mediaSubTasks[0].filename,
        /bilibili-BV1xx411c7mD-p2.*\.mp4$/
    );
    assert.equal(
        new URL(requests[0]).searchParams.get('url'),
        `${videoUrl}?p=2`
    );
    assert.ok(decodeURIComponent(requests[0]).includes('哔哩哔哩视频下载器'));
    const preheated = await preheatService.preheatLinks({
        items: [{ downloaderType: '哔哩哔哩视频下载器', url: videoUrl }]
    });
    assert.equal(preheated.ok, true);
    assert.deepEqual(preheated.cachedUrlsBySourceUrl[videoUrl], [
        'https://storage.example/bilibili/clip.mp4'
    ]);
    assert.equal(new URL(requests[1]).searchParams.get('useProxy'), 'true');
    const cached = await downloadService.downloadSingleNote({
        cachedUrls: preheated.cachedUrlsBySourceUrl[videoUrl],
        downloaderType: '哔哩哔哩视频下载器',
        url: videoUrl
    });
    assert.equal(cached.ok, true);
    assert.equal(cached.usedCachedUrls, true);
    assert.equal(
        requests.length,
        2,
        'Cached downloads should not re-extract media'
    );
    assert.equal(isSupportedDownloader('微博图片下载器'), false);
    const pills = renderTypePillsHtml('哔哩哔哩视频下载器', false);
    assert.ok(pills.includes('哔哩哔哩视频'));
    assert.ok(!pills.includes('小红书'));
});
