// The getProgramAccounts filters depend on byte offsets in the program's accounts; check them
// against the serialized accounts in the client's Rust-generated vectors.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { OFFSETS, decodePosition, decodeRound } from '@flipthememe/client';
import {
  HOUSE_LIMITS_ACCOUNT_SIZE,
  ORACLE_ACCOUNT_SIZE,
  POSITION_ACCOUNT_SIZE,
  ROUND_ACCOUNT_SIZE,
  ROUND_FEES_SWEPT_OFFSET,
  ROUND_ID_OFFSET,
  VAULT_ACCOUNT_SIZE,
} from '../src/chain.ts';

const vectors = JSON.parse(readFileSync(new URL('../../../packages/client/test/vectors.json', import.meta.url), 'utf8')) as {
  accounts: { round: string; position: string; vault: string; houseLimits: string; oracle: string };
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

test('Position: size, round and claimed offsets', () => {
  const data = bytes(vectors.accounts.position);
  assert.equal(data.length, POSITION_ACCOUNT_SIZE);
  const position = decodePosition(data);
  const flipped = data.slice();
  flipped[OFFSETS.positionRound] = (flipped[OFFSETS.positionRound] ?? 0) ^ 0xff;
  assert.notEqual(decodePosition(flipped).round, position.round);
  // The closer finds claimed positions with a memcmp of [1] at this offset.
  assert.equal(data[OFFSETS.positionClaimed], position.claimed ? 1 : 0);
  const unclaimed = data.slice();
  unclaimed[OFFSETS.positionClaimed] = position.claimed ? 0 : 1;
  assert.equal(decodePosition(unclaimed).claimed, !position.claimed);
  // The census and the house wallet limit read is_house: the byte right before `claimed` (89).
  assert.equal(OFFSETS.positionIsHouse, 89);
  assert.equal(OFFSETS.positionIsHouse + 1, OFFSETS.positionClaimed);
  assert.equal(data[OFFSETS.positionIsHouse], position.isHouse ? 1 : 0);
  const otherSide = data.slice();
  otherSide[OFFSETS.positionIsHouse] = position.isHouse ? 0 : 1;
  assert.equal(decodePosition(otherSide).isHouse, !position.isHouse);
  assert.equal(decodePosition(otherSide).claimed, position.claimed);
});

test('Vault, HouseLimits and OracleConfig sizes', () => {
  assert.equal(bytes(vectors.accounts.vault).length, VAULT_ACCOUNT_SIZE);
  assert.equal(bytes(vectors.accounts.houseLimits).length, HOUSE_LIMITS_ACCOUNT_SIZE);
  assert.equal(bytes(vectors.accounts.oracle).length, ORACLE_ACCOUNT_SIZE);
});
