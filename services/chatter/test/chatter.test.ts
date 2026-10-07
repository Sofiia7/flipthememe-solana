import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import worker, { CACHE_SECONDS, HOURLY_BUDGET, UPSTREAM_TIMEOUT_MS, cleanText, moodOf, toItems } from '../src/index.ts';

test('mood: scam words win, moon words and emoji, neutral otherwise', () => {
  assert.equal(moodOf('this is going to the moon lfg'), 'moon');
  assert.equal(moodOf('dev rugged, total scam'), 'scam');
  assert.equal(moodOf('pump then dump'), 'scam');
  assert.equal(moodOf('🚀🚀🚀'), 'moon');
  assert.equal(moodOf('💀 chart'), 'scam');
  assert.equal(moodOf('paper hands along the way'), 'neutral');
  assert.equal(moodOf('who is the dev'), 'neutral');
});

test('negations: "not a scam", "no scam", "isnt a rug", "not a rug", "not scam" are not scam talk', () => {
  for (const text of [
    'not a scam',
    'Not A Scam',
    'no scam',
    "isn't a rug",
    'isn\u2019t a rug',
    'isnt a rug',
    'not a rug',
    'not scam',
    'never rugs',
    'not gonna rug',
    'no rug here',
    "ain't no scam",
    'not bearish at all',
    "it's not a scam",
  ]) {
    assert.notEqual(moodOf(text), 'scam', text);
    assert.equal(moodOf(text), 'neutral', text);
  }
  // A negated scam word next to moon talk reads as moon; a scam word the negation does not cover stays scam.
  assert.equal(moodOf('not a scam lfg'), 'moon');
  assert.equal(moodOf('not a scam, we buy'), 'moon');
  assert.equal(moodOf('not a scam but the dev dumped'), 'scam');
  assert.equal(moodOf('no rug, just a rug pull in the comments'), 'scam');
  assert.equal(moodOf('not a scam 💀'), 'scam');
  // Plain scam talk is untouched, also next to words that only look like negations.
  for (const text of ['scam', 'a scam', 'this is a scam', 'dev rugged', 'is it a rug?', 'nothing but a scam', 'know your scam', 'another rug']) {
    assert.equal(moodOf(text), 'scam', text);
  }
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

/** The data centre's cache (caches.default) as a stand-in: keyed by string, honours max-age against Date.now(). */
class FakeEdge {
  readonly entries = new Map<string, { body: string; maxAge: number; storedAt: number }>();
  puts: string[] = [];
  async match(key: string | Request) {
    const k = typeof key === 'string' ? key : key.url;
    const entry = this.entries.get(k);
    if (!entry || Date.now() - entry.storedAt >= entry.maxAge * 1000) return undefined;
    return new Response(entry.body);
  }
  async put(key: string | Request, res: Response) {
    const k = typeof key === 'string' ? key : key.url;
    this.puts.push(k);
    const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1] ?? 0);
    this.entries.set(k, { body: await res.text(), maxAge, storedAt: Date.now() });
  }
}

type Worker = typeof worker;
/** A Worker with fresh module state, as another isolate of the same data centre would be. */
async function isolate(name: string): Promise<Worker> {
  const specifier = `../src/index.ts?isolate=${name}`;
  return ((await import(specifier)) as { default: Worker }).default;
}

function withEdge(t: { after(fn: () => void): void }): FakeEdge {
  const edge = new FakeEdge();
  Object.assign(globalThis, { caches: { default: edge } });
  t.after(() => void delete (globalThis as { caches?: unknown }).caches);
  return edge;
}

const ask = (w: Worker, symbol: string, mint = '', ctx?: { waitUntil(p: Promise<unknown>): void }) =>
  w.fetch(new Request(`https://w.dev/v1/chatter?symbol=${symbol}${mint ? `&mint=${mint}` : ''}`), KEYED, ctx);

