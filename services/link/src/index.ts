import { avatar } from './avatar.ts';
// sol.flipthememe.com: the web side of a shared round link.
//
//   /r/<round>?side=up&t=<ticker>&by=<wallet>&n=<name>
//                                   challenge page: opens the app on the challenge, or offers the APK
//   /get?r=<round>&side=..&t=..&by=..&n=..
//                                   how to install and play; with a challenge, a button that opens the
//                                   app on it once installed
//   /.well-known/assetlinks.json    Android App Links: lets the app open /r/ links directly
//   /v1/faucet                      POST {"address"}: 0.2 test SOL on devnet for the app's GET TEST SOL
//                                   button, see faucet.ts
//   /v1/names?a=<addr>,<addr>       Seeker ID (.skr) names for player rows, see names.ts. OPTIONAL: the
//                                   app resolves .skr names itself on mainnet and does not call this
//
// The app is not a web app: this page only bridges a messenger link to the Android app. A friend
// rarely installs, connects and tops up within the minute a round is open, so the challenge travels
// on (to /get, then into the app) and the copy invites them to any later round.

import { faucet, type FaucetEnv } from './faucet.ts';
import { leaderboard, leaderboardPage, type LeaderboardEnv } from './leaderboard.ts';
import { base58Decode, names, type NamesEnv } from './names.ts';

const PACKAGE = 'com.flipthememe.app';
/** SHA-256 of the release signing certificate (public, printed by apksigner in CI). */
const RELEASE_CERT_SHA256 = '94:A7:26:CF:26:AB:3A:F1:FA:D6:54:4A:73:86:22:29:7B:A0:A9:AD:40:95:76:76:56:58:F7:A3:3F:3F:20:89';
const ORIGIN = 'https://sol.flipthememe.com';
/** Every release carries the APK under this fixed name, so the newest one is always this URL. */
const APK_URL = 'https://github.com/Sofiia7/flipthememe-apk/releases/latest/download/FlipTheMeme.apk';
const OG_IMAGE = 'https://flipthememe.com/og-cover.png';
/** The one promise, worded the same on every page: the move is one minute, the result takes about two. */
const PROMISE = 'A 1-minute move on a busy Solana memecoin. Result in about 2 minutes.';
/** The line that tells a new player where free devnet SOL comes from (the faucet in faucet.ts behind the app's button). */
const FREE_SOL = 'No devnet SOL? Tap GET TEST SOL in the app.';

const ASSET_LINKS = [
  {
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: PACKAGE, sha256_cert_fingerprints: [RELEASE_CERT_SHA256] },
  },
];

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

/** A ticker from the query, cut to something a ticker can be: letters, digits, a few marks, 20 at most. */
export function cleanTicker(raw: string | null): string | null {
  if (!raw) return null;
  const t = Array.from(raw.replace(/^\$+/, '').replace(/[^\p{L}\p{N} ._-]/gu, '').trim()).slice(0, 20).join('');
  return t || null;
}

/** The inviter's wallet from the query: base58, 32-44 characters, exactly 32 bytes; anything else is refused. */
export function cleanAddress(raw: string | null): string | null {
  return raw && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw) && base58Decode(raw)?.length === 32 ? raw : null;
}

/** The inviter's display name (a Seeker ID such as oxbla.skr): lowercase letters, digits, dots, hyphens, underscores, 32 at most. */
export function cleanName(raw: string | null): string | null {
  const name = raw?.toLowerCase() ?? '';
  return /^[a-z0-9._-]{1,32}$/.test(name) ? name : null;
}

/** A challenge as the link carries it; every value but the round may be missing. */
export type Challenge = { round: string; side: 'up' | 'down' | null; ticker: string | null; by: string | null; name: string | null };

/** The challenge of `round` from a query: each value is checked on its own, a refused one is dropped. */
export function readChallenge(round: string, query: URLSearchParams): Challenge {
  const side = query.get('side');
  return {
    round,
    side: side === 'up' || side === 'down' ? side : null,
    ticker: cleanTicker(query.get('t')),
    by: cleanAddress(query.get('by')),
    name: cleanName(query.get('n')),
  };
}

/** "side=up&t=WIF&by=..&n=..": the values present, each URL-encoded. */
function challengeQuery(c: Challenge): string {
  const pairs: [string, string | null][] = [
    ['side', c.side],
    ['t', c.ticker],
    ['by', c.by],
    ['n', c.name],
  ];
  return pairs.flatMap(([key, value]) => (value === null ? [] : [`${key}=${encodeURIComponent(value)}`])).join('&');
}

