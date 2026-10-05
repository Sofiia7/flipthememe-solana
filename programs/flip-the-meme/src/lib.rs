use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

pub mod payout;

declare_id!("5kUCKYAYxZyaSz18xEajhSDNwdXvVLp2AvBp4LDxWuCz");

/// Fewer observations than this in a price window means the round cannot be priced.
pub const MIN_SAMPLES: usize = 5;
pub const MAX_SAMPLES: usize = 16;
/// Hard caps that no config update can exceed: 2% of the bank on a result, 1% on a refund.
pub const MAX_FEE_WIN_BPS: u16 = 200;
pub const MAX_FEE_REFUND_BPS: u16 = 100;
pub const MAX_SESSION_SECS: i64 = 7 * 24 * 60 * 60;

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

    /// Signed by the session key, which also pays for the position account.
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
        require!(vault.available >= amount, ErrorCode::InsufficientAvailable);
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

        let position = &mut ctx.accounts.position;
        position.round = round.key();
        position.authority = session.authority;
        position.side = side;
        position.stake = amount;
        position.face = face;
        position.is_house = false;
        position.claimed = false;
        position.payout = 0;
        position.bump = ctx.bumps.position;

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
    /// lone player still gets a matched round. It never takes the larger side.
    pub fn house_fill(ctx: Context<HouseFill>, amount: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let config = &mut ctx.accounts.config;
        let round = &mut ctx.accounts.round;
        let vault = &mut ctx.accounts.house_vault;
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
        require!(vault.available >= amount, ErrorCode::InsufficientAvailable);
        let (raw_up, raw_down) = add_to_side(round.raw_up, round.raw_down, side, amount)?;
        require!(
            within_depth(raw_up, raw_down, round.max_bank),
            ErrorCode::BankTooLargeForPool
        );

        lock_stake(vault, config, amount)?;
        round.raw_up = raw_up;
        round.raw_down = raw_down;
        round.house_amount = round.house_amount.checked_add(amount).ok_or(ErrorCode::Arithmetic)?;
        round.position_count = round.position_count.checked_add(1).ok_or(ErrorCode::Arithmetic)?;

        let position = &mut ctx.accounts.position;
        position.round = round.key();
        position.authority = ctx.accounts.house_authority.key();
        position.side = side;
        position.stake = amount;
        position.face = [0; 8];
        position.is_house = true;
        position.claimed = false;
        position.payout = 0;
        position.bump = ctx.bumps.position;

        emit!(BetPlaced {
            round_id: round.id,
            authority: ctx.accounts.house_authority.key(),
            side,
            amount,
            is_house: true,
        });
        Ok(())
    }

    /// Fixes the strike from observations taken after the pause. A round without a matched
    /// bank ends here as NotActivated and returns every stake in full.
    pub fn set_strike(ctx: Context<PriceUpdate>, samples: Vec<PriceSample>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let round = &mut ctx.accounts.round;
        require!(
            round.status == RoundStatus::Open
                && now >= round.strike_end
                && now <= round.settle_deadline,
            ErrorCode::NotDue
        );
        if !payout::is_activated(round.raw_up, round.raw_down, round.min_bank) {
            finalize(round, Outcome::NotActivated, RefundReason::None);
            return Ok(());
        }
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

    /// Anyone can end a round the keeper failed to price in time.
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
        let amount = payout::position_payout(
            round.raw_up,
            round.raw_down,
            round.outcome,
            round.fee_win_bps,
            round.fee_refund_bps,
            position.side,
            position.stake,
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
    /// Entry open until `cutoff_at`, then waiting for the strike.
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
    /// Activated round returned minus `fee_refund_bps` (tie, no price, expired).
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
    #[account(init, payer = session_signer, space = 8 + Position::INIT_SPACE, seeds = [b"position", round.key().as_ref(), session.authority.as_ref()], bump)]
    pub position: Account<'info, Position>,
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
    #[account(init, payer = house_authority, space = 8 + Position::INIT_SPACE, seeds = [b"position", round.key().as_ref(), house_authority.key().as_ref()], bump)]
    pub position: Account<'info, Position>,
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
}
