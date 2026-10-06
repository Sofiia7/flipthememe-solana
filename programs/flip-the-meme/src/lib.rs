use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Allocate, Assign, Transfer};

pub mod payout;

declare_id!("5kUCKYAYxZyaSz18xEajhSDNwdXvVLp2AvBp4LDxWuCz");

/// Fewer observations than this in a price window means the round cannot be priced.
pub const MIN_SAMPLES: usize = 5;
pub const MAX_SAMPLES: usize = 16;
/// Hard caps that no config update can exceed: 2% of the bank on a result, 1% on a refund.
pub const MAX_FEE_WIN_BPS: u16 = 200;
pub const MAX_FEE_REFUND_BPS: u16 = 100;
pub const MAX_SESSION_SECS: i64 = 7 * 24 * 60 * 60;
/// What the admin (the keeper's hot key) may schedule, so no round can hold bets for long: at most
/// this long from a round's opening to the end of its exit window ...
pub const MAX_ROUND_SECS: i64 = 15 * 60;
/// ... and from the end of the exit window to the deadline after which anyone may refund it.
pub const MAX_SETTLE_GRACE_SECS: i64 = 60 * 60;
/// A paid position stays on chain this long after its round's exit window as readable history,
/// then anyone may close it and its rent goes back to the owner.
pub const POSITION_CLOSE_DELAY_SECS: i64 = 60 * 60;
/// The house's daily cap counts per UTC day: `unix_timestamp / SECS_PER_DAY`.
pub const SECS_PER_DAY: i64 = 24 * 60 * 60;

#[program]
pub mod flip_the_meme {
    use super::*;

