//! Round scenarios against the compiled program in LiteSVM.
//! Needs `target/deploy/flip_the_meme.so`: `cargo build-sbf --manifest-path programs/flip-the-meme/Cargo.toml`.

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{system_program, AccountDeserialize, InstructionData, ToAccountMetas};
use flip_the_meme::{
    accounts as acc, instruction as ixs, Config, ConfigParams, CreateRoundArgs, Outcome, Position,
    PriceSample, RefundReason, Round, RoundStatus, Session, Side, Vault, ID,
};
use litesvm::LiteSVM;
use solana_clock::Clock;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::Transaction;

const SOL: u64 = 1_000_000_000;
const CSOL: u64 = SOL / 100;
const T0: i64 = 1_800_000_000;

struct Env {
    svm: LiteSVM,
    admin: Keypair,
    treasury: Keypair,
}

struct Player {
    owner: Keypair,
    key: Keypair,
}

fn config_pda() -> Pubkey {
    Pubkey::find_program_address(&[b"config"], &ID).0
}
fn vault_pda(owner: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"vault", owner.as_ref()], &ID).0
}
fn session_pda(vault: &Pubkey, signer: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"session", vault.as_ref(), signer.as_ref()], &ID).0
}
fn round_pda(id: u64) -> Pubkey {
    Pubkey::find_program_address(&[b"round", &id.to_le_bytes()], &ID).0
}
fn position_pda(round: &Pubkey, owner: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"position", round.as_ref(), owner.as_ref()], &ID).0
}

