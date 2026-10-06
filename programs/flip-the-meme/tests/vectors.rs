//! Writes packages/client/test/vectors.json: the exact bytes the program expects and stores,
//! so the TypeScript client can be checked byte for byte without a validator.
//! Run: cargo test --manifest-path programs/flip-the-meme/Cargo.toml --test vectors

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::AccountMeta;
use anchor_lang::{system_program, AccountSerialize, Discriminator, InstructionData, ToAccountMetas};
use flip_the_meme::payout::position_payout;
use flip_the_meme::{
    accounts as acc, instruction as ixs, BetPlaced, Claimed, Config, ConfigParams, CreateRoundArgs, ErrorCode,
    HouseLimits, OracleConfig, Outcome, Position, PositionClosed, PriceSample, RefundReason, Round, RoundSettled,
    RoundStatus, Session, Side, StrikeSet, Vault, ID,
};
use std::fmt::Write as _;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn key(n: u8) -> Pubkey {
    Pubkey::new_from_array([n; 32])
}

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &ID).0
}

fn account<T: AccountSerialize>(value: &T) -> String {
    let mut out = Vec::new();
    value.try_serialize(&mut out).unwrap();
    hex(&out)
}

fn metas(list: Vec<AccountMeta>) -> String {
    let items: Vec<String> = list
        .iter()
        .map(|m| format!("{{ \"pubkey\": \"{}\", \"signer\": {}, \"writable\": {} }}", m.pubkey, m.is_signer, m.is_writable))
        .collect();
    format!("[{}]", items.join(", "))
}

