import assert from 'node:assert/strict';
import test from 'node:test';
import {
    determineXhsDownloaderType,
    extractNoteInfoFromInitialState,
    resolveFullNoteUrlFromPage,
} from '../src/xhsPageAdapter';

test('extractNoteInfoFromInitialState handles video notes and live photos', () => {
    const fakeState = {
        note: {
            firstNoteId: '666666666666666666666661',
            noteDetailMap: {
                '666666666666666666666661': {
                    note: {
                        id: '666666666666666666666661',
                        title: '测试视频笔记',
                        type: 'video',
                        video: { media: { stream: {} } },
                    },
                },
                '666666666666666666666662': {
                    note: {
                        id: '666666666666666666666662',
                        title: '测试实况笔记',
                        type: 'normal',
                        imageList: [
                            { urlDefault: 'https://img.com/1.jpg', livePhoto: true, stream: { h264: [{ masterUrl: 'https://v.com/1.mp4' }] } },
                        ],
                    },
                },
                '666666666666666666666663': {
                    note: {
                        id: '666666666666666666666663',
                        title: '普通图文笔记',
                        type: 'normal',
                        imageList: [
                            { urlDefault: 'https://img.com/1.jpg', livePhoto: false },
                        ],
                    },
                },
            },
        },
    };

    const videoInfo = extractNoteInfoFromInitialState(fakeState, '666666666666666666666661');
    assert.equal(videoInfo?.hasVideo, true);
    const detVideo = determineXhsDownloaderType({ stateInfo: videoInfo });
    assert.equal(detVideo.downloader, '小红书视频下载器');

    const liveInfo = extractNoteInfoFromInitialState(fakeState, '666666666666666666666662');
    assert.equal(liveInfo?.hasLivePhoto, true);
    const detLive = determineXhsDownloaderType({ stateInfo: liveInfo });
    assert.equal(detLive.downloader, '小红书实况图片下载器');

    const imgInfo = extractNoteInfoFromInitialState(fakeState, '666666666666666666666663');
    assert.equal(imgInfo?.hasLivePhoto, false);
    const detImg = determineXhsDownloaderType({ stateInfo: imgInfo });
    assert.equal(detImg.downloader, '小红书图片下载器');
});

test('determineXhsDownloaderType returns null when uncertain to prevent silent misclassification', () => {
    const result = determineXhsDownloaderType({});
    assert.equal(result.downloader, null);
    assert.ok(result.reason.includes('手动选择'));
});

test('resolveFullNoteUrlFromPage retains xsec_token', () => {
    const href = 'https://www.xiaohongshu.com/explore/777777777777777777777777?xsec_token=TOKEN_XYZ_123&xsec_source=pc_search';
    const resolved = resolveFullNoteUrlFromPage(href);
    assert.ok(resolved);
    assert.equal(resolved?.noteId, '777777777777777777777777');
    assert.ok(resolved?.url.includes('xsec_token=TOKEN_XYZ_123'));
    assert.ok(resolved?.url.includes('xsec_source=pc_search'));
});