test('the answer is kept 45 s in the data centre cache: a second isolate does not go upstream', async (t) => {
  assert.equal(CACHE_SECONDS, 45);
  const edge = withEdge(t);
  let upstream = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    upstream++;
    return new Response(tweetsBody, { status: 200 });
  });
  const one = await isolate('edge-one');
  const two = await isolate('edge-two');
  const real = Date.now();
  let now = real;
  t.mock.method(Date, 'now', () => now);

  const pending: Promise<unknown>[] = [];
  const first = await ask(one, 'EDGE', '', { waitUntil: (p) => void pending.push(p) });
  await Promise.all(pending);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('x-cache'), 'miss');
  assert.equal(upstream, 1);
  assert.deepEqual(
    edge.puts.filter((k) => k.includes('/__chatter/')),
    ['https://sol.flipthememe.com/__chatter/EDGE%7C'],
  );
  const firstBody = await first.json();

  // Another isolate, no memory of it: answered from the cache, SocialData is not called.
  now = real + 30_000;
  const fromEdge = await ask(two, 'edge');
  assert.equal(fromEdge.status, 200);
  assert.equal(fromEdge.headers.get('x-cache'), 'edge');
  assert.deepEqual(await fromEdge.json(), firstBody);
  assert.equal(upstream, 1);
  // Its memory now has the answer with its true age.
  const again = await ask(two, 'EDGE');
  assert.equal(again.headers.get('x-cache'), 'memory');
  assert.deepEqual(await again.json(), firstBody);
  assert.equal(upstream, 1);

  // Past 45 s the entry is gone: one call upstream, and the new answer is stored again.
  now = real + 46_000;
  assert.equal((await ask(two, 'EDGE')).status, 200);
  assert.equal(upstream, 2);
  assert.equal((await ask(one, 'EDGE')).status, 200);
  assert.equal(upstream, 2, "the first isolate finds the second one's answer");

  // The mint is part of the key: the same ticker on another token is another entry.
  const mint = '1'.repeat(32);
  assert.equal((await ask(one, 'EDGE', mint)).status, 200);
  assert.equal(upstream, 3);
  assert.equal((await ask(two, 'EDGE', mint)).status, 200);
  assert.equal(upstream, 3);
});

test('the hourly upstream budget is counted per data centre, not per isolate', async (t) => {
  withEdge(t);
  let upstream = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    upstream++;
    return new Response(tweetsBody, { status: 200 });
  });
  const one = await isolate('budget-one');
  const two = await isolate('budget-two');
  const three = await isolate('budget-three');
  // Two isolates spend the whole budget between them, half of it each, on distinct tickers.
  for (let i = 0; i < HOURLY_BUDGET / 2; i++) {
    assert.equal((await ask(one, `A${i}`)).status, 200);
    assert.equal((await ask(two, `B${i}`)).status, 200);
  }
  assert.equal(upstream, HOURLY_BUDGET);
  // A third isolate has spent nothing itself, but the data centre has: no call, an empty list.
  const over = await ask(three, 'NEWONE');
  assert.equal(over.status, 200);
  assert.deepEqual(await over.json(), { symbol: 'NEWONE', items: [], error: 'budget' });
  assert.equal(upstream, HOURLY_BUDGET);
  // Tickers already cached keep being answered, from the cache.
  assert.equal(((await (await ask(three, 'A0')).json()) as { items: unknown[] }).items.length, 1);
  assert.equal(upstream, HOURLY_BUDGET);
});

test('without a data centre cache the Worker still works from its own memory', async (t) => {
  let upstream = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    upstream++;
    return new Response(tweetsBody, { status: 200 });
  });
  const lone = await isolate('no-edge');
  assert.equal((await ask(lone, 'LONE')).status, 200);
  assert.equal((await ask(lone, 'LONE')).status, 200);
  assert.equal(upstream, 1);
});

test('a cache that throws is skipped: the Worker goes upstream and answers', async (t) => {
  Object.assign(globalThis, {
    caches: {
      default: {
        match: async () => {
          throw new Error('cache unavailable');
        },
        put: async () => {
          throw new Error('cache unavailable');
        },
      },
    },
  });
  t.after(() => void delete (globalThis as { caches?: unknown }).caches);
  t.mock.method(console, 'warn', () => undefined);
  t.mock.method(globalThis, 'fetch', async () => new Response(tweetsBody, { status: 200 }));
  const broken = await isolate('broken-edge');
  const res = await ask(broken, 'BROKEN');
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { items: unknown[] }).items.length, 1);
});
