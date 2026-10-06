// What the admin scripts plan from the chain state and the command line, before anything is signed.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PROGRAM_ID, type VaultAccount } from '@flipthememe/client';
import { address } from '@solana/kit';
import { NO_ATTESTOR } from '../src/attest.ts';
import {
  addressArg,
  boolArg,
  lamportsArg,
  oracleCosigner,
  planHouseLimits,
  planOracle,
  planRoleSplit,
  wantedOracle,
  weakensOracle,
  type SplitInput,
} from '../src/plans.ts';
import { SOL, makeConfig } from './fake-chain.ts';

const KEEPER = address('11111111111111111111111111111112');
const PRICE = address('11111111111111111111111111111113');
const HOUSE = address('11111111111111111111111111111114');
const TREASURY = address('11111111111111111111111111111115');
const ATTESTOR = address('11111111111111111111111111111116');
const VAULT_RENT = 939_800n; // 185 bytes x 5080 lamports

describe('command line', () => {
  test('flags with values', () => {
    const argv = ['--round-cap', '25_000_000', '--required', 'true', '--attestor', ATTESTOR, '--dry-run'];
    assert.equal(lamportsArg(argv, '--round-cap', 1n), 25_000_000n);
    assert.equal(lamportsArg(argv, '--daily-cap', 2_000_000_000n), 2_000_000_000n);
    assert.equal(boolArg(argv, '--required'), true);
    assert.equal(boolArg(argv, '--other'), null);
    assert.equal(addressArg(argv, '--attestor'), ATTESTOR);
    assert.throws(() => lamportsArg(['--round-cap', '0.05'], '--round-cap', 1n), /whole number of lamports/);
    assert.throws(() => boolArg(['--required', 'yes'], '--required'), /true or false/);
    assert.throws(() => addressArg(['--attestor', 'nope'], '--attestor'), /base58 address/);
    assert.throws(() => lamportsArg(['--round-cap', '--dry-run'], '--round-cap', 1n), /needs a value/);
  });
});

describe('init-house-limits and init-oracle are idempotent', () => {
  const limits = { roundCap: 50_000_000n, dailyCap: 2n * SOL, day: 20_732n, spent: 7n, bump: 255 };

  test('house limits: init when missing, update when a cap differs, else nothing', () => {
    assert.equal(planHouseLimits(null, { roundCap: 1n, dailyCap: 2n }), 'init');
    assert.equal(planHouseLimits(limits, { roundCap: 50_000_000n, dailyCap: 2n * SOL }), 'none');
    assert.equal(planHouseLimits(limits, { roundCap: 25_000_000n, dailyCap: 2n * SOL }), 'update');
  });

  test('oracle: a flag left out keeps the current value; a required attestor must be a real key', () => {
    assert.deepEqual(wantedOracle(null, { attestor: null, required: null }), { attestor: NO_ATTESTOR, required: false });
    const current = { attestor: ATTESTOR, required: false, bump: 254 };
    assert.deepEqual(wantedOracle(current, { attestor: null, required: true }), { attestor: ATTESTOR, required: true });
    assert.throws(() => wantedOracle(null, { attestor: null, required: true }), /needs --attestor/);
    assert.throws(() => wantedOracle(null, { attestor: PROGRAM_ID, required: true }), /needs --attestor/);
    assert.equal(planOracle(null, { attestor: NO_ATTESTOR, required: false }), 'init');
    assert.equal(planOracle(current, { attestor: ATTESTOR, required: false }), 'none');
    assert.equal(planOracle(current, { attestor: ATTESTOR, required: true }), 'update');
  });

  test('oracle: the admin alone only strengthens; weakening a required one needs the attestor in office', () => {
    const optional = { attestor: ATTESTOR, required: false, bump: 254 };
    const required = { ...optional, required: true };
    // Strengthening, or anything while not required: no co-signer.
    for (const want of [
      { attestor: ATTESTOR, required: true },
      { attestor: HOUSE, required: false },
      { attestor: HOUSE, required: true },
    ]) {
      assert.equal(weakensOracle(optional, want), false);
      assert.deepEqual(oracleCosigner(optional, want, null), { cosigner: null, error: null });
    }
    assert.equal(weakensOracle(null, { attestor: ATTESTOR, required: false }), false);
    assert.equal(weakensOracle(required, { attestor: ATTESTOR, required: true }), false);
    // Switching off or replacing a required attestor: refused locally without its key file.
    assert.equal(weakensOracle(required, { attestor: ATTESTOR, required: false }), true);
    assert.equal(weakensOracle(required, { attestor: HOUSE, required: true }), true);
    assert.deepEqual(oracleCosigner(required, { attestor: ATTESTOR, required: false }, null), {
      cosigner: null,
      error: `switching off the required attestor ${ATTESTOR} needs its signature: pass --attestor-keypair <its key file>`,
    });
    assert.match(oracleCosigner(required, { attestor: HOUSE, required: true }, null).error ?? '', /^replacing the required attestor/);
    assert.deepEqual(oracleCosigner(required, { attestor: HOUSE, required: true }, PRICE), {
      cosigner: null,
      error: `--attestor-keypair holds ${PRICE}, but the attestor in office is ${ATTESTOR}`,
    });
    assert.deepEqual(oracleCosigner(required, { attestor: HOUSE, required: true }, ATTESTOR), { cosigner: ATTESTOR, error: null });
  });
});

