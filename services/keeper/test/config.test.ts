import assert from 'node:assert/strict';
import type { webcrypto } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { describeError, TransactionTooLarge, isRateLimited, isTooLarge } from '../src/chain.ts';
import { DEFAULT_MAINNET_RPCS, loadConfig, loadPoolGate } from '../src/config.ts';
import { DEFAULT_GATE } from '../src/poolgate.ts';
import { loadKeypairSigner } from '../src/keypair.ts';
import { backoffMs } from '../src/rpc.ts';
import { parseState } from '../src/state.ts';
import { TransactionFailed } from '@flipthememe/client';
import type { Signature } from '@solana/kit';

describe('loadConfig', () => {
  const cwd = resolve('/srv/keeper');

  test('defaults', () => {
    const cfg = loadConfig({}, cwd);
    assert.equal(cfg.devnetRpc, 'https://api.devnet.solana.com');
    assert.deepEqual(cfg.mainnetRpcs, DEFAULT_MAINNET_RPCS);
    // Next to the keeper package (services/keeper), whatever the working directory is.
    const packageDir = fileURLToPath(new URL('..', import.meta.url));
    assert.equal(cfg.stateFile, join(packageDir, 'keeper-state.json'));
    assert.equal(cfg.statusFile, join(packageDir, 'status.json'));
    assert.equal(cfg.houseRoundCap, 50_000_000n);
    assert.equal(cfg.houseDailyBudget, 2_000_000_000n);
    assert.equal(cfg.poolOverride, null);
    assert.match(cfg.keypairPath, /\.flipthememe[\\/]keeper\.json$/);
    assert.deepEqual(cfg.poolGate, DEFAULT_GATE);
  });

  test('env values', () => {
    const cfg = loadConfig(
      {
        DEVNET_RPC: 'http://127.0.0.1:8899',
        MAINNET_RPCS: ' https://a.example/rpc , ,https://b.example ',
        KEEPER_KEYPAIR: '/secrets/keeper.json',
        STATE_FILE: '/data/state.json',
        HOUSE_ROUND_CAP_LAMPORTS: '25_000_000',
        HOUSE_DAILY_BUDGET_LAMPORTS: '1000000000',
        POOL_OVERRIDE: '11111111111111111111111111111112',
      },
      cwd,
    );
    assert.equal(cfg.devnetRpc, 'http://127.0.0.1:8899');
    assert.deepEqual(cfg.mainnetRpcs, ['https://a.example/rpc', 'https://b.example']);
    assert.equal(cfg.keypairPath, resolve(cwd, '/secrets/keeper.json'));
    assert.equal(cfg.stateFile, resolve(cwd, '/data/state.json'));
    assert.equal(cfg.statusFile, join(resolve(cwd, '/data'), 'status.json'));
    assert.equal(cfg.houseRoundCap, 25_000_000n);
    assert.equal(cfg.houseDailyBudget, 1_000_000_000n);
    assert.equal(cfg.poolOverride, '11111111111111111111111111111112');
  });

  test('pool gate from the environment, in minutes', () => {
    const gate = loadPoolGate({
      POOL_MIN_AGE_MIN: '5',
      POOL_MAX_AGE_MIN: ' 60 ',
      POOL_MIN_TX_M5: '30',
      POOL_HOLD_MIN: '7.5',
      POOL_SWITCH_RATIO: '2',
      POOL_KEEP_MIN_TX_M5: '10',
      POOL_KEEP_MAX_AGE_MIN: '90',
    });
    assert.deepEqual(gate, { minAgeMs: 300_000, maxAgeMs: 3_600_000, minTxM5: 30, holdMs: 450_000, switchRatio: 2, keepMinTxM5: 10, keepMaxAgeMs: 5_400_000 });
    assert.deepEqual(loadPoolGate({ POOL_MAX_AGE_MIN: '', POOL_SWITCH_RATIO: ' ' }), DEFAULT_GATE);
    assert.throws(() => loadPoolGate({ POOL_MIN_TX_M5: '50.5' }), /POOL_MIN_TX_M5 must be a whole number/);
    assert.throws(() => loadPoolGate({ POOL_MAX_AGE_MIN: '-5' }), /POOL_MAX_AGE_MIN must be a non-negative number/);
    assert.throws(() => loadPoolGate({ POOL_MIN_AGE_MIN: '120' }), /POOL_MAX_AGE_MIN must be greater than POOL_MIN_AGE_MIN/);
    assert.throws(() => loadPoolGate({ POOL_KEEP_MAX_AGE_MIN: '100' }), /POOL_KEEP_MAX_AGE_MIN must not be below POOL_MAX_AGE_MIN/);
    assert.throws(() => loadPoolGate({ POOL_KEEP_MIN_TX_M5: '60' }), /POOL_KEEP_MIN_TX_M5 must not exceed POOL_MIN_TX_M5/);
    assert.throws(() => loadPoolGate({ POOL_SWITCH_RATIO: '0.9' }), /POOL_SWITCH_RATIO must be at least 1/);
    assert.throws(() => loadConfig({ POOL_HOLD_MIN: 'ten' }, cwd), /POOL_HOLD_MIN/);
  });

  test('rejects malformed values', () => {
    assert.throws(() => loadConfig({ HOUSE_ROUND_CAP_LAMPORTS: '0.05' }, cwd), /whole number of lamports/);
    assert.throws(() => loadConfig({ HOUSE_DAILY_BUDGET_LAMPORTS: '-1' }, cwd), /whole number of lamports/);
    assert.throws(() => loadConfig({ POOL_OVERRIDE: 'not-an-address' }, cwd), /POOL_OVERRIDE/);
    assert.throws(() => loadConfig({ DEVNET_RPC: 'ftp://x' }, cwd), /DEVNET_RPC/);
    assert.throws(() => loadConfig({ MAINNET_RPCS: ' , ' }, cwd), /MAINNET_RPCS/);
  });
});

