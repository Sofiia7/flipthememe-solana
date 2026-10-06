//! Money rules of one round, free of account handling so they can be unit-tested.
//!
//! Matched 1:1 bank: `m = min(up, down)` plays on each side. The larger side's surplus
//! comes back pro rata without a fee. A winner gets exactly `2 * (1 - fee_win)` of the
//! accepted stake (1.96x at 200 bps), whatever the book looks like.
//!
//! One exception to "a refund returns the stake": a matched round that expires unpriced takes the
//! house stake and hands it to the other positions (see `claim_payout`).

use crate::{Outcome, RefundReason, Side};

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

/// What `claim` credits: `position_payout`, except in one case. When a matched round expires
/// (nobody priced it in time) the house position forfeits its stake and the other positions
/// share it pro rata to their stakes:
///   house position:       0
///   any other position:   its normal refund + floor(house_amount * stake / other_stakes)
/// with `other_stakes = raw_up + raw_down - house_amount`. The operator runs both the keeper and
/// the house, so without this a house that is losing could withhold the price and take its stake
/// back for free. Tie, no-price and unmatched refunds are not withholding cases and stay as they
/// were. Floors only: the payouts sum to at most the bank, the dust goes to `sweep_fees`.
///
/// If the house stake is the whole bank there is nobody to compensate: no forfeiture. Not
/// reachable with a real book, since the house never takes the larger side.
#[allow(clippy::too_many_arguments)]
pub fn claim_payout(
    raw_up: u64,
    raw_down: u64,
    house_amount: u64,
    outcome: Outcome,
    refund_reason: RefundReason,
    fee_win_bps: u16,
    fee_refund_bps: u16,
    side: Side,
    stake: u64,
    is_house: bool,
) -> Option<u64> {
    let base = position_payout(raw_up, raw_down, outcome, fee_win_bps, fee_refund_bps, side, stake)?;
    if outcome != Outcome::Refund || refund_reason != RefundReason::Expired || house_amount == 0 {
        return Some(base);
    }
    let other_stakes = raw_up.checked_add(raw_down)?.checked_sub(house_amount)?;
    if other_stakes == 0 {
        return Some(base);
    }
    if is_house {
        return Some(0);
    }
    let share = (house_amount as u128).checked_mul(stake as u128)? / other_stakes as u128;
    base.checked_add(u64::try_from(share).ok()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOL: u64 = 1_000_000_000;

    fn pay(up: u64, down: u64, outcome: Outcome, side: Side, stake: u64) -> u64 {
        position_payout(up, down, outcome, 200, 100, side, stake).unwrap()
    }

    fn pay_with(up: u64, down: u64, outcome: Outcome, fee_refund_bps: u16, side: Side, stake: u64) -> u64 {
        position_payout(up, down, outcome, 200, fee_refund_bps, side, stake).unwrap()
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

    /// What claim pays: every refund reason, with the house's share of the book.
    #[allow(clippy::too_many_arguments)]
    fn claim(
        up: u64,
        down: u64,
        house: u64,
        outcome: Outcome,
        reason: RefundReason,
        fee_refund_bps: u16,
        side: Side,
        stake: u64,
        is_house: bool,
    ) -> u64 {
        claim_payout(up, down, house, outcome, reason, 200, fee_refund_bps, side, stake, is_house).unwrap()
    }

    #[test]
    fn an_expired_round_pays_the_house_stake_to_the_other_positions() {
        // 0.08 UP from two players (0.06 and 0.02), 0.02 DOWN from one; the house filled DOWN with 0.06.
        let (up, down, house) = (8 * SOL / 100, 8 * SOL / 100, 6 * SOL / 100);
        let expired = |side, stake, is_house| claim(up, down, house, Outcome::Refund, RefundReason::Expired, 0, side, stake, is_house);
        // Other stakes total 0.10: each gets its stake back plus 0.06 * stake / 0.10.
        assert_eq!(expired(Side::Up, 6 * SOL / 100, false), 6 * SOL / 100 + 36 * SOL / 1000);
        assert_eq!(expired(Side::Up, 2 * SOL / 100, false), 2 * SOL / 100 + 12 * SOL / 1000);
        assert_eq!(expired(Side::Down, 2 * SOL / 100, false), 2 * SOL / 100 + 12 * SOL / 1000);
        assert_eq!(expired(Side::Down, 6 * SOL / 100, true), 0);
    }

    #[test]
    fn an_expired_round_without_a_house_position_pays_like_any_refund() {
        let (up, down) = (3 * SOL / 10, SOL / 10);
        for fee in [0, 100] {
            for (side, stake) in [(Side::Up, up), (Side::Down, down)] {
                let plain = pay_with(up, down, Outcome::Refund, fee, side, stake);
                assert_eq!(claim(up, down, 0, Outcome::Refund, RefundReason::Expired, fee, side, stake, false), plain);
            }
        }
    }

    #[test]
    fn only_an_expired_refund_takes_the_house_stake() {
        let (up, down, house) = (SOL / 10, SOL / 10, SOL / 20);
        for reason in [RefundReason::Tie, RefundReason::Unpriceable, RefundReason::None] {
            for is_house in [true, false] {
                let plain = pay_with(up, down, Outcome::Refund, 100, Side::Down, SOL / 20);
                assert_eq!(claim(up, down, house, Outcome::Refund, reason, 100, Side::Down, SOL / 20, is_house), plain);
            }
        }
        // A priced round and an unmatched one never look at the house either.
        for outcome in [Outcome::Up, Outcome::Down, Outcome::NotActivated] {
            let plain = pay_with(up, down, outcome, 100, Side::Down, SOL / 20);
            assert_eq!(claim(up, down, house, outcome, RefundReason::Expired, 100, Side::Down, SOL / 20, true), plain);
        }
    }

    #[test]
    fn with_nobody_to_compensate_the_house_gets_its_refund() {
        // Not reachable with a real book (the house never takes the larger side), but the rule must hold.
        let (up, down) = (SOL / 10, SOL / 10);
        let plain = pay_with(up, down, Outcome::Refund, 100, Side::Up, up);
        assert_eq!(claim(up, down, up + down, Outcome::Refund, RefundReason::Expired, 100, Side::Up, up, true), plain);
    }

    #[test]
    fn a_pending_round_has_no_payout_whoever_asks() {
        assert_eq!(claim_payout(1, 1, 1, Outcome::Pending, RefundReason::Expired, 200, 0, Side::Up, 1, false), None);
        assert_eq!(claim_payout(1, 1, 1, Outcome::Pending, RefundReason::Expired, 200, 0, Side::Up, 1, true), None);
    }

    #[test]
    fn expired_payouts_with_a_house_never_exceed_the_bank() {
        let mut rng = Rng(0x1234_5678_9abc_def1);
        for _ in 0..2_000 {
            let ups: Vec<u64> = (0..1 + rng.next() % 6).map(|_| rng.stake()).collect();
            let downs: Vec<u64> = (0..1 + rng.next() % 6).map(|_| rng.stake()).collect();
            let (up_players, down_players) = (ups.iter().sum::<u64>(), downs.iter().sum::<u64>());
            // The house tops the smaller side up by part of the gap, in one or two fills.
            let (house_side, gap) = if up_players < down_players {
                (Side::Up, down_players - up_players)
            } else {
                (Side::Down, up_players - down_players)
            };
            let first = if gap == 0 { 0 } else { 1 + rng.next() % gap };
            let second = if gap > first { rng.next() % (gap - first + 1) } else { 0 };
            let house_stakes: Vec<u64> = [first, second].into_iter().filter(|&h| h > 0).collect();
            let house: u64 = house_stakes.iter().sum();
            let (up, down) = match house_side {
                Side::Up => (up_players + house, down_players),
                Side::Down => (up_players, down_players + house),
            };
            for fee in [0u16, 100] {
                let mut paid = 0u64;
                for &s in &ups {
                    paid += claim(up, down, house, Outcome::Refund, RefundReason::Expired, fee, Side::Up, s, false);
                }
                for &s in &downs {
                    paid += claim(up, down, house, Outcome::Refund, RefundReason::Expired, fee, Side::Down, s, false);
                }
                for &s in &house_stakes {
                    let got = claim(up, down, house, Outcome::Refund, RefundReason::Expired, fee, house_side, s, true);
                    assert_eq!(got, 0, "the house keeps nothing of an expired round");
                    paid += got;
                }
                assert!(paid <= up + down, "paid {paid} > bank {} (house {house}, fee {fee})", up + down);
                if fee == 0 && house > 0 {
                    // Floors lose at most one lamport per other position.
                    let others = (ups.len() + downs.len()) as u64;
                    assert!(up + down - paid <= others, "dust {} for {others} positions", up + down - paid);
                }
            }
        }
    }
}
