// Node tests for challenge links and the challenge kept on the phone (no React Native). Run from the repo root:
//   node --test "apps/mobile/src/__tests__/*.test.ts"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddressDecoder } from '@solana/kit';
import { Outcome, RefundReason, RoundStatus, Side, type RoundAccount } from '@flipthememe/client';
import { cleanAddress, cleanName, cleanTicker, parseRoundLink, roundLink, shortAddress } from '../lib/format.ts';
import {
  CHALLENGE_KEY,
  CHALLENGE_TTL_MS,
  challengeActive,
  challengeHeadline,
  challengeRoundState,
  createChallengeStore,
  inviterPosition,
  meetLine,
  parseChallenge,
  roundStateLine,
  serializeChallenge,
  type Challenge,
  type ChallengeStorage,
} from '../state/challenge.ts';

const SOL = 1_000_000_000n;
const addr = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n));
const BY = addr(7);
const WEB = 'https://sol.flipthememe.com/r/';
const NOW = 1_800_000_000_000;

const challenge = (over: Partial<Challenge> = {}): Challenge => ({
  round: 496n,
  side: 'up',
  ticker: 'TSLA',
  by: BY,
  name: 'oxbla.skr',
  at: NOW,
  ...over,
});

test('a challenge link round-trips: round, side, ticker, inviter wallet and name', () => {
  const link = roundLink(496n, { side: 'UP', token: 'TSLA', by: BY, name: 'oxbla.skr' });
  assert.equal(link, `${WEB}496?side=up&t=TSLA&by=${BY}&n=oxbla.skr`);
  assert.deepEqual(parseRoundLink(link), { round: 496n, side: 'up', ticker: 'TSLA', by: BY, name: 'oxbla.skr' });
  // The app scheme carries the same query (the OPEN FLIPTHEMEME button of the link page).
  assert.deepEqual(parseRoundLink(`flipthememe://round/496?side=down&t=Dog%20Wif&by=${BY}&n=oxbla.skr`), {
    round: 496n,
    side: 'down',
    ticker: 'Dog Wif',
    by: BY,
    name: 'oxbla.skr',
  });
  // Values go out encoded and come back decoded.
  const spaced = roundLink(9n, { side: 'DOWN', token: 'Dog Wif', by: null, name: null });
  assert.equal(spaced, `${WEB}9?side=down&t=Dog%20Wif`);
  assert.equal(parseRoundLink(spaced)?.ticker, 'Dog Wif');
});

test('old links and plain round links keep working', () => {
  const none = { side: null, ticker: null, by: null, name: null };
  assert.equal(roundLink(5n), `${WEB}5`);
  assert.deepEqual(parseRoundLink(`${WEB}5`), { round: 5n, ...none });
  assert.equal(roundLink(496n, { side: 'UP', token: 'Tesla' }), `${WEB}496?side=up&t=Tesla`);
  assert.deepEqual(parseRoundLink(`${WEB}496?side=up&t=Tesla`), { round: 496n, ...none, side: 'up', ticker: 'Tesla' });
  assert.deepEqual(parseRoundLink('flipthememe://round/12'), { round: 12n, ...none });
  assert.deepEqual(parseRoundLink('FLIPTHEMEME:///round/12?x=1'), { round: 12n, ...none });
  // A trailing slash, a fragment or an unknown parameter changes nothing.
  assert.deepEqual(parseRoundLink(`${WEB}12/?utm=x&side=down#top`), { round: 12n, ...none, side: 'down' });
  assert.deepEqual(parseRoundLink(`${WEB}12#side=down`), { round: 12n, ...none });
});