describe('split-roles plan', () => {
  const vault = (available: bigint, locked = 0n): VaultAccount => ({ authority: KEEPER, available, locked, bump: 255 });
  const base: SplitInput = {
    config: makeConfig(KEEPER),
    keeper: KEEPER,
    keeperLamports: 3n * SOL,
    price: PRICE,
    house: HOUSE,
    treasury: TREASURY,
    oldVault: vault(2n * SOL),
    newVault: null,
    amount: null,
    vaultRent: VAULT_RENT,
    feeReserve: 50_000_000n,
  };

  test('from the single-key setup: every amount explicit, Config last, nothing extra for the house wallet', () => {
    const plan = planRoleSplit(base);
    assert.deepEqual(plan, {
      steps: [
        { kind: 'withdraw', vaultOwner: KEEPER, lamports: 2n * SOL },
        // Position rent now comes out of the house vault: the wallet gets the vault's rent only.
        { kind: 'transfer', from: KEEPER, to: HOUSE, lamports: 2n * SOL + VAULT_RENT, deposit: 2n * SOL, vaultRent: VAULT_RENT },
        { kind: 'open-vault', owner: HOUSE, rent: VAULT_RENT },
        { kind: 'deposit', owner: HOUSE, lamports: 2n * SOL },
        { kind: 'update-config', priceAuthority: PRICE, houseAuthority: HOUSE, treasury: TREASURY },
      ],
      warnings: [],
      errors: [],
    });
  });

  test('part of the money into an existing vault: only the deposit moves', () => {
    const plan = planRoleSplit({ ...base, amount: SOL / 2n, newVault: vault(0n) });
    assert.deepEqual(
      plan.steps.map((s) => [s.kind, 'lamports' in s ? s.lamports : null]),
      [
        ['withdraw', SOL / 2n],
        ['transfer', SOL / 2n],
        ['deposit', SOL / 2n],
        ['update-config', null],
      ],
    );
  });

  test('only the price role moves: one update_config, the house vault stays', () => {
    const plan = planRoleSplit({ ...base, house: KEEPER, treasury: KEEPER });
    assert.deepEqual(plan.steps, [{ kind: 'update-config', priceAuthority: PRICE, houseAuthority: KEEPER, treasury: KEEPER }]);
    assert.deepEqual(planRoleSplit({ ...base, price: KEEPER, house: KEEPER, treasury: KEEPER }), {
      steps: [],
      warnings: ['Config already names these roles: nothing to do'],
      errors: [],
    });
  });

  test('refuses what cannot be signed or paid, and warns about money still locked in rounds', () => {
    assert.match(planRoleSplit({ ...base, amount: 3n * SOL }).errors.join(), /exceeds the 2000000000 lamports free/);
    assert.match(planRoleSplit({ ...base, config: makeConfig(KEEPER, { admin: PRICE }) }).errors.join(), /Config admin is/);
    assert.match(planRoleSplit({ ...base, config: makeConfig(KEEPER, { houseAuthority: PRICE }) }).errors.join(), /move its vault by hand/);
    assert.match(planRoleSplit({ ...base, keeperLamports: VAULT_RENT }).errors.join(), /keeper wallet holds/);
    assert.match(planRoleSplit({ ...base, oldVault: vault(2n * SOL, SOL / 10n) }).warnings.join(), /100000000 lamports are still locked/);
  });
});