/** The install page that keeps the challenge, to open the app on it once installed. */
export function getLink(c: Challenge): string {
  const query = challengeQuery(c);
  return `${ORIGIN}/get?r=${encodeURIComponent(c.round)}${query ? `&${query}` : ''}`;
}

/** Opens the app on the challenge when it is installed; Chrome falls back to the install page, which keeps it. */
export function appIntent(c: Challenge): string {
  const query = challengeQuery(c);
  return `intent://round/${encodeURIComponent(c.round)}${query ? `?${query}` : ''}#Intent;scheme=flipthememe;package=${PACKAGE};S.browser_fallback_url=${encodeURIComponent(getLink(c))};end`;
}

function page(opts: { title: string; description: string; url: string; body: string }): string {
  const t = escapeHtml(opts.title);
  const d = escapeHtml(opts.description);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t}</title>
<meta name="description" content="${d}">
<meta property="og:type" content="website">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:url" content="${escapeHtml(opts.url)}">
<meta property="og:image" content="${OG_IMAGE}">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#100d1f">
<style>
  :root { --bg: #100d1f; --panel: #1c1830; --text: #e6e0f1; --dim: #9f9aad; --green: #3dff8b; --red: #ff3d6e; --gold: #ffe14d; --purple: #b46cff; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--text); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; display: flex; justify-content: center; }
  main { width: 100%; max-width: 440px; padding: 28px 16px 40px; display: flex; flex-direction: column; gap: 18px; }
  .top { display: flex; justify-content: space-between; align-items: center; }
  .brand { font-weight: 900; font-size: 20px; letter-spacing: 1px; color: #fff; text-shadow: 2px 2px 0 var(--purple); }
  .tag { border: 1px solid var(--gold); color: var(--gold); font-size: 11px; font-weight: 900; padding: 1px 6px; }
  .card { border: 3px solid var(--purple); background: var(--panel); padding: 22px 18px; text-align: center; display: flex; flex-direction: column; gap: 10px; box-shadow: 0 0 24px #b46cff44; }
  .big { font-size: 34px; font-weight: 900; line-height: 1.1; overflow-wrap: anywhere; }
  .up { color: var(--green); } .down { color: var(--red); }
  .round { color: var(--dim); font-size: 14px; letter-spacing: 2px; }
  .sub { color: var(--text); font-size: 14px; line-height: 1.5; }
  .call { font-size: 22px; font-weight: 900; color: #fff; letter-spacing: 1px; }
  a.btn { display: block; text-align: center; text-decoration: none; font-weight: 900; font-size: 18px; letter-spacing: 1px; padding: 16px; border: 3px solid; }
  a.go { background: linear-gradient(#ffe680, #f6b62d 60%, #d9870f); color: #2a1a00; border-color: #fff3b0; }
  a.get { color: var(--text); border-color: var(--purple); }
  p { margin: 0; color: var(--dim); font-size: 13px; line-height: 1.6; }
  ol { margin: 0; padding-left: 20px; color: var(--text); font-size: 14px; line-height: 1.7; }
</style>
</head>
<body><main>
<div class="top"><span class="brand">$FLIPTHEMEME</span><span class="tag">DEVNET</span></div>
${opts.body}
</main></body>
</html>`;
}

function challengePage(c: Challenge, url: string): string {
  const { round, side, ticker, name } = c;
  // No side but a sender: an invitation to play from outside a bet, not a call to answer.
  const invite = side === null && c.by !== null;
  const other = side === 'up' ? 'down' : side === 'down' ? 'up' : null;
  const token = ticker ? `$${ticker}` : 'a busy memecoin';
  const title = side
    ? `I'm ${side.toUpperCase()} on ${token}. Take the other side.`
    : invite
      ? `${name ?? 'A friend'} invites you to FlipTheMeme`
      : `FlipTheMeme round #${round}`;
  const who = escapeHtml((name ?? 'friend').toUpperCase());
  const headline = side
    ? `<div class="big ${side}">${who} IS ${side.toUpperCase()} ${side === 'up' ? '&#9650;' : '&#9660;'}</div>
<div class="call">ON ${escapeHtml(token.toUpperCase())}</div>
<div class="big ${other}">CALL ${other!.toUpperCase()} ${other === 'up' ? '&#9650;' : '&#9660;'}</div>`
    : `<div class="big">${invite ? `${name ? who : 'A FRIEND'} INVITES YOU` : 'PICK A SIDE'}</div><div class="call">UP &#9650; OR DOWN &#9660;</div>`;
  return page({
    title,
    description: `${PROMISE} Matched 1:1. Devnet, test SOL.`,
    url,
    body: `<div class="card">
${headline}
<div class="round">${invite ? 'A NEW ROUND EVERY MINUTE' : `ROUND #${escapeHtml(round)}`}</div>
<div class="sub">${PROMISE}</div>
</div>
<a class="btn go" href="${escapeHtml(appIntent(c))}">OPEN FLIPTHEMEME</a>
<a class="btn get" href="${escapeHtml(getLink(c))}">GET THE ANDROID APP</a>
<p>No rush: rounds start every minute. Install the app, top up once and ${side ? 'take the other side' : 'make your call'} whenever you are ready. In the app your friend's face is marked RIVAL when you meet in a round. Calls are matched in one shared bank, not against your friend directly. You never buy the token. Solana devnet, test SOL only.</p>
<p>${FREE_SOL}</p>`,
  });
}

/** How to install and play; with a challenge or an invite (r, side, t, by, n), a button that opens the app on it once installed. */
function getPage(c: Challenge | null): string {
  return page({
    title: 'FlipTheMeme for Android',
    description: `${PROMISE} Android app on Solana devnet.`,
    url: `${ORIGIN}/get`,
    body: `<div class="card"><div class="big">ONE MINUTE.<br>UP OR DOWN.</div><div class="sub">${PROMISE}</div></div>
<a class="btn go" href="${APK_URL}">DOWNLOAD THE APK</a>${
      c
        ? `
<a class="btn get" href="${escapeHtml(appIntent(c))}">OPEN THE ${c.side ? 'CHALLENGE' : c.by ? 'INVITE' : 'ROUND'}</a>
<p>After installing, come back here and tap it: the app opens on ${c.side ? "your friend's challenge" : c.by ? "your friend's invite" : `round #${escapeHtml(c.round)}`}.</p>`
        : ''
    }
<ol>
<li>Install the APK on an Android phone (built for Solana Seeker).</li>
<li>Switch your wallet to Devnet: Seed Vault Wallet or Solflare, Settings, Network, Devnet.</li>
<li>Open FlipTheMeme, tap Top up &amp; play once, then every call is one tap.</li>
</ol>
<p>${FREE_SOL}</p>
<p>Devnet only, test SOL only. Prices come from live PumpSwap pools on mainnet.</p>`,
  });
}

const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' } });

export function handle(request: Request): Response {
  const url = new URL(request.url);
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
  if (url.pathname === '/.well-known/assetlinks.json') {
    return new Response(JSON.stringify(ASSET_LINKS), {
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' },
    });
  }
  const round = url.pathname.match(/^\/r\/(\d{1,20})\/?$/)?.[1];
  if (round) return html(challengePage(readChallenge(round, url.searchParams), `${ORIGIN}/r/${round}`));
  if (url.pathname === '/get') {
    const r = url.searchParams.get('r');
    return html(getPage(r && /^\d{1,20}$/.test(r) ? readChallenge(r, url.searchParams) : null));
  }
  if (url.pathname === '/') return html(getPage(null));
  return new Response(null, { status: 302, headers: { location: `${ORIGIN}/get` } });
}

export default {
  fetch: async (request: Request, env: NamesEnv & FaucetEnv & LeaderboardEnv, ctx: { waitUntil(promise: Promise<unknown>): void }) => {
    const { pathname } = new URL(request.url);
    if (pathname === '/v1/arena' && request.method === 'GET') {
      const raw = await env.LEADERBOARD?.get('snapshot');
      const arena = raw ? JSON.parse(raw).arena : null;
      return Response.json(arena ?? { error: 'collecting' }, { status: arena ? 200 : 503, headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' } });
    }
    if (pathname === '/v1/avatar' && request.method === 'GET') return avatar(request);
    if (pathname === '/v1/leaderboard') return leaderboard(request, env);
    if (pathname === '/leaderboard') return leaderboardPage();
    if (pathname === '/v1/names') return names(request, env, ctx);
    if (pathname === '/v1/faucet') return faucet(request, env);
    return handle(request);
  },
};