    pub fn initialize_config(ctx: Context<InitializeConfig>, params: ConfigParams) -> Result<()> {
        params.validate()?;
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.apply(&params);
        config.paused = false;
        config.next_round_id = 0;
        config.total_available = 0;
        config.total_locked = 0;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Affects only rounds created afterwards: every round keeps a snapshot of its parameters.
    pub fn update_config(ctx: Context<AdminConfig>, params: ConfigParams) -> Result<()> {
        params.validate()?;
        ctx.accounts.config.apply(&params);
        Ok(())
    }

    /// Stops new bets only. Settlement, refunds, claims and withdrawals keep working.
    pub fn set_pause(ctx: Context<AdminConfig>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        Ok(())
    }

    /// On-chain ceiling for the house: per round and per UTC day. Zero disables house fills.
    pub fn init_house_limits(ctx: Context<InitHouseLimits>, round_cap: u64, daily_cap: u64) -> Result<()> {
        let limits = &mut ctx.accounts.house_limits;
        limits.round_cap = round_cap;
        limits.daily_cap = daily_cap;
        limits.day = Clock::get()?.unix_timestamp.div_euclid(SECS_PER_DAY);
        limits.spent = 0;
        limits.bump = ctx.bumps.house_limits;
        Ok(())
    }

    /// New caps apply at once; what the house already spent today still counts.
    pub fn update_house_limits(ctx: Context<UpdateHouseLimits>, round_cap: u64, daily_cap: u64) -> Result<()> {
        let limits = &mut ctx.accounts.house_limits;
        limits.round_cap = round_cap;
        limits.daily_cap = daily_cap;
        Ok(())
    }

    /// The independent price attestor. While `required` is false, prices need no second signer.
    pub fn init_oracle(ctx: Context<InitOracle>, attestor: Pubkey, required: bool) -> Result<()> {
        validate_attestor(attestor, required)?;
        let oracle = &mut ctx.accounts.oracle;
        oracle.attestor = attestor;
        oracle.required = required;
        oracle.bump = ctx.bumps.oracle;
        Ok(())
    }

    /// The admin is the keeper's hot key, so alone it may only strengthen the oracle: require an
    /// attestor, or pick one while none is required. Switching a required attestor off or
    /// replacing it needs the attestor in office to co-sign.
    pub fn set_oracle(ctx: Context<SetOracle>, attestor: Pubkey, required: bool) -> Result<()> {
        validate_attestor(attestor, required)?;
        let oracle = &ctx.accounts.oracle;
        if oracle.required && (!required || attestor != oracle.attestor) {
            check_attestor(oracle, &ctx.accounts.current_attestor)?;
        }
        let oracle = &mut ctx.accounts.oracle;
        oracle.attestor = attestor;
        oracle.required = required;
        Ok(())
    }

    pub fn open_vault(ctx: Context<OpenVault>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.authority = ctx.accounts.authority.key();
        vault.available = 0;
        vault.locked = 0;
        vault.bump = ctx.bumps.vault;
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, ErrorCode::InvalidAmount);
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                Transfer {
                    from: ctx.accounts.authority.to_account_info(),
                    to: ctx.accounts.config.to_account_info(),
                },
            ),
            amount,
        )?;
        let vault = &mut ctx.accounts.vault;
        vault.available = vault.available.checked_add(amount).ok_or(ErrorCode::Arithmetic)?;
        let config = &mut ctx.accounts.config;
        config.total_available = config
            .total_available
            .checked_add(amount)
            .ok_or(ErrorCode::Arithmetic)?;
        Ok(())
    }

    /// Only the free balance leaves; stakes in open rounds stay locked.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(
            amount > 0 && vault.available >= amount,
            ErrorCode::InsufficientAvailable
        );
        let rent_reserve = Rent::get()?.minimum_balance(8 + Config::INIT_SPACE);
        let config = &mut ctx.accounts.config;
        require!(
            config.get_lamports()
                >= rent_reserve.checked_add(amount).ok_or(ErrorCode::Arithmetic)?,
            ErrorCode::Insolvent
        );
        vault.available -= amount;
        config.total_available = config
            .total_available
            .checked_sub(amount)
            .ok_or(ErrorCode::Arithmetic)?;
        config.sub_lamports(amount)?;
        ctx.accounts.authority.add_lamports(amount)?;
        Ok(())
    }

    /// The owner grants a device key a budget for one-tap bets. Re-issuing resets the budget;
    /// only the owner can do it, the session key itself cannot.
    pub fn start_session(
        ctx: Context<StartSession>,
        expiry: i64,
        max_per_bet: u64,
        session_cap: u64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(
            expiry > now
                && expiry - now <= MAX_SESSION_SECS
                && max_per_bet > 0
                && session_cap > 0,
            ErrorCode::InvalidSession
        );
        let session = &mut ctx.accounts.session;
        session.authority = ctx.accounts.authority.key();
        session.vault = ctx.accounts.vault.key();
        session.signer = ctx.accounts.session_signer.key();
        session.expiry = expiry;
        session.max_per_bet = max_per_bet;
        session.session_cap = session_cap;
        session.spent = 0;
        session.revoked = false;
        session.bump = ctx.bumps.session;
        Ok(())
    }

    pub fn revoke_session(ctx: Context<RevokeSession>) -> Result<()> {
        ctx.accounts.session.revoked = true;
        Ok(())
    }

    pub fn create_round(ctx: Context<CreateRound>, round_id: u64, args: CreateRoundArgs) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let config = &mut ctx.accounts.config;
        require!(round_id == config.next_round_id, ErrorCode::InvalidRoundId);
        require!(
            args.opens_at < args.cutoff_at
                && args.cutoff_at <= args.strike_start
                && args.strike_start < args.strike_end
                && args.strike_end <= args.exit_start
                && args.exit_start < args.exit_end
                && args.exit_end <= args.settle_deadline
                && now < args.cutoff_at,
            ErrorCode::InvalidRoundTime
        );
        require!(args.max_bank > 0, ErrorCode::InvalidAmount);
        // A round that cannot be activated would hold a lone bet until it expires.
        require!(args.max_bank >= config.min_bank, ErrorCode::MaxBankBelowMin);
        // Saturating: an absurd timestamp saturates to a huge span and fails, it never wraps.
        require!(
            args.exit_end.saturating_sub(args.opens_at) <= MAX_ROUND_SECS,
            ErrorCode::RoundTooLong
        );
        require!(
            args.settle_deadline.saturating_sub(args.exit_end) <= MAX_SETTLE_GRACE_SECS,
            ErrorCode::SettleDeadlineTooFar
        );
        config.next_round_id = round_id.checked_add(1).ok_or(ErrorCode::Arithmetic)?;

        let round = &mut ctx.accounts.round;
        round.id = round_id;
        round.token_mint = args.token_mint;
        round.pool = args.pool;
        round.opens_at = args.opens_at;
        round.cutoff_at = args.cutoff_at;
        round.strike_start = args.strike_start;
        round.strike_end = args.strike_end;
        round.exit_start = args.exit_start;
        round.exit_end = args.exit_end;
        round.settle_deadline = args.settle_deadline;
        round.min_stake = config.min_stake;
        round.max_stake = config.max_stake;
        round.min_bank = config.min_bank;
        round.max_bank = args.max_bank;
        round.fee_win_bps = config.fee_win_bps;
        round.fee_refund_bps = config.fee_refund_bps;
        round.raw_up = 0;
        round.raw_down = 0;
        round.house_amount = 0;
        round.position_count = 0;
        round.claimed_count = 0;
        round.total_paid = 0;
        round.fees_swept = false;
        round.status = RoundStatus::Open;
        round.outcome = Outcome::Pending;
        round.refund_reason = RefundReason::None;
        round.strike_price = 0;
        round.exit_price = 0;
        round.strike_samples = 0;
        round.exit_samples = 0;
        round.bump = ctx.bumps.round;
        Ok(())
    }

    /// Signed by the session key, which pays only the network fee: the position's rent comes out of
    /// the owner's vault (open_position) and goes back into it when the position is closed. The
    /// session budget counts the stake alone.
    pub fn place_bet(ctx: Context<PlaceBet>, side: Side, amount: u64, face: [u8; 8]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let config = &mut ctx.accounts.config;
        let round = &mut ctx.accounts.round;
        let vault = &mut ctx.accounts.vault;
        let session = &mut ctx.accounts.session;
        require!(!config.paused, ErrorCode::Paused);
        require!(
            round.status == RoundStatus::Open && now >= round.opens_at && now < round.cutoff_at,
            ErrorCode::RoundNotOpen
        );
        require!(
            !session.revoked && now < session.expiry,
            ErrorCode::SessionInvalid
        );
        require!(
            amount >= round.min_stake && amount <= round.max_stake && amount <= session.max_per_bet,
            ErrorCode::InvalidAmount
        );
        let spent = session.spent.checked_add(amount).ok_or(ErrorCode::Arithmetic)?;
        require!(spent <= session.session_cap, ErrorCode::SessionCapExceeded);
        require!(
            vault.available >= amount.checked_add(position_rent()?).ok_or(ErrorCode::Arithmetic)?,
            ErrorCode::InsufficientAvailable
        );
        let (raw_up, raw_down) = add_to_side(round.raw_up, round.raw_down, side, amount)?;
        require!(
            within_depth(raw_up, raw_down, round.max_bank),
            ErrorCode::BankTooLargeForPool
        );

        lock_stake(vault, config, amount)?;
        session.spent = spent;
        round.raw_up = raw_up;
        round.raw_down = raw_down;
        round.position_count = round.position_count.checked_add(1).ok_or(ErrorCode::Arithmetic)?;

        let (round_key, authority, bump) = (round.key(), session.authority, ctx.bumps.position);
        let seeds: &[&[u8]] = &[b"position", round_key.as_ref(), authority.as_ref(), &[bump]];
        let position = Position {
            round: round_key,
            authority,
            side,
            stake: amount,
            face,
            is_house: false,
            claimed: false,
            payout: 0,
            bump,
        };
        open_position(&ctx.accounts.position, seeds, config, vault, &position)?;

        emit!(BetPlaced {
            round_id: round.id,
            authority: session.authority,
            side,
            amount,
            is_house: false,
        });
        Ok(())
    }

    /// After entry closes, the house may bring the smaller side up to the larger one, so a
    /// lone player still gets a matched round. It never takes the larger side. HouseLimits caps
    /// the house total in one round and the house spend per UTC day (stakes only). The house
    /// position's rent comes out of the house vault, like a player's.
    pub fn house_fill(ctx: Context<HouseFill>, amount: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let config = &mut ctx.accounts.config;
        let round = &mut ctx.accounts.round;
        let vault = &mut ctx.accounts.house_vault;
        let limits = &mut ctx.accounts.house_limits;
        require!(
            round.status == RoundStatus::Open && now >= round.cutoff_at && now < round.strike_start,
            ErrorCode::NotFillWindow
        );
        let (side, gap) = if round.raw_up < round.raw_down {
            (Side::Up, round.raw_down - round.raw_up)
        } else if round.raw_down < round.raw_up {
            (Side::Down, round.raw_up - round.raw_down)
        } else {
            return err!(ErrorCode::NothingToFill);
        };
        require!(amount > 0 && amount <= gap, ErrorCode::InvalidAmount);
        require!(
            vault.available >= amount.checked_add(position_rent()?).ok_or(ErrorCode::Arithmetic)?,
            ErrorCode::InsufficientAvailable
        );
        let (raw_up, raw_down) = add_to_side(round.raw_up, round.raw_down, side, amount)?;
        require!(
            within_depth(raw_up, raw_down, round.max_bank),
            ErrorCode::BankTooLargeForPool
        );
        // One house position per round and key, but a rotated house key could fill again: the
        // cap is on the round's house total.
        let house_amount = round.house_amount.checked_add(amount).ok_or(ErrorCode::Arithmetic)?;
        require!(house_amount <= limits.round_cap, ErrorCode::HouseRoundCapExceeded);
        let today = now.div_euclid(SECS_PER_DAY);
        if today > limits.day {
            limits.day = today;
            limits.spent = 0;
        }
        let spent = limits.spent.checked_add(amount).ok_or(ErrorCode::Arithmetic)?;
        require!(spent <= limits.daily_cap, ErrorCode::HouseDailyCapExceeded);

        lock_stake(vault, config, amount)?;
        limits.spent = spent;
        round.raw_up = raw_up;
        round.raw_down = raw_down;
        round.house_amount = house_amount;
        round.position_count = round.position_count.checked_add(1).ok_or(ErrorCode::Arithmetic)?;

        let (round_key, authority, bump) = (round.key(), ctx.accounts.house_authority.key(), ctx.bumps.position);
        let seeds: &[&[u8]] = &[b"position", round_key.as_ref(), authority.as_ref(), &[bump]];
        let position = Position {
            round: round_key,
            authority,
            side,
            stake: amount,
            face: [0; 8],
            is_house: true,
            claimed: false,
            payout: 0,
            bump,
        };
        open_position(&ctx.accounts.position, seeds, config, vault, &position)?;

        emit!(BetPlaced {
            round_id: round.id,
            authority: ctx.accounts.house_authority.key(),
            side,
            amount,
            is_house: true,
        });
        Ok(())
    }

    /// Fixes the strike from observations taken after the pause, from `strike_end` up to but not
    /// including `exit_start`: once the exit window has begun the exit price is on its way, so a
    /// strike fixed later could be chosen with it in view. A round whose strike is not set in time
    /// stays Open and ends through `refund_expired` after the settle deadline. A round without a
    /// matched bank ends here as NotActivated and returns every stake in full; no price is used
    /// for it, so it needs no attestor either, but it too must be closed in this window.
    pub fn set_strike(ctx: Context<PriceUpdate>, samples: Vec<PriceSample>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let round = &mut ctx.accounts.round;
        require!(
            round.status == RoundStatus::Open && now >= round.strike_end,
            ErrorCode::NotDue
        );
        require!(now < round.exit_start, ErrorCode::StrikeWindowClosed);
        if !payout::is_activated(round.raw_up, round.raw_down, round.min_bank) {
            finalize(round, Outcome::NotActivated, RefundReason::None);
            return Ok(());
        }
        check_attestor(&ctx.accounts.oracle, &ctx.accounts.attestor)?;
        let mean = mean_price(&samples)?;
        round.strike_samples = samples.len() as u8;
        match mean {
            None => finalize(round, Outcome::Refund, RefundReason::Unpriceable),
            Some(price) => {
                round.strike_price = price;
                round.status = RoundStatus::Live;
                emit!(StrikeSet {
                    round_id: round.id,
                    price,
                    samples: samples.len() as u8,
                });
            }
        }
        Ok(())
    }

    pub fn settle(ctx: Context<PriceUpdate>, samples: Vec<PriceSample>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let round = &mut ctx.accounts.round;
        require!(
            round.status == RoundStatus::Live
                && now >= round.exit_end
                && now <= round.settle_deadline,
            ErrorCode::NotDue
        );
        check_attestor(&ctx.accounts.oracle, &ctx.accounts.attestor)?;
        let mean = mean_price(&samples)?;
        round.exit_samples = samples.len() as u8;
        match mean {
            None => finalize(round, Outcome::Refund, RefundReason::Unpriceable),
            Some(price) => {
                round.exit_price = price;
                if price > round.strike_price {
                    finalize(round, Outcome::Up, RefundReason::None)
                } else if price < round.strike_price {
                    finalize(round, Outcome::Down, RefundReason::None)
                } else {
                    finalize(round, Outcome::Refund, RefundReason::Tie)
                }
            }
        }
        Ok(())
    }

    /// Anyone can end a round the keeper failed to price in time, whether its strike was never
    /// set (Open) or only its exit price is missing (Live). It never needs the attestor, so an
    /// attestor outage only delays a round into this refund. A matched round ends as Refund with
    /// reason Expired, and claim then takes the house's stake and shares it among the other
    /// positions (payout::claim_payout), so withholding a price is no free option for the house.
    pub fn refund_expired(ctx: Context<RefundExpired>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let round = &mut ctx.accounts.round;
        require!(
            round.status != RoundStatus::Final && now > round.settle_deadline,
            ErrorCode::NotDue
        );
        if payout::is_activated(round.raw_up, round.raw_down, round.min_bank) {
            finalize(round, Outcome::Refund, RefundReason::Expired);
        } else {
            finalize(round, Outcome::NotActivated, RefundReason::None);
        }
        Ok(())
    }

    /// Anyone may crank a claim; the money always lands in the position owner's vault.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let round = &mut ctx.accounts.round;
        let position = &mut ctx.accounts.position;
        require!(round.status == RoundStatus::Final, ErrorCode::NotFinal);
        require!(!position.claimed, ErrorCode::AlreadyClaimed);
        let amount = payout::claim_payout(
            round.raw_up,
            round.raw_down,
            round.house_amount,
            round.outcome,
            round.refund_reason,
            round.fee_win_bps,
            round.fee_refund_bps,
            position.side,
            position.stake,
            position.is_house,
        )
        .ok_or(ErrorCode::Arithmetic)?;
        let total_paid = round.total_paid.checked_add(amount).ok_or(ErrorCode::Arithmetic)?;
        let bank = round.raw_up.checked_add(round.raw_down).ok_or(ErrorCode::Arithmetic)?;
        require!(total_paid <= bank, ErrorCode::Insolvent);

        position.claimed = true;
        position.payout = amount;
        round.total_paid = total_paid;
        round.claimed_count = round.claimed_count.checked_add(1).ok_or(ErrorCode::Arithmetic)?;

        let vault = &mut ctx.accounts.vault;
        vault.locked = vault.locked.checked_sub(position.stake).ok_or(ErrorCode::Arithmetic)?;
        vault.available = vault.available.checked_add(amount).ok_or(ErrorCode::Arithmetic)?;
        let config = &mut ctx.accounts.config;
        config.total_locked = config
            .total_locked
            .checked_sub(position.stake)
            .ok_or(ErrorCode::Arithmetic)?;
        config.total_available = config
            .total_available
            .checked_add(amount)
            .ok_or(ErrorCode::Arithmetic)?;

        emit!(Claimed {
            round_id: round.id,
            authority: position.authority,
            payout: amount,
        });
        Ok(())
    }

    /// After every position is paid, the round's remainder (fee plus rounding dust) goes to
    /// the treasury. Unclaimed positions block it, so dust can never eat a player's claim.
    pub fn sweep_fees(ctx: Context<SweepFees>) -> Result<()> {
        let round = &mut ctx.accounts.round;
        require!(
            round.status == RoundStatus::Final
                && round.claimed_count == round.position_count
                && !round.fees_swept,
            ErrorCode::NotSweepable
        );
        let bank = round.raw_up.checked_add(round.raw_down).ok_or(ErrorCode::Arithmetic)?;
        let amount = bank.checked_sub(round.total_paid).ok_or(ErrorCode::Arithmetic)?;
        round.fees_swept = true;
        if amount > 0 {
            let rent_reserve = Rent::get()?.minimum_balance(8 + Config::INIT_SPACE);
            let config = &ctx.accounts.config;
            require!(
                config.get_lamports()
                    >= rent_reserve.checked_add(amount).ok_or(ErrorCode::Arithmetic)?,
                ErrorCode::Insolvent
            );
            config.sub_lamports(amount)?;
            ctx.accounts.treasury.add_lamports(amount)?;
        }
        Ok(())
    }

    /// Rounds nobody played are closed so the keeper's rent comes back.
    pub fn close_empty_round(ctx: Context<CloseEmptyRound>) -> Result<()> {
        let round = &ctx.accounts.round;
        require!(
            round.status == RoundStatus::Final && round.position_count == 0,
            ErrorCode::NotClosable
        );
        Ok(())
    }

    /// Anyone may close a paid position an hour after its round's exit window. Its lamports move
    /// to Config and count as available in the owner's vault; that holds for older positions too,
    /// whose rent a device key paid. Claim needs the account, and an unclaimed stake is still
    /// locked in the vault, so only claimed positions close. A Final round never opens again, so
    /// place_bet and house_fill cannot create the account anew and nothing can be claimed twice.
    pub fn close_position(ctx: Context<ClosePosition>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let round = &ctx.accounts.round;
        let position = &ctx.accounts.position;
        require!(round.status == RoundStatus::Final, ErrorCode::NotFinal);
        require!(position.claimed, ErrorCode::NotClaimed);
        require!(
            now.saturating_sub(round.exit_end) >= POSITION_CLOSE_DELAY_SECS,
            ErrorCode::NotDue
        );
        // `close = config` moves every lamport of the position, whoever put it there.
        let lamports = position.get_lamports();
        let vault = &mut ctx.accounts.vault;
        vault.available = vault.available.checked_add(lamports).ok_or(ErrorCode::Arithmetic)?;
        let config = &mut ctx.accounts.config;
        config.total_available = config
            .total_available
            .checked_add(lamports)
            .ok_or(ErrorCode::Arithmetic)?;
        emit!(PositionClosed {
            round_id: round.id,
            authority: position.authority,
            is_house: position.is_house,
            lamports,
        });
        Ok(())
    }
}

