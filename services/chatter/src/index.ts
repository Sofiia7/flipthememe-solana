// Live X chatter about the arena token, for the "notifications raining from the top" overlay.
// The SocialData key stays here as a Worker secret; the app only ever sees tweet text.
// Real tweets only: nothing is generated or replayed.

export interface Env {
  SOCIALDATA_API_KEY: string;
}

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

const CACHE_MS = 60_000;
/** Upstream calls allowed per isolate per hour: SocialData bills per tweet returned. */
const HOURLY_BUDGET = 40;
const MAX_ITEMS = 12;

const MOON_WORDS = /\b(moon\w*|pump\w*|send it|sending|gem|ape|aped|aping|bullish|lfg|\d+x|ath|wagmi|buy\w*|long|rocket\w*)\b/i;
const MOON_EMOJI = /🚀|🔥|💎|📈/u;
const SCAM_WORDS = /\b(scam\w*|rug\w*|dump\w*|honeypot|jeet\w*|bearish|dead|rekt|sell\w*|short|fud|exit liquidity)\b/i;
const SCAM_EMOJI = /💀|🚨|📉|🤡/u;
const SLURS = /\b(nigg\w*|fagg?\w*|retard\w*)\b/gi;

export function moodOf(text: string): Mood {
  const scam = SCAM_WORDS.test(text) || SCAM_EMOJI.test(text);
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

function json(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=30' },
  });
}

function spendBudget(now: number): boolean {
  const hour = Math.floor(now / 3_600_000);
  if (budget.hour !== hour) budget = { hour, used: 0 };
  if (budget.used >= HOURLY_BUDGET) return false;
  budget.used += 1;
  return true;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json(JSON.stringify({ ok: true }));
    if (url.pathname !== '/v1/chatter' || request.method !== 'GET') return json(JSON.stringify({ error: 'not found' }), 404);

    const symbol = (url.searchParams.get('symbol') ?? '').replace(/^\$/, '');
    const mint = url.searchParams.get('mint') ?? '';
    if (!/^[A-Za-z0-9]{1,15}$/.test(symbol)) return json(JSON.stringify({ error: 'bad symbol' }), 400);
    if (mint && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return json(JSON.stringify({ error: 'bad mint' }), 400);

    const key = `${symbol.toUpperCase()}|${mint}`;
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && now - hit.at < CACHE_MS) return json(hit.body);
    if (!env.SOCIALDATA_API_KEY) return json(JSON.stringify({ symbol, items: [], error: 'not configured' }), 503);
    if (!spendBudget(now)) return json(hit?.body ?? JSON.stringify({ symbol, items: [], error: 'budget' }));

    const query = mint ? `($${symbol} OR ${mint}) -filter:nativeretweets` : `$${symbol} -filter:nativeretweets`;
    const upstream = await fetch(
      `https://api.socialdata.tools/twitter/search?query=${encodeURIComponent(query)}&type=Latest`,
      { headers: { Authorization: `Bearer ${env.SOCIALDATA_API_KEY}`, Accept: 'application/json' } },
    );
    if (!upstream.ok) {
      return json(hit?.body ?? JSON.stringify({ symbol, items: [], error: `upstream ${upstream.status}` }), hit ? 200 : 502);
    }
    const data = (await upstream.json()) as { tweets?: RawTweet[] };
    const body = JSON.stringify({ symbol, items: toItems(data.tweets ?? []), fetchedAt: new Date(now).toISOString() });
    cache.set(key, { at: now, body });
    if (cache.size > 50) cache.delete(cache.keys().next().value as string);
    return json(body);
  },
};
