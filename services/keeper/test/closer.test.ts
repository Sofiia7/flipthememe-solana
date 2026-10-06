// Closing paid positions (audit A09): which positions the keeper picks, how it batches them, and
// how one failing position is isolated. Fake devnet; the fake never applies a transaction.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  Outcome,
  POSITION_CLOSE_DELAY_SECS,
  RoundStatus,
  Side,
  configAddress,
  positionAddress,
  roundAddress,
  vaultAddress,
  type PositionAccount,
  type RoundAccount,
} from '@flipthememe/client';
import { address, generateKeyPairSigner, type Address, type KeyPairSigner } from '@solana/kit';
import {
  CLOSE_AFTER_SECS,
  CLOSE_BATCH,
  CLOSE_MARGIN_SECS,
  CLOSE_REJECT_MS,
  CLOSE_SCAN_MS,
  MAX_ROUND_CHECKS,
  MAX_ROUND_REJECTS,
  PositionCloser,
  ROUND_CLOSE_BATCH,
  effectiveCloseAfter,
} from '../src/closer.ts';
import type { LogFields } from '../src/log.ts';
import { FAKE_ACCOUNT_LAMPORTS, FakeChain, makeRound } from './fake-chain.ts';

const POOL = address('11111111111111111111111111111112');
const MINT = address('11111111111111111111111111111113');
/** Chain time of the scan in these tests. */
const NOW = 1_800_000_000n;
const HOUR = 3_600n;

type Setup = { chain: FakeChain; keeper: KeyPairSigner; logs: LogFields[]; closer: (closeAfterSecs?: bigint) => PositionCloser };

async function setup(): Promise<Setup> {
  const keeper = await generateKeyPairSigner();
  const chain = new FakeChain(keeper.address);
  const logs: LogFields[] = [];
  const closer = (closeAfterSecs?: bigint) => new PositionCloser({ rpc: chain.rpc(), signer: keeper, logger: (f) => logs.push(f), startMs: 0, closeAfterSecs });
  return { chain, keeper, logs, closer };
}

/** A Final round whose exit window ended `age` seconds before NOW, with these positions. */
async function finalRound(
  chain: FakeChain,
  id: bigint,
  age: bigint,
  positions: { owner: Address; claimed: boolean; isHouse?: boolean }[],
  over: Partial<RoundAccount> = {},
): Promise<void> {
  const opensAt = NOW - age - 160n; // exit_end = opens_at + 160
  chain.rounds.set(id, makeRound(id, opensAt, POOL, MINT, { status: RoundStatus.Final, outcome: Outcome.Up, positionCount: positions.length, ...over }));
  const round = await roundAddress(id);
  const list: PositionAccount[] = positions.map((p) => ({
    round,
    authority: p.owner,
    side: Side.Up,
    stake: 10_000_000n,
    face: new Uint8Array(8),
    isHouse: p.isHouse ?? false,
    claimed: p.claimed,
    payout: 0n,
    bump: 250,
  }));
  chain.positions.set(id, list);
}

const owners = async (n: number): Promise<Address[]> => Promise.all(Array.from({ length: n }, async () => (await generateKeyPairSigner()).address));