fn add_to_side(raw_up: u64, raw_down: u64, side: Side, amount: u64) -> Result<(u64, u64)> {
    Ok(match side {
        Side::Up => (raw_up.checked_add(amount).ok_or(ErrorCode::Arithmetic)?, raw_down),
        Side::Down => (raw_up, raw_down.checked_add(amount).ok_or(ErrorCode::Arithmetic)?),
    })
}

/// Depth rule: the accepted bank `2 * min(up, down)` may not exceed the pool-derived cap.
/// A bet on the larger side does not grow it and always passes.
fn within_depth(raw_up: u64, raw_down: u64, max_bank: u64) -> bool {
    (raw_up.min(raw_down) as u128) * 2 <= max_bank as u128
}

/// Rent-exempt minimum of a position account, at the cluster's current rent.
fn position_rent() -> Result<u64> {
    Ok(Rent::get()?.minimum_balance(8 + Position::INIT_SPACE))
}

/// Creates a position PDA owned by this program, its rent paid out of the owner's vault: the
/// lamports move from Config, which holds every deposited lamport, so session and house keys pay
/// network fees only. An address someone pre-funded takes only what it still lacks, and the vault
/// pays only that. An existing position makes allocate fail ("already in use"), as `init` did.
fn open_position<'info>(
    position: &UncheckedAccount<'info>,
    seeds: &[&[u8]],
    config: &mut Account<'info, Config>,
    vault: &mut Account<'info, Vault>,
    value: &Position,
) -> Result<()> {
    // The system calls come first: at a CPI the runtime balances only the accounts of that call,
    // so lamports moved by hand before it would show the position's credit without Config's debit.
    let info = position.to_account_info();
    let signer: &[&[&[u8]]] = &[seeds];
    system_program::allocate(
        CpiContext::new_with_signer(system_program::ID, Allocate { account_to_allocate: info.clone() }, signer),
        (8 + Position::INIT_SPACE) as u64,
    )?;
    system_program::assign(
        CpiContext::new_with_signer(system_program::ID, Assign { account_to_assign: info.clone() }, signer),
        &crate::ID,
    )?;
    let charge = position_rent()?.saturating_sub(info.lamports());
    if charge > 0 {
        vault.available = vault.available.checked_sub(charge).ok_or(ErrorCode::InsufficientAvailable)?;
        config.total_available = config
            .total_available
            .checked_sub(charge)
            .ok_or(ErrorCode::Arithmetic)?;
        let rent_reserve = Rent::get()?.minimum_balance(8 + Config::INIT_SPACE);
        require!(
            config.get_lamports()
                >= rent_reserve.checked_add(charge).ok_or(ErrorCode::Arithmetic)?,
            ErrorCode::Insolvent
        );
        config.sub_lamports(charge)?;
        info.add_lamports(charge)?;
    }
    let mut data = info.try_borrow_mut_data()?;
    value.try_serialize(&mut &mut data[..])?;
    Ok(())
}

