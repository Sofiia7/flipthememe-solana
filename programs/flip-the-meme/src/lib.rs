use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

const BPS_DENOMINATOR: u128 = 10_000;
const MAX_FEE_BPS: u16 = 100;

#[program]
pub mod flip_the_meme {
    use super::*;

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        price_authority: Pubkey,
        treasury_authority: Pubkey,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.price_authority = price_authority;
        config.treasury_authority = treasury_authority;
        config.paused = false;
        config.mock_only = true;
        config.total_available = 0;
        config.total_locked = 0;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn set_pause(ctx: Context<SetPause>, paused: bool) -> Result<()> {
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
        require!(!ctx.accounts.config.mock_only, ErrorCode::MockOnly);
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
        ctx.accounts.vault.available = ctx
            .accounts
            .vault
            .available
            .checked_add(amount)
            .ok_or(ErrorCode::Arithmetic)?;
        ctx.accounts.config.total_available = ctx
            .accounts
            .config
            .total_available
            .checked_add(amount)
            .ok_or(ErrorCode::Arithmetic)?;
        Ok(())
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require!(
            amount > 0 && ctx.accounts.vault.available >= amount,
            ErrorCode::InsufficientAvailable
        );
        let rent_reserve = Rent::get()?.minimum_balance(8 + Config::INIT_SPACE);
        require!(
            ctx.accounts.config.get_lamports()
                >= rent_reserve
                    .checked_add(amount)
                    .ok_or(ErrorCode::Arithmetic)?,
            ErrorCode::RentReserve
        );
        ctx.accounts.vault.available = ctx
            .accounts
            .vault
            .available
            .checked_sub(amount)
            .ok_or(ErrorCode::Arithmetic)?;
        ctx.accounts.config.total_available = ctx
            .accounts
            .config
            .total_available
            .checked_sub(amount)
            .ok_or(ErrorCode::Arithmetic)?;
        ctx.accounts.config.sub_lamports(amount)?;
        ctx.accounts.authority.add_lamports(amount)?;
        Ok(())
    }

