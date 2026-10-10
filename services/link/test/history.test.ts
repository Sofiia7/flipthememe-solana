import assert from 'node:assert/strict';
import { test } from 'node:test';
import { history } from '../src/history.ts';
test('history is scoped by validated owner; unavailable archive never fabricates results', async () => {
  const env = { LEADERBOARD: { get: async () => null, put: async () => {} } };
  assert.equal((await history(new Request('https://test/v1/history?owner=invalid'), env)).status, 400);
  assert.equal((await history(new Request('https://test/v1/history?owner=11111111111111111111111111111111'), env)).status, 404);
});
test('unsigned and unbounded histories cannot overwrite an archive', async () => {
  let writes = 0;
  const env = { LEADERBOARD: { get: async () => null, put: async () => { writes++; } } };
  assert.equal((await history(new Request('https://test/v1/history', { method: 'PUT', body: '{}' }), env)).status, 401);
  assert.equal((await history(new Request('https://test/v1/history', { method: 'PUT', body: 'x'.repeat(1_000_001) }), env)).status, 413);
  assert.equal(writes, 0);
});
