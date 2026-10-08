// close_session builder: same accounts as revokeSession, but the owner receives the rent and so is
// writable. The byte-level agreement with the program is in vectors.test.ts; this pins the roles
// and the PDA, which the app relies on when it batches several closes into one transaction.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AccountRole, address, getAddressDecoder, type Address } from '@solana/kit';
import { IX, PROGRAM_ID, PROGRAM_ERRORS, closePosition, closeSession, revokeSession, sessionAddress, vaultAddress } from '../src/index.ts';

const key = (n: number): Address => getAddressDecoder().decode(new Uint8Array(32).fill(n));
const OWNER = key(10);
const DEVICE = key(7);

test('closeSession takes the owner vault and the session of the device key, and the owner signs and receives the rent', async () => {
  const vault = await vaultAddress(OWNER);
  const session = await sessionAddress(vault, DEVICE);
  const instruction = await closeSession({ owner: OWNER, sessionSigner: DEVICE });
  assert.equal(instruction.programAddress, PROGRAM_ID);
  assert.deepEqual(instruction.accounts, [
    { address: vault, role: AccountRole.READONLY },
    { address: session, role: AccountRole.WRITABLE },
    { address: OWNER, role: AccountRole.WRITABLE_SIGNER },
  ]);
  // No arguments: the discriminator alone.
  assert.deepEqual([...(instruction.data as Uint8Array)], [...IX.closeSession]);
  assert.equal((instruction.data as Uint8Array).length, 8);
});

test('closeSession is revokeSession with a writable owner, over the same session address', async () => {
  const revoke = await revokeSession({ owner: OWNER, sessionSigner: DEVICE });
  const close = await closeSession({ owner: OWNER, sessionSigner: DEVICE });
  assert.deepEqual(
    close.accounts?.map((a) => a.address),
    revoke.accounts?.map((a) => a.address),
  );
  assert.equal(revoke.accounts?.[2].role, AccountRole.READONLY_SIGNER);
  assert.equal(close.accounts?.[2].role, AccountRole.WRITABLE_SIGNER);
  assert.notDeepEqual([...(close.data as Uint8Array)], [...(revoke.data as Uint8Array)]);
});

test('a signer object is kept on the owner account, and another program id moves every address', async () => {
  const signer = { address: OWNER, signTransactions: async () => [] } as never;
  const withSigner = await closeSession({ owner: signer, sessionSigner: DEVICE });
  assert.equal((withSigner.accounts?.[2] as { signer?: unknown }).signer, signer);

  const other = address('11111111111111111111111111111112');
  const moved = await closeSession({ owner: OWNER, sessionSigner: DEVICE, programId: other });
  assert.equal(moved.programAddress, other);
  assert.notEqual(moved.accounts?.[0].address, (await closeSession({ owner: OWNER, sessionSigner: DEVICE })).accounts?.[0].address);
});

test('SessionStillActive is the next program error after MaxBankBelowMin, and RoundOpensTooFar follows it', () => {
  const at = PROGRAM_ERRORS.indexOf('SessionStillActive');
  assert.equal(6000 + at, 6032);
  assert.equal(PROGRAM_ERRORS[at - 1], 'MaxBankBelowMin');
  assert.equal(PROGRAM_ERRORS[at + 1], 'RoundOpensTooFar');
  assert.equal(6000 + at + 1, 6033);
  assert.deepEqual(PROGRAM_ERRORS.slice(at + 2), ['AttestationInvalid', 'DetachedPriceRequired']);
});

test('closePosition marks the round writable, since the program lowers its position counts', async () => {
  const instruction = await closePosition({ roundId: 42n, owner: OWNER });
  // config, round, position, vault: all writable, none signs (anyone may send it).
  assert.deepEqual(
    instruction.accounts?.map((a) => a.role),
    [AccountRole.WRITABLE, AccountRole.WRITABLE, AccountRole.WRITABLE, AccountRole.WRITABLE],
  );
});
