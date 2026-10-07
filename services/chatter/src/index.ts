// Live X chatter about the arena token, for the "notifications raining from the top" overlay.
// The SocialData key stays here as a Worker secret; the app only ever sees tweet text.
// Real tweets only: nothing is generated or replayed.
//
// Caching, so that the SocialData bill does not depend on how many isolates serve the app: an answer
// is kept 45 s in the data centre's cache (caches.default, key = ticker and mint) and in the isolate's
// memory (which also serves the last good answer when SocialData fails). The hourly budget of upstream
// calls is counted in the same cache, per data centre, and in memory, per isolate.

export interface Env {
  SOCIALDATA_API_KEY: string;
}

type Ctx = { waitUntil(promise: Promise<unknown>): void };

type Mood = 'moon' | 'scam' | 'neutral';

export type ChatterItem = {
  id: string;
  author: string;
  name: string;
  followers: number;
  text: string;
  createdAt: string;
  url: string;
  mood: Mood;
};

/** How long an answer is fresh, in the data centre's cache and in an isolate's memory. */
export const CACHE_SECONDS = 45;
const CACHE_MS = CACHE_SECONDS * 1000;
/**
 * Upstream calls allowed per hour, per data centre (a counter in caches.default) and per isolate:
 * SocialData bills per tweet returned. One ticker polled all hour needs 80 calls at a 45 s cache, so
 * this is a cap on a busy hour, not a target; past it the last good answer is served, or an empty list.
 */
export const HOURLY_BUDGET = 60;
const CACHE_PREFIX = 'https://sol.flipthememe.com/__chatter/';
const BUDGET_PREFIX = 'https://sol.flipthememe.com/__chatter-budget/';
const MAX_ITEMS = 12;
/** Longest wait for SocialData: a hanging upstream must not hang the Worker. */
export const UPSTREAM_TIMEOUT_MS = 8_000;

const MOON_WORDS = /\b(moon\w*|pump\w*|send it|sending|gem|ape|aped|aping|bullish|lfg|\d+x|ath|wagmi|buy\w*|long|rocket\w*)\b/i;
const MOON_EMOJI = /🚀|🔥|💎|📈/u;
const SCAM_ALTERNATIVES = 'scam\\w*|rug\\w*|dump\\w*|honeypot|jeet\\w*|bearish|dead|rekt|sell\\w*|short|fud|exit liquidity';
const SCAM_WORDS = new RegExp(`\\b(${SCAM_ALTERNATIVES})\\b`, 'i');
/**
 * A scam word after a negation ("not a scam", "no rug", "isn't a rug", "never dumps", "not gonna
 * rug") says the opposite, so it is taken out before the words are looked for. \u2019 is the curly
 * apostrophe phones type. Only a few filler words may sit between the negation and the word.
 */
const NEGATED_SCAM = new RegExp(
  '\\b(?:not|no|isn[\'\\u2019]?t|aren[\'\\u2019]?t|ain[\'\\u2019]?t|wasn[\'\\u2019]?t|never|without|zero|won[\'\\u2019]?t|don[\'\\u2019]?t|doesn[\'\\u2019]?t|can[\'\\u2019]?t|cannot)' +
    '\\s+(?:(?:a|an|the|any|gonna|going|to|be|get|got|really|even|just|fully)\\s+)*' +
    `(?:${SCAM_ALTERNATIVES})\\b`,
  'gi',
);
const SCAM_EMOJI = /💀|🚨|📉|🤡/u;
const SLURS = /\b(nigg\w*|fagg?\w*|retard\w*)\b/gi;

export function moodOf(text: string): Mood {
  const scam = SCAM_WORDS.test(text.replace(NEGATED_SCAM, ' ')) || SCAM_EMOJI.test(text);
  const moon = MOON_WORDS.test(text) || MOON_EMOJI.test(text);
  if (scam) return 'scam';
  if (moon) return 'moon';
  return 'neutral';
}

export function cleanText(raw: string): string {
  const cleaned = raw
    .replace(/https?:\/\/\S+/g, '')
    .replace(SLURS, '***')
    .replace(/\s+/g, ' ')
    .trim();
  // Slice by code points so emoji are never cut in half.
  return Array.from(cleaned).slice(0, 160).join('');
}

type RawTweet = {
  id_str?: string;
  full_text?: string;
  text?: string;
  tweet_created_at?: string;
  user?: { screen_name?: string; name?: string; followers_count?: number };
};

export function toItems(tweets: RawTweet[]): ChatterItem[] {
  const items: ChatterItem[] = [];
  for (const t of tweets) {
    const author = t.user?.screen_name;
    const id = t.id_str;
    const text = cleanText(t.full_text ?? t.text ?? '');
    if (!author || !id || text.length < 3) continue;
    items.push({
      id,
      author,
      name: (t.user?.name ?? author).slice(0, 40),
      followers: t.user?.followers_count ?? 0,
      text,
      createdAt: t.tweet_created_at ?? '',
      url: `https://x.com/${author}/status/${id}`,
      mood: moodOf(text),
    });
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

const cache = new Map<string, { at: number; body: string }>();
let budget = { hour: 0, used: 0 };

/** `source` (x-cache) says where an answer came from: this isolate's memory, the data centre's cache, or SocialData. */
function json(body: string, status = 200, source?: 'memory' | 'edge' | 'miss'): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=30',
      ...(source ? { 'x-cache': source } : {}),
    },
  });
}