    pub fn start_session(
        ctx: Context<StartSession>,
        expiry: i64,
        max_per_bet: u64,
        session_cap: u64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(
            expiry > now && max_per_bet > 0 && session_cap > 0,
            ErrorCode::InvalidSession
        );
        let session = &mut ctx.accounts.session;
        if session.authority != Pubkey::default() {
            require!(
                session.authority == ctx.accounts.authority.key()
                    && (session.revoked || now >= session.expiry),
                ErrorCode::SessionStillActive
            );
        }
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

    pub fn create_round(
        ctx: Context<CreateRound>,
        round_id: u64,
        args: CreateRoundArgs,
    ) -> Result<()> {
        let _ = round_id;
        require!(!ctx.accounts.config.mock_only, ErrorCode::MockOnly);
        require!(
            args.fee_bps <= MAX_FEE_BPS && args.max_pool > 0,
            ErrorCode::FeeTooHigh
        );
        require!(
            args.opens_at < args.cutoff_at
                && args.cutoff_at <= args.starts_at
                && args.starts_at < args.ends_at
                && args.ends_at <= args.settlement_deadline_at,
            ErrorCode::InvalidRoundTime
        );
        let round = &mut ctx.accounts.round;
        round.config = ctx.accounts.config.key();
        round.token_mint = args.token_mint;
        round.pool = args.pool;
        round.opens_at = args.opens_at;
        round.cutoff_at = args.cutoff_at;
        round.starts_at = args.starts_at;
        round.ends_at = args.ends_at;
        round.settlement_deadline_at = args.settlement_deadline_at;
        round.fee_bps = args.fee_bps;
        round.tie_tolerance_bps = args.tie_tolerance_bps;
        round.max_pool = args.max_pool;
        round.up_pool = 0;
        round.down_pool = 0;
        round.fee = 0;
        round.start_price = 0;
        round.end_price = 0;
        round.position_count = 0;
        round.claimed_position_count = 0;
        round.total_payout = 0;
        round.fees_withdrawn = false;
        round.status = RoundStatus::Scheduled;
        round.outcome = Outcome::Unset;
        round.bump = ctx.bumps.round;
        Ok(())
    }

    pub fn open_round(ctx: Context<ManageRound>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(
            now >= ctx.accounts.round.opens_at && now < ctx.accounts.round.cutoff_at,
            ErrorCode::InvalidRoundTime
        );
        require!(
            ctx.accounts.round.status == RoundStatus::Scheduled,
            ErrorCode::InvalidTransition
        );
        ctx.accounts.round.status = RoundStatus::Open;
        Ok(())
    }

    pub fn place_bet(ctx: Context<PlaceBet>, side: Side, amount: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let round = &mut ctx.accounts.round;
        let vault = &mut ctx.accounts.vault;
        let session = &mut ctx.accounts.session;
        require!(!ctx.accounts.config.paused, ErrorCode::Paused);
        require!(
            round.status == RoundStatus::Open && now < round.cutoff_at,
            ErrorCode::RoundNotOpen
        );
        require!(
            session.signer == ctx.accounts.session_signer.key()
                && !session.revoked
                && now < session.expiry,
            ErrorCode::SessionInvalid
        );
        require!(
            amount > 0 && amount <= session.max_per_bet,
            ErrorCode::InvalidAmount
        );
        require!(
            session
                .spent
                .checked_add(amount)
                .ok_or(ErrorCode::Arithmetic)?
                <= session.session_cap,
            ErrorCode::SessionCapExceeded
        );
        require!(vault.available >= amount, ErrorCode::InsufficientAvailable);
        require!(
            round
                .up_pool
                .checked_add(round.down_pool)
                .and_then(|v| v.checked_add(amount))
                .ok_or(ErrorCode::Arithmetic)?
                <= round.max_pool,
            ErrorCode::PoolCapReached
        );
        vault.available = vault
            .available
            .checked_sub(amount)
            .ok_or(ErrorCode::Arithmetic)?;
        vault.locked = vault
            .locked
            .checked_add(amount)
            .ok_or(ErrorCode::Arithmetic)?;
        ctx.accounts.config.total_available = ctx
            .accounts
            .config
            .total_available
            .checked_sub(amount)
            .ok_or(ErrorCode::Arithmetic)?;
        ctx.accounts.config.total_locked = ctx
            .accounts
            .config
            .total_locked
            .checked_add(amount)
            .ok_or(ErrorCode::Arithmetic)?;
        session.spent = session
            .spent
            .checked_add(amount)
            .ok_or(ErrorCode::Arithmetic)?;
        match side {
            Side::Up => {
                round.up_pool = round
                    .up_pool
                    .checked_add(amount)
                    .ok_or(ErrorCode::Arithmetic)?
            }
            Side::Down => {
                round.down_pool = round
                    .down_pool
                    .checked_add(amount)
                    .ok_or(ErrorCode::Arithmetic)?
            }
        }
        let position = &mut ctx.accounts.position;
        position.round = round.key();
        position.authority = vault.authority;
        position.side = side;
        position.amount = amount;
        position.claimed = false;
        position.bump = ctx.bumps.position;
        round.position_count = round
            .position_count
            .checked_add(1)
            .ok_or(ErrorCode::Arithmetic)?;
        Ok(())
    }

    pub fn lock_round(ctx: Context<ManageRound>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(
            ctx.accounts.round.status == RoundStatus::Open && now >= ctx.accounts.round.cutoff_at,
            ErrorCode::InvalidRoundTime
        );
        ctx.accounts.round.status = RoundStatus::Locked;
        Ok(())
    }

    pub fn activate_round(ctx: Context<ManageRound>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(
            ctx.accounts.round.status == RoundStatus::Locked && now >= ctx.accounts.round.starts_at,
            ErrorCode::InvalidRoundTime
        );
        ctx.accounts.round.status = RoundStatus::Active;
        Ok(())
    }

    pub fn settle_round(ctx: Context<SettleRound>, start_price: u64, end_price: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let round = &mut ctx.accounts.round;
        require!(
            round.status == RoundStatus::Active
                && now >= round.ends_at
                && now <= round.settlement_deadline_at,
            ErrorCode::NotSettleable
        );
        require!(start_price > 0 && end_price > 0, ErrorCode::InvalidPrice);
        round.start_price = start_price;
        round.end_price = end_price;
        let change_bps = ((end_price as i128 - start_price as i128) * BPS_DENOMINATOR as i128)
            / start_price as i128;
        if change_bps.unsigned_abs() <= round.tie_tolerance_bps as u128
            || round.up_pool == 0
            || round.down_pool == 0
        {
            round.status = RoundStatus::Refundable;
            round.outcome = Outcome::Refund;
            return Ok(());
        }
        let (winner, loser_pool) = if change_bps > 0 {
            (Outcome::Up, round.down_pool)
        } else {
            (Outcome::Down, round.up_pool)
        };
        round.fee = ((loser_pool as u128 * round.fee_bps as u128) / BPS_DENOMINATOR) as u64;
        round.outcome = winner;
        round.status = if winner == Outcome::Up {
            RoundStatus::SettledUp
        } else {
            RoundStatus::SettledDown
        };
        Ok(())
    }

    pub fn make_refundable(ctx: Context<MakeRefundable>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(
            now >= ctx.accounts.round.settlement_deadline_at,
            ErrorCode::RefundTooEarly
        );
        require!(
            !ctx.accounts.round.status.is_terminal(),
            ErrorCode::AlreadyFinal
        );
        ctx.accounts.round.status = RoundStatus::Refundable;
        ctx.accounts.round.outcome = Outcome::Refund;
        Ok(())
    }

    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let round = &ctx.accounts.round;
        let position = &mut ctx.accounts.position;
        let vault = &mut ctx.accounts.vault;
        require!(round.status.is_terminal(), ErrorCode::NotFinal);
        require!(!position.claimed, ErrorCode::AlreadyClaimed);
        let payout = payout_for(round, position)?;
        position.claimed = true;
        vault.locked = vault
            .locked
            .checked_sub(position.amount)
            .ok_or(ErrorCode::Arithmetic)?;
        vault.available = vault
            .available
            .checked_add(payout)
            .ok_or(ErrorCode::Arithmetic)?;
        let config = &mut ctx.accounts.config;
        config.total_locked = config
            .total_locked
            .checked_sub(position.amount)
            .ok_or(ErrorCode::Arithmetic)?;
        config.total_available = config
            .total_available
            .checked_add(payout)
            .ok_or(ErrorCode::Arithmetic)?;
        let round = &mut ctx.accounts.round;
        round.claimed_position_count = round
            .claimed_position_count
            .checked_add(1)
            .ok_or(ErrorCode::Arithmetic)?;
        round.total_payout = round
            .total_payout
            .checked_add(payout)
            .ok_or(ErrorCode::Arithmetic)?;
        Ok(())
    }

