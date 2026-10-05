// sol.flipthememe.com: the web side of a shared round link.
//
//   /r/<round>?side=up&t=<ticker>   challenge page: opens the app on that round, or offers the APK
//   /get                            how to install and play
//   /.well-known/assetlinks.json    Android App Links: lets the app open /r/ links directly
//   /v1/names?a=<addr>,<addr>       Seeker ID (.skr) names for the app's player rows, see names.ts
//
// The app is not a web app: this page only bridges a messenger link to the Android app.

import { names, type NamesEnv } from './names.ts';

const PACKAGE = 'com.flipthememe.app';
/** SHA-256 of the release signing certificate (public, printed by apksigner in CI). */
const RELEASE_CERT_SHA256 = '94:A7:26:CF:26:AB:3A:F1:FA:D6:54:4A:73:86:22:29:7B:A0:A9:AD:40:95:76:76:56:58:F7:A3:3F:3F:20:89';
const ORIGIN = 'https://sol.flipthememe.com';
/** Every release carries the APK under this fixed name, so the newest one is always this URL. */
const APK_URL = 'https://github.com/Sofiia7/flipthememe-solana/releases/latest/download/FlipTheMeme.apk';
const OG_IMAGE = 'https://flipthememe.com/og-cover.png';

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

/** Opens the app on the round when it is installed; Chrome falls back to the install page. */
export function appIntent(round: string): string {
  return `intent://round/${round}#Intent;scheme=flipthememe;package=${PACKAGE};S.browser_fallback_url=${encodeURIComponent(`${ORIGIN}/get`)};end`;
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
  .big { font-size: 34px; font-weight: 900; line-height: 1.1; }
  .up { color: var(--green); } .down { color: var(--red); }
  .round { color: var(--dim); font-size: 14px; letter-spacing: 2px; }
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

function challengePage(round: string, side: 'up' | 'down' | null, ticker: string | null, url: string): string {
  const other = side === 'up' ? 'down' : side === 'down' ? 'up' : null;
  const token = ticker ? `$${ticker}` : 'a fresh memecoin';
  const title = side ? `I'm ${side.toUpperCase()} on ${token}. Take the other side.` : `FlipTheMeme round #${round}`;
  const headline = side
    ? `<div class="big ${side}">FRIEND IS ${side.toUpperCase()} ${side === 'up' ? '&#9650;' : '&#9660;'}</div>
<div class="call">ON ${escapeHtml(token.toUpperCase())}</div>
<div class="big ${other}">CALL ${other!.toUpperCase()} ${other === 'up' ? '&#9650;' : '&#9660;'}</div>`
    : `<div class="big">PICK A SIDE</div><div class="call">UP &#9650; OR DOWN &#9660;</div>`;
  return page({
    title,
    description: '60-second UP/DOWN calls on fresh Solana memecoins, matched 1:1. Devnet, test SOL.',
    url,
    body: `<div class="card">
${headline}
<div class="round">ROUND #${round}</div>
</div>
<a class="btn go" href="${escapeHtml(appIntent(round))}">OPEN FLIPTHEMEME</a>
<a class="btn get" href="/get">GET THE ANDROID APP</a>
<p>A new round every minute on a busy fresh memecoin, so you can always catch the next one. Calls are matched in one shared bank, not against your friend directly. You never buy the token. Solana devnet, test SOL only.</p>`,
  });
}

function getPage(): string {
  return page({
    title: 'FlipTheMeme for Android',
    description: '60-second UP/DOWN calls on fresh Solana memecoins. Android app on Solana devnet.',
    url: `${ORIGIN}/get`,
    body: `<div class="card"><div class="big">60 SECONDS.<br>UP OR DOWN.</div><div class="round">FRESH SOLANA MEMECOINS</div></div>
<a class="btn go" href="${APK_URL}">DOWNLOAD THE APK</a>
<ol>
<li>Install the APK on an Android phone (built for Solana Seeker).</li>
<li>Switch your wallet to Devnet: Seed Vault Wallet or Solflare, Settings, Network, Devnet.</li>
<li>Open FlipTheMeme, tap Top up &amp; play once, then every call is one tap.</li>
</ol>
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
  if (round) {
    const sideRaw = url.searchParams.get('side');
    const side = sideRaw === 'up' || sideRaw === 'down' ? sideRaw : null;
    return html(challengePage(round, side, cleanTicker(url.searchParams.get('t')), `${ORIGIN}/r/${round}`));
  }
  if (url.pathname === '/get' || url.pathname === '/') return html(getPage());
  return new Response(null, { status: 302, headers: { location: `${ORIGIN}/get` } });
}

export default {
  fetch: (request: Request, env: NamesEnv, ctx: { waitUntil(promise: Promise<unknown>): void }) =>
    new URL(request.url).pathname === '/v1/names' ? names(request, env, ctx) : handle(request),
};
