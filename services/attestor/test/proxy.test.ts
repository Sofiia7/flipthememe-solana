// Run: node --test "services/attestor/test/*.test.ts" (from the repo root). No network.
// Proxy mode: the main deployment forwards the attestor routes to the backup and touches nothing else.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { forward, upstreamUrl } from '../src/proxy.ts';

const BASE = 'https://ftm-attestor.example-backup.workers.dev';
const req = (path: string, init: RequestInit = {}, host = 'sol.flipthememe.com') => new Request(`https://${host}${path}`, init);

describe('upstreamUrl', () => {
  test('maps an attestor route onto the backup, keeping the query', () => {
    assert.equal(upstreamUrl(req('/v1/attestation?round=7&kind=strike'), BASE)?.href, `${BASE}/v1/attestation?round=7&kind=strike`);
    assert.equal(upstreamUrl(req('/v1/attestor/ready'), BASE)?.href, `${BASE}/v1/attestor/ready`);
    assert.equal(upstreamUrl(req('/v1/attest', { method: 'POST' }), BASE)?.href, `${BASE}/v1/attest`);
  });

  test('refuses what is not an attestor route, an unusable base, and a loop onto itself', () => {
    assert.equal(upstreamUrl(req('/v1/leaderboard'), BASE), null);
    assert.equal(upstreamUrl(req('/v1/attestor'), undefined), null);
    assert.equal(upstreamUrl(req('/v1/attestor'), 'http://insecure.example'), null, 'only https');
    assert.equal(upstreamUrl(req('/v1/attestor'), 'not a url'), null);
    assert.equal(upstreamUrl(req('/v1/attestor', {}, 'ftm-attestor.example-backup.workers.dev'), BASE), null, 'a deployment never forwards to itself');
  });
});

describe('forward', () => {
  test('sends a POST with its body and bearer token, drops connection headers, marks the response', async () => {
    let seen: { url: string; method: string; headers: Headers; body: string } | null = null;
    const fetcher = (async (url: URL, init: RequestInit) => {
      seen = { url: String(url), method: String(init.method), headers: new Headers(init.headers), body: new TextDecoder().decode(init.body as ArrayBuffer) };
      return new Response('{"signature":"x"}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const res = await forward(req('/v1/attest', { method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4', host: 'sol.flipthememe.com' }, body: '{"tx":"abc"}' }), BASE, fetcher);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-proxied'), '1');
    assert.equal(await res.text(), '{"signature":"x"}');
    assert.ok(seen);
    const s = seen as { url: string; method: string; headers: Headers; body: string };
    assert.equal(s.url, `${BASE}/v1/attest`);
    assert.equal(s.method, 'POST');
    assert.equal(s.body, '{"tx":"abc"}');
    assert.equal(s.headers.get('authorization'), 'Bearer t');
    assert.equal(s.headers.get('cf-connecting-ip'), null, 'the caller address is not passed on');
    assert.equal(s.headers.get('host'), null);
    assert.equal(s.headers.get('x-forwarded-by'), 'ftm-attestor-proxy');
  });

  test('passes an upstream error status through, and says 503 when the backup cannot be reached', async () => {
    const refused = (async () => new Response('{"error":"x","reason":"unauthorized"}', { status: 401 })) as unknown as typeof fetch;
    assert.equal((await forward(req('/v1/attest', { method: 'POST', body: '{}' }), BASE, refused)).status, 401);
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const res = await forward(req('/v1/attestor'), BASE, down);
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { reason: string }).reason, 'unavailable');
  });

  test('a path outside the attestor is 404 and a missing base is a clear misconfiguration, never a fetch', async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      return new Response('x');
    }) as unknown as typeof fetch;
    assert.equal((await forward(req('/v1/leaderboard'), BASE, fetcher)).status, 404);
    const res = await forward(req('/v1/attestor'), undefined, fetcher);
    assert.equal(res.status, 500);
    assert.equal(((await res.json()) as { reason: string }).reason, 'proxy_misconfigured');
    assert.equal(calls, 0);
  });
});
