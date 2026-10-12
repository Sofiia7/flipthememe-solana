import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gateArena } from '../src/arena-readiness.ts';
test('a ready keeper cannot override absent, failed or stale oracle readiness', async () => {
  const arena = { phase: 'ready', updatedAt: new Date().toISOString(), pool: 'pool', reason: 'ready' };
  for (const body of [{}, { readiness: { ready: false, checkedAt: new Date().toISOString() } }, { readiness: { ready: true, checkedAt: new Date(Date.now() - 60_000).toISOString() } }]) {
    const result = await gateArena(arena, async () => Response.json(body));
    assert.equal(result.phase, 'paused');
    assert.equal(result.pool, arena.pool);
    assert.equal(result.keeperUpdatedAt, arena.updatedAt);
  }
  assert.equal((await gateArena(arena, async () => { throw new TypeError('offline'); })).phase, 'paused');
  assert.equal(await gateArena(arena, async () => Response.json({ readiness: { ready: true, checkedAt: new Date().toISOString() } })), arena);
});
test('already searching and paused states need no oracle request', async () => {
  const arena = { phase: 'observing' };
  assert.equal(await gateArena(arena, async () => { throw new Error('must not call'); }), arena);
});
