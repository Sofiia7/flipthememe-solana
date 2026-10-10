import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readiness } from '../src/readiness.ts';
import { handle } from '../src/http.ts';
const input = { now: 180_000, refreshedAt: 170_000, oracleMatches: true, keyOk: true, windows: [], lastSampleAt: null };
test('idle healthy oracle needs no market sample; stale snapshot and an active window fail closed', () => {
  assert.equal(readiness(input).ready, true);
  assert.equal(readiness({ ...input, refreshedAt: 1 }).ready, false);
  assert.equal(readiness({ ...input, windows: [{ startMs: 175_000, endMs: 185_000 }] }).ready, false);
  assert.equal(readiness({ ...input, oracleMatches: false }).ready, false);
});
test('liveness does not masquerade as readiness; readiness errors are uncached', async () => {
  const api = { attest: async () => ({ status: 503, body: {} }), health: async () => ({ status: 200, body: { readiness: { ready: false } } }) };
  assert.equal((await handle(new Request('https://test/v1/attestor/live'), api)).status, 200);
  const response = await handle(new Request('https://test/v1/attestor/ready'), api);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
