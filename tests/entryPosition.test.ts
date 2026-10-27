import assert from 'node:assert/strict';
import test from 'node:test';
import { Window, HTMLElement as HappyHTMLElement } from 'happy-dom';
import {
    EntryPositionState,
    observeEntryPosition,
    positionEntryBar,
    resetEntryPosition,
} from '../src/ui/entryPosition';

test('Entry follows visible note media and stays inside a narrow viewport', () => {
    const browser = new Window({ width: 1440, height: 900 });
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
    browser.happyDOM.setWindowSize({ width: 360, height: 800 });
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
    const browser = new Window({ width: 1440, height: 900 });
    const doc = browser.document;
    doc.body.innerHTML = '<div class="media-container"></div><div id="host"></div>';
    doc.querySelector('.media-container')!.getBoundingClientRect = () => new browser.DOMRect(180, 40, 800, 800);
    const root = doc.getElementById('host')!.attachShadow({ mode: 'open' });
    const state: EntryPositionState = {};
    resetEntryPosition(state, 'note-a');
    const renderBar = () => {
        root.innerHTML = '<div class="bb-entry-bar"><span class="bb-entry-drag"></span><button>下载</button></div>';
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
                isPrimary: true,
                pointerId: 1,
                clientX: 440,
                clientY: 81,
            })
        );
    const move = (x: number, y: number) =>
        doc.dispatchEvent(new browser.PointerEvent('pointermove', { pointerId: 1, clientX: x, clientY: y }));
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