    pub fn withdraw_round_fees(ctx: Context<WithdrawRoundFees>) -> Result<()> {
        let round = &mut ctx.accounts.round;
        require!(round.status.is_terminal(), ErrorCode::NotFinal);
        require!(
            round.claimed_position_count == round.position_count,
            ErrorCode::ClaimsOutstanding
        );
        require!(!round.fees_withdrawn, ErrorCode::FeesAlreadyWithdrawn);
        let total_pool = round
            .up_pool
            .checked_add(round.down_pool)
            .ok_or(ErrorCode::Arithmetic)?;
        let amount = total_pool
            .checked_sub(round.total_payout)
            .ok_or(ErrorCode::Arithmetic)?;
        let rent_reserve = Rent::get()?.minimum_balance(8 + Config::INIT_SPACE);
        let liabilities = ctx
            .accounts
            .config
            .total_available
            .checked_add(ctx.accounts.config.total_locked)
            .ok_or(ErrorCode::Arithmetic)?;
        let required = rent_reserve
            .checked_add(liabilities)
            .and_then(|v| v.checked_add(amount))
            .ok_or(ErrorCode::Arithmetic)?;
        require!(
            ctx.accounts.config.get_lamports() >= required,
            ErrorCode::Insolvent
        );
        round.fees_withdrawn = true;
        ctx.accounts.config.sub_lamports(amount)?;
        ctx.accounts.treasury.add_lamports(amount)?;
        Ok(())
    }
}

