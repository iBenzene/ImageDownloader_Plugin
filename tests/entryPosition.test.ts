import assert from 'node:assert/strict';
import test from 'node:test';
import {
    Window,
    HTMLElement as HappyHTMLElement,
    HTMLButtonElement
} from 'happy-dom';
import { getGmBridge, resetGmBridge } from '../src/gmAdapter';
import { storage } from '../src/storage';
import {
    EntryPositionState,
    observeEntryPosition,
    positionEntryBar,
    resetEntryPosition
} from '../src/ui/entryPosition';
import { BenbenPluginUI } from '../src/ui/panel';
import { xhsPageAdapter } from '../src/xhsPageAdapter';

test('Entry follows visible note media and stays inside a narrow viewport', () => {
    const browser = new Window({ height: 900, width: 1440 });
    browser.document.body.innerHTML =
        '<div class="note-container"><div class="media-container" id="hidden"></div></div>' +
        '<div id="noteContainer"><div class="media-container" id="active"></div></div><div id="bar"></div>';
    const media = browser.document.getElementById('active')!;
    const bar = browser.document.getElementById('bar')! as HappyHTMLElement;
    let rect = new browser.DOMRect(180, 40, 800, 800);
    media.getBoundingClientRect = () => rect;
    const update = () =>
        positionEntryBar(
            bar as unknown as HTMLElement,
            browser.document as unknown as Document,
            browser as unknown as globalThis.Window
        );
    update();
    assert.equal(bar.style.left, '580px');
    assert.equal(bar.style.top, '56px');
    assert.equal(bar.style.maxWidth, '768px');
    assert.equal(bar.style.visibility, 'visible');
    browser.happyDOM.setWindowSize({ height: 800, width: 360 });
    rect = new browser.DOMRect(0, 20, 360, 720);
    update();
    assert.equal(bar.style.left, '180px');
    assert.equal(bar.style.top, '36px');
    assert.equal(bar.style.maxWidth, '328px');
    media.remove();
    update();
    assert.equal(bar.style.visibility, 'hidden');
    browser.happyDOM.abort();
});

test('Dragging survives bar replacement, stays on screen and resets for each opened note', async () => {
    const browser = new Window({ height: 900, width: 1440 });
    const doc = browser.document;
    doc.body.innerHTML =
        '<div class="media-container"></div><div id="host"></div>';
    doc.querySelector('.media-container')!.getBoundingClientRect = () =>
        new browser.DOMRect(180, 40, 800, 800);
    const root = doc.getElementById('host')!.attachShadow({ mode: 'open' });
    const state: EntryPositionState = {};
    resetEntryPosition(state, 'note-a');
    const renderBar = () => {
        root.innerHTML =
            '<div class="bb-entry-bar"><span class="bb-entry-drag"></span><button>下载</button></div>';
        const bar = root.querySelector('.bb-entry-bar')! as HappyHTMLElement;
        bar.getBoundingClientRect = () =>
            new browser.DOMRect(
                parseFloat(bar.style.left || '580') - 150,
                parseFloat(bar.style.top || '440') - 25,
                300,
                50
            );
        positionEntryBar(
            bar as unknown as HTMLElement,
            doc as unknown as Document,
            browser as unknown as globalThis.Window,
            state
        );
        return bar;
    };
    let bar = renderBar();
    assert.equal(bar.getBoundingClientRect().top, 56);
    observeEntryPosition(root as unknown as ShadowRoot, state);
    const down = (selector: string) =>
        root.querySelector(selector)!.dispatchEvent(
            new browser.PointerEvent('pointerdown', {
                bubbles: true,
                button: 0,
                clientX: 440,
                clientY: 81,
                isPrimary: true,
                pointerId: 1
            })
        );
    const move = (x: number, y: number) =>
        doc.dispatchEvent(
            new browser.PointerEvent('pointermove', {
                clientX: x,
                clientY: y,
                pointerId: 1
            })
        );
    down('button');
    move(100, 100);
    assert.equal(state.manual, undefined);
    down('.bb-entry-drag');
    move(600, 200);
    assert.equal(bar.style.left, '740px');
    assert.equal(bar.style.top, '200px');
    bar = renderBar();
    assert.equal(bar.style.left, '740px');
    assert.equal(bar.style.top, '200px');
    move(2000, -100);
    assert.equal(bar.style.left, '1282px');
    assert.equal(bar.style.top, '33px');
    doc.dispatchEvent(new browser.PointerEvent('pointerup', { pointerId: 1 }));
    move(500, 500);
    assert.equal(bar.style.left, '1282px');
    resetEntryPosition(state, 'note-a');
    assert.ok(state.manual);
    resetEntryPosition(state, 'note-b');
    bar = renderBar();
    assert.equal(bar.style.left, '580px');
    assert.equal(bar.getBoundingClientRect().top, 56);
    state.manual = { x: 700, y: 200 };
    resetEntryPosition(state, undefined);
    resetEntryPosition(state, 'note-b');
    assert.equal(state.manual, undefined);
    await browser.happyDOM.abort();
});

