//! Money rules of one round, free of account handling so they can be unit-tested.
//!
//! Matched 1:1 bank: `m = min(up, down)` plays on each side. The larger side's surplus
//! comes back pro rata without a fee. A winner gets exactly `2 * (1 - fee_win)` of the
//! accepted stake (1.96x at 200 bps), whatever the book looks like.
//!
//! One exception to "a refund returns the stake": a matched round that ends without a price
//! (expired, or priced from too few samples) takes the house stake and hands it to the other
//! positions (see `claim_payout`).

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

/// What `claim` credits: `position_payout`, except in one case. When a matched round ends without
/// a price (`RefundReason::Expired`: nobody priced it in time, or `RefundReason::Unpriceable`: the
/// attested window held too few observations) the house position forfeits its stake and the other
/// positions share it pro rata to their stakes:
///   house position:       0
///   any other position:   its normal refund + floor(house_amount * stake / other_stakes)
/// with `other_stakes = raw_up + raw_down - house_amount`. The operator runs both the keeper and
/// the house, so without this a house that is losing could withhold the price, or submit a window
/// too thin to price, and take its stake back for free. A tie is a real price that came out equal,
/// and an unmatched round (`Outcome::NotActivated`, which is never `Refund`) is no priced round at
/// all: both return the house stake like any other. Floors only: the payouts sum to at most the
/// bank, the dust goes to `sweep_fees`.
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
    let unpriced = matches!(refund_reason, RefundReason::Expired | RefundReason::Unpriceable);
    if outcome != Outcome::Refund || !unpriced || house_amount == 0 {
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
    fn only_a_refund_without_a_price_takes_the_house_stake() {
        let (up, down, house) = (SOL / 10, SOL / 10, SOL / 20);
        // A tie is a real price that came out equal: the house is refunded like everyone.
        for reason in [RefundReason::Tie, RefundReason::None] {
            for is_house in [true, false] {
                let plain = pay_with(up, down, Outcome::Refund, 100, Side::Down, SOL / 20);
                assert_eq!(claim(up, down, house, Outcome::Refund, reason, 100, Side::Down, SOL / 20, is_house), plain);
            }
        }
        // A priced round and an unmatched one never look at the house either, whatever the reason says.
        for reason in [RefundReason::Expired, RefundReason::Unpriceable] {
            for outcome in [Outcome::Up, Outcome::Down, Outcome::NotActivated] {
                let plain = pay_with(up, down, outcome, 100, Side::Down, SOL / 20);
                assert_eq!(claim(up, down, house, outcome, reason, 100, Side::Down, SOL / 20, true), plain);
            }
        }
    }

    #[test]
    fn an_unpriceable_round_treats_the_house_exactly_like_an_expired_one() {
        // 0.08 UP from two players (0.06 and 0.02), 0.02 DOWN from one; the house filled DOWN with 0.06.
        let (up, down, house) = (8 * SOL / 100, 8 * SOL / 100, 6 * SOL / 100);
        let book = [
            (Side::Up, 6 * SOL / 100, false),
            (Side::Up, 2 * SOL / 100, false),
            (Side::Down, 2 * SOL / 100, false),
            (Side::Down, house, true),
        ];
        for fee in [0, 100] {
            for (side, stake, is_house) in book {
                let unpriceable = claim(up, down, house, Outcome::Refund, RefundReason::Unpriceable, fee, side, stake, is_house);
                let expired = claim(up, down, house, Outcome::Refund, RefundReason::Expired, fee, side, stake, is_house);
                assert_eq!(unpriceable, expired);
            }
        }
        // The house gets nothing; the other positions split its 0.06 by stake (0.10 in all).
        let unpriceable =
            |side, stake, is_house| claim(up, down, house, Outcome::Refund, RefundReason::Unpriceable, 0, side, stake, is_house);
        assert_eq!(unpriceable(Side::Up, 6 * SOL / 100, false), 6 * SOL / 100 + 36 * SOL / 1000);
        assert_eq!(unpriceable(Side::Down, 2 * SOL / 100, false), 2 * SOL / 100 + 12 * SOL / 1000);
        assert_eq!(unpriceable(Side::Down, house, true), 0);
    }

    #[test]
    fn a_tie_and_an_unmatched_round_pay_the_house_in_full_or_at_the_refund_rate() {
        let (up, down, house) = (8 * SOL / 100, 8 * SOL / 100, 6 * SOL / 100);
        // Tie: the refund fee applies to the house stake like to any other, nothing is forfeited.
        assert_eq!(claim(up, down, house, Outcome::Refund, RefundReason::Tie, 100, Side::Down, house, true), house * 99 / 100);
        assert_eq!(claim(up, down, house, Outcome::Refund, RefundReason::Tie, 0, Side::Down, house, true), house);
        // Unmatched round with a small house fill: every stake back whole, the house's included.
        let (up, down, house) = (5 * SOL / 100, SOL / 200, SOL / 200);
        assert_eq!(claim(up, down, house, Outcome::NotActivated, RefundReason::None, 0, Side::Down, house, true), house);
        assert_eq!(claim(up, down, house, Outcome::NotActivated, RefundReason::None, 0, Side::Up, up, false), up);
    }

    #[test]
    fn with_nobody_to_compensate_the_house_gets_its_refund() {
        // Not reachable with a real book (the house never takes the larger side), but the rule must hold.
        let (up, down) = (SOL / 10, SOL / 10);
        let plain = pay_with(up, down, Outcome::Refund, 100, Side::Up, up);
        assert_eq!(claim(up, down, up + down, Outcome::Refund, RefundReason::Expired, 100, Side::Up, up, true), plain);
    }

    #[test]
    fn five_to_ten_players_with_odd_stakes_on_the_larger_side_never_overpay_and_lose_little_dust() {
        let mut rng = Rng(0x0dd5_7a4e_5eed_0001);
        let mut checked = 0;
        for _ in 0..2_000 {
            let n_big = 5 + (rng.next() % 6) as usize;
            let n_small = 1 + (rng.next() % 3) as usize;
            // Odd stakes: an odd base plus an even amount of noise.
            let odd = |rng: &mut Rng| (rng.stake() | 1) + 2 * (rng.next() % 50);
            let big: Vec<u64> = (0..n_big).map(|_| odd(&mut rng)).collect();
            let small: Vec<u64> = (0..n_small).map(|_| odd(&mut rng)).collect();
            let (big_total, small_total) = (big.iter().sum::<u64>(), small.iter().sum::<u64>());
            if big_total <= small_total {
                continue;
            }
            checked += 1;
            // The larger side is UP here; mirror it to cover DOWN as well.
            for big_side in [Side::Up, Side::Down] {
                let (up, down) = if big_side == Side::Up { (big_total, small_total) } else { (small_total, big_total) };
                let small_side = if big_side == Side::Up { Side::Down } else { Side::Up };
                for outcome in [Outcome::Up, Outcome::Down, Outcome::Refund] {
                    let paid: u64 = big.iter().map(|&s| pay(up, down, outcome, big_side, s)).sum::<u64>()
                        + small.iter().map(|&s| pay(up, down, outcome, small_side, s)).sum::<u64>();
                    assert!(paid <= up + down, "paid {paid} > bank {} for {outcome:?}", up + down);
                    // What stays behind is the fee on the accepted bank (2% of it on a result, 1% on a
                    // refund; the accepted bank is twice the smaller side) plus floors: at most one
                    // lamport per position on the accepted part, and one more on the 1.96x.
                    let fee_total = 2 * small_total * if outcome == Outcome::Refund { 1 } else { 2 } / 100;
                    let positions = (n_big + n_small) as u64;
                    let dust = up + down - paid;
                    assert!(dust <= fee_total + 2 * positions, "{outcome:?}: left {dust}, fee {fee_total}, positions {positions}");
                }
            }
        }
        assert!(checked > 1_000, "only {checked} books had a larger side");
    }

    #[test]
    fn a_pending_round_has_no_payout_whoever_asks() {
        assert_eq!(claim_payout(1, 1, 1, Outcome::Pending, RefundReason::Expired, 200, 0, Side::Up, 1, false), None);
        assert_eq!(claim_payout(1, 1, 1, Outcome::Pending, RefundReason::Expired, 200, 0, Side::Up, 1, true), None);
    }

    #[test]
    fn payouts_of_a_round_without_a_price_and_with_a_house_never_exceed_the_bank() {
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
            for reason in [RefundReason::Expired, RefundReason::Unpriceable] {
                for fee in [0u16, 100] {
                    let mut paid = 0u64;
                    for &s in &ups {
                        paid += claim(up, down, house, Outcome::Refund, reason, fee, Side::Up, s, false);
                    }
                    for &s in &downs {
                        paid += claim(up, down, house, Outcome::Refund, reason, fee, Side::Down, s, false);
                    }
                    for &s in &house_stakes {
                        let got = claim(up, down, house, Outcome::Refund, reason, fee, house_side, s, true);
                        assert_eq!(got, 0, "the house keeps nothing of a round that ended without a price ({reason:?})");
                        paid += got;
                    }
                    assert!(paid <= up + down, "paid {paid} > bank {} (house {house}, fee {fee}, {reason:?})", up + down);
                    if fee == 0 && house > 0 {
                        // Floors lose at most one lamport per other position.
                        let others = (ups.len() + downs.len()) as u64;
                        assert!(up + down - paid <= others, "dust {} for {others} positions", up + down - paid);
                    }
                }
            }
        }
    }
}
