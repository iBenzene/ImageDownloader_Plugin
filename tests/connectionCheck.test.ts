import assert from 'node:assert/strict';
import test from 'node:test';
import { checkConnectionAndFeatures } from '../src/api';
import { getGmBridge, resetGmBridge } from '../src/gmAdapter';

test('Connection check validates locally and sends only an empty sync request', async () => {
    resetGmBridge();
    let requests = 0;
    let status = 200;
    let body = JSON.stringify({
        records: [],
        syncedAt: '2026-10-27T00:00:00.000Z'
    });
    let networkError = '';
    getGmBridge().httpRequest = async ({ data, method, url }) => {
        requests++;
        assert.equal(new URL(url).pathname, '/api/v1/saved-links/sync');
        assert.equal(method, 'POST');
        assert.deepEqual(JSON.parse(data as string), { records: [] });
        if (networkError) {
            throw new Error(networkError);
        }
        return { headers: '', responseText: body, status, statusText: '' };
    };
    const settings = {
        serverToken: 'test-token',
        serverUrl: 'https://example.com/api'
    };
    try {
        for (const serverUrl of [
            '',
            'invalid',
            'ftp://example.com',
            'https://example.com/api?token=x'
        ]) {
            assert.equal(
                (await checkConnectionAndFeatures({ ...settings, serverUrl }))
                    .overallOk,
                false
            );
        }
        assert.equal(
            (
                await checkConnectionAndFeatures({
                    ...settings,
                    serverToken: ' '
                })
            ).overallOk,
            false
        );
        assert.equal(requests, 0);
        const success = await checkConnectionAndFeatures(settings);
        assert.equal(success.overallOk, true);
        assert.equal(requests, 1);
        assert.match(success.items[0].detail, /未测试写入/);
        for (const [code, response, message] of [
            [401, '{}', /令牌无效/],
            [403, '{}', /权限不足/],
            [500, '{}', /云端读取失败/],
            [200, '<html>wrong endpoint</html>', /接口地址或版本不匹配/]
        ] as const) {
            status = code;
            body = response;
            const before: number = requests;
            const result = await checkConnectionAndFeatures(settings);
            assert.equal(result.overallOk, false);
            assert.match(result.items[0].detail, message);
            assert.equal(requests, before + 1);
        }
        networkError = '请求超时';
        assert.match(
            (await checkConnectionAndFeatures(settings)).items[0].detail,
            /请求超时/
        );
        networkError = 'network failure';
        assert.match(
            (await checkConnectionAndFeatures(settings)).items[0].detail,
            /无法访问服务端/
        );
    } finally {
        resetGmBridge();
    }
});