fn ix(accounts: impl ToAccountMetas, data: impl InstructionData) -> Instruction {
    Instruction {
        program_id: ID,
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}

impl Env {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let so = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/deploy/flip_the_meme.so");
        let bytes = std::fs::read(&so).expect("build the program first: cargo build-sbf");
        let _ = svm.add_program(ID, &bytes);
        let admin = Keypair::new();
        let treasury = Keypair::new();
        svm.airdrop(&admin.pubkey(), 100 * SOL).unwrap();
        svm.airdrop(&treasury.pubkey(), SOL).unwrap();
        let mut env = Env { svm, admin, treasury };
        env.warp(T0);
        let params = env.params();
        env.send_admin(ix(
            acc::InitializeConfig {
                config: config_pda(),
                admin: env.admin.pubkey(),
                system_program: system_program::ID,
            },
            ixs::InitializeConfig { params },
        ))
        .unwrap();
        // The house is the admin's own vault, funded like any player.
        let admin = env.admin.insecure_clone();
        env.open_and_deposit(&admin, 5 * SOL);
        env
    }

    fn params(&self) -> ConfigParams {
        ConfigParams {
            price_authority: self.admin.pubkey(),
            house_authority: self.admin.pubkey(),
            treasury: self.treasury.pubkey(),
            min_stake: CSOL,
            max_stake: 10 * CSOL,
            min_bank: 2 * CSOL,
            fee_win_bps: 200,
            fee_refund_bps: 100,
        }
    }

    fn warp(&mut self, unix: i64) {
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.unix_timestamp = unix;
        clock.slot += 1;
        self.svm.set_sysvar::<Clock>(&clock);
    }

    fn send(&mut self, ixs: Vec<Instruction>, payer: &Keypair, signers: &[&Keypair]) -> Result<(), String> {
        let tx = Transaction::new_signed_with_payer(&ixs, Some(&payer.pubkey()), signers, self.svm.latest_blockhash());
        let res = self.svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?} {:?}", e.err, e.meta.logs));
        self.svm.expire_blockhash();
        res
    }

    fn send_admin(&mut self, i: Instruction) -> Result<(), String> {
        let admin = self.admin.insecure_clone();
        self.send(vec![i], &admin, &[&admin])
    }

    fn read<T: AccountDeserialize>(&self, key: &Pubkey) -> T {
        let account = self.svm.get_account(key).expect("account exists");
        T::try_deserialize(&mut account.data.as_slice()).unwrap()
    }

    fn lamports(&self, key: &Pubkey) -> u64 {
        self.svm.get_account(key).map(|a| a.lamports).unwrap_or(0)
    }

    fn open_and_deposit(&mut self, owner: &Keypair, amount: u64) {
        let vault = vault_pda(&owner.pubkey());
        let open = ix(
            acc::OpenVault { config: config_pda(), vault, authority: owner.pubkey(), system_program: system_program::ID },
            ixs::OpenVault {},
        );
        let deposit = ix(
            acc::Deposit { config: config_pda(), vault, authority: owner.pubkey(), system_program: system_program::ID },
            ixs::Deposit { amount },
        );
        self.send(vec![open, deposit], owner, &[owner]).unwrap();
    }

    fn player(&mut self, deposit: u64) -> Player {
        let owner = Keypair::new();
        let key = Keypair::new();
        self.svm.airdrop(&owner.pubkey(), 10 * SOL).unwrap();
        self.svm.airdrop(&key.pubkey(), SOL).unwrap();
        self.open_and_deposit(&owner, deposit);
        self.start_session(&owner, &key, T0 + 3_600, 10 * CSOL, SOL).unwrap();
        Player { owner, key }
    }

    fn start_session(&mut self, owner: &Keypair, key: &Keypair, expiry: i64, max_per_bet: u64, cap: u64) -> Result<(), String> {
        let vault = vault_pda(&owner.pubkey());
        let i = ix(
            acc::StartSession {
                config: config_pda(),
                vault,
                session: session_pda(&vault, &key.pubkey()),
                authority: owner.pubkey(),
                session_signer: key.pubkey(),
                system_program: system_program::ID,
            },
            ixs::StartSession { expiry, max_per_bet, session_cap: cap },
        );
        self.send(vec![i], owner, &[owner])
    }

    /// Round `id` opening at `open`, with the production cadence: 60 s entry, 30 s pause,
    /// 10 s strike window, exit window 60 s after the strike window starts.
    fn create_round(&mut self, id: u64, open: i64, max_bank: u64) -> Result<(), String> {
        let cutoff = open + 60;
        let args = CreateRoundArgs {
            token_mint: Pubkey::new_unique(),
            pool: Pubkey::new_unique(),
            opens_at: open,
            cutoff_at: cutoff,
            strike_start: cutoff + 30,
            strike_end: cutoff + 40,
            exit_start: cutoff + 90,
            exit_end: cutoff + 100,
            settle_deadline: cutoff + 700,
            max_bank,
        };
        self.send_admin(ix(
            acc::CreateRound { config: config_pda(), round: round_pda(id), admin: self.admin.pubkey(), system_program: system_program::ID },
            ixs::CreateRound { round_id: id, args },
        ))
    }

    fn bet(&mut self, id: u64, p: &Player, side: Side, amount: u64) -> Result<(), String> {
        let round = round_pda(id);
        let vault = vault_pda(&p.owner.pubkey());
        let i = ix(
            acc::PlaceBet {
                config: config_pda(),
                round,
                vault,
                session: session_pda(&vault, &p.key.pubkey()),
                position: position_pda(&round, &p.owner.pubkey()),
                session_signer: p.key.pubkey(),
                system_program: system_program::ID,
            },
            ixs::PlaceBet { side, amount, face: [1, 2, 3, 4, 5, 0, 0, 0] },
        );
        let key = p.key.insecure_clone();
        self.send(vec![i], &key, &[&key])
    }

    fn house_fill(&mut self, id: u64, signer: &Keypair, amount: u64) -> Result<(), String> {
        let round = round_pda(id);
        let i = ix(
            acc::HouseFill {
                config: config_pda(),
                round,
                house_vault: vault_pda(&signer.pubkey()),
                position: position_pda(&round, &signer.pubkey()),
                house_authority: signer.pubkey(),
                system_program: system_program::ID,
            },
            ixs::HouseFill { amount },
        );
        self.send(vec![i], signer, &[signer])
    }

    fn set_strike(&mut self, id: u64, signer: &Keypair, samples: Vec<PriceSample>) -> Result<(), String> {
        let i = ix(
            acc::PriceUpdate { config: config_pda(), round: round_pda(id), price_authority: signer.pubkey() },
            ixs::SetStrike { samples },
        );
        self.send(vec![i], signer, &[signer])
    }

    fn settle(&mut self, id: u64, samples: Vec<PriceSample>) -> Result<(), String> {
        let admin = self.admin.insecure_clone();
        let i = ix(
            acc::PriceUpdate { config: config_pda(), round: round_pda(id), price_authority: admin.pubkey() },
            ixs::Settle { samples },
        );
        self.send(vec![i], &admin, &[&admin])
    }

    fn claim(&mut self, id: u64, owner: &Pubkey) -> Result<(), String> {
        let round = round_pda(id);
        let i = ix(
            acc::Claim { config: config_pda(), round, position: position_pda(&round, owner), vault: vault_pda(owner) },
            ixs::Claim {},
        );
        // Anyone may crank a claim: a stranger pays the fee here.
        let stranger = Keypair::new();
        self.svm.airdrop(&stranger.pubkey(), SOL).unwrap();
        self.send(vec![i], &stranger, &[&stranger])
    }

    fn sweep(&mut self, id: u64) -> Result<(), String> {
        let i = ix(
            acc::SweepFees { config: config_pda(), round: round_pda(id), treasury: self.treasury.pubkey() },
            ixs::SweepFees {},
        );
        let admin = self.admin.insecure_clone();
        self.send(vec![i], &admin, &[&admin])
    }

    fn round(&self, id: u64) -> Round {
        self.read(&round_pda(id))
    }

    fn vault(&self, owner: &Pubkey) -> Vault {
        self.read(&vault_pda(owner))
    }

    /// Runs a round from strike to settlement with the given mean prices.
    fn price_round(&mut self, id: u64, strike: u64, exit: u64) {
        let r = self.round(id);
        self.warp(r.strike_end);
        let admin = self.admin.insecure_clone();
        self.set_strike(id, &admin, samples(100, &[strike; 6])).unwrap();
        self.warp(r.exit_end);
        self.settle(id, samples(200, &[exit; 6])).unwrap();
    }
}

