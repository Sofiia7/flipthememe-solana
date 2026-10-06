// Node tests for the bet chips: which amounts fit the game balance (a bet also parks its position rent
// there), the caption of the real maximum, and the fall back to the largest chip that fits. Run from
// the repo root: node --test "apps/mobile/src/__tests__/*.test.ts"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BET_AMOUNTS } from '../config.ts';
import { chipStates, effectiveAmount, largestFitting, maxBet, maxBetCaption } from '../lib/betChips.ts';
import { RENT_FALLBACK } from '../wallet/topUpPlan.ts';

const SOL = 1_000_000_000n;
const REAL_RENT = 1_158_240n; // a 100-byte position at the rate devnet charges now
const chips = BET_AMOUNTS; // 0.01, 0.02, 0.05, 0.10

test('after a 0.10 top up the 0.10 chip is off: 0.10 plus the position rent is more than the balance', () => {
  const max = maxBet({ available: SOL / 10n, positionRent: REAL_RENT });
  assert.equal(max, SOL / 10n - REAL_RENT);
  assert.deepEqual(
    chipStates(chips, max).map((c) => [c.amount, c.fits]),
    [
      [SOL / 100n, true],
      [SOL / 50n, true],
      [SOL / 20n, true],
      [SOL / 10n, false],
    ],
  );
  assert.equal(maxBetCaption(max), 'max 0.098');
  // The fallback rent, used until the real one is read, gives the same caption.
  assert.equal(maxBetCaption(maxBet({ available: SOL / 10n, positionRent: RENT_FALLBACK.position })), 'max 0.098');
});

test('a chip that does not fit falls back to the largest one that does', () => {
  const max = maxBet({ available: SOL / 10n, positionRent: REAL_RENT });
  assert.equal(largestFitting(chips, max), SOL / 20n);
  assert.equal(effectiveAmount(SOL / 10n, chips, max), SOL / 20n);
  // A chip that fits is kept, even when a larger one fits too.
  assert.equal(effectiveAmount(SOL / 50n, chips, max), SOL / 50n);
  assert.equal(effectiveAmount(SOL / 20n, chips, max), SOL / 20n);
  // A bigger balance gives the player's own choice back.
  assert.equal(effectiveAmount(SOL / 10n, chips, maxBet({ available: SOL / 4n, positionRent: REAL_RENT })), SOL / 10n);
  // The balance exactly covers the chip and the rent: it fits.
  assert.equal(effectiveAmount(SOL / 10n, chips, maxBet({ available: SOL / 10n + REAL_RENT, positionRent: REAL_RENT })), SOL / 10n);
  assert.equal(effectiveAmount(SOL / 10n, chips, maxBet({ available: SOL / 10n + REAL_RENT - 1n, positionRent: REAL_RENT })), SOL / 20n);
});

test('when no chip fits every chip is off, the choice stays and the caption says how little is left', () => {
  const max = maxBet({ available: 10_500_000n, positionRent: REAL_RENT });
  assert.equal(max, 9_341_760n);
  assert.deepEqual(chipStates(chips, max).map((c) => c.fits), [false, false, false, false]);
  assert.equal(largestFitting(chips, max), null);
  assert.equal(effectiveAmount(SOL / 50n, chips, max), SOL / 50n);
  assert.equal(maxBetCaption(max), 'max 0.009');
  // Less than the rent: nothing can be bet at all, and the maximum never goes negative.
  const none = maxBet({ available: REAL_RENT - 1n, positionRent: REAL_RENT });
  assert.equal(none, 0n);
  assert.equal(maxBetCaption(none), 'max 0.00');
});

test('a limited session (made before the allowance was widened) also caps the chips', () => {
  const max = maxBet({ available: SOL, positionRent: REAL_RENT, sessionLeft: (SOL * 3n) / 100n });
  assert.equal(max, (SOL * 3n) / 100n);
  assert.deepEqual(chipStates(chips, max).map((c) => c.fits), [true, true, false, false]);
  assert.equal(effectiveAmount(SOL / 10n, chips, max), SOL / 50n);
  // No limit known: only the balance counts.
  assert.equal(maxBet({ available: SOL, positionRent: REAL_RENT, sessionLeft: null }), SOL - REAL_RENT);
});

test('the caption truncates and never promises more than the balance allows', () => {
  assert.equal(maxBetCaption(98_841_760n), 'max 0.098');
  assert.equal(maxBetCaption(98_999_999n), 'max 0.098');
  assert.equal(maxBetCaption(SOL), 'max 1.00');
});