describe('PositionCloser', () => {
  test('the keeper waits a day after exit_end (phones keep history while positions exist), never less than the program hour', () => {
    assert.equal(CLOSE_AFTER_SECS, 86_400n);
    assert.equal(POSITION_CLOSE_DELAY_SECS, HOUR);
    assert.equal(effectiveCloseAfter(60n), HOUR);
    assert.equal(effectiveCloseAfter(0n), HOUR);
    assert.equal(effectiveCloseAfter(2n * 86_400n), 2n * 86_400n);
  });

  test('queues claimed positions of final rounds a day past exit_end, oldest round first', async () => {
    const { chain, keeper, logs, closer } = await setup();
    const [a, b, c, d] = await owners(4);
    if (!a || !b || !c || !d) throw new Error('owners');
    await finalRound(chain, 3n, 2n * 86_400n, [{ owner: a, claimed: true }, { owner: b, claimed: true }, { owner: c, claimed: false }]);
    await finalRound(chain, 2n, 25n * HOUR, [{ owner: keeper.address, claimed: true, isHouse: true }]);
    // Past the program's hour but not the keeper's day: it waits.
    await finalRound(chain, 4n, 2n * HOUR, [{ owner: d, claimed: true }]);
    const pc = closer();
    await pc.scan(0, NOW);
    assert.deepEqual(
      pc.queue.map((q) => [q.roundId, q.owner, q.isHouse]),
      [
        [2n, keeper.address, true],
        [3n, a, false],
        [3n, b, false],
      ],
    );
    assert.equal(pc.queue[1]?.position, await positionAddress(await roundAddress(3n), a));
    assert.deepEqual(logs.at(-1), { event: 'positions_scan', claimed: 4, closable: 3, lamports: 3n * FAKE_ACCOUNT_LAMPORTS, waiting: 1, skipped: 0 });
  });

  test('CLOSE_AFTER_SECS can be shortened for a demo, down to the program hour plus the clock margin', async () => {
    const { chain, closer } = await setup();
    const [a] = await owners(1);
    if (!a) throw new Error('owners');
    await finalRound(chain, 1n, HOUR + CLOSE_MARGIN_SECS - 1n, [{ owner: a, claimed: true }]);
    const demo = closer(60n);
    assert.equal(demo.closeAfterSecs, HOUR);
    await demo.scan(0, NOW);
    assert.equal(demo.queue.length, 0);
    await demo.scan(0, NOW + 1n);
    assert.equal(demo.queue.length, 1);
  });

  test(`closes ${CLOSE_BATCH} positions per transaction, rent into each owner's vault, and logs counts and lamports`, async () => {
    const { chain, logs, closer } = await setup();
    const many = await owners(10);
    await finalRound(chain, 5n, 30n * HOUR, many.slice(0, 6).map((owner) => ({ owner, claimed: true })));
    await finalRound(chain, 6n, 30n * HOUR, many.slice(6).map((owner) => ({ owner, claimed: true })));
    const pc = closer();
    await pc.scan(0, NOW);
    await pc.closeNext(0);
    await pc.closeNext(0);
    assert.deepEqual(chain.sent.map((tx) => tx.length), [8, 2]);
    assert.ok(chain.sent.flat().every((ix) => ix.name === 'closePosition'));
    const round5 = await roundAddress(5n);
    const [first] = chain.sent[0] ?? [];
    // config, round, position, the owner's vault: the rent goes back into the game balance.
    assert.deepEqual(first?.accounts, [await configAddress(), round5, await positionAddress(round5, many[0] as Address), await vaultAddress(many[0] as Address)]);
    const closed = logs.filter((l) => l.event === 'positions_closed');
    assert.deepEqual(
      closed.map((l) => [l.positions, l.lamports, l.house, l.rounds, l.queued]),
      [
        [8, 8n * FAKE_ACCOUNT_LAMPORTS, 0, [5n, 6n], 2],
        [2, 2n * FAKE_ACCOUNT_LAMPORTS, 0, [6n], 0],
      ],
    );
    assert.deepEqual([pc.closed, pc.closedLamports, pc.hasWork()], [10, 10n * FAKE_ACCOUNT_LAMPORTS, false]);
  });

  test(`the worst case still fits: ${CLOSE_BATCH} closes of ${CLOSE_BATCH} different rounds and owners in one transaction`, async () => {
    const { chain, logs, closer } = await setup();
    const owners8 = await owners(CLOSE_BATCH);
    for (const [k, owner] of owners8.entries()) await finalRound(chain, 20n + BigInt(k), 30n * HOUR, [{ owner, claimed: true }]);
    const pc = closer();
    await pc.scan(0, NOW);
    await pc.closeNext(0);
    assert.deepEqual(chain.sent.map((tx) => tx.length), [CLOSE_BATCH]);
    assert.equal(logs.some((l) => l.event === 'close_batch_shrunk'), false);
  });

  test('a failing batch is retried one position at a time, and the one that fails is set aside', async () => {
    const { chain, logs, closer } = await setup();
    const [a, b, c] = await owners(3);
    if (!a || !b || !c) throw new Error('owners');
    await finalRound(chain, 7n, 30n * HOUR, [a, b, c].map((owner) => ({ owner, claimed: true })));
    // The program keeps refusing b's position (whatever the reason): it must not block a and c.
    const stuck = await positionAddress(await roundAddress(7n), b);
    chain.failWhen = (ixs) =>
      ixs.some((ix) => ix.accounts.includes(stuck))
        ? Object.assign(new Error('Transaction simulation failed'), { context: { logs: ['Program log: AnchorError occurred. Error Code: NotDue. Error Number: 6009.'] } })
        : null;
    const pc = closer();
    await pc.scan(0, NOW);
    await assert.rejects(pc.closeNext(0));
    assert.deepEqual(logs.at(-1), { event: 'positions_close_failed', positions: 3, error: 'NotDue', retry: 'one by one' });
    await pc.closeNext(0);
    await assert.rejects(pc.closeNext(0));
    assert.deepEqual(logs.at(-1), { event: 'positions_close_failed', positions: 1, error: 'NotDue', retry: 'after the next scan' });
    await pc.closeNext(0);
    assert.deepEqual(chain.sent.map((tx) => tx.map((ix) => ix.accounts[3])), [[await vaultAddress(a)], [await vaultAddress(c)]]);
    // On chain only b is left; the next scan leaves it out for an hour.
    chain.positions.set(7n, (chain.positions.get(7n) ?? []).filter((p) => p.authority === b));
    await pc.scan(0, NOW);
    assert.deepEqual([pc.queue.length, logs.at(-1)?.claimed, logs.at(-1)?.skipped], [0, 1, 1]);
  });
});