fn samples(first_slot: u64, prices: &[u64]) -> Vec<PriceSample> {
    prices.iter().enumerate().map(|(i, &price)| PriceSample { slot: first_slot + i as u64, price }).collect()
}

fn assert_err(res: Result<(), String>, needle: &str) {
    match res {
        Ok(()) => panic!("expected failure containing {needle}"),
        Err(e) => assert!(e.contains(needle), "expected {needle}, got {e}"),
    }
}

#[test]
fn full_round_up_returns_surplus_and_pays_1_96() {
    let mut env = Env::new();
    let (a, b, c) = (env.player(SOL), env.player(SOL), env.player(SOL));
    env.create_round(0, T0, SOL).unwrap();
    env.bet(0, &a, Side::Up, 6 * CSOL).unwrap();
    env.bet(0, &c, Side::Up, 2 * CSOL).unwrap();
    env.bet(0, &b, Side::Down, 2 * CSOL).unwrap();
    assert_eq!(env.vault(&a.owner.pubkey()).locked, 6 * CSOL);
    env.price_round(0, 1_000, 1_100);
    let r = env.round(0);
    assert_eq!((r.status, r.outcome), (RoundStatus::Final, Outcome::Up));

    for p in [&a, &b, &c] {
        env.claim(0, &p.owner.pubkey()).unwrap();
    }
    // A: 0.015 of 0.06 played (0.02 * 0.06 / 0.08), 0.045 back, 0.015 * 1.96 won.
    assert_eq!(env.vault(&a.owner.pubkey()).available, SOL - 6 * CSOL + 4_500_000 * 10 + 15_000_000 * 196 / 100);
    assert_eq!(env.vault(&c.owner.pubkey()).available, SOL - 2 * CSOL + 15_000_000 + 5_000_000 * 196 / 100);
    assert_eq!(env.vault(&b.owner.pubkey()).available, SOL - 2 * CSOL);
    for p in [&a, &b, &c] {
        assert_eq!(env.vault(&p.owner.pubkey()).locked, 0);
    }

    let before = env.lamports(&env.treasury.pubkey());
    env.sweep(0).unwrap();
    // 2% of the accepted bank 0.04.
    assert_eq!(env.lamports(&env.treasury.pubkey()) - before, 4 * CSOL * 2 / 100);
    assert_err(env.sweep(0), "NotSweepable");
}