fn lock_stake(vault: &mut Vault, config: &mut Config, amount: u64) -> Result<()> {
    vault.available = vault.available.checked_sub(amount).ok_or(ErrorCode::Arithmetic)?;
    vault.locked = vault.locked.checked_add(amount).ok_or(ErrorCode::Arithmetic)?;
    config.total_available = config
        .total_available
        .checked_sub(amount)
        .ok_or(ErrorCode::Arithmetic)?;
    config.total_locked = config.total_locked.checked_add(amount).ok_or(ErrorCode::Arithmetic)?;
    Ok(())
}

/// Integer mean of the window. `None` when the window holds too few observations.
fn mean_price(samples: &[PriceSample]) -> Result<Option<u64>> {
    require!(samples.len() <= MAX_SAMPLES, ErrorCode::InvalidSamples);
    for pair in samples.windows(2) {
        require!(pair[0].slot < pair[1].slot, ErrorCode::InvalidSamples);
    }
    require!(samples.iter().all(|s| s.price > 0), ErrorCode::InvalidSamples);
    if samples.len() < MIN_SAMPLES {
        return Ok(None);
    }
    let sum: u128 = samples.iter().map(|s| s.price as u128).sum();
    Ok(Some((sum / samples.len() as u128) as u64))
}

/// While the oracle requires it, the configured attestor must be among the signers: for a price,
/// and for a change that weakens the oracle (Anchor already rejects an account that did not sign).
fn check_attestor(oracle: &OracleConfig, attestor: &Option<Signer>) -> Result<()> {
    if !oracle.required {
        return Ok(());
    }
    let attestor = attestor.as_ref().ok_or(ErrorCode::AttestorRequired)?;
    require_keys_eq!(attestor.key(), oracle.attestor, ErrorCode::InvalidAttestor);
    Ok(())
}