fn payout_for(round: &Round, position: &Position) -> Result<u64> {
    if round.outcome == Outcome::Refund {
        return Ok(position.amount);
    }
    if (round.outcome == Outcome::Up && position.side != Side::Up)
        || (round.outcome == Outcome::Down && position.side != Side::Down)
    {
        return Ok(0);
    }
    let (winner_pool, loser_pool) = if round.outcome == Outcome::Up {
        (round.up_pool, round.down_pool)
    } else {
        (round.down_pool, round.up_pool)
    };
    let prize = loser_pool
        .checked_sub(round.fee)
        .ok_or(ErrorCode::Arithmetic)?;
    let share = ((prize as u128)
        .checked_mul(position.amount as u128)
        .ok_or(ErrorCode::Arithmetic)?
        / winner_pool as u128) as u64;
    position
        .amount
        .checked_add(share)
        .ok_or(ErrorCode::Arithmetic.into())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreateRoundArgs {
    pub token_mint: Pubkey,
    pub pool: Pubkey,
    pub opens_at: i64,
    pub cutoff_at: i64,
    pub starts_at: i64,
    pub ends_at: i64,
    pub settlement_deadline_at: i64,
    pub fee_bps: u16,
    pub tie_tolerance_bps: u16,
    pub max_pool: u64,
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum Side {
    Up,
    Down,
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum RoundStatus {
    Scheduled,
    Open,
    Locked,
    Active,
    SettledUp,
    SettledDown,
    Refundable,
}
impl RoundStatus {
    fn is_terminal(&self) -> bool {
        matches!(self, Self::SettledUp | Self::SettledDown | Self::Refundable)
    }
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum Outcome {
    Unset,
    Up,
    Down,
    Refund,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub price_authority: Pubkey,
    pub treasury_authority: Pubkey,
    pub paused: bool,
    pub mock_only: bool,
    pub total_available: u64,
    pub total_locked: u64,
    pub bump: u8,
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
    pub config: Pubkey,
    pub token_mint: Pubkey,
    pub pool: Pubkey,
    pub opens_at: i64,
    pub cutoff_at: i64,
    pub starts_at: i64,
    pub ends_at: i64,
    pub settlement_deadline_at: i64,
    pub fee_bps: u16,
    pub tie_tolerance_bps: u16,
    pub max_pool: u64,
    pub up_pool: u64,
    pub down_pool: u64,
    pub fee: u64,
    pub start_price: u64,
    pub end_price: u64,
    pub position_count: u64,
    pub claimed_position_count: u64,
    pub total_payout: u64,
    pub fees_withdrawn: bool,
    pub status: RoundStatus,
    pub outcome: Outcome,
    pub bump: u8,
}
#[account]
#[derive(InitSpace)]
pub struct Position {
    pub round: Pubkey,
    pub authority: Pubkey,
    pub side: Side,
    pub amount: u64,
    pub claimed: bool,
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
pub struct SetPause<'info> {
    #[account(mut, has_one = admin)]
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
    #[account(mut, seeds = [b"vault", authority.key().as_ref()], bump = vault.bump, has_one = authority)]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"vault", authority.key().as_ref()], bump = vault.bump, has_one = authority)]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub authority: Signer<'info>,
}
#[derive(Accounts)]
pub struct StartSession<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [b"vault", authority.key().as_ref()], bump = vault.bump, has_one = authority)]
    pub vault: Account<'info, Vault>,
    #[account(init_if_needed, payer = authority, space = 8 + Session::INIT_SPACE, seeds = [b"session", vault.key().as_ref(), session_signer.key().as_ref()], bump)]
    pub session: Account<'info, Session>,
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: key is stored and must sign future bet calls
    pub session_signer: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct RevokeSession<'info> {
    #[account(seeds = [b"vault", authority.key().as_ref()], bump = vault.bump, has_one = authority)]
    pub vault: Account<'info, Vault>,
    #[account(mut, seeds = [b"session", vault.key().as_ref(), session.signer.as_ref()], bump = session.bump, has_one = authority)]
    pub session: Account<'info, Session>,
    pub authority: Signer<'info>,
}
#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct CreateRound<'info> {
    #[account(has_one = admin)]
    pub config: Account<'info, Config>,
    #[account(init, payer = admin, space = 8 + Round::INIT_SPACE, seeds = [b"round".as_ref(), &round_id.to_le_bytes()], bump)]
    pub round: Account<'info, Round>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct ManageRound<'info> {
    #[account(has_one = admin)]
    pub config: Account<'info, Config>,
    #[account(mut, has_one = config)]
    pub round: Account<'info, Round>,
    pub admin: Signer<'info>,
}
#[derive(Accounts)]
pub struct PlaceBet<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, has_one = config)]
    pub round: Account<'info, Round>,
    #[account(mut, seeds = [b"vault", session.authority.as_ref()], bump = vault.bump, constraint = vault.key() == session.vault @ ErrorCode::SessionInvalid)]
    pub vault: Account<'info, Vault>,
    #[account(mut, seeds = [b"session", vault.key().as_ref(), session_signer.key().as_ref()], bump = session.bump, constraint = session.vault == vault.key() @ ErrorCode::SessionInvalid)]
    pub session: Account<'info, Session>,
    #[account(init, payer = payer, space = 8 + Position::INIT_SPACE, seeds = [b"position", round.key().as_ref(), session.authority.as_ref()], bump)]
    pub position: Account<'info, Position>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub session_signer: Signer<'info>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct SettleRound<'info> {
    #[account(has_one = price_authority)]
    pub config: Account<'info, Config>,
    #[account(mut, has_one = config)]
    pub round: Account<'info, Round>,
    pub price_authority: Signer<'info>,
}
#[derive(Accounts)]
pub struct MakeRefundable<'info> {
    pub config: Account<'info, Config>,
    #[account(mut, has_one = config)]
    pub round: Account<'info, Round>,
}
#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut, address = round.config)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub round: Account<'info, Round>,
    #[account(mut, seeds = [b"position", round.key().as_ref(), position.authority.as_ref()], bump = position.bump, has_one = round)]
    pub position: Account<'info, Position>,
    #[account(mut, seeds = [b"vault", position.authority.as_ref()], bump = vault.bump, constraint = vault.authority == position.authority @ ErrorCode::InvalidAuthority)]
    pub vault: Account<'info, Vault>,
}
#[derive(Accounts)]
pub struct WithdrawRoundFees<'info> {
    #[account(mut, has_one = treasury_authority)]
    pub config: Account<'info, Config>,
    #[account(mut, has_one = config)]
    pub round: Account<'info, Round>,
    pub treasury_authority: Signer<'info>,
    #[account(mut, address = config.treasury_authority)]
    pub treasury: SystemAccount<'info>,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Amount is invalid")]
    InvalidAmount,
    #[msg("Arithmetic overflow or underflow")]
    Arithmetic,
    #[msg("Available balance is insufficient")]
    InsufficientAvailable,
    #[msg("Config rent reserve would be violated")]
    RentReserve,
    #[msg("Session is invalid, expired, or revoked")]
    SessionInvalid,
    #[msg("Session spending cap exceeded")]
    SessionCapExceeded,
    #[msg("Round is not open")]
    RoundNotOpen,
    #[msg("Round time is invalid")]
    InvalidRoundTime,
    #[msg("Round cannot be settled now")]
    NotSettleable,
    #[msg("Round is not final")]
    NotFinal,
    #[msg("Round has already been finalized")]
    AlreadyFinal,
    #[msg("Claim was already processed")]
    AlreadyClaimed,
    #[msg("Refund is not available yet")]
    RefundTooEarly,
    #[msg("Fee exceeds configured cap or pool cap is zero")]
    FeeTooHigh,
    #[msg("Pool cap reached")]
    PoolCapReached,
    #[msg("Price is invalid")]
    InvalidPrice,
    #[msg("Session parameters are invalid")]
    InvalidSession,
    #[msg("New entries are paused")]
    Paused,
    #[msg("Authority mismatch")]
    InvalidAuthority,
    #[msg("Round state transition is invalid")]
    InvalidTransition,
    #[msg("Existing session is still active")]
    SessionStillActive,
    #[msg("Mock-only mode cannot accept money or create rounds")]
    MockOnly,
    #[msg("Claims remain outstanding")]
    ClaimsOutstanding,
    #[msg("Round fees were already withdrawn")]
    FeesAlreadyWithdrawn,
    #[msg("Config liabilities are not fully backed")]
    Insolvent,
}