#[test]
fn house_fills_a_lone_player_and_the_round_plays() {
    let mut env = Env::new();
    let a = env.player(SOL);
    let admin = env.admin.insecure_clone();
    env.create_round(0, T0, SOL).unwrap();
    env.bet(0, &a, Side::Up, 5 * CSOL).unwrap();
    assert_err(env.house_fill(0, &admin, 5 * CSOL), "NotFillWindow");
    env.warp(T0 + 60);
    assert_err(env.house_fill(0, &admin, 6 * CSOL), "InvalidAmount");
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 3 * SOL).unwrap();
    env.open_and_deposit(&stranger, SOL);
    assert_err(env.house_fill(0, &stranger, 5 * CSOL), "Unauthorized");
    env.house_fill(0, &admin, 5 * CSOL).unwrap();
    let r = env.round(0);
    assert_eq!((r.raw_up, r.raw_down, r.house_amount), (5 * CSOL, 5 * CSOL, 5 * CSOL));
    let house_position: Position = env.read(&position_pda(&round_pda(0), &admin.pubkey()));
    assert!(house_position.is_house);
    assert_eq!(house_position.side, Side::Down);

    let house_before = env.vault(&admin.pubkey()).available;
    env.price_round(0, 1_000, 900);
    env.claim(0, &a.owner.pubkey()).unwrap();
    env.claim(0, &admin.pubkey()).unwrap();
    assert_eq!(env.vault(&a.owner.pubkey()).available, SOL - 5 * CSOL);
    assert_eq!(env.vault(&admin.pubkey()).available, house_before + 5 * CSOL * 196 / 100);
}

#[test]
fn house_cannot_fill_after_the_strike_window_opens() {
    let mut env = Env::new();
    let a = env.player(SOL);
    let admin = env.admin.insecure_clone();
    env.create_round(0, T0, SOL).unwrap();
    env.bet(0, &a, Side::Up, 5 * CSOL).unwrap();
    env.warp(T0 + 90);
    assert_err(env.house_fill(0, &admin, 5 * CSOL), "NotFillWindow");
}

#[test]
fn unmatched_round_is_not_activated_and_returns_everything() {
    let mut env = Env::new();
    let a = env.player(SOL);
    env.create_round(0, T0, SOL).unwrap();
    env.bet(0, &a, Side::Up, 5 * CSOL).unwrap();
    env.warp(T0 + 100);
    let admin = env.admin.insecure_clone();
    env.set_strike(0, &admin, vec![]).unwrap();
    assert_eq!(env.round(0).outcome, Outcome::NotActivated);
    env.claim(0, &a.owner.pubkey()).unwrap();
    let v = env.vault(&a.owner.pubkey());
    assert_eq!((v.available, v.locked), (SOL, 0));
    env.sweep(0).unwrap();
}

#[test]
fn tie_refunds_minus_one_percent() {
    let mut env = Env::new();
    let (a, b) = (env.player(SOL), env.player(SOL));
    env.create_round(0, T0, SOL).unwrap();
    env.bet(0, &a, Side::Up, 5 * CSOL).unwrap();
    env.bet(0, &b, Side::Down, 5 * CSOL).unwrap();
    env.price_round(0, 1_000, 1_000);
    let r = env.round(0);
    assert_eq!((r.outcome, r.refund_reason), (Outcome::Refund, RefundReason::Tie));
    env.claim(0, &a.owner.pubkey()).unwrap();
    env.claim(0, &b.owner.pubkey()).unwrap();
    assert_eq!(env.vault(&a.owner.pubkey()).available, SOL - 5 * CSOL + 5 * CSOL * 99 / 100);
    let before = env.lamports(&env.treasury.pubkey());
    env.sweep(0).unwrap();
    assert_eq!(env.lamports(&env.treasury.pubkey()) - before, 10 * CSOL / 100);
}

#[test]
fn too_few_observations_refund_the_round() {
    let mut env = Env::new();
    let (a, b) = (env.player(SOL), env.player(SOL));
    env.create_round(0, T0, SOL).unwrap();
    env.bet(0, &a, Side::Up, 5 * CSOL).unwrap();
    env.bet(0, &b, Side::Down, 5 * CSOL).unwrap();
    env.warp(T0 + 100);
    let admin = env.admin.insecure_clone();
    env.set_strike(0, &admin, samples(1, &[1_000; 4])).unwrap();
    let r = env.round(0);
    assert_eq!((r.outcome, r.refund_reason), (Outcome::Refund, RefundReason::Unpriceable));
}