test('Entry bar status transitions from detection reason to progress and final result', async () => {
    const noteId = '66abcdef1234567890abcdef';
    const noteUrl = `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=tok`;
    const browser = new Window({ height: 900, url: noteUrl, width: 1440 });
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
        resetGmBridge();
        storage.saveSettings({
            preheatResources: true,
            serverToken: 'tok',
            serverUrl: 'https://entry-status.example/api'
        });
        (
            browser as unknown as { __INITIAL_STATE__?: unknown }
        ).__INITIAL_STATE__ = {
            note: {
                noteDetailMap: {
                    [noteId]: {
                        note: {
                            imageList: [{ livePhoto: true }],
                            noteId,
                            title: '实况测试笔记',
                            type: 'normal'
                        }
                    }
                }
            }
        };
        browser.document.body.innerHTML =
            '<div id="noteContainer"><div class="media-container"></div></div>';
        xhsPageAdapter.evaluateCurrentPage();

        let releaseExtract!: () => void;
        let extractPending = new Promise<void>(resolve => {
            releaseExtract = resolve;
        });
        getGmBridge().httpRequest = async ({ url }) => {
            if (url.includes('/extract')) {
                await extractPending;
                return {
                    headers: '',
                    responseText: JSON.stringify({
                        mediaUrls: [
                            {
                                cover: 'https://storage.example/cache/xhs/cover.jpg',
                                video: 'https://storage.example/cache/xhs/video.mp4'
                            }
                        ]
                    }),
                    status: 200,
                    statusText: 'OK'
                };
            }
            return {
                headers: '',
                responseText: JSON.stringify({
                    records: [],
                    syncedAt: new Date().toISOString()
                }),
                status: 200,
                statusText: 'OK'
            };
        };
        getGmBridge().downloadFile = async () => ({
            bytesTransferred: 1024,
            confirmedByManager: true
        });

        const ui = new BenbenPluginUI();
        ui.init();
        const root =
            browser.document.getElementById('benben-xhs-host')!.shadowRoot!;
        const statusEl = () =>
            root.querySelector<HappyHTMLElement>('.bb-entry-status')!;

        // 1. 初始识别态
        assert.equal(statusEl().textContent?.trim(), '已识别包含实况图片');
        assert.equal(statusEl().classList.contains('is-ok'), false);

        // 2. 点击收藏触发预热进度 -> 预热结果
        root.querySelector<HTMLButtonElement>(
            '[data-action="entry-save"]'
        )!.click();
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.match(statusEl().textContent || '', /预热中|正在执行|等待执行/);

        releaseExtract();
        await new Promise<void>(resolve => setImmediate(resolve));
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.match(statusEl().textContent || '', /预热成功，共缓存 1 个资源/);
        assert.equal(statusEl().classList.contains('is-ok'), true);

        // 3. 点击下载（强制无缓存实时解析路径）验证下载进度 -> 下载结果
        storage.setSavedLinks([]);
        extractPending = new Promise<void>(resolve => {
            releaseExtract = resolve;
        });
        root.querySelector<HTMLButtonElement>(
            '[data-action="entry-download"]'
        )!.click();
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.match(
            statusEl().textContent || '',
            /正在解析媒体链接|下载中|正在执行/
        );

        releaseExtract();
        await new Promise<void>(resolve => setImmediate(resolve));
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.match(
            statusEl().textContent || '',
            /下载完成，共保存 1 个图片或视频/
        );
        assert.equal(statusEl().classList.contains('is-ok'), true);
    } finally {
        xhsPageAdapter.stop();
        await browser.happyDOM.close();
        for (const [key, descriptor] of original) {
            if (descriptor) {
                Object.defineProperty(globalThis, key, descriptor);
            } else {
                Reflect.deleteProperty(globalThis, key);
            }
        }
        resetGmBridge();
    }
});
