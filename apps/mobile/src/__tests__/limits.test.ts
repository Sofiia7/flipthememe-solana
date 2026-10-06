// Node tests for the 429 back-off and the bounded caches. Run from the repo root:
//   node --test "apps/mobile/src/__tests__/*.test.ts"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coolDownMs, createCoolDown, retryAfterMs, setBounded } from '../lib/limits.ts';

test('Retry-After is read as seconds or as an HTTP date', () => {
  assert.equal(retryAfterMs('5', 0), 5_000);
  assert.equal(retryAfterMs(' 1.5 ', 0), 1_500);
  const now = Date.parse('Wed, 07 Oct 2026 10:00:00 GMT');
  assert.equal(retryAfterMs('Wed, 07 Oct 2026 10:00:03 GMT', now), 3_000);
  assert.equal(retryAfterMs('Wed, 07 Oct 2026 09:59:00 GMT', now), 0);
  assert.equal(retryAfterMs('soon', now), null);
  assert.equal(retryAfterMs(null, now), null);
});

test('a rate-limited source is left alone longer after each 429 in a row, and starts over after an answer', () => {
  assert.equal(coolDownMs(1, null, 2_000, 30_000), 2_000);
  assert.equal(coolDownMs(2, null, 2_000, 30_000), 4_000);
  assert.equal(coolDownMs(4, null, 2_000, 30_000), 16_000);
  assert.equal(coolDownMs(5, null, 2_000, 30_000), 30_000);
  assert.equal(coolDownMs(500, null, 2_000, 30_000), 30_000);
  // The server may ask for more, never for less, and never past the cap.
  assert.equal(coolDownMs(1, 10_000, 2_000, 30_000), 10_000);
  assert.equal(coolDownMs(3, 1_000, 2_000, 30_000), 8_000);
  assert.equal(coolDownMs(1, 600_000, 2_000, 30_000), 30_000);

  const c = createCoolDown(2_000, 30_000);
  assert.equal(c.left(0), 0);
  assert.equal(c.hit(1_000), 2_000);
  assert.equal(c.left(2_000), 1_000);
  assert.equal(c.left(3_000), 0);
  assert.equal(c.hit(3_000), 4_000);
  assert.equal(c.left(5_000), 2_000);
  c.ok();
  assert.equal(c.hit(10_000, 5_000), 5_000);
  assert.equal(c.hit(20_000), 4_000);
});

test('bounded caches drop the oldest entries but keep the ones in use', () => {
  const m = new Map<string, number>();
  for (const k of ['a', 'b', 'c', 'd']) setBounded(m, k, 1, 3);
  assert.deepEqual([...m.keys()], ['b', 'c', 'd']);
  // Setting a key again makes it the newest.
  setBounded(m, 'b', 2, 3);
  setBounded(m, 'e', 1, 3);
  assert.deepEqual([...m.keys()], ['d', 'b', 'e']);
  // Keys in use stay even when they are the oldest.
  setBounded(m, 'f', 1, 3, (k) => k === 'd');
  assert.deepEqual([...m.keys()], ['d', 'e', 'f']);
  // When everything else is in use the cache grows rather than drop a key on screen.
  setBounded(m, 'g', 1, 3, (k) => k !== 'g');
  assert.deepEqual([...m.keys()], ['d', 'e', 'f', 'g']);
});