#[test]
fn malformed_samples_are_rejected_and_the_strike_mean_is_on_chain() {
    let mut env = Env::new();
    let (a, b) = (env.player(SOL), env.player(SOL));
    env.create_round(0, T0, SOL).unwrap();
    env.bet(0, &a, Side::Up, 5 * CSOL).unwrap();
    env.bet(0, &b, Side::Down, 5 * CSOL).unwrap();
    let admin = env.admin.insecure_clone();
    assert_err(env.set_strike(0, &admin, samples(1, &[1_000; 6])), "NotDue");
    env.warp(T0 + 100);
    let mut repeated = samples(1, &[1_000; 6]);
    repeated[3].slot = repeated[2].slot;
    assert_err(env.set_strike(0, &admin, repeated), "InvalidSamples");
    assert_err(env.set_strike(0, &admin, samples(1, &[1_000; 17])), "InvalidSamples");
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), SOL).unwrap();
    assert_err(env.set_strike(0, &stranger, samples(1, &[1_000; 6])), "Unauthorized");
    env.set_strike(0, &admin, samples(1, &[1_000, 1_001, 1_002, 1_003, 1_004, 1_005])).unwrap();
    let r = env.round(0);
    assert_eq!((r.status, r.strike_price, r.strike_samples), (RoundStatus::Live, 1_002, 6));
    assert_err(env.set_strike(0, &admin, samples(50, &[1_000; 6])), "NotDue");
}

#[test]
fn expired_round_refunds_through_anyone() {
    let mut env = Env::new();
    let (a, b) = (env.player(SOL), env.player(SOL));
    env.create_round(0, T0, SOL).unwrap();
    env.bet(0, &a, Side::Up, 5 * CSOL).unwrap();
    env.bet(0, &b, Side::Down, 5 * CSOL).unwrap();
    let anyone = Keypair::new();
    env.svm.airdrop(&anyone.pubkey(), SOL).unwrap();
    let refund = ix(acc::RefundExpired { round: round_pda(0) }, ixs::RefundExpired {});
    assert_err(env.send(vec![refund.clone()], &anyone, &[&anyone]), "NotDue");
    env.warp(T0 + 60 + 701);
    env.send(vec![refund], &anyone, &[&anyone]).unwrap();
    let r = env.round(0);
    assert_eq!((r.outcome, r.refund_reason), (Outcome::Refund, RefundReason::Expired));
    let admin = env.admin.insecure_clone();
    assert_err(env.set_strike(0, &admin, samples(1, &[1_000; 6])), "NotDue");
    env.claim(0, &b.owner.pubkey()).unwrap();
    assert_eq!(env.vault(&b.owner.pubkey()).available, SOL - 5 * CSOL + 5 * CSOL * 99 / 100);
}

#[test]
fn claims_and_settlement_happen_once() {
    let mut env = Env::new();
    let (a, b) = (env.player(SOL), env.player(SOL));
    env.create_round(0, T0, SOL).unwrap();
    env.bet(0, &a, Side::Up, 5 * CSOL).unwrap();
    env.bet(0, &b, Side::Down, 5 * CSOL).unwrap();
    assert_err(env.claim(0, &a.owner.pubkey()), "NotFinal");
    env.price_round(0, 1_000, 1_100);
    assert_err(env.settle(0, samples(300, &[900; 6])), "NotDue");
    env.claim(0, &a.owner.pubkey()).unwrap();
    assert_err(env.claim(0, &a.owner.pubkey()), "AlreadyClaimed");
    assert_err(env.sweep(0), "NotSweepable");
    assert_eq!(env.round(0).outcome, Outcome::Up);
}

#[test]
fn entry_closes_on_the_program_clock() {
    let mut env = Env::new();
    let (a, b) = (env.player(SOL), env.player(SOL));
    env.create_round(0, T0 + 10, SOL).unwrap();
    assert_err(env.bet(0, &a, Side::Up, 5 * CSOL), "RoundNotOpen");
    env.warp(T0 + 69);
    env.bet(0, &a, Side::Up, 5 * CSOL).unwrap();
    env.warp(T0 + 70);
    assert_err(env.bet(0, &b, Side::Down, 5 * CSOL), "RoundNotOpen");
}

#[test]
fn one_position_per_player_per_round() {
    let mut env = Env::new();
    let a = env.player(SOL);
    env.create_round(0, T0, SOL).unwrap();
    env.bet(0, &a, Side::Up, 2 * CSOL).unwrap();
    assert!(env.bet(0, &a, Side::Down, 2 * CSOL).is_err());
}

