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
} from '@flipthememe/client';
import { address, generateKeyPairSigner, type Address, type KeyPairSigner } from '@solana/kit';
import { CLOSE_AFTER_SECS, CLOSE_BATCH, CLOSE_MARGIN_SECS, PositionCloser, effectiveCloseAfter } from '../src/closer.ts';
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
async function finalRound(chain: FakeChain, id: bigint, age: bigint, positions: { owner: Address; claimed: boolean; isHouse?: boolean }[]): Promise<void> {
  const opensAt = NOW - age - 160n; // exit_end = opens_at + 160
  chain.rounds.set(id, makeRound(id, opensAt, POOL, MINT, { status: RoundStatus.Final, outcome: Outcome.Up, positionCount: positions.length }));
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
