// Run: node --test services/link/test/*.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appIntent, cleanAddress, cleanName, cleanTicker, getLink, handle, readChallenge, type Challenge } from '../src/index.ts';
import { base58Encode } from '../src/names.ts';

const get = (path: string) => handle(new Request(`https://sol.flipthememe.com${path}`));
/** A valid wallet address: 32 bytes of 7. */
const BY = base58Encode(new Uint8Array(32).fill(7));
const PREFIX = 'intent://round/';
const SUFFIX = ';end';

/** The href of the link labelled `label`, unescaped as a browser reads it. */
function href(body: string, label: string): string | null {
  const m = body.match(new RegExp(`<a class="btn [a-z]+" href="([^"]*)">${label}</a>`));
  return m ? m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>') : null;
}

test('a challenge link names the side and the token and offers the opposite side', async () => {
  const res = get('/r/496?side=up&t=Tesla');
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /FRIEND IS UP/);
  assert.match(body, /ON \$TESLA/);
  assert.match(body, /CALL DOWN/);
  assert.match(body, /ROUND #496/);
  assert.ok(body.includes('intent://round/496?side=up&amp;t=Tesla#Intent;scheme=flipthememe;package=com.flipthememe.app;'));
  assert.match(body, /<meta property="og:title" content="I&#39;m UP on \$Tesla\. Take the other side\.">/);
});