#[test]
fn session_limits_are_enforced_by_the_program() {
    let mut env = Env::new();
    let a = env.player(SOL);
    env.create_round(0, T0, SOL).unwrap();
    assert_err(env.bet(0, &a, Side::Up, CSOL / 2), "InvalidAmount");
    assert_err(env.bet(0, &a, Side::Up, 11 * CSOL), "InvalidAmount");

    // Tight budget: 0.03 per session.
    let owner = a.owner.insecure_clone();
    let tight = Keypair::new();
    env.svm.airdrop(&tight.pubkey(), SOL).unwrap();
    env.start_session(&owner, &tight, T0 + 3_600, 10 * CSOL, 3 * CSOL).unwrap();
    let p = Player { owner: owner.insecure_clone(), key: tight };
    assert_err(env.bet(0, &p, Side::Up, 4 * CSOL), "SessionCapExceeded");

    // Expired key.
    let old = Keypair::new();
    env.svm.airdrop(&old.pubkey(), SOL).unwrap();
    env.start_session(&owner, &old, T0 + 30, 10 * CSOL, SOL).unwrap();
    env.warp(T0 + 30);
    let p_old = Player { owner: owner.insecure_clone(), key: old };
    assert_err(env.bet(0, &p_old, Side::Up, CSOL), "SessionInvalid");
    assert_err(env.start_session(&owner, &Keypair::new(), T0 + 30 + 8 * 24 * 3600, CSOL, CSOL), "InvalidSession");

    // Revoked key.
    let vault = vault_pda(&owner.pubkey());
    let revoke = ix(
        acc::RevokeSession { vault, session: session_pda(&vault, &a.key.pubkey()), authority: owner.pubkey() },
        ixs::RevokeSession {},
    );
    env.send(vec![revoke], &owner, &[&owner]).unwrap();
    let s: Session = env.read(&session_pda(&vault, &a.key.pubkey()));
    assert!(s.revoked);
    assert_err(env.bet(0, &a, Side::Up, CSOL), "SessionInvalid");
}

#[test]
fn a_session_key_cannot_bet_from_someone_elses_vault() {
    let mut env = Env::new();
    let (a, b) = (env.player(SOL), env.player(SOL));
    env.create_round(0, T0, SOL).unwrap();
    let round = round_pda(0);
    let victim_vault = vault_pda(&b.owner.pubkey());
    let i = ix(
        acc::PlaceBet {
            config: config_pda(),
            round,
            vault: victim_vault,
            session: session_pda(&vault_pda(&a.owner.pubkey()), &a.key.pubkey()),
            position: position_pda(&round, &b.owner.pubkey()),
            session_signer: a.key.pubkey(),
            system_program: system_program::ID,
        },
        ixs::PlaceBet { side: Side::Up, amount: CSOL, face: [0; 8] },
    );
    let key = a.key.insecure_clone();
    assert!(env.send(vec![i], &key, &[&key]).is_err());
    assert_eq!(env.vault(&b.owner.pubkey()).available, SOL);
}

#[test]
fn depth_cap_limits_the_accepted_bank_only() {
    let mut env = Env::new();
    let (a, b, c) = (env.player(SOL), env.player(SOL), env.player(SOL));
    env.create_round(0, T0, 4 * CSOL).unwrap();
    env.bet(0, &a, Side::Up, 5 * CSOL).unwrap();
    assert_err(env.bet(0, &b, Side::Down, 3 * CSOL), "BankTooLargeForPool");
    env.bet(0, &b, Side::Down, 2 * CSOL).unwrap();
    // The larger side does not grow the accepted bank.
    env.bet(0, &c, Side::Up, 5 * CSOL).unwrap();
}

#[test]
fn locked_stake_cannot_be_withdrawn() {
    let mut env = Env::new();
    let a = env.player(10 * CSOL);
    env.create_round(0, T0, SOL).unwrap();
    env.bet(0, &a, Side::Up, 5 * CSOL).unwrap();
    let owner = a.owner.insecure_clone();
    let withdraw = |amount| {
        ix(
            acc::Withdraw { config: config_pda(), vault: vault_pda(&owner.pubkey()), authority: owner.pubkey() },
            ixs::Withdraw { amount },
        )
    };
    assert_err(env.send(vec![withdraw(6 * CSOL)], &owner, &[&owner]), "InsufficientAvailable");
    let before = env.lamports(&owner.pubkey());
    env.send(vec![withdraw(5 * CSOL)], &owner, &[&owner]).unwrap();
    assert_eq!(env.lamports(&owner.pubkey()), before + 5 * CSOL - 5_000);
}