/** The data centre's cache, or undefined where there is none (node:test, a runtime without it). */
function edgeCache(): Cache | undefined {
  return (globalThis as { caches?: { default?: Cache } }).caches?.default;
}

/** A body from the data centre's cache, or undefined. A cache that fails is skipped, never an error. */
async function edgeGet(edge: Cache | undefined, key: string): Promise<string | undefined> {
  try {
    const hit = await edge?.match(key);
    return hit ? await hit.text() : undefined;
  } catch {
    return undefined;
  }
}

async function edgePut(edge: Cache | undefined, key: string, body: string, seconds: number): Promise<void> {
  try {
    await edge?.put(key, new Response(body, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${seconds}` } }));
  } catch (error) {
    console.warn(`chatter: cache put: ${error instanceof Error ? error.message : error}`);
  }
}

/** When a cached body was fetched (its fetchedAt), so a copy from the data centre keeps its real age. */
function fetchedAtOf(body: string, fallback: number): number {
  try {
    const at = Date.parse((JSON.parse(body) as { fetchedAt?: unknown }).fetchedAt as string);
    return Number.isFinite(at) ? at : fallback;
  } catch {
    return fallback;
  }
}

/**
 * One more upstream call, if the hour's budget allows: counted in memory (per isolate) and, where
 * there is a cache, in it too (per data centre: a counter entry per hour). The counter is read and
 * written without a lock, so calls in flight together can undercount a little: a cap, not an invoice.
 */
async function spendBudget(edge: Cache | undefined, now: number): Promise<boolean> {
  const hour = Math.floor(now / 3_600_000);
  if (budget.hour !== hour) budget = { hour, used: 0 };
  if (budget.used >= HOURLY_BUDGET) return false;
  if (edge) {
    const key = `${BUDGET_PREFIX}${hour}`;
    const used = Number(await edgeGet(edge, key)) || 0;
    if (used >= HOURLY_BUDGET) return false;
    await edgePut(edge, key, String(used + 1), 3600);
  }
  budget.used += 1;
  return true;
}

export default {
  async fetch(request: Request, env: Env, ctx?: Ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json(JSON.stringify({ ok: true }));
    if (url.pathname !== '/v1/chatter' || request.method !== 'GET') return json(JSON.stringify({ error: 'not found' }), 404);

    const symbol = (url.searchParams.get('symbol') ?? '').replace(/^\$/, '');
    const mint = url.searchParams.get('mint') ?? '';
    if (!/^[A-Za-z0-9]{1,15}$/.test(symbol)) return json(JSON.stringify({ error: 'bad symbol' }), 400);
    if (mint && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return json(JSON.stringify({ error: 'bad mint' }), 400);

    const key = `${symbol.toUpperCase()}|${mint}`;
    const now = Date.now();
    let hit = cache.get(key);
    if (hit && now - hit.at < CACHE_MS) return json(hit.body, 200, 'memory');
    // Not fresh in this isolate: another isolate of the data centre may have fetched it meanwhile.
    const edge = edgeCache();
    const edgeKey = `${CACHE_PREFIX}${encodeURIComponent(key)}`;
    const shared = await edgeGet(edge, edgeKey);
    if (shared !== undefined) {
      hit = { at: fetchedAtOf(shared, now), body: shared };
      cache.set(key, hit);
      return json(shared, 200, 'edge');
    }
    if (!env.SOCIALDATA_API_KEY) return json(JSON.stringify({ symbol, items: [], error: 'not configured' }), 503);
    if (!(await spendBudget(edge, now))) return json(hit?.body ?? JSON.stringify({ symbol, items: [], error: 'budget' }));

    const query = mint ? `($${symbol} OR ${mint}) -filter:nativeretweets` : `$${symbol} -filter:nativeretweets`;
    // An upstream that fails, answers late or sends rubbish is one case: the last good answer if
    // there is one, otherwise a 502 with an empty list.
    const failed = (reason: string) => json(hit?.body ?? JSON.stringify({ symbol, items: [], error: reason }), hit ? 200 : 502);
    let data: { tweets?: RawTweet[] };
    try {
      const upstream = await fetch(
        `https://api.socialdata.tools/twitter/search?query=${encodeURIComponent(query)}&type=Latest`,
        {
          headers: { Authorization: `Bearer ${env.SOCIALDATA_API_KEY}`, Accept: 'application/json' },
          // The signal also covers reading the body.
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        },
      );
      if (!upstream.ok) return failed(`upstream ${upstream.status}`);
      data = (await upstream.json()) as { tweets?: RawTweet[] };
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      return failed(timedOut ? 'upstream timeout' : 'upstream error');
    }
    const body = JSON.stringify({ symbol, items: toItems(data.tweets ?? []), fetchedAt: new Date(now).toISOString() });
    cache.set(key, { at: now, body });
    if (cache.size > 50) cache.delete(cache.keys().next().value as string);
    const stored = edgePut(edge, edgeKey, body, CACHE_SECONDS);
    if (ctx) ctx.waitUntil(stored);
    else await stored;
    return json(body, 200, 'miss');
  },
};