// Audit L2: the Round account of a played round (about 0.0025 SOL of rent the keeper paid at
// create_round) is returned once its last position is closed. The upgraded program decrements
// round.position_count in close_position and lets close_empty_round close a swept Final round whose
// count is 0; the fake chain has no program, so `applyUpgradedCloses` applies that to its state.
describe('PositionCloser: returns the round rent after the last position', () => {
  const programError = (name: string) =>
    Object.assign(new Error('Transaction simulation failed'), { context: { logs: [`Program log: AnchorError occurred. Error Code: ${name}. Error Number: 6000.`] } });

  /** close_position takes the position away and decrements both counters; close_empty_round removes the round. */
  const upgradedProgram = (chain: FakeChain): void => chain.applyUpgradedCloses();

  /** A round that is claimed and swept, with `n` claimed positions. */
  const swept = (n: number): Partial<RoundAccount> => ({ feesSwept: true, claimedCount: n, rawUp: 10_000_000n, rawDown: 10_000_000n });
  const names = (chain: FakeChain): string[][] => chain.sent.map((tx) => tx.map((ix) => ix.name));
  const checks = (logs: LogFields[]): LogFields[] => logs.filter((l) => l.event === 'rounds_checked');

  test('the last position of a swept round is closed: the round follows in a transaction of its own, its rent to the admin', async () => {
    const { chain, keeper, logs, closer } = await setup();
    upgradedProgram(chain);
    const [a] = await owners(1);
    if (!a) throw new Error('owners');
    await finalRound(chain, 5n, 30n * HOUR, [{ owner: a, claimed: true }], swept(1));
    const pc = closer();
    await pc.scan(0, NOW);
    await pc.closeNext(0);
    assert.deepEqual(names(chain), [['closePosition']]);
    // Read fresh after the batch: no positions left and the bank is swept, so the round is queued.
    assert.deepEqual(checks(logs), [{ event: 'rounds_checked', checked: 1, closable: 1, lamports: FAKE_ACCOUNT_LAMPORTS, notEmpty: 0, unswept: 0 }]);
    assert.equal(pc.hasWork(), true);
    await pc.closeNext(0);
    assert.deepEqual(names(chain), [['closePosition'], ['closeEmptyRound']]);
    // config (read-only), the round, and the admin that gets the rent back.
    assert.deepEqual(chain.sent[1]?.[0]?.accounts, [await configAddress(), await roundAddress(5n), keeper.address]);
    const closed = logs.filter((l) => l.event === 'round_closed');
    assert.equal(closed.length, 1);
    assert.deepEqual([closed[0]?.round, closed[0]?.lamports, typeof closed[0]?.sig], [5n, FAKE_ACCOUNT_LAMPORTS, 'string']);
    assert.deepEqual([pc.closedRounds, pc.closedRoundLamports, pc.hasWork()], [1, FAKE_ACCOUNT_LAMPORTS, false]);
    // Nothing is left to do: the next scan and the next close send nothing.
    await pc.scan(CLOSE_SCAN_MS, NOW);
    await pc.closeNext(CLOSE_SCAN_MS);
    assert.equal(chain.sent.length, 2);
  });

  test('the rent goes to the admin the scheduler hands over (config.admin), by default the keeper', async () => {
    const { chain, keeper, closer } = await setup();
    upgradedProgram(chain);
    const [a, admin] = await owners(2);
    if (!a || !admin) throw new Error('owners');
    await finalRound(chain, 5n, 30n * HOUR, [{ owner: a, claimed: true }], swept(1));
    const pc = closer();
    assert.equal(pc.admin, keeper.address);
    pc.admin = admin;
    await pc.scan(0, NOW);
    await pc.closeNext(0);
    await pc.closeNext(0);
    assert.equal(chain.sent[1]?.[0]?.accounts[2], admin);
  });

  test('a round that still has positions is left alone and picked up when the last one is closed', async () => {
    const { chain, logs, closer } = await setup();
    upgradedProgram(chain);
    const [a, b] = await owners(2);
    if (!a || !b) throw new Error('owners');
    // a's position can be closed, b has not claimed yet.
    await finalRound(chain, 5n, 30n * HOUR, [{ owner: a, claimed: true }, { owner: b, claimed: false }], { claimedCount: 1, rawUp: 10_000_000n, rawDown: 10_000_000n });
    const pc = closer();
    await pc.scan(0, NOW);
    await pc.closeNext(0);
    assert.deepEqual(checks(logs), [{ event: 'rounds_checked', checked: 1, closable: 0, lamports: 0n, notEmpty: 1, unswept: 0 }]);
    assert.deepEqual([pc.hasWork(), pc.status().roundsPending], [false, 0]);
    await pc.closeNext(0);
    assert.deepEqual(names(chain), [['closePosition']]);
    // b claims, the round is swept and the next scan queues b's position; closing it queues the round.
    const round = chain.rounds.get(5n);
    if (!round) throw new Error('round');
    chain.rounds.set(5n, { ...round, claimedCount: 1, feesSwept: true });
    chain.positions.set(5n, (chain.positions.get(5n) ?? []).map((p) => ({ ...p, claimed: true })));
    await pc.scan(CLOSE_SCAN_MS, NOW);
    await pc.closeNext(CLOSE_SCAN_MS);
    await pc.closeNext(CLOSE_SCAN_MS);
    assert.deepEqual(names(chain), [['closePosition'], ['closePosition'], ['closeEmptyRound']]);
  });

  test('a round whose bank is not swept yet is left alone and looked at again on the next scans', async () => {
    const { chain, logs, closer } = await setup();
    upgradedProgram(chain);
    const [a] = await owners(1);
    if (!a) throw new Error('owners');
    await finalRound(chain, 5n, 30n * HOUR, [{ owner: a, claimed: true }], { ...swept(1), feesSwept: false });
    const pc = closer();
    await pc.scan(0, NOW);
    await pc.closeNext(0);
    assert.deepEqual(checks(logs).at(-1), { event: 'rounds_checked', checked: 1, closable: 0, lamports: 0n, notEmpty: 0, unswept: 1 });
    assert.deepEqual([pc.hasWork(), pc.status().roundsPending], [false, 1]);
    await pc.scan(CLOSE_SCAN_MS, NOW);
    assert.deepEqual([pc.hasWork(), chain.sent.length], [false, 1]);
    // The sweep lands: the next scan queues the round.
    const round = chain.rounds.get(5n);
    if (!round) throw new Error('round');
    chain.rounds.set(5n, { ...round, feesSwept: true });
    await pc.scan(2 * CLOSE_SCAN_MS, NOW);
    assert.equal(pc.hasWork(), true);
    await pc.closeNext(2 * CLOSE_SCAN_MS);
    assert.deepEqual(names(chain), [['closePosition'], ['closeEmptyRound']]);
  });

  test(`a round that stays unswept is dropped after ${MAX_ROUND_CHECKS} looks, not read for ever`, async () => {
    const { chain, closer } = await setup();
    upgradedProgram(chain);
    const [a] = await owners(1);
    if (!a) throw new Error('owners');
    await finalRound(chain, 5n, 30n * HOUR, [{ owner: a, claimed: true }], { ...swept(1), feesSwept: false });
    const pc = closer();
    await pc.scan(0, NOW);
    await pc.closeNext(0); // look 1, right after the batch
    for (let k = 1; k < MAX_ROUND_CHECKS; k++) {
      assert.equal(pc.status().roundsPending, 1, `still watched at look ${k}`);
      await pc.scan(k * CLOSE_SCAN_MS, NOW);
    }
    assert.equal(pc.status().roundsPending, 0);
    const reads = chain.reads;
    await pc.scan(MAX_ROUND_CHECKS * CLOSE_SCAN_MS, NOW);
    assert.deepEqual([chain.reads, chain.sent.length], [reads, 1]);
  });

  test('a round with no bank at all needs no sweep before it is closed', async () => {
    const { chain, closer } = await setup();
    upgradedProgram(chain);
    const [a] = await owners(1);
    if (!a) throw new Error('owners');
    await finalRound(chain, 5n, 30n * HOUR, [{ owner: a, claimed: true }], { claimedCount: 1, feesSwept: false, rawUp: 0n, rawDown: 0n });
    const pc = closer();
    await pc.scan(0, NOW);
    await pc.closeNext(0);
    await pc.closeNext(0);
    assert.deepEqual(names(chain), [['closePosition'], ['closeEmptyRound']]);
  });

  test('a rejected round close is left alone for an hour, then tried once more', async () => {
    const { chain, logs, closer } = await setup();
    upgradedProgram(chain);
    const [a] = await owners(1);
    if (!a) throw new Error('owners');
    await finalRound(chain, 5n, 30n * HOUR, [{ owner: a, claimed: true }], swept(1));
    let attempts = 0;
    chain.failWhen = (ixs) => (ixs.some((ix) => ix.name === 'closeEmptyRound') ? (attempts++, programError('NotClosable')) : null);
    const pc = closer();
    await pc.scan(0, NOW);
    await pc.closeNext(0);
    await assert.rejects(pc.closeNext(0));
    assert.deepEqual(logs.at(-1), { event: 'round_close_failed', round: 5n, error: 'NotClosable', retry: 'after the cooldown' });
    assert.deepEqual([attempts, pc.hasWork(), pc.closedRounds], [1, false, 0]);
    // Scans inside the hour do not queue it again, however often they run.
    await pc.scan(CLOSE_SCAN_MS, NOW);
    await pc.scan(CLOSE_REJECT_MS - 1, NOW);
    assert.deepEqual([attempts, pc.hasWork()], [1, false]);
    // After the hour one more try; this time the chain accepts it.
    chain.failWhen = null;
    await pc.scan(CLOSE_REJECT_MS, NOW);
    assert.equal(pc.hasWork(), true);
    await pc.closeNext(CLOSE_REJECT_MS);
    assert.deepEqual([names(chain), pc.closedRounds, pc.status().roundsPending], [[['closePosition'], ['closeEmptyRound']], 1, 0]);
  });

  test(`a round the program keeps refusing is given up after ${MAX_ROUND_REJECTS} tries`, async () => {
    const { chain, logs, closer } = await setup();
    upgradedProgram(chain);
    const [a] = await owners(1);
    if (!a) throw new Error('owners');
    await finalRound(chain, 5n, 30n * HOUR, [{ owner: a, claimed: true }], swept(1));
    let attempts = 0;
    chain.failWhen = (ixs) => (ixs.some((ix) => ix.name === 'closeEmptyRound') ? (attempts++, programError('NotClosable')) : null);
    const pc = closer();
    await pc.scan(0, NOW);
    await pc.closeNext(0);
    for (let k = 0; k < MAX_ROUND_REJECTS; k++) {
      const at = k * CLOSE_REJECT_MS;
      if (k > 0) await pc.scan(at, NOW);
      await assert.rejects(pc.closeNext(at));
    }
    assert.equal(attempts, MAX_ROUND_REJECTS);
    assert.deepEqual(logs.at(-1), { event: 'round_close_failed', round: 5n, error: 'NotClosable', retry: 'not again' });
    await pc.scan(MAX_ROUND_REJECTS * CLOSE_REJECT_MS, NOW);
    assert.deepEqual([attempts, pc.hasWork(), pc.status().roundsPending], [MAX_ROUND_REJECTS, false, 0]);
  });

  test('two rounds that end in the same batch are closed in one transaction, oldest first', async () => {
    const { chain, logs, closer } = await setup();
    upgradedProgram(chain);
    const [a, b] = await owners(2);
    if (!a || !b) throw new Error('owners');
    await finalRound(chain, 6n, 30n * HOUR, [{ owner: b, claimed: true }], swept(1));
    await finalRound(chain, 5n, 30n * HOUR, [{ owner: a, claimed: true }], swept(1));
    const pc = closer();
    await pc.scan(0, NOW);
    await pc.closeNext(0);
    assert.deepEqual(checks(logs), [{ event: 'rounds_checked', checked: 2, closable: 2, lamports: 2n * FAKE_ACCOUNT_LAMPORTS, notEmpty: 0, unswept: 0 }]);
    await pc.closeNext(0);
    assert.deepEqual(names(chain), [['closePosition', 'closePosition'], ['closeEmptyRound', 'closeEmptyRound']]);
    assert.deepEqual(chain.sent[1]?.map((ix) => ix.accounts[1]), [await roundAddress(5n), await roundAddress(6n)]);
    assert.deepEqual(logs.filter((l) => l.event === 'round_closed').map((l) => [l.round, l.lamports]), [[5n, FAKE_ACCOUNT_LAMPORTS], [6n, FAKE_ACCOUNT_LAMPORTS]]);
    assert.deepEqual([pc.closedRounds, pc.closedRoundLamports], [2, 2n * FAKE_ACCOUNT_LAMPORTS]);
  });

  test('a round with more positions than one batch is read only after its last batch', async () => {
    const { chain, logs, closer } = await setup();
    upgradedProgram(chain);
    const many = await owners(CLOSE_BATCH + 2);
    await finalRound(chain, 5n, 30n * HOUR, many.map((owner) => ({ owner, claimed: true })), swept(many.length));
    const pc = closer();
    await pc.scan(0, NOW);
    const reads = chain.reads;
    await pc.closeNext(0);
    assert.deepEqual([chain.reads, checks(logs).length], [reads, 0]);
    await pc.closeNext(0);
    assert.equal(checks(logs).length, 1);
    await pc.closeNext(0);
    assert.deepEqual(chain.sent.map((tx) => tx.length), [CLOSE_BATCH, 2, 1]);
    assert.equal(chain.sent[2]?.[0]?.name, 'closeEmptyRound');
  });

  test(`${ROUND_CLOSE_BATCH} round closes fit one transaction, more go in the next; a scan finds rounds whose last position vanished`, async () => {
    const { chain, logs, closer } = await setup();
    const count = ROUND_CLOSE_BATCH + 2;
    const ids = Array.from({ length: count }, (_, k) => 20n + BigInt(k));
    for (const id of ids) await finalRound(chain, id, 30n * HOUR, [{ owner: (await owners(1))[0] as Address, claimed: true }], swept(1));
    const pc = closer();
    await pc.scan(0, NOW);
    assert.equal(pc.queue.length, count);
    // Every position is closed by someone else before the next scan (or the keeper's confirmation was lost).
    for (const id of ids) {
      const round = chain.rounds.get(id);
      if (!round) throw new Error('round');
      chain.rounds.set(id, { ...round, positionCount: 0, claimedCount: 0 });
      chain.positions.set(id, []);
    }
    upgradedProgram(chain);
    await pc.scan(CLOSE_SCAN_MS, NOW);
    assert.deepEqual([pc.queue.length, pc.status().roundsQueued], [0, count]);
    await pc.closeNext(CLOSE_SCAN_MS);
    await pc.closeNext(CLOSE_SCAN_MS);
    assert.deepEqual(chain.sent.map((tx) => tx.length), [ROUND_CLOSE_BATCH, 2]);
    assert.ok(chain.sent.flat().every((ix) => ix.name === 'closeEmptyRound'));
    assert.equal(logs.some((l) => l.event === 'close_batch_shrunk' || l.event === 'round_close_batch_shrunk'), false);
    assert.deepEqual([pc.closedRounds, pc.hasWork()], [count, false]);
  });

  test('a round whose positions the old program closed keeps its count: it is read once and then forgotten', async () => {
    const { chain, logs, closer } = await setup();
    const [a, b] = await owners(2);
    if (!a || !b) throw new Error('owners');
    await finalRound(chain, 5n, 30n * HOUR, [{ owner: a, claimed: true }, { owner: b, claimed: true }], swept(2));
    const pc = closer();
    await pc.scan(0, NOW);
    // The old program closed both positions without touching round.position_count.
    chain.positions.set(5n, []);
    await pc.scan(CLOSE_SCAN_MS, NOW);
    assert.deepEqual(checks(logs), [{ event: 'rounds_checked', checked: 1, closable: 0, lamports: 0n, notEmpty: 1, unswept: 0 }]);
    const reads = chain.reads;
    await pc.scan(2 * CLOSE_SCAN_MS, NOW);
    await pc.scan(3 * CLOSE_SCAN_MS, NOW);
    assert.deepEqual([chain.reads, chain.sent.length, pc.hasWork(), pc.status().roundsPending], [reads, 0, false, 0]);
  });

  test('an RPC error while reading the rounds does not fail the batch: it is logged and the next scan tries again', async () => {
    const { chain, logs, closer } = await setup();
    upgradedProgram(chain);
    const [a] = await owners(1);
    if (!a) throw new Error('owners');
    await finalRound(chain, 5n, 30n * HOUR, [{ owner: a, claimed: true }], swept(1));
    const pc = closer();
    await pc.scan(0, NOW);
    chain.readError = new Error('socket hang up');
    await pc.closeNext(0);
    assert.deepEqual(logs.find((l) => l.event === 'round_check_failed'), { event: 'round_check_failed', rounds: 1, error: 'socket hang up' });
    assert.deepEqual([pc.closed, pc.hasWork(), pc.status().roundsPending, names(chain)], [1, false, 1, [['closePosition']]]);
    chain.readError = null;
    await pc.scan(CLOSE_SCAN_MS, NOW);
    await pc.closeNext(CLOSE_SCAN_MS);
    assert.deepEqual(names(chain), [['closePosition'], ['closeEmptyRound']]);
  });

  test('HTTP 429 while reading the rounds is passed on so the scheduler backs off, and the round is kept for the next scan', async () => {
    const { chain, closer } = await setup();
    upgradedProgram(chain);
    const [a] = await owners(1);
    if (!a) throw new Error('owners');
    await finalRound(chain, 5n, 30n * HOUR, [{ owner: a, claimed: true }], swept(1));
    const pc = closer();
    await pc.scan(0, NOW);
    chain.readError = Object.assign(new Error('HTTP error (429): Too Many Requests'), { context: { statusCode: 429 } });
    await assert.rejects(pc.closeNext(0));
    assert.deepEqual([pc.closed, pc.status().roundsPending], [1, 1]);
    chain.readError = null;
    await pc.scan(CLOSE_SCAN_MS, NOW);
    await pc.closeNext(CLOSE_SCAN_MS);
    assert.deepEqual(names(chain), [['closePosition'], ['closeEmptyRound']]);
  });

  test('a failing round batch is retried one round per transaction, and the one the program refuses is set aside', async () => {
    const { chain, logs, closer } = await setup();
    upgradedProgram(chain);
    const [a, b, c] = await owners(3);
    if (!a || !b || !c) throw new Error('owners');
    await finalRound(chain, 5n, 30n * HOUR, [{ owner: a, claimed: true }], swept(1));
    await finalRound(chain, 6n, 30n * HOUR, [{ owner: b, claimed: true }], swept(1));
    await finalRound(chain, 7n, 30n * HOUR, [{ owner: c, claimed: true }], swept(1));
    const stuck = await roundAddress(6n);
    chain.failWhen = (ixs) => (ixs.some((ix) => ix.name === 'closeEmptyRound' && ix.accounts.includes(stuck)) ? programError('NotClosable') : null);
    const pc = closer();
    await pc.scan(0, NOW);
    await pc.closeNext(0);
    await assert.rejects(pc.closeNext(0));
    assert.deepEqual(
      logs.filter((l) => l.event === 'round_close_failed').map((l) => [l.round, l.error, l.retry]),
      [[5n, 'NotClosable', 'one by one'], [6n, 'NotClosable', 'one by one'], [7n, 'NotClosable', 'one by one']],
    );
    await pc.closeNext(0);
    await assert.rejects(pc.closeNext(0));
    await pc.closeNext(0);
    assert.deepEqual(names(chain), [['closePosition', 'closePosition', 'closePosition'], ['closeEmptyRound'], ['closeEmptyRound']]);
    assert.deepEqual(chain.sent.slice(1).map((tx) => tx[0]?.accounts[1]), [await roundAddress(5n), await roundAddress(7n)]);
    assert.deepEqual(logs.filter((l) => l.event === 'round_close_failed').at(-1), { event: 'round_close_failed', round: 6n, error: 'NotClosable', retry: 'after the cooldown' });
    assert.deepEqual([pc.closedRounds, pc.hasWork(), pc.status().roundsPending], [2, false, 1]);
  });

  test('the status keeps its old fields in place and only adds the round counters', async () => {
    const { chain, closer } = await setup();
    upgradedProgram(chain);
    const [a] = await owners(1);
    if (!a) throw new Error('owners');
    await finalRound(chain, 5n, 30n * HOUR, [{ owner: a, claimed: true }], swept(1));
    const pc = closer();
    assert.deepEqual(Object.keys(pc.status()), [
      'closeAfterSecs',
      'queued',
      'queuedLamports',
      'closed',
      'closedLamports',
      'nextScanAt',
      'closedRounds',
      'closedRoundLamports',
      'roundsQueued',
      'roundsPending',
    ]);
    await pc.scan(0, NOW);
    await pc.closeNext(0);
    assert.deepEqual([pc.status().roundsQueued, pc.status().roundsPending], [1, 1]);
    await pc.closeNext(0);
    const status = pc.status();
    assert.deepEqual([status.closed, status.closedRounds, status.closedRoundLamports, status.roundsQueued, status.roundsPending], [1, 1, FAKE_ACCOUNT_LAMPORTS, 0, 0]);
  });
});
