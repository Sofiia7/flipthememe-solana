//! Money rules of one round, free of account handling so they can be unit-tested.
//!
//! Matched 1:1 bank: `m = min(up, down)` plays on each side. The larger side's surplus
//! comes back pro rata without a fee. A winner gets exactly `2 * (1 - fee_win)` of the
//! accepted stake (1.96x at 200 bps), whatever the book looks like.

use crate::{Outcome, Side};

pub const BPS: u128 = 10_000;

/// Both sides are present and the accepted bank `2m` reaches `min_bank`.
pub fn is_activated(raw_up: u64, raw_down: u64, min_bank: u64) -> bool {
    let m = raw_up.min(raw_down);
    m > 0 && (m as u128) * 2 >= min_bank as u128
}

/// The part of `stake` that plays. Floors on the larger side, so the sum never exceeds `m`.
pub fn accepted_stake(raw_up: u64, raw_down: u64, side: Side, stake: u64) -> Option<u64> {
    let (mine, other) = match side {
        Side::Up => (raw_up, raw_down),
        Side::Down => (raw_down, raw_up),
    };
    if stake > mine {
        return None;
    }
    if mine <= other {
        return Some(stake);
    }
    let accepted = (stake as u128).checked_mul(other as u128)? / mine as u128;
    u64::try_from(accepted).ok()
}

/// Lamports credited to the owner of a position once the round is final.
pub fn position_payout(
    raw_up: u64,
    raw_down: u64,
    outcome: Outcome,
    fee_win_bps: u16,
    fee_refund_bps: u16,
    side: Side,
    stake: u64,
) -> Option<u64> {
    match outcome {
        Outcome::Pending => None,
        Outcome::NotActivated => Some(stake),
        Outcome::Refund => {
            let accepted = accepted_stake(raw_up, raw_down, side, stake)?;
            let excess = stake.checked_sub(accepted)?;
            let back = (accepted as u128).checked_mul(BPS.checked_sub(fee_refund_bps as u128)?)? / BPS;
            excess.checked_add(u64::try_from(back).ok()?)
        }
        Outcome::Up | Outcome::Down => {
            let accepted = accepted_stake(raw_up, raw_down, side, stake)?;
            let excess = stake.checked_sub(accepted)?;
            let won = matches!(
                (outcome, side),
                (Outcome::Up, Side::Up) | (Outcome::Down, Side::Down)
            );
            if !won {
                return Some(excess);
            }
            let gross = (accepted as u128)
                .checked_mul(2)?
                .checked_mul(BPS.checked_sub(fee_win_bps as u128)?)?
                / BPS;
            excess.checked_add(u64::try_from(gross).ok()?)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOL: u64 = 1_000_000_000;

    fn pay(up: u64, down: u64, outcome: Outcome, side: Side, stake: u64) -> u64 {
        position_payout(up, down, outcome, 200, 100, side, stake).unwrap()
    }

    #[test]
    fn equal_sides_pay_exactly_1_96() {
        let s = SOL / 10;
        assert_eq!(pay(s, s, Outcome::Up, Side::Up, s), s * 196 / 100);
        assert_eq!(pay(s, s, Outcome::Up, Side::Down, s), 0);
    }

    #[test]
    fn surplus_of_the_larger_side_comes_back_without_fee() {
        // 0.40 UP against 0.10 DOWN: 0.10 plays per side, 0.30 returns to UP.
        let (up, down) = (4 * SOL / 10, SOL / 10);
        assert_eq!(accepted_stake(up, down, Side::Up, up), Some(SOL / 10));
        assert_eq!(pay(up, down, Outcome::Up, Side::Up, up), 3 * SOL / 10 + SOL / 10 * 196 / 100);
        assert_eq!(pay(up, down, Outcome::Down, Side::Up, up), 3 * SOL / 10);
        assert_eq!(pay(up, down, Outcome::Down, Side::Down, down), SOL / 10 * 196 / 100);
    }

    #[test]
    fn activated_refund_keeps_one_percent_of_the_accepted_part() {
        let (up, down) = (3 * SOL / 10, SOL / 10);
        assert_eq!(pay(up, down, Outcome::Refund, Side::Up, up), 2 * SOL / 10 + SOL / 10 * 99 / 100);
        assert_eq!(pay(up, down, Outcome::Refund, Side::Down, down), SOL / 10 * 99 / 100);
    }

    #[test]
    fn not_activated_returns_everything() {
        assert_eq!(pay(SOL / 10, 0, Outcome::NotActivated, Side::Up, SOL / 10), SOL / 10);
    }

    #[test]
    fn pending_has_no_payout() {
        assert_eq!(position_payout(1, 1, Outcome::Pending, 200, 100, Side::Up, 1), None);
    }

    #[test]
    fn activation_needs_both_sides_and_the_minimum_bank() {
        let min_bank = 2 * SOL / 100;
        assert!(!is_activated(SOL, 0, min_bank));
        assert!(!is_activated(SOL, SOL / 200, min_bank));
        assert!(is_activated(SOL, SOL / 100, min_bank));
    }

    /// xorshift64*, enough to spread books over many shapes without a dependency.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 >> 12;
            self.0 ^= self.0 << 25;
            self.0 ^= self.0 >> 27;
            self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
        }
        fn stake(&mut self) -> u64 {
            SOL / 100 + self.next() % (SOL / 10)
        }
    }

    #[test]
    fn payouts_never_exceed_the_bank() {
        let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
        for _ in 0..1_000 {
            let ups: Vec<u64> = (0..1 + rng.next() % 6).map(|_| rng.stake()).collect();
            let downs: Vec<u64> = (0..rng.next() % 6).map(|_| rng.stake()).collect();
            let (up, down) = (ups.iter().sum::<u64>(), downs.iter().sum::<u64>());
            let outcomes: &[Outcome] = if is_activated(up, down, 2 * SOL / 100) {
                &[Outcome::Up, Outcome::Down, Outcome::Refund]
            } else {
                &[Outcome::NotActivated]
            };
            for &outcome in outcomes {
                let paid: u64 = ups.iter().map(|&s| pay(up, down, outcome, Side::Up, s)).sum::<u64>()
                    + downs.iter().map(|&s| pay(up, down, outcome, Side::Down, s)).sum::<u64>();
                assert!(paid <= up + down, "paid {paid} > bank {} for {outcome:?}", up + down);
                if outcome == Outcome::NotActivated {
                    assert_eq!(paid, up + down);
                }
            }
        }
    }
}
