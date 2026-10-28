import assert from 'node:assert/strict';
import test from 'node:test';
import { Window, HTMLInputElement, HTMLButtonElement } from 'happy-dom';
import { getGmBridge, resetGmBridge } from '../src/gmAdapter';
import { storage } from '../src/storage';
import { BenbenPluginUI } from '../src/ui/panel';

test('Settings keep drafts during diagnostics and refresh, and save without navigation', async () => {
    const browser = new Window({
        url: 'https://www.xiaohongshu.com/explore/test'
    });
    const original = new Map<string, PropertyDescriptor | undefined>();
    for (const key of ['window', 'document', 'FormData']) {
        original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
        Object.defineProperty(globalThis, key, {
            configurable: true,
            value: (browser as unknown as Record<string, unknown>)[key],
            writable: true
        });
    }
    try {
        resetGmBridge();
        const requests: URL[] = [];
        let releaseRequest!: () => void;
        const requestPending = new Promise<void>(resolve => {
            releaseRequest = resolve;
        });
        getGmBridge().httpRequest = async ({ url }) => {
            requests.push(new URL(url));
            await requestPending;
            return {
                headers: '',
                responseText: '{}',
                status: 401,
                statusText: 'Unauthorized'
            };
        };
        const ui = new BenbenPluginUI();
        ui.init();
        ui.openPanel('settings');
        const root =
            browser.document.getElementById('benben-xhs-host')!.shadowRoot!;
        const input = (name: string) =>
            root.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
        const edit = (name: string, value: string) => {
            input(name).value = value;
            input(name).dispatchEvent(
                new browser.Event('input', { bubbles: true })
            );
        };
        edit('serverUrl', 'https://draft.example/api');
        edit('serverToken', 'draft-token');
        input('serverSideProxy').checked = true;
        input('serverSideProxy').dispatchEvent(
            new browser.Event('change', { bubbles: true })
        );
        input('preheatResources').checked = true;
        input('preheatResources').dispatchEvent(
            new browser.Event('change', { bubbles: true })
        );
        storage.emitChange('logs');
        assert.equal(input('serverUrl').value, 'https://draft.example/api');
        assert.equal(input('serverToken').value, 'draft-token');
        assert.equal(input('serverSideProxy').checked, true);
        root.querySelector<HTMLButtonElement>(
            '[data-action="run-diagnostics"]'
        )!.click();
        assert.equal(requests[0].pathname, '/api/v1/saved-links/sync');
        assert.equal(input('serverToken').value, 'draft-token');
        assert.equal(storage.getSettings().serverToken, '');
        releaseRequest();
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(requests.length, 1);
        assert.equal(requests[0].searchParams.get('token'), 'draft-token');
        assert.equal(input('serverUrl').value, 'https://draft.example/api');
        assert.equal(input('serverToken').value, 'draft-token');
        assert.match(root.textContent!, /❌ 连接异常（令牌无效或权限不足）/);

        let prevented = false;
        root.addEventListener('submit', event => {
            prevented = event.defaultPrevented;
        });
        root.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
        assert.equal(
            prevented,
            true,
            'Native form navigation must be cancelled'
        );
        assert.equal(
            browser.location.href,
            'https://www.xiaohongshu.com/explore/test'
        );
        assert.equal(
            storage.getSettings().serverUrl,
            'https://draft.example/api'
        );
        assert.equal(storage.getSettings().serverToken, 'draft-token');
        assert.equal(storage.getSettings().serverSideProxy, true);
        assert.equal(storage.getSettings().preheatResources, true);
        assert.match(root.textContent!, /设置已保存/);
        ui.closePanel();
        ui.openPanel('settings');
        assert.equal(input('serverToken').value, 'draft-token');

        edit('serverToken', 'updated-token');
        const submit = new browser.Event('submit', {
            bubbles: true,
            cancelable: true
        });
        root.querySelector('form')!.dispatchEvent(submit);
        assert.equal(
            submit.defaultPrevented,
            true,
            'Keyboard form submission must also be cancelled'
        );
        assert.equal(storage.getSettings().serverToken, 'updated-token');
    } finally {
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