/// A required attestor must be a key that can sign: not the default key, and not the program id,
/// which stands for "no account" in the optional attestor slot.
fn validate_attestor(attestor: Pubkey, required: bool) -> Result<()> {
    require!(
        !required || (attestor != Pubkey::default() && attestor != crate::ID),
        ErrorCode::InvalidAttestor
    );
    Ok(())
}

fn finalize(round: &mut Round, outcome: Outcome, refund_reason: RefundReason) {
    round.status = RoundStatus::Final;
    round.outcome = outcome;
    round.refund_reason = refund_reason;
    emit!(RoundSettled {
        round_id: round.id,
        outcome,
        refund_reason,
        strike_price: round.strike_price,
        exit_price: round.exit_price,
    });
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ConfigParams {
    pub price_authority: Pubkey,
    pub house_authority: Pubkey,
    pub treasury: Pubkey,
    pub min_stake: u64,
    pub max_stake: u64,
    pub min_bank: u64,
    pub fee_win_bps: u16,
    pub fee_refund_bps: u16,
}

impl ConfigParams {
    fn validate(&self) -> Result<()> {
        require!(
            self.fee_win_bps <= MAX_FEE_WIN_BPS && self.fee_refund_bps <= MAX_FEE_REFUND_BPS,
            ErrorCode::FeeTooHigh
        );
        require!(
            self.min_stake > 0 && self.max_stake >= self.min_stake && self.min_bank > 0,
            ErrorCode::InvalidAmount
        );
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreateRoundArgs {
    pub token_mint: Pubkey,
    pub pool: Pubkey,
    pub opens_at: i64,
    pub cutoff_at: i64,
    pub strike_start: i64,
    pub strike_end: i64,
    pub exit_start: i64,
    pub exit_end: i64,
    pub settle_deadline: i64,
    pub max_bank: u64,
}

/// One observation of the mainnet pool: the slot it was read at and the integer price.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct PriceSample {
    pub slot: u64,
    pub price: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Side {
    Up,
    Down,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum RoundStatus {
    /// Entry open until `cutoff_at`, then waiting for the strike (set from `strike_end` until
    /// `exit_start`; unset by then, the round expires).
    Open,
    /// Strike fixed, waiting for the exit window.
    Live,
    Final,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Outcome {
    Pending,
    Up,
    Down,
    /// Activated round returned minus `fee_refund_bps` (tie, no price, expired). When it expired,
    /// the house position forfeits its stake to the other positions (payout::claim_payout).
    Refund,
    /// No matched bank: every stake returns in full.
    NotActivated,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum RefundReason {
    None,
    Tie,
    Unpriceable,
    Expired,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub price_authority: Pubkey,
    pub house_authority: Pubkey,
    pub treasury: Pubkey,
    pub paused: bool,
    pub next_round_id: u64,
    pub min_stake: u64,
    pub max_stake: u64,
    pub min_bank: u64,
    pub fee_win_bps: u16,
    pub fee_refund_bps: u16,
    pub total_available: u64,
    pub total_locked: u64,
    pub bump: u8,
}

impl Config {
    fn apply(&mut self, params: &ConfigParams) {
        self.price_authority = params.price_authority;
        self.house_authority = params.house_authority;
        self.treasury = params.treasury;
        self.min_stake = params.min_stake;
        self.max_stake = params.max_stake;
        self.min_bank = params.min_bank;
        self.fee_win_bps = params.fee_win_bps;
        self.fee_refund_bps = params.fee_refund_bps;
    }
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub authority: Pubkey,
    pub available: u64,
    pub locked: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Session {
    pub authority: Pubkey,
    pub vault: Pubkey,
    pub signer: Pubkey,
    pub expiry: i64,
    pub max_per_bet: u64,
    pub session_cap: u64,
    pub spent: u64,
    pub revoked: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Round {
    pub id: u64,
    pub token_mint: Pubkey,
    pub pool: Pubkey,
    pub opens_at: i64,
    pub cutoff_at: i64,
    pub strike_start: i64,
    pub strike_end: i64,
    pub exit_start: i64,
    pub exit_end: i64,
    pub settle_deadline: i64,
    pub min_stake: u64,
    pub max_stake: u64,
    pub min_bank: u64,
    pub max_bank: u64,
    pub fee_win_bps: u16,
    pub fee_refund_bps: u16,
    pub raw_up: u64,
    pub raw_down: u64,
    pub house_amount: u64,
    pub position_count: u32,
    pub claimed_count: u32,
    pub total_paid: u64,
    pub fees_swept: bool,
    pub status: RoundStatus,
    pub outcome: Outcome,
    pub refund_reason: RefundReason,
    pub strike_price: u64,
    pub exit_price: u64,
    pub strike_samples: u8,
    pub exit_samples: u8,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub round: Pubkey,
    pub authority: Pubkey,
    pub side: Side,
    pub stake: u64,
    /// Pixel-face settings chosen in the app; cosmetic only.
    pub face: [u8; 8],
    pub is_house: bool,
    pub claimed: bool,
    pub payout: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct HouseLimits {
    /// Most the house may put into one round, over all its fills.
    pub round_cap: u64,
    /// Most the house may put into rounds per UTC day.
    pub daily_cap: u64,
    /// `unix_timestamp / SECS_PER_DAY` of the day `spent` belongs to.
    pub day: i64,
    pub spent: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct OracleConfig {
    /// Second signer of set_strike and settle while `required` is true.
    pub attestor: Pubkey,
    pub required: bool,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin @ ErrorCode::Unauthorized)]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct InitHouseLimits<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin @ ErrorCode::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(init, payer = admin, space = 8 + HouseLimits::INIT_SPACE, seeds = [b"house_limits"], bump)]
    pub house_limits: Account<'info, HouseLimits>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateHouseLimits<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin @ ErrorCode::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"house_limits"], bump = house_limits.bump)]
    pub house_limits: Account<'info, HouseLimits>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct InitOracle<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin @ ErrorCode::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(init, payer = admin, space = 8 + OracleConfig::INIT_SPACE, seeds = [b"oracle"], bump)]
    pub oracle: Account<'info, OracleConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetOracle<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin @ ErrorCode::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"oracle"], bump = oracle.bump)]
    pub oracle: Account<'info, OracleConfig>,
    pub admin: Signer<'info>,
    /// The attestor in office, co-signing a change that weakens a required oracle; otherwise the
    /// program id stands in this slot.
    pub current_attestor: Option<Signer<'info>>,
}

#[derive(Accounts)]
pub struct OpenVault<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(init, payer = authority, space = 8 + Vault::INIT_SPACE, seeds = [b"vault", authority.key().as_ref()], bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"vault", authority.key().as_ref()], bump = vault.bump, has_one = authority @ ErrorCode::Unauthorized)]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"vault", authority.key().as_ref()], bump = vault.bump, has_one = authority @ ErrorCode::Unauthorized)]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct StartSession<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [b"vault", authority.key().as_ref()], bump = vault.bump, has_one = authority @ ErrorCode::Unauthorized)]
    pub vault: Account<'info, Vault>,
    #[account(init_if_needed, payer = authority, space = 8 + Session::INIT_SPACE, seeds = [b"session", vault.key().as_ref(), session_signer.key().as_ref()], bump)]
    pub session: Account<'info, Session>,
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: only its address is stored; it has to sign every bet made under the session.
    pub session_signer: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevokeSession<'info> {
    #[account(seeds = [b"vault", authority.key().as_ref()], bump = vault.bump, has_one = authority @ ErrorCode::Unauthorized)]
    pub vault: Account<'info, Vault>,
    #[account(mut, seeds = [b"session", vault.key().as_ref(), session.signer.as_ref()], bump = session.bump, has_one = authority @ ErrorCode::Unauthorized)]
    pub session: Account<'info, Session>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct CreateRound<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin @ ErrorCode::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(init, payer = admin, space = 8 + Round::INIT_SPACE, seeds = [b"round", round_id.to_le_bytes().as_ref()], bump)]
    pub round: Account<'info, Round>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PlaceBet<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"round", round.id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,
    #[account(mut, seeds = [b"vault", session.authority.as_ref()], bump = vault.bump, constraint = vault.key() == session.vault @ ErrorCode::SessionInvalid)]
    pub vault: Account<'info, Vault>,
    #[account(mut, seeds = [b"session", vault.key().as_ref(), session_signer.key().as_ref()], bump = session.bump, constraint = session.signer == session_signer.key() @ ErrorCode::SessionInvalid)]
    pub session: Account<'info, Session>,
    /// CHECK: the position PDA of this round and the session's owner, created by the handler
    /// (open_position) with its rent taken from the vault.
    #[account(mut, seeds = [b"position", round.key().as_ref(), session.authority.as_ref()], bump)]
    pub position: UncheckedAccount<'info>,
    /// Pays the network fee only. Still writable, so apps built before keep sending the same accounts.
    #[account(mut)]
    pub session_signer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct HouseFill<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = house_authority @ ErrorCode::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"round", round.id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,
    #[account(mut, seeds = [b"vault", house_authority.key().as_ref()], bump = house_vault.bump)]
    pub house_vault: Account<'info, Vault>,
    #[account(mut, seeds = [b"house_limits"], bump = house_limits.bump)]
    pub house_limits: Account<'info, HouseLimits>,
    /// CHECK: the position PDA of this round and the house authority, created by the handler
    /// (open_position) with its rent taken from the house vault.
    #[account(mut, seeds = [b"position", round.key().as_ref(), house_authority.key().as_ref()], bump)]
    pub position: UncheckedAccount<'info>,
    /// Signs the fill and pays nothing now. Still writable, so the account list stays as it was.
    #[account(mut)]
    pub house_authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PriceUpdate<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = price_authority @ ErrorCode::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"round", round.id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,
    pub price_authority: Signer<'info>,
    #[account(seeds = [b"oracle"], bump = oracle.bump)]
    pub oracle: Account<'info, OracleConfig>,
    /// Second signer while `oracle.required`; without it the program id stands in this slot.
    pub attestor: Option<Signer<'info>>,
}