describe('state file', () => {
  const now = Date.parse('2026-10-05T12:00:00Z');

  test('round-trips the ledger and pool, ignores garbage', () => {
    const state = parseState(
      {
        version: 1,
        house: { day: '2026-10-05', spent: '50000000', rounds: ['1', 2, '3'] },
        pool: { pool: '11111111111111111111111111111112', baseMint: '11111111111111111111111111111113', name: 'X', selectedAtMs: now, fallback: true },
      },
      now,
    );
    assert.deepEqual(state.house, { day: '2026-10-05', spent: 50_000_000n, rounds: ['1', '3'] });
    assert.equal(state.pool?.fallback, true);
    assert.equal(state.pool?.rung, 3, 'a file without a rung maps fallback to the any-age rung');
    assert.deepEqual(parseState('nonsense', now), { house: { day: '2026-10-05', spent: 0n, rounds: [] }, pool: null });
    assert.equal(parseState({ house: { day: 'x', spent: '1', rounds: [] }, pool: { pool: 'bad' } }, now).pool, null);
  });

  test('the ladder rung of the pool survives a restart', () => {
    const pool = { pool: '11111111111111111111111111111112', baseMint: '11111111111111111111111111111113', name: 'X', selectedAtMs: now };
    const rungs = [
      parseState({ pool: { ...pool, rung: 1, fallback: true } }, now).pool,
      parseState({ pool: { ...pool, fallback: false } }, now).pool,
      parseState({ pool: { ...pool, rung: 7 } }, now).pool,
    ].map((p) => [p?.rung, p?.fallback]);
    assert.deepEqual(rungs, [[1, true], [0, false], [0, false]]);
  });
});

describe('keeper keypair file', () => {
  test('loads a solana-keygen array and never echoes the file in errors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ftm-keeper-'));
    try {
      // Build a valid 64-byte keypair: random secret, public key exported from WebCrypto.
      const pair = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
      const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
      const secret = pkcs8.slice(pkcs8.length - 32);
      const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
      const good = join(dir, 'good.json');
      writeFileSync(good, JSON.stringify([...secret, ...pub]));
      const signer = await loadKeypairSigner(good);
      assert.equal(typeof signer.address, 'string');

      const secretText = '[1,2,3,"top-secret-value"]';
      const bad = join(dir, 'bad.json');
      writeFileSync(bad, secretText);
      await assert.rejects(loadKeypairSigner(bad), (e: Error) => !e.message.includes('top-secret') && /64 bytes/.test(e.message));
      const broken = join(dir, 'broken.json');
      writeFileSync(broken, 'top-secret-value');
      await assert.rejects(loadKeypairSigner(broken), (e: Error) => !e.message.includes('top-secret') && /not valid JSON/.test(e.message));
      const mismatched = join(dir, 'mismatched.json');
      writeFileSync(mismatched, JSON.stringify([...secret, ...new Uint8Array(32).fill(7)]));
      await assert.rejects(loadKeypairSigner(mismatched), /invalid ed25519 key pair/);
      await assert.rejects(loadKeypairSigner(join(dir, 'missing.json')), /cannot read keeper keypair file .* \(ENOENT\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('error helpers', () => {
  test('program error names from simulation logs, transaction errors and causes', () => {
    const preflight = Object.assign(new Error('Transaction simulation failed'), {
      context: { logs: ['Program 5kUCKYAYxZyaSz18xEajhSDNwdXvVLp2AvBp4LDxWuCz failed: custom program error: 0x1779'] },
    });
    assert.equal(describeError(preflight), 'NotDue');
    const failed = new TransactionFailed('sig' as Signature, { InstructionError: [0, { Custom: 6018 }] });
    assert.equal(describeError(failed), 'NotFillWindow');
    const wrapped = new Error('outer', { cause: failed });
    assert.equal(describeError(wrapped), 'NotFillWindow');
    const anchorLog = Object.assign(new Error('x'), { context: { logs: ['Program log: AnchorError occurred. Error Code: AccountNotInitialized. Error Number: 3012.'] } });
    assert.equal(describeError(anchorLog), 'AccountNotInitialized');
    assert.equal(describeError(new Error('boom')), 'boom');
  });

  test('rate-limit detection', () => {
    assert.equal(isRateLimited(Object.assign(new Error('HTTP error (429): Too Many Requests'), { context: { statusCode: 429 } })), true);
    assert.equal(isRateLimited(new Error('HTTP 429')), true);
    assert.equal(isRateLimited(new Error('NotDue')), false);
  });

  test('too-large detection and RPC backoff', () => {
    assert.equal(isTooLarge(new TransactionTooLarge(5)), true);
    assert.equal(isTooLarge(new Error('base64 encoded solana_transaction::versioned::VersionedTransaction too large: 1700 bytes')), true);
    assert.equal(isTooLarge(new Error('NotDue')), false);
    assert.deepEqual([1, 2, 3, 4, 7, 50].map(backoffMs), [1_000, 2_000, 4_000, 8_000, 60_000, 60_000]);
  });
});