test('the challenge page names the inviter, invites to any later round and passes the whole challenge on', async () => {
  const body = await get(`/r/496?side=up&t=Tesla&by=${BY}&n=OxBla.skr`).text();
  assert.match(body, /OXBLA\.SKR IS UP &#9650;/);
  assert.match(body, /CALL DOWN &#9660;/);
  assert.match(body, /No rush: rounds start every minute\./);
  assert.match(body, /whenever you are ready/);
  assert.match(body, /marked RIVAL when you meet in a round/);
  assert.match(body, /not against your friend directly/);
  assert.match(body, /Solana devnet, test SOL only/);
  // OPEN FLIPTHEMEME carries every checked value into the app, and Chrome falls back to /get with the same challenge.
  const fallback = `https://sol.flipthememe.com/get?r=496&side=up&t=Tesla&by=${BY}&n=oxbla.skr`;
  assert.equal(
    href(body, 'OPEN FLIPTHEMEME'),
    `intent://round/496?side=up&t=Tesla&by=${BY}&n=oxbla.skr#Intent;scheme=flipthememe;package=com.flipthememe.app;S.browser_fallback_url=${encodeURIComponent(fallback)};end`,
  );
  // GET THE ANDROID APP keeps the challenge too, so the app opens on it after the install.
  assert.equal(href(body, 'GET THE ANDROID APP'), fallback);
  // Without a name the headline stays FRIEND.
  assert.match(await get(`/r/496?side=down&by=${BY}`).text(), /FRIEND IS DOWN/);
});

test('challenge values: each is checked on its own, a refused one is dropped', () => {
  const read = (query: string) => readChallenge('7', new URLSearchParams(query));
  assert.deepEqual(read(`side=down&t=$WIF&by=${BY}&n=OxBla.SKR`), { round: '7', side: 'down', ticker: 'WIF', by: BY, name: 'oxbla.skr' });
  assert.deepEqual(read(''), { round: '7', side: null, ticker: null, by: null, name: null });
  assert.equal(read('side=UP').side, null);
  assert.equal(read('side=up&side=down').side, 'up');
  assert.equal(cleanAddress(BY), BY);
  for (const bad of ['0OIl'.repeat(8), '1'.repeat(43), `${BY}x`, BY.slice(0, 20), '<script>', '', null]) assert.equal(cleanAddress(bad), null, String(bad));
  assert.equal(cleanName('OxBla.SKR'), 'oxbla.skr');
  assert.equal(cleanName('a'.repeat(32)), 'a'.repeat(32));
  for (const bad of ['a'.repeat(33), '<b>x</b>', 'ox bla', 'ox\u0000bla', 'дима', 'ox‮bla', '"onmouseover=', '', null]) assert.equal(cleanName(bad), null, String(bad));
});

test('the app intent and the install link carry only checked values, URL-encoded', () => {
  const c: Challenge = { round: '12', side: 'up', ticker: 'Dog Wif', by: BY, name: 'oxbla.skr' };
  assert.equal(getLink(c), `https://sol.flipthememe.com/get?r=12&side=up&t=Dog%20Wif&by=${BY}&n=oxbla.skr`);
  const intent = appIntent(c);
  assert.ok(intent.startsWith(`${PREFIX}12?side=up&t=Dog%20Wif&by=${BY}&n=oxbla.skr#Intent;`));
  assert.ok(intent.endsWith(SUFFIX));
  // The fallback is one encoded value: nothing in it can end the intent early.
  const fallback = intent.match(/;S\.browser_fallback_url=([^;#]*);end$/)?.[1] ?? '';
  assert.equal(decodeURIComponent(fallback), getLink(c));
  // A round alone: no query in the intent, the round alone on the install page.
  const bare: Challenge = { round: '5', side: null, ticker: null, by: null, name: null };
  assert.equal(
    appIntent(bare),
    `${PREFIX}5#Intent;scheme=flipthememe;package=com.flipthememe.app;S.browser_fallback_url=${encodeURIComponent('https://sol.flipthememe.com/get?r=5')};end`,
  );
});

test('/get with a challenge offers OPEN THE CHALLENGE; without one it is unchanged', async () => {
  const body = await get(`/get?r=496&side=up&t=Tesla&by=${BY}&n=oxbla.skr`).text();
  assert.match(body, /DOWNLOAD THE APK<\/a>\n<a class="btn get" href="[^"]*">OPEN THE CHALLENGE<\/a>/);
  assert.match(body, /After installing, come back here and tap it: the app opens on your friend's challenge\./);
  assert.equal(href(body, 'OPEN THE CHALLENGE'), appIntent(readChallenge('496', new URLSearchParams(`side=up&t=Tesla&by=${BY}&n=oxbla.skr`))));
  // Any valid round is enough; without one (or with a bad one) the page is the plain install page.
  assert.match(await get('/get?r=5').text(), /OPEN THE ROUND<\/a>\n<p>After installing, come back here and tap it: the app opens on round #5\.<\/p>/);
  const plain = await get('/get').text();
  for (const path of ['/get?r=abc&side=up', '/get?side=up&t=WIF', `/get?r=${'9'.repeat(21)}`, '/']) {
    assert.equal(await get(path).text(), plain, path);
  }
  assert.ok(!plain.includes('OPEN THE CHALLENGE') && !plain.includes('intent://'));
});

test('a link with its sender and no side is an invitation to play', async () => {
  const body = await get(`/r/496?by=${BY}&n=OxBla.skr`).text();
  assert.match(body, /<div class="big">OXBLA\.SKR INVITES YOU<\/div><div class="call">UP &#9650; OR DOWN &#9660;<\/div>/);
  assert.match(body, /A NEW ROUND EVERY MINUTE/);
  assert.ok(!body.includes('ROUND #496') && !body.includes('PICK A SIDE') && !body.includes('take the other side'));
  assert.match(body, /top up once and make your call whenever you are ready/);
  assert.match(body, /<meta property="og:title" content="oxbla\.skr invites you to FlipTheMeme">/);
  assert.equal(href(body, 'OPEN FLIPTHEMEME'), appIntent(readChallenge('496', new URLSearchParams(`by=${BY}&n=oxbla.skr`))));
  // Without a name the page still says who: a friend.
  assert.match(await get(`/r/496?by=${BY}`).text(), /A FRIEND INVITES YOU/);
  const install = await get(`/get?r=496&by=${BY}&n=oxbla.skr`).text();
  assert.match(install, /OPEN THE INVITE<\/a>\n<p>After installing, come back here and tap it: the app opens on your friend's invite\.<\/p>/);
});

test('hostile query values never reach the page or the intent unescaped', async () => {
  const ticker = '%22%3E%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E%23Intent%3Bend';
  const rest = '&by=%3Csvg%2Fonload%3Dalert(1)%3E&n=%22%20onmouseover%3D%22alert(1)%3B';
  const paths = [
    `/r/7?side=up&t=${ticker}${rest}`,
    `/r/7?side=%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E&t=${ticker}${rest}`,
    `/get?r=7&side=up&t=${ticker}${rest}`,
  ];
  for (const path of paths) {
    const body = await get(path).text();
    assert.ok(!/<(script|img|svg)/i.test(body), `${path}: a tag got through`);
    assert.ok(!/\son[a-z]+\s*=/i.test(body), `${path}: an event handler got through`);
    assert.ok(!body.includes('alert('), path);
    // Every attribute value stays inside its quotes: no raw quote, angle bracket or space comes from the query.
    for (const m of body.matchAll(/href="([^"]*)"/g)) assert.ok(!/[<>'" ]/.test(m[1]), m[1]);
    // One intent, ending where it should: nothing from the query adds an extra or ends it early.
    const intent = href(body, path.startsWith('/get') ? 'OPEN THE CHALLENGE' : 'OPEN FLIPTHEMEME') ?? '';
    assert.ok(intent.startsWith(`${PREFIX}7`) && intent.endsWith(SUFFIX), intent);
    assert.equal(intent.split('#Intent;').length, 2, intent);
    assert.equal(intent.split(';').length, 5, intent);
  }
  // What survives the checks is plain text: the wallet, the name and a bad side are dropped.
  const c = readChallenge('7', new URLSearchParams(`side=up&t=${ticker}${rest}`));
  assert.deepEqual(c, { round: '7', side: 'up', ticker: 'img srcx onerroraler', by: null, name: null });
  assert.equal(
    appIntent(c),
    `${PREFIX}7?side=up&t=img%20srcx%20onerroraler#Intent;scheme=flipthememe;package=com.flipthememe.app;S.browser_fallback_url=${encodeURIComponent(
      'https://sol.flipthememe.com/get?r=7&side=up&t=img%20srcx%20onerroraler',
    )};end`,
  );
});

test('query values cannot inject markup', async () => {
  const body = await get('/r/7?side=%3Cscript%3E&t=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E').text();
  assert.ok(!body.includes('<script>') && !body.includes('<img'));
  assert.match(body, /PICK A SIDE/);
  assert.equal(cleanTicker('$<b>WIF</b>'), 'bWIFb');
  assert.equal(cleanTicker('$$$'), null);
  assert.equal(cleanTicker('a'.repeat(40))?.length, 20);
});

test('asset links carry the release certificate for the app package', async () => {
  const res = get('/.well-known/assetlinks.json');
  assert.equal(res.headers.get('content-type'), 'application/json');
  const [entry] = (await res.json()) as { target: { package_name: string; sha256_cert_fingerprints: string[] } }[];
  assert.equal(entry.target.package_name, 'com.flipthememe.app');
  assert.match(entry.target.sha256_cert_fingerprints[0], /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
});

test('other paths: home and /get explain the app, the rest redirects, writes are refused', async () => {
  assert.match(await get('/get').text(), /DOWNLOAD THE APK/);
  assert.equal(get('/').status, 200);
  const other = get('/r/abc');
  assert.equal(other.status, 302);
  assert.equal(other.headers.get('location'), 'https://sol.flipthememe.com/get');
  assert.equal(handle(new Request('https://sol.flipthememe.com/r/1', { method: 'POST' })).status, 405);
  assert.ok(appIntent({ round: '5', side: null, ticker: null, by: null, name: null }).endsWith(';end'));
});

const HERO = 'ONE MINUTE.<br>UP OR DOWN.';
const SUB = 'A 1-minute move on a busy Solana memecoin. Result in about 2 minutes.';
const FREE_SOL = 'No devnet SOL? Tap GET TEST SOL in the app.';

test('the home, /get and challenge pages use the canonical wording and stay honest about devnet', async () => {
  const hero = ['/', '/get', `/get?r=496&side=up&t=Tesla&by=${BY}`];
  const challenge = ['/r/496', '/r/496?side=up', '/r/496?side=down&t=Tesla', `/r/496?by=${BY}&n=OxBla.skr`];
  for (const path of [...hero, ...challenge]) {
    const body = await get(path).text();
    assert.ok(body.includes(SUB), `${path}: sub line missing`);
    assert.ok(body.includes(`<p>${FREE_SOL}</p>`), `${path}: the free test SOL line is missing`);
    assert.ok(!/fresh|60 seconds|60-second|60 sec/i.test(body), `${path}: old wording left`);
    assert.match(body, /DEVNET/, path);
    assert.match(body, /test SOL/, path);
    assert.match(body, /<meta name="description" content="[^"]*1-minute move[^"]*about 2 minutes[^"]*">/, path);
  }
  for (const path of hero) assert.ok((await get(path).text()).includes(HERO), `${path}: hero missing`);
  assert.match(await get('/r/496?side=down').text(), /ON A BUSY MEMECOIN/);
});