#[derive(Accounts)]
pub struct RefundExpired<'info> {
    #[account(mut, seeds = [b"round", round.id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"round", round.id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,
    #[account(mut, seeds = [b"position", round.key().as_ref(), position.authority.as_ref()], bump = position.bump, has_one = round @ ErrorCode::InvalidAccount)]
    pub position: Account<'info, Position>,
    #[account(mut, seeds = [b"vault", position.authority.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
}

#[derive(Accounts)]
pub struct SweepFees<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = treasury @ ErrorCode::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"round", round.id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,
    /// CHECK: receives lamports only; its address is pinned by `config.treasury`.
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CloseEmptyRound<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin @ ErrorCode::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut, close = admin, seeds = [b"round", round.id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,
    /// CHECK: receives the rent back; its address is pinned by `config.admin`.
    #[account(mut)]
    pub admin: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ClosePosition<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [b"round", round.id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,
    #[account(
        mut,
        close = config,
        seeds = [b"position", round.key().as_ref(), position.authority.as_ref()],
        bump = position.bump,
        has_one = round @ ErrorCode::InvalidAccount,
    )]
    pub position: Account<'info, Position>,
    /// The owner's vault: the rent comes back into its available balance.
    #[account(mut, seeds = [b"vault", position.authority.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
}

