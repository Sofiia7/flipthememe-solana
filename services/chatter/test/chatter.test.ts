import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import worker, { UPSTREAM_TIMEOUT_MS, cleanText, moodOf, toItems } from '../src/index.ts';

test('mood: scam words win, moon words and emoji, neutral otherwise', () => {
  assert.equal(moodOf('this is going to the moon lfg'), 'moon');
  assert.equal(moodOf('dev rugged, total scam'), 'scam');
  assert.equal(moodOf('pump then dump'), 'scam');
  assert.equal(moodOf('🚀🚀🚀'), 'moon');
  assert.equal(moodOf('💀 chart'), 'scam');
  assert.equal(moodOf('paper hands along the way'), 'neutral');
  assert.equal(moodOf('who is the dev'), 'neutral');
});

test('clean text drops links, masks slurs, trims', () => {
  assert.equal(cleanText('  look   https://t.co/abc  here\n now '), 'look here now');
  assert.equal(cleanText('x'.repeat(300)).length, 160);
});

test('tweets map to items and skip incomplete rows', () => {
  const items = toItems([
    { id_str: '1', full_text: 'moon soon $AIKOL', tweet_created_at: '2026-10-05T13:00:00Z', user: { screen_name: 'a', name: 'A', followers_count: 10 } },
    { id_str: '2', full_text: '', user: { screen_name: 'b' } },
    { full_text: 'no id', user: { screen_name: 'c' } },
  ]);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], {
    id: '1',
    author: 'a',
    name: 'A',
    followers: 10,
    text: 'moon soon $AIKOL',
    createdAt: '2026-10-05T13:00:00Z',
    url: 'https://x.com/a/status/1',
    mood: 'moon',
  });
});

test('worker validates input and refuses without a key', async () => {
  const call = (path: string) => worker.fetch(new Request(`https://w.dev${path}`), { SOCIALDATA_API_KEY: '' });
  assert.equal((await call('/health')).status, 200);
  assert.equal((await call('/v1/chatter?symbol=bad-symbol!')).status, 400);
  assert.equal((await call('/v1/chatter?symbol=AIKOL&mint=0OIl')).status, 400);
  assert.equal((await call('/v1/chatter?symbol=AIKOL')).status, 503);
  assert.equal((await call('/elsewhere')).status, 404);
});

const KEYED = { SOCIALDATA_API_KEY: 'test-key' };
const callWorker = (symbol: string) => worker.fetch(new Request(`https://w.dev/v1/chatter?symbol=${symbol}`), KEYED);
const tweetsBody = JSON.stringify({ tweets: [{ id_str: '1', full_text: 'moon soon $AIKOL', user: { screen_name: 'a' } }] });

test('the upstream request has an 8 second timeout', () => {
  assert.equal(UPSTREAM_TIMEOUT_MS, 8_000);
});

/**
 * AbortSignal.timeout timers are unref'd, so a test that waits for nothing but one lets Node 22's
 * event loop drain and the runner reports "Promise resolution is still pending". A plain timer
 * keeps the loop alive until the awaited work settles.
 */
async function alive<T>(work: Promise<T>): Promise<T> {
  const keep = setTimeout(() => undefined, 30_000);
  try {
    return await work;
  } finally {
    clearTimeout(keep);
  }
}

test('a hanging upstream is cut off by the timeout and answered like an upstream error', async (t) => {
  // The stub never answers; it only fails when the Worker's own signal fires. The timeout is
  // shortened to 20 ms here, but the Worker must have asked for UPSTREAM_TIMEOUT_MS.
  let asked = -1;
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    asked = ms;
    return realTimeout(20);
  });
  t.mock.method(globalThis, 'fetch', (_url: string, init: { signal: AbortSignal }) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      if (init.signal.aborted) reject(init.signal.reason);
    }),
  );
  const res = await alive(callWorker('HANGS'));
  assert.equal(asked, UPSTREAM_TIMEOUT_MS);
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { symbol: 'HANGS', items: [], error: 'upstream timeout' });
});

test('a fetch that rejects with TimeoutError, or fails otherwise, answers 502 without throwing', async (t) => {
  let error: Error = new DOMException('The operation timed out.', 'TimeoutError');
  t.mock.method(globalThis, 'fetch', async () => {
    throw error;
  });
  const timeout = await callWorker('SLOW');
  assert.equal(timeout.status, 502);
  assert.equal(((await timeout.json()) as { error: string }).error, 'upstream timeout');
  error = new TypeError('fetch failed');
  const down = await callWorker('DOWN');
  assert.equal(down.status, 502);
  assert.equal(((await down.json()) as { error: string }).error, 'upstream error');
});

test('a timeout after a good answer serves the last good answer, as an upstream error does', async (t) => {
  let fail = false;
  t.mock.method(globalThis, 'fetch', async () => {
    if (fail) throw new DOMException('The operation timed out.', 'TimeoutError');
    return new Response(tweetsBody, { status: 200 });
  });
  const first = await callWorker('STALE');
  assert.equal(first.status, 200);
  const firstBody = (await first.json()) as { items: unknown[] };
  assert.equal(firstBody.items.length, 1);
  // The cache is fresh for 60 s; jump past it so the Worker goes upstream again.
  const real = Date.now();
  t.mock.method(Date, 'now', () => real + 61_000);
  fail = true;
  const second = await callWorker('STALE');
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), firstBody);
});
