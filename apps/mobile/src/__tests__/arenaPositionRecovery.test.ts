import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { test } from 'node:test';
import { getAddressDecoder, getAddressEncoder } from '@solana/kit';
import { positionAddress, roundAddress } from '@flipthememe/client';
import { recoverPosition, readPositionSnapshot } from '../chain/recoverPosition.ts';
import { showBetReceipt, withOwnPosition } from '../chain/arenaPositions.ts';
import type { SolanaRpc } from '../chain/rpc.ts';
import type { PositionView } from '../chain/fetch.ts';

const vectors = JSON.parse(readFileSync(new URL('../../../../packages/client/test/vectors.json', import.meta.url), 'utf8'));
const owner = getAddressDecoder().decode(new Uint8Array(32).fill(7));
const id = 8335n;
async function fixture() {
  const round = await roundAddress(id);
  const position = await positionAddress(round, owner);
  const roundBytes = Buffer.from(vectors.accounts.round, 'hex');
  roundBytes.writeBigUInt64LE(id, 8);
  const positionBytes = Buffer.from(vectors.accounts.position, 'hex');
  positionBytes.set(getAddressEncoder().encode(round), 8);
  positionBytes.set(getAddressEncoder().encode(owner), 40);
  positionBytes[89] = 0; // player, not the house
  const calls: unknown[] = [];
  const rpc = { getMultipleAccounts: (addresses: unknown) => {
    calls.push(addresses);
    return { send: async () => ({ value: [positionBytes, roundBytes].map(data => ({ data: [data.toString('base64'), 'base64'], lamports: 1100000n })) }) };
  } } as unknown as SolanaRpc;
  return { rpc, calls, position, round, positionBytes, roundBytes };
}

test('a confirmed call stays visible while position reads lag, including after a new entry opens', () => {
  assert.equal(showBetReceipt('confirmed', id, false), true);
  assert.equal(showBetReceipt('confirmed', id, true), false);
  assert.equal(showBetReceipt('failed', id, false), true);
  assert.equal(showBetReceipt('idle', null, false), false);
});

test('an open book cannot hide my already-read position or duplicate a fresh arena row', () => {
  const own = { address: 'mine' } as PositionView;
  const rival = { address: 'rival' } as PositionView;
  assert.deepEqual(withOwnPosition([rival], own), [rival, own]);
  const fresh = [rival, own];
  assert.equal(withOwnPosition(fresh, own), fresh);
  assert.deepEqual(withOwnPosition([], null), []);
});

test('recover a sent call by its two PDA accounts without a program-wide positions scan', async () => {
  const f = await fixture();
  const recovered = await recoverPosition(f.rpc, owner, id);
  assert.deepEqual(f.calls, [[f.position, f.round]]);
  assert.equal(recovered?.position.account.authority, owner);
  assert.equal(recovered?.round.id, id);
  assert.equal(recovered?.position.lamports, 1100000n);
});

test('recovery refuses a different player, a different round, and a house position', async () => {
  for (const change of [(f: Awaited<ReturnType<typeof fixture>>) => { f.positionBytes[40] ^= 1; }, (f: Awaited<ReturnType<typeof fixture>>) => { f.roundBytes.writeBigUInt64LE(id + 1n, 8); }, (f: Awaited<ReturnType<typeof fixture>>) => { f.positionBytes[89] = 1; }]) {
    const f = await fixture();
    change(f);
    await assert.rejects(recoverPosition(f.rpc, owner, id), /different player or round/);
  }
});

test('a missing position and a transport failure never fabricate a saved stake', async () => {
  const rpc = { getMultipleAccounts: () => ({ send: async () => ({ value: [null, null] }) }) } as unknown as SolanaRpc;
  assert.equal(await recoverPosition(rpc, owner, id), null);
  const offline = { getMultipleAccounts: () => ({ send: async () => { throw new Error('offline'); } }) } as unknown as SolanaRpc;
  await assert.rejects(recoverPosition(offline, owner, id), /offline/);
});

test('program scan failure still recovers a sent stake directly and preserves earlier verified positions', async () => {
  const f = await fixture();
  Object.assign(f.rpc, { getProgramAccounts: () => ({ send: async () => { throw new Error('program scan rate limited'); } }) });
  const previous = { address: 'earlier' } as PositionView;
  const snapshot = await readPositionSnapshot(f.rpc, owner, id, [previous], true);
  assert.equal(snapshot.positions.length, 2);
  assert.equal(snapshot.positions[0], previous);
  assert.equal(snapshot.positions[1].address, f.position);
  assert.equal(snapshot.scanSucceeded, false);
  assert.match(String(snapshot.error), /rate limited/);
});

test('an empty lagging program scan cannot erase the directly recovered current stake', async () => {
  const f = await fixture();
  Object.assign(f.rpc, { getProgramAccounts: () => ({ send: async () => [] }) });
  const snapshot = await readPositionSnapshot(f.rpc, owner, id, [], true);
  assert.equal(snapshot.positions.length, 1);
  assert.equal(snapshot.positions[0].address, f.position);
  assert.equal(snapshot.error, null);
});
