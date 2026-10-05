// The getProgramAccounts filters depend on byte offsets in the program's accounts; check them
// against the serialized accounts in the client's Rust-generated vectors.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { OFFSETS, decodePosition, decodeRound } from '@flipthememe/client';
import { POSITION_ACCOUNT_SIZE, ROUND_ACCOUNT_SIZE, ROUND_FEES_SWEPT_OFFSET, ROUND_ID_OFFSET } from '../src/chain.ts';

const vectors = JSON.parse(readFileSync(new URL('../../../packages/client/test/vectors.json', import.meta.url), 'utf8')) as {
  accounts: { round: string; position: string };
};
const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex'));

test('Round: size, id and fees_swept offsets', () => {
  const data = bytes(vectors.accounts.round);
  assert.equal(data.length, ROUND_ACCOUNT_SIZE);
  const round = decodeRound(data);
  assert.equal(new DataView(data.buffer).getBigUint64(ROUND_ID_OFFSET, true), round.id);
  const flipped = data.slice();
  flipped[ROUND_FEES_SWEPT_OFFSET] = round.feesSwept ? 0 : 1;
  assert.equal(decodeRound(flipped).feesSwept, !round.feesSwept);
});

test('Position: size and round offset', () => {
  const data = bytes(vectors.accounts.position);
  assert.equal(data.length, POSITION_ACCOUNT_SIZE);
  const position = decodePosition(data);
  const flipped = data.slice();
  flipped[OFFSETS.positionRound] = (flipped[OFFSETS.positionRound] ?? 0) ^ 0xff;
  assert.notEqual(decodePosition(flipped).round, position.round);
});
