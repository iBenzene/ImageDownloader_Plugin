import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildMediaFilename,
    decodeLiveCachedUrls,
    encodeLiveCachedUrl,
    extractLocalContentKey,
    extractUrlsFromInput,
    generateUUID,
    getServerNamespaceHash,
    isConfirmableS3CachedUrl,
    isSameId,
    normalizeServerBaseUrl,
    normalizeXhsNoteUrl,
    redactSensitive,
    toIso8601WithMs,
    verifyPreheatCacheResult
} from '../src/utils';

test('UUID generation & case-insensitive matching', () => {
    const id1 = generateUUID();
    assert.match(
        id1,
        /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/
    );
    assert.equal(
        id1,
        id1.toUpperCase(),
        'UUID should be uppercase to match iOS Swift UUID'
    );

    assert.ok(isSameId('ABC-123', 'abc-123'));
    assert.ok(isSameId(id1, id1.toLowerCase()));
    assert.ok(!isSameId('ABC', 'DEF'));
});

test('ISO8601 formatting includes milliseconds', () => {
    const iso = toIso8601WithMs(new Date('2026-10-27T00:37:00.123Z'));
    assert.equal(iso, '2026-10-27T00:37:00.123Z');
});

test('Server URL normalization and namespace hashing', () => {
    assert.equal(
        normalizeServerBaseUrl('https://example.com/api/'),
        'https://example.com/api'
    );
    assert.equal(
        normalizeServerBaseUrl('https://example.com/api///'),
        'https://example.com/api'
    );

    const ns1 = getServerNamespaceHash('https://example.com/api', 'token1');
    const ns2 = getServerNamespaceHash('https://example.com/api/', 'token1');
    const ns3 = getServerNamespaceHash('https://example.com/api', 'token2');
    assert.equal(
        ns1,
        ns2,
        'Trailing slash should produce identical namespace hash'
    );
    assert.notEqual(
        ns1,
        ns3,
        'Different token must produce isolated namespace hash'
    );
});

test('Sensitive information redaction in logs', () => {
    const secretToken = 'my_super_secret_token_123';
    const text = `Request to https://api.com/v1/extract?token=${secretToken}&url=https://xhs.com/item?xsec_token=secret_abc123`;
    const redacted = redactSensitive(text, secretToken);
    assert.ok(!redacted.includes(secretToken), 'Server token must be masked');
    assert.ok(
        !redacted.includes('secret_abc123'),
        'xsec_token parameter value must be masked'
    );
    assert.ok(redacted.includes('***'));
});

test('URL extraction matches iOS behavior and preserves query parameters', () => {
    const input = `
    看这个：https://www.xiaohongshu.com/explore/654321abcdef0123456789ab?xsec_token=CB123&xsec_source=pc_feed
    无效内容
    http://xhslink.com/a/abc123
  `;
    const result = extractUrlsFromInput(input, 'skipWithWarning');
    assert.equal(result.urls.length, 2);
    assert.ok(
        result.urls[0].includes('xsec_token=CB123'),
        'Must preserve xsec_token parameter'
    );
    assert.equal(result.skippedLines.length, 1);
});

test('Local ContentKey resolution and canonical note URL normalization', () => {
    const rawUrl =
        'https://www.xiaohongshu.com/explore/654321abcdef0123456789ab?xsec_token=CB123';
    const key = extractLocalContentKey(rawUrl, '小红书图片下载器');
    assert.equal(key, 'xhs:654321abcdef0123456789ab');

    const normalized = normalizeXhsNoteUrl(
        'https://www.xiaohongshu.com/user/profile/5f0000000000000000000001/654321abcdef0123456789ab?xsec_token=CB123'
    );
    assert.ok(normalized);
    assert.equal(normalized?.noteId, '654321abcdef0123456789ab');
    assert.ok(normalized?.url.includes('/explore/654321abcdef0123456789ab'));
    assert.ok(normalized?.url.includes('xsec_token=CB123'));
});

test('Live Photo cache encoding and decoding', () => {
    const cover = 'https://s3.example.com/cache/xhs/cover1.jpg';
    const video = 'https://s3.example.com/cache/xhs/video1.mp4';
    const encoded = encodeLiveCachedUrl(cover, video);
    assert.ok(encoded.startsWith('__LIVE_CACHE__'));

    const decoded = decodeLiveCachedUrls([encoded]);
    assert.ok(decoded);
    assert.equal(decoded?.length, 1);
    assert.equal(decoded?.[0].cover, cover);
    assert.equal(decoded?.[0].video, video);

    // Invalid payload returns null to trigger live re-extract fallback
    assert.equal(decodeLiveCachedUrls(['invalid_string']), null);
});

test('S3 cache verification rejects raw XHS CDN URLs as preheat success', () => {
    const rawCdnUrl =
        'https://sns-webpic-qc.xhscdn.com/20261027/123/original.jpg';
    const s3Url = 'https://s3.example.com/bucket/cache/xhs/cached_item.jpg';

    assert.ok(
        !isConfirmableS3CachedUrl(rawCdnUrl),
        'Raw xhscdn domain must not be treated as S3 cached'
    );
    assert.ok(
        isConfirmableS3CachedUrl(s3Url),
        'URL with /cache/ on custom S3 host should be confirmable'
    );

    const verifiedFailure = verifyPreheatCacheResult(
        [rawCdnUrl],
        '小红书图片下载器'
    );
    assert.ok(
        !verifiedFailure.confirmed,
        'Fallback raw CDN URL must be flagged as unconfirmed preheat'
    );
    assert.equal(verifiedFailure.unconfirmedCount, 1);

    const verifiedSuccess = verifyPreheatCacheResult(
        [s3Url],
        '小红书图片下载器'
    );
    assert.ok(verifiedSuccess.confirmed);
    assert.equal(verifiedSuccess.unconfirmedCount, 0);
});

test('Media filename builder retains note identity, index and role', () => {
    const fn = buildMediaFilename({
        downloaderType: '小红书实况图片下载器',
        mediaIndex: 1,
        mediaUrl: 'https://example.com/photo.jpg',
        role: 'live-cover',
        sourceUrl:
            'https://www.xiaohongshu.com/explore/654321abcdef0123456789ab',
        totalCount: 3
    });
    assert.equal(fn, 'benben-xhs-654321abcdef0123456789ab-01-cover.jpg');
});