test('hostile links: each value is checked on its own, only the round id is required', () => {
  const parse = (query: string) => parseRoundLink(`${WEB}7?${query}`);
  // side: up or down, nothing else.
  assert.equal(parse('side=UP')?.side, null);
  assert.equal(parse('side=sideways')?.side, null);
  assert.equal(parse('side=up&side=down')?.side, 'up', 'the first value wins, as on the link page');
  // by: a base58 address of exactly 32 bytes.
  assert.equal(parse(`by=${BY}`)?.by, BY);
  for (const bad of ['0OIl'.repeat(8), '1'.repeat(43), `${BY}x`, BY.slice(0, 20), '%3Cscript%3E', '']) {
    assert.equal(parse(`by=${bad}`)?.by, null, bad);
  }
  // n: lowercase letters, digits, dots, hyphens, underscores; 32 at most.
  assert.equal(parse('n=OxBla.SKR')?.name, 'oxbla.skr');
  assert.equal(parse(`n=${'a'.repeat(32)}`)?.name, 'a'.repeat(32));
  for (const bad of ['a'.repeat(33), '%3Cb%3Eoxbla', 'ox%20bla', 'ox%00bla', '%D0%B4%D0%B8%D0%BC%D0%B0', 'ox%E2%80%AEbla', '%22onmouseover%3D', '']) {
    assert.equal(parse(`n=${bad}`)?.name, null, bad);
  }
  // t: cut like the link page's cleanTicker.
  assert.equal(parse('t=%24%3Cb%3EWIF%3C%2Fb%3E')?.ticker, 'bWIFb');
  assert.equal(parse(`t=${'A'.repeat(40)}`)?.ticker, 'A'.repeat(20));
  assert.equal(parse('t=Dog+Wif')?.ticker, 'Dog Wif');
  assert.equal(parse('t=%F0%9F%90%B6')?.ticker, null);
  assert.equal(parse('t=%E0%A4%A')?.ticker, null, 'broken encoding');
  assert.equal(cleanTicker('$$$'), null);
  // Everything refused: the round still opens.
  assert.deepEqual(parse('side=%3Cscript%3E&t=%24%24&by=x&n=%22%3E&by=%00'), { round: 7n, side: null, ticker: null, by: null, name: null });
  // Round ids: digits within u64.
  assert.equal(parseRoundLink(`${WEB}18446744073709551615`)?.round, 18_446_744_073_709_551_615n);
  for (const url of [
    `${WEB}18446744073709551616`,
    `${WEB}-1`,
    `${WEB}1e3`,
    'http://sol.flipthememe.com/r/5',
    'https://sol.flipthememe.com.evil.example/r/5',
    'https://sol.flipthememe.com@evil.example/r/5',
    'https://evil.example/r/5?u=https://sol.flipthememe.com/r/5',
    'javascript:alert(1)//https://sol.flipthememe.com/r/5',
    'flipthememe://evil/round/5',
    ` ${WEB}5`,
    '',
    undefined,
  ]) {
    assert.equal(parseRoundLink(url), null, String(url));
  }
  // The checks are shared, and a link is never made with a value its reader would refuse.
  assert.equal(cleanName('Ünïcode.skr'), null);
  assert.equal(cleanAddress(BY), BY);
  assert.equal(roundLink(5n, { side: 'sideways', token: '$$$', by: 'not-an-address', name: 'Not Valid!' }), `${WEB}5`);
  assert.equal(roundLink(5n, { side: 'DOWN', token: '$WIF', by: BY, name: 'Ünïcode.skr' }), `${WEB}5?side=down&t=WIF&by=${BY}`);
});

function memoryStorage() {
  const data = new Map<string, string>();
  const storage: ChallengeStorage = {
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => {
      await new Promise((r) => setTimeout(r, 1));
      data.set(key, value);
    },
    removeItem: async (key) => {
      data.delete(key);
    },
  };
  return { data, storage };
}

test('the challenge is kept on the phone for a week; a newer link replaces it, OK clears it', async () => {
  const c = challenge();
  assert.deepEqual(parseChallenge(serializeChallenge(c)), c);
  const stored = JSON.parse(serializeChallenge(c)) as Record<string, unknown>;
  for (const raw of [null, '', 'not json', 'null', '5', JSON.stringify({ ...stored, round: '-1' }), JSON.stringify({ ...stored, at: 'yesterday' })]) {
    assert.equal(parseChallenge(raw), null, String(raw));
  }
  // Stored values are checked like a link: a damaged one is dropped alone.
  const damaged = { ...stored, side: 'sideways', by: '<script>', name: 'Ox Bla', ticker: '$<b>WIF</b>' };
  assert.deepEqual(parseChallenge(JSON.stringify(damaged)), { ...c, side: null, by: null, name: null, ticker: 'bWIFb' });

  assert.equal(challengeActive(c, NOW + CHALLENGE_TTL_MS - 1), true);
  assert.equal(challengeActive(c, NOW + CHALLENGE_TTL_MS), false);
  assert.equal(challengeActive(c, NOW - CHALLENGE_TTL_MS), false, 'a time far ahead of the clock is stale too');

  const { data, storage } = memoryStorage();
  const store = createChallengeStore(storage);
  assert.equal(await store.load(NOW), null);
  await store.save(c);
  assert.equal(CHALLENGE_KEY, 'ftm.challenge.v1');
  assert.deepEqual([...data.keys()], [CHALLENGE_KEY]);
  assert.deepEqual(await store.load(NOW + 1_000), c);
  // A newer link replaces it.
  const newer = challenge({ round: 600n, side: 'down', at: NOW + 5_000 });
  await store.save(newer);
  assert.deepEqual(await store.load(NOW + 6_000), newer);
  // Writes land in call order even when fired together: OK after a save leaves nothing.
  await Promise.all([store.save(c), store.clear()]);
  assert.equal(await store.load(NOW), null);
  assert.equal(data.has(CHALLENGE_KEY), false);
  // After a week it is ignored and removed.
  await store.save(c);
  assert.equal(await store.load(NOW + CHALLENGE_TTL_MS), null);
  assert.equal(data.has(CHALLENGE_KEY), false);
  // An unreadable entry is removed too.
  data.set(CHALLENGE_KEY, '{');
  assert.equal(await store.load(NOW), null);
  assert.equal(data.has(CHALLENGE_KEY), false);
});

