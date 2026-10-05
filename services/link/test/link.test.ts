// Run: node --test services/link/test/*.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appIntent, cleanTicker, handle } from '../src/index.ts';

const get = (path: string) => handle(new Request(`https://sol.flipthememe.com${path}`));

test('a challenge link names the side and the token and offers the opposite side', async () => {
  const res = get('/r/496?side=up&t=Tesla');
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /FRIEND IS UP/);
  assert.match(body, /ON \$TESLA/);
  assert.match(body, /CALL DOWN/);
  assert.match(body, /ROUND #496/);
  assert.ok(body.includes('intent://round/496#Intent;scheme=flipthememe;package=com.flipthememe.app;'));
  assert.match(body, /<meta property="og:title" content="I&#39;m UP on \$Tesla\. Take the other side\.">/);
});

test('query values cannot inject markup', async () => {
  const body = await get('/r/7?side=%3Cscript%3E&t=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E').text();
  assert.ok(!body.includes('<script>') && !body.includes('<img'));
  assert.match(body, /PICK A SIDE/);
  assert.equal(cleanTicker('$<b>WIF</b>'), 'bWIFb');
  assert.equal(cleanTicker('$$$'), null);
  assert.equal(cleanTicker('a'.repeat(40))?.length, 20);
});

test('asset links carry the release certificate for the app package', async () => {
  const res = get('/.well-known/assetlinks.json');
  assert.equal(res.headers.get('content-type'), 'application/json');
  const [entry] = (await res.json()) as { target: { package_name: string; sha256_cert_fingerprints: string[] } }[];
  assert.equal(entry.target.package_name, 'com.flipthememe.app');
  assert.match(entry.target.sha256_cert_fingerprints[0], /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
});

test('other paths: home and /get explain the app, the rest redirects, writes are refused', async () => {
  assert.match(await get('/get').text(), /DOWNLOAD THE APK/);
  assert.equal(get('/').status, 200);
  const other = get('/r/abc');
  assert.equal(other.status, 302);
  assert.equal(other.headers.get('location'), 'https://sol.flipthememe.com/get');
  assert.equal(handle(new Request('https://sol.flipthememe.com/r/1', { method: 'POST' })).status, 405);
  assert.ok(appIntent('5').endsWith(';end'));
});
