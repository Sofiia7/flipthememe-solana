import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releaseInfo, PUBLISHED_RELEASE } from '../src/release.ts';
const release = { tag_name: 'build-29', published_at: '2026-10-10T06:00:00Z', html_url: 'https://github.com/Sofiia7/flipthememe-apk/releases/tag/build-29', assets: [{ name: 'FlipTheMeme.apk', size: 1000000, digest: 'sha256:' + 'a'.repeat(64), browser_download_url: 'https://github.com/Sofiia7/flipthememe-apk/releases/download/build-29/FlipTheMeme.apk' }] };
test('release metadata is bounded and cannot send users to a different download host', async () => {
  const response = await releaseInfo(async () => Response.json(release));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).sha256, 'a'.repeat(64));
  const bad = { ...release, assets: [{ ...release.assets[0], browser_download_url: 'https://other.test/app.apk' }] };
  assert.equal((await releaseInfo(async () => Response.json(bad))).status, 503);
  assert.equal((await releaseInfo(async () => new Response('', { status: 429 }))).status, 503);
});

test('GitHub rate limits and network failure preserve the verified immutable APK link', async () => {
  for (const fetcher of [async () => new Response('', { status: 429 }), async () => { throw new Error('network unavailable'); }]) {
    const response = await releaseInfo(fetcher, PUBLISHED_RELEASE);
    assert.equal(response.status, 200);
    const metadata = await response.json();
    assert.equal(metadata.version, 'build-29');
    assert.equal(metadata.sha256, '3e421cb91393433e75c0b106a3e1a1336b4d4f0b42b8c8404d615664dcb6ce0a');
    assert.equal(metadata.apkUrl, 'https://github.com/Sofiia7/flipthememe-apk/releases/download/build-29/FlipTheMeme.apk');
  }
});