#[test]
fn pause_stops_new_bets_but_not_payouts() {
    let mut env = Env::new();
    let (a, b) = (env.player(SOL), env.player(SOL));
    env.create_round(0, T0, SOL).unwrap();
    env.bet(0, &a, Side::Up, 5 * CSOL).unwrap();
    env.bet(0, &b, Side::Down, 5 * CSOL).unwrap();
    let pause = ix(acc::AdminConfig { config: config_pda(), admin: env.admin.pubkey() }, ixs::SetPause { paused: true });
    env.send_admin(pause).unwrap();
    let c = env.player(SOL);
    assert_err(env.bet(0, &c, Side::Up, CSOL), "Paused");
    env.price_round(0, 1_000, 900);
    env.claim(0, &b.owner.pubkey()).unwrap();
    assert_eq!(env.vault(&b.owner.pubkey()).available, SOL - 5 * CSOL + 5 * CSOL * 196 / 100);
}

#[test]
fn only_the_admin_creates_rounds_in_sequence() {
    let mut env = Env::new();
    assert_err(env.create_round(1, T0, SOL), "InvalidRoundId");
    let mallory = Keypair::new();
    env.svm.airdrop(&mallory.pubkey(), SOL).unwrap();
    let args = CreateRoundArgs {
        token_mint: Pubkey::new_unique(),
        pool: Pubkey::new_unique(),
        opens_at: T0,
        cutoff_at: T0 + 60,
        strike_start: T0 + 90,
        strike_end: T0 + 100,
        exit_start: T0 + 150,
        exit_end: T0 + 160,
        settle_deadline: T0 + 760,
        max_bank: SOL,
    };
    let i = ix(
        acc::CreateRound { config: config_pda(), round: round_pda(0), admin: mallory.pubkey(), system_program: system_program::ID },
        ixs::CreateRound { round_id: 0, args },
    );
    assert_err(env.send(vec![i], &mallory, &[&mallory]), "Unauthorized");
    env.create_round(0, T0, SOL).unwrap();
    env.create_round(1, T0 + 60, SOL).unwrap();
    let config: Config = env.read(&config_pda());
    assert_eq!(config.next_round_id, 2);
}

#[test]
fn empty_rounds_close_and_return_rent() {
    let mut env = Env::new();
    let a = env.player(SOL);
    env.create_round(0, T0, SOL).unwrap();
    env.create_round(1, T0 + 60, SOL).unwrap();
    env.warp(T0 + 60);
    env.bet(1, &a, Side::Up, CSOL).unwrap();
    let admin = env.admin.insecure_clone();
    env.warp(T0 + 160);
    env.set_strike(0, &admin, vec![]).unwrap();
    env.set_strike(1, &admin, vec![]).unwrap();
    let close = |id| {
        ix(
            acc::CloseEmptyRound { config: config_pda(), round: round_pda(id), admin: admin.pubkey() },
            ixs::CloseEmptyRound {},
        )
    };
    assert_err(env.send_admin(close(1)), "NotClosable");
    let rent = env.lamports(&round_pda(0));
    let before = env.lamports(&admin.pubkey());
    env.send_admin(close(0)).unwrap();
    assert!(env.svm.get_account(&round_pda(0)).map(|a| a.lamports == 0).unwrap_or(true));
    assert_eq!(env.lamports(&admin.pubkey()), before + rent - 5_000);
}

#[test]
fn config_update_applies_to_new_rounds_only() {
    let mut env = Env::new();
    env.create_round(0, T0, SOL).unwrap();
    let mut params = env.params();
    params.fee_win_bps = 100;
    env.send_admin(ix(acc::AdminConfig { config: config_pda(), admin: env.admin.pubkey() }, ixs::UpdateConfig { params: params.clone() }))
        .unwrap();
    env.create_round(1, T0 + 60, SOL).unwrap();
    assert_eq!((env.round(0).fee_win_bps, env.round(1).fee_win_bps), (200, 100));
    params.fee_win_bps = 300;
    assert_err(
        env.send_admin(ix(acc::AdminConfig { config: config_pda(), admin: env.admin.pubkey() }, ixs::UpdateConfig { params })),
        "FeeTooHigh",
    );
}