function account(over: Partial<RoundAccount> & { opensAt: bigint }): RoundAccount {
  const o = over.opensAt;
  return {
    id: 496n,
    tokenMint: '11111111111111111111111111111111' as RoundAccount['tokenMint'],
    pool: '11111111111111111111111111111111' as RoundAccount['pool'],
    cutoffAt: o + 60n,
    strikeStart: o + 90n,
    strikeEnd: o + 100n,
    exitStart: o + 150n,
    exitEnd: o + 160n,
    settleDeadline: o + 760n,
    minStake: SOL / 100n,
    maxStake: SOL / 10n,
    minBank: SOL / 50n,
    maxBank: SOL,
    feeWinBps: 200,
    feeRefundBps: 0,
    rawUp: 0n,
    rawDown: 0n,
    houseAmount: 0n,
    positionCount: 1,
    claimedCount: 0,
    totalPaid: 0n,
    feesSwept: false,
    status: RoundStatus.Open,
    outcome: Outcome.Pending,
    refundReason: RefundReason.None,
    strikePrice: 0n,
    exitPrice: 0n,
    strikeSamples: 0,
    exitSamples: 0,
    bump: 255,
    ...over,
  };
}

test('the card says who called what, how that round went and where to meet, never a side for the reader', () => {
  const c = challenge();
  assert.equal(challengeHeadline(c), 'oxbla.skr called UP on $TSLA · round #496');
  assert.equal(challengeHeadline(challenge({ name: null })), `${shortAddress(BY)} called UP on $TSLA · round #496`);
  assert.equal(challengeHeadline(challenge({ name: null, by: null, ticker: null, side: 'down' })), 'A FRIEND called DOWN · round #496');
  assert.equal(challengeHeadline(challenge({ side: null })), 'oxbla.skr sent you round #496 on $TSLA');

  const now = 1_000_000;
  const state = (over: Partial<RoundAccount> & { opensAt: bigint }) => challengeRoundState(account(over), now);
  // Not read yet, closed because nobody played it, or unreadable: nothing about a result.
  assert.deepEqual(challengeRoundState(null, now), { kind: 'unknown' });
  assert.equal(roundStateLine(c, { kind: 'unknown' }), null);
  const upcoming = state({ opensAt: BigInt(now + 12) });
  assert.deepEqual(upcoming, { kind: 'upcoming', secondsLeft: 12 });
  assert.equal(roundStateLine(c, upcoming), 'Round #496 opens in 0:12.');
  const open = state({ opensAt: BigInt(now - 18) });
  assert.deepEqual(open, { kind: 'open', secondsLeft: 42 });
  assert.equal(roundStateLine(c, open), 'Round #496 is open: pick your side, entry closes in 0:42.');
  const live = state({ opensAt: BigInt(now - 95), status: RoundStatus.Live, strikePrice: 100n });
  assert.deepEqual(live, { kind: 'live', secondsLeft: 65 });
  assert.equal(roundStateLine(c, live), 'Round #496 is live: result in 1:05.');
  // Entry closed before the strike is posted counts as live too; after the exit window it is settling.
  assert.equal(state({ opensAt: BigInt(now - 70) }).kind, 'live');
  assert.equal(roundStateLine(c, state({ opensAt: BigInt(now - 200), status: RoundStatus.Live })), 'Round #496 is settling: result soon.');

  const final = (outcome: Outcome, refundReason: RefundReason = RefundReason.None) =>
    state({ opensAt: BigInt(now - 400), status: RoundStatus.Final, outcome, refundReason });
  assert.equal(roundStateLine(c, final(Outcome.Up)), 'Round #496 went UP: they won.');
  assert.equal(roundStateLine(c, final(Outcome.Down)), 'Round #496 went DOWN: they lost.');
  assert.equal(roundStateLine(challenge({ side: 'down' }), final(Outcome.Down)), 'Round #496 went DOWN: they won.');
  assert.equal(roundStateLine(challenge({ side: null }), final(Outcome.Up)), 'Round #496 went UP.');
  assert.equal(roundStateLine(c, final(Outcome.Refund, RefundReason.Tie)), 'Round #496 was a tie: refund.');
  assert.equal(roundStateLine(c, final(Outcome.NotActivated)), 'Round #496 had no match: refund.');
  assert.equal(roundStateLine(c, final(Outcome.Refund, RefundReason.Unpriceable)), 'Round #496 ended in a refund.');

  // Where to meet: the inviter's own call in the round open now (never a house position), else an open invitation.
  const positions = [
    { account: { authority: BY, isHouse: true, side: Side.Down } },
    { account: { authority: addr(8), isHouse: false, side: Side.Down } },
    { account: { authority: BY, isHouse: false, side: Side.Up } },
  ];
  assert.equal(inviterPosition(positions, BY), positions[2]);
  assert.equal(inviterPosition(positions.slice(0, 2), BY), null);
  assert.equal(inviterPosition(positions, null), null);
  assert.equal(meetLine(c, 498n, Side.Up), 'oxbla.skr is in round #498 now: UP. Take the other side.');
  assert.equal(meetLine(challenge({ name: null }), 498n, Side.Down), `${shortAddress(BY)} is in round #498 now: DOWN. Take the other side.`);
  assert.equal(meetLine(c, 498n, null), 'Rounds start every minute: call round #498 whenever you are ready.');
  assert.equal(meetLine(c, null, null), 'Rounds start every minute: call the next one whenever you are ready.');
});