#[test]
fn write_vectors() {
    let params = ConfigParams {
        price_authority: key(1),
        house_authority: key(2),
        treasury: key(3),
        min_stake: 10_000_000,
        max_stake: 100_000_000,
        min_bank: 20_000_000,
        fee_win_bps: 200,
        fee_refund_bps: 100,
    };
    let args = CreateRoundArgs {
        token_mint: key(4),
        pool: key(5),
        opens_at: 1_800_000_000,
        cutoff_at: 1_800_000_060,
        strike_start: 1_800_000_090,
        strike_end: 1_800_000_100,
        exit_start: 1_800_000_150,
        exit_end: 1_800_000_160,
        settle_deadline: 1_800_000_760,
        max_bank: 270_000_000,
    };
    let instructions: Vec<(&str, Vec<u8>)> = vec![
        ("initializeConfig", ixs::InitializeConfig { params: params.clone() }.data()),
        ("updateConfig", ixs::UpdateConfig { params: params.clone() }.data()),
        ("setPause", ixs::SetPause { paused: true }.data()),
        ("openVault", ixs::OpenVault {}.data()),
        ("deposit", ixs::Deposit { amount: 123_456_789 }.data()),
        ("withdraw", ixs::Withdraw { amount: 987_654_321 }.data()),
        (
            "startSession",
            ixs::StartSession { expiry: 1_800_003_600, max_per_bet: 100_000_000, session_cap: 1_000_000_000 }.data(),
        ),
        ("revokeSession", ixs::RevokeSession {}.data()),
        ("createRound", ixs::CreateRound { round_id: 42, args }.data()),
        ("placeBet", ixs::PlaceBet { side: Side::Down, amount: 50_000_000, face: [1, 2, 3, 4, 5, 6, 7, 8] }.data()),
        ("houseFill", ixs::HouseFill { amount: 30_000_000 }.data()),
        (
            "setStrike",
            ixs::SetStrike { samples: vec![PriceSample { slot: 100, price: 1_000 }, PriceSample { slot: 101, price: 1_001 }] }
                .data(),
        ),
        ("settle", ixs::Settle { samples: vec![PriceSample { slot: 200, price: 900 }] }.data()),
        ("refundExpired", ixs::RefundExpired {}.data()),
        ("claim", ixs::Claim {}.data()),
        ("sweepFees", ixs::SweepFees {}.data()),
        ("closeEmptyRound", ixs::CloseEmptyRound {}.data()),
        ("closePosition", ixs::ClosePosition {}.data()),
        ("initHouseLimits", ixs::InitHouseLimits { round_cap: 50_000_000, daily_cap: 2_000_000_000 }.data()),
        ("updateHouseLimits", ixs::UpdateHouseLimits { round_cap: 25_000_000, daily_cap: 1_000_000_000 }.data()),
        ("initOracle", ixs::InitOracle { attestor: key(6), required: false }.data()),
        ("setOracle", ixs::SetOracle { attestor: key(6), required: true }.data()),
    ];

    // Account order and roles of the instructions added or changed in the October 2026 upgrade,
    // with distinct keys so a swapped pair shows: admin 9, house 2, price authority 1, attestor 6,
    // attestor in office 8, position owner 10, session key 7, round 42.
    let config_key = pda(&[b"config"]);
    let round_key = pda(&[b"round", &42u64.to_le_bytes()]);
    let house_limits_key = pda(&[b"house_limits"]);
    let oracle_key = pda(&[b"oracle"]);
    let account_metas: Vec<(&str, Vec<AccountMeta>)> = vec![
        (
            "closePosition",
            acc::ClosePosition {
                config: config_key,
                round: round_key,
                position: pda(&[b"position", round_key.as_ref(), key(10).as_ref()]),
                vault: pda(&[b"vault", key(10).as_ref()]),
            }
            .to_account_metas(None),
        ),
        // Unchanged since before October: apps already on phones build exactly this list.
        (
            "placeBet",
            acc::PlaceBet {
                config: config_key,
                round: round_key,
                vault: pda(&[b"vault", key(10).as_ref()]),
                session: pda(&[b"session", pda(&[b"vault", key(10).as_ref()]).as_ref(), key(7).as_ref()]),
                position: pda(&[b"position", round_key.as_ref(), key(10).as_ref()]),
                session_signer: key(7),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        ),
        (
            "initHouseLimits",
            acc::InitHouseLimits { config: config_key, house_limits: house_limits_key, admin: key(9), system_program: system_program::ID }
                .to_account_metas(None),
        ),
        (
            "updateHouseLimits",
            acc::UpdateHouseLimits { config: config_key, house_limits: house_limits_key, admin: key(9) }.to_account_metas(None),
        ),
        (
            "initOracle",
            acc::InitOracle { config: config_key, oracle: oracle_key, admin: key(9), system_program: system_program::ID }.to_account_metas(None),
        ),
        (
            "setOracle",
            acc::SetOracle { config: config_key, oracle: oracle_key, admin: key(9), current_attestor: None }.to_account_metas(None),
        ),
        (
            "setOracleCosigned",
            acc::SetOracle { config: config_key, oracle: oracle_key, admin: key(9), current_attestor: Some(key(8)) }.to_account_metas(None),
        ),
        (
            "houseFill",
            acc::HouseFill {
                config: config_key,
                round: round_key,
                house_vault: pda(&[b"vault", key(2).as_ref()]),
                house_limits: house_limits_key,
                position: pda(&[b"position", round_key.as_ref(), key(2).as_ref()]),
                house_authority: key(2),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        ),
        (
            "setStrikeAttested",
            acc::PriceUpdate { config: config_key, round: round_key, price_authority: key(1), oracle: oracle_key, attestor: Some(key(6)) }
                .to_account_metas(None),
        ),
        (
            "settleUnattested",
            acc::PriceUpdate { config: config_key, round: round_key, price_authority: key(1), oracle: oracle_key, attestor: None }
                .to_account_metas(None),
        ),
    ];
    let events: Vec<(&str, &[u8])> = vec![
        ("BetPlaced", BetPlaced::DISCRIMINATOR),
        ("StrikeSet", StrikeSet::DISCRIMINATOR),
        ("RoundSettled", RoundSettled::DISCRIMINATOR),
        ("Claimed", Claimed::DISCRIMINATOR),
        ("PositionClosed", PositionClosed::DISCRIMINATOR),
    ];
    // Every error with the number the program returns for it. The app maps numbers by position,
    // so the client test fails if a code is ever inserted or reordered instead of appended.
    use ErrorCode::*;
    let errors = [
        InvalidAmount, Arithmetic, InsufficientAvailable, SessionInvalid, SessionCapExceeded, InvalidSession, RoundNotOpen,
        InvalidRoundTime, InvalidRoundId, NotDue, NotFinal, AlreadyClaimed, FeeTooHigh, BankTooLargeForPool, InvalidSamples,
        Paused, Unauthorized, InvalidAccount, NotFillWindow, NothingToFill, NotSweepable, NotClosable, Insolvent, NotClaimed,
        HouseRoundCapExceeded, HouseDailyCapExceeded, AttestorRequired, InvalidAttestor,
    ];

    let config = Config {
        admin: key(9),
        price_authority: key(1),
        house_authority: key(2),
        treasury: key(3),
        paused: true,
        next_round_id: 77,
        min_stake: 10_000_000,
        max_stake: 100_000_000,
        min_bank: 20_000_000,
        fee_win_bps: 200,
        fee_refund_bps: 100,
        total_available: 5_000_000_000,
        total_locked: 70_000_000,
        bump: 254,
    };
    let vault = Vault { authority: key(10), available: 900_000_000, locked: 50_000_000, bump: 253 };
    let session = Session {
        authority: key(10),
        vault: key(11),
        signer: key(12),
        expiry: 1_800_003_600,
        max_per_bet: 100_000_000,
        session_cap: 1_000_000_000,
        spent: 50_000_000,
        revoked: false,
        bump: 252,
    };
    let round = Round {
        id: 42,
        token_mint: key(4),
        pool: key(5),
        opens_at: 1_800_000_000,
        cutoff_at: 1_800_000_060,
        strike_start: 1_800_000_090,
        strike_end: 1_800_000_100,
        exit_start: 1_800_000_150,
        exit_end: 1_800_000_160,
        settle_deadline: 1_800_000_760,
        min_stake: 10_000_000,
        max_stake: 100_000_000,
        min_bank: 20_000_000,
        max_bank: 270_000_000,
        fee_win_bps: 200,
        fee_refund_bps: 100,
        raw_up: 80_000_000,
        raw_down: 20_000_000,
        house_amount: 0,
        position_count: 3,
        claimed_count: 1,
        total_paid: 74_400_000,
        fees_swept: false,
        status: RoundStatus::Final,
        outcome: Outcome::Refund,
        refund_reason: RefundReason::Tie,
        strike_price: 15_302_000_000,
        exit_price: 15_302_000_000,
        strike_samples: 9,
        exit_samples: 10,
        bump: 251,
    };
    let position = Position {
        round: key(13),
        authority: key(10),
        side: Side::Down,
        stake: 50_000_000,
        face: [9, 8, 7, 6, 5, 4, 3, 2],
        is_house: true,
        claimed: true,
        payout: 98_000_000,
        bump: 250,
    };
    let house_limits = HouseLimits { round_cap: 50_000_000, daily_cap: 2_000_000_000, day: 20_833, spent: 150_000_000, bump: 249 };
    let oracle = OracleConfig { attestor: key(6), required: true, bump: 248 };

    let mut json = String::from("{\n  \"instructions\": {\n");
    for (i, (name, bytes)) in instructions.iter().enumerate() {
        let comma = if i + 1 < instructions.len() { "," } else { "" };
        writeln!(json, "    \"{name}\": \"{}\"{comma}", hex(bytes)).unwrap();
    }
    json.push_str("  },\n  \"accounts\": {\n");
    writeln!(json, "    \"config\": \"{}\",", account(&config)).unwrap();
    writeln!(json, "    \"vault\": \"{}\",", account(&vault)).unwrap();
    writeln!(json, "    \"session\": \"{}\",", account(&session)).unwrap();
    writeln!(json, "    \"round\": \"{}\",", account(&round)).unwrap();
    writeln!(json, "    \"position\": \"{}\",", account(&position)).unwrap();
    writeln!(json, "    \"houseLimits\": \"{}\",", account(&house_limits)).unwrap();
    writeln!(json, "    \"oracle\": \"{}\"", account(&oracle)).unwrap();
    json.push_str("  },\n  \"accountMetas\": {\n");
    for (i, (name, list)) in account_metas.iter().enumerate() {
        let comma = if i + 1 < account_metas.len() { "," } else { "" };
        writeln!(json, "    \"{name}\": {}{comma}", metas(list.clone())).unwrap();
    }
    json.push_str("  },\n  \"events\": {\n");
    for (i, (name, bytes)) in events.iter().enumerate() {
        let comma = if i + 1 < events.len() { "," } else { "" };
        writeln!(json, "    \"{name}\": \"{}\"{comma}", hex(bytes)).unwrap();
    }
    json.push_str("  },\n  \"errors\": {\n");
    for (i, error) in errors.iter().enumerate() {
        let comma = if i + 1 < errors.len() { "," } else { "" };
        writeln!(json, "    \"{}\": {}{comma}", error.name(), u32::from(*error)).unwrap();
    }
    json.push_str("  },\n  \"payouts\": [\n");

    let mut state: u64 = 0x2545_f491_4f6c_dd1d;
    let mut next = move || {
        state ^= state >> 12;
        state ^= state << 25;
        state ^= state >> 27;
        state.wrapping_mul(0x2545_f491_4f6c_dd1d)
    };
    let outcomes = [Outcome::Up, Outcome::Down, Outcome::Refund, Outcome::NotActivated];
    let mut rows = Vec::new();
    for _ in 0..60 {
        let up = 10_000_000 + next() % 400_000_000;
        let down = 10_000_000 + next() % 400_000_000;
        let side = if next() % 2 == 0 { Side::Up } else { Side::Down };
        let side_total = if side == Side::Up { up } else { down };
        let stake = 1 + next() % side_total;
        let outcome = outcomes[(next() % 4) as usize];
        let fee_win = (next() % 201) as u16;
        let fee_refund = (next() % 101) as u16;
        let payout = position_payout(up, down, outcome, fee_win, fee_refund, side, stake).unwrap();
        rows.push(format!(
            "    {{ \"rawUp\": \"{up}\", \"rawDown\": \"{down}\", \"outcome\": {}, \"side\": {}, \"stake\": \"{stake}\", \"feeWinBps\": {fee_win}, \"feeRefundBps\": {fee_refund}, \"payout\": \"{payout}\" }}",
            outcome as u8, side as u8
        ));
    }
    json.push_str(&rows.join(",\n"));
    json.push_str("\n  ]\n}\n");

    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/client/test/vectors.json");
    std::fs::write(&path, json).unwrap();
}