#[event]
pub struct BetPlaced {
    pub round_id: u64,
    pub authority: Pubkey,
    pub side: Side,
    pub amount: u64,
    pub is_house: bool,
}

#[event]
pub struct StrikeSet {
    pub round_id: u64,
    pub price: u64,
    pub samples: u8,
}

#[event]
pub struct RoundSettled {
    pub round_id: u64,
    pub outcome: Outcome,
    pub refund_reason: RefundReason,
    pub strike_price: u64,
    pub exit_price: u64,
}

#[event]
pub struct Claimed {
    pub round_id: u64,
    pub authority: Pubkey,
    pub payout: u64,
}

#[event]
pub struct PositionClosed {
    pub round_id: u64,
    pub authority: Pubkey,
    pub is_house: bool,
    /// Rent returned to `authority`.
    pub lamports: u64,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Amount is invalid")]
    InvalidAmount,
    #[msg("Arithmetic overflow or underflow")]
    Arithmetic,
    #[msg("Available balance is insufficient")]
    InsufficientAvailable,
    #[msg("Session is invalid, expired, or revoked")]
    SessionInvalid,
    #[msg("Session spending cap exceeded")]
    SessionCapExceeded,
    #[msg("Session parameters are invalid")]
    InvalidSession,
    #[msg("Round is not accepting bets")]
    RoundNotOpen,
    #[msg("Round times are invalid")]
    InvalidRoundTime,
    #[msg("Round id must equal config.next_round_id")]
    InvalidRoundId,
    #[msg("This step is not due yet or is already past")]
    NotDue,
    #[msg("Round is not final")]
    NotFinal,
    #[msg("Position was already claimed")]
    AlreadyClaimed,
    #[msg("Fee exceeds the hard cap")]
    FeeTooHigh,
    #[msg("Accepted bank would exceed the pool-depth cap")]
    BankTooLargeForPool,
    #[msg("Price samples are malformed")]
    InvalidSamples,
    #[msg("New bets are paused")]
    Paused,
    #[msg("Signer is not authorized for this action")]
    Unauthorized,
    #[msg("Account does not belong to this round")]
    InvalidAccount,
    #[msg("House fill is only allowed between cutoff and strike")]
    NotFillWindow,
    #[msg("Both sides are already equal")]
    NothingToFill,
    #[msg("Fees can be swept only once, after every position is claimed")]
    NotSweepable,
    #[msg("Only final rounds without positions can be closed")]
    NotClosable,
    #[msg("Config would not cover its obligations")]
    Insolvent,
    // Added in the October 2026 upgrade. The app maps codes by position: append only.
    #[msg("Only claimed positions can be closed")]
    NotClaimed,
    #[msg("House fill would exceed the house cap for one round")]
    HouseRoundCapExceeded,
    #[msg("House fill would exceed the house cap for the UTC day")]
    HouseDailyCapExceeded,
    #[msg("This price needs the attestor's signature")]
    AttestorRequired,
    #[msg("Attestor does not match the oracle config")]
    InvalidAttestor,
    // Added with the strike-window and round-bounds fix (October 2026): append only.
    #[msg("The strike can no longer be set: the exit window has started")]
    StrikeWindowClosed,
    #[msg("Round runs too long from opening to the end of its exit window")]
    RoundTooLong,
    #[msg("The settle deadline is too far after the end of the exit window")]
    SettleDeadlineTooFar,
    #[msg("The round's bank cap is below the minimum bank")]
    MaxBankBelowMin,
}
