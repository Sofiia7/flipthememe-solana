//! Round scenarios against the compiled program in LiteSVM.
//! Needs `target/deploy/flip_the_meme.so`: `cargo build-sbf --manifest-path programs/flip-the-meme/Cargo.toml`.

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{system_program, AccountDeserialize, AccountSerialize, Event, InstructionData, Space, ToAccountMetas};
use flip_the_meme::{
    accounts as acc, instruction as ixs, Config, ConfigParams, CreateRoundArgs, HouseLimits, OracleConfig, Outcome,
    Position, PositionClosed, PriceSample, RefundReason, Round, RoundStatus, Session, Side, Vault, ID,
    MAX_ROUND_SECS, POSITION_CLOSE_DELAY_SECS, SECS_PER_DAY,
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
fn house_limits_pda() -> Pubkey {
    Pubkey::find_program_address(&[b"house_limits"], &ID).0
}
fn oracle_pda() -> Pubkey {
    Pubkey::find_program_address(&[b"oracle"], &ID).0
}

/// set_strike / settle accounts; `attestor: None` puts the program id in the optional slot.
fn price_ix(id: u64, price_authority: &Pubkey, attestor: Option<Pubkey>, data: impl InstructionData) -> Instruction {
    ix(
        acc::PriceUpdate { config: config_pda(), round: round_pda(id), price_authority: *price_authority, oracle: oracle_pda(), attestor },
        data,
    )
}

/// Standard base64 with padding, to find an event in the "Program data:" log lines.
fn base64(bytes: &[u8]) -> String {
    const ABC: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            out.push(if i <= chunk.len() { ABC[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
        }
    }
    out
}

/// The build under test, `target/deploy/flip_the_meme.so`.
fn program() -> Vec<u8> {
    let so = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/deploy/flip_the_meme.so");
    std::fs::read(&so).expect("build the program first: cargo build-sbf")
}

fn ix(accounts: impl ToAccountMetas, data: impl InstructionData) -> Instruction {
    Instruction {
        program_id: ID,
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}

impl Env {
    /// Config and the funded house vault, with roomy house limits and an oracle that requires no
    /// attestor (what the devnet deployment starts with after the upgrade).
    fn new() -> Self {
        Self::new_with(&program())
    }

    /// `new` on another build of the program, for example the one live on devnet.
    fn new_with(program: &[u8]) -> Self {
        let mut env = Self::bare_with(program);
        let admin = env.admin.insecure_clone();
        env.init_house_limits(&admin, SOL, 5 * SOL).unwrap();
        env.init_oracle(&admin, Pubkey::default(), false).unwrap();
        env
    }

    /// Config and the house vault only: no HouseLimits, no OracleConfig.
    fn bare() -> Self {
        Self::bare_with(&program())
    }

    fn bare_with(program: &[u8]) -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(ID, program).unwrap();
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
        self.send_logs(ixs, payer, signers).map(|_| ())
    }

    fn send_logs(&mut self, ixs: Vec<Instruction>, payer: &Keypair, signers: &[&Keypair]) -> Result<Vec<String>, String> {
        let tx = Transaction::new_signed_with_payer(&ixs, Some(&payer.pubkey()), signers, self.svm.latest_blockhash());
        let res = self.svm.send_transaction(tx).map(|m| m.logs).map_err(|e| format!("{:?} {:?}", e.err, e.meta.logs));
        self.svm.expire_blockhash();
        res
    }

    fn init_house_limits(&mut self, signer: &Keypair, round_cap: u64, daily_cap: u64) -> Result<(), String> {
        let i = ix(
            acc::InitHouseLimits { config: config_pda(), house_limits: house_limits_pda(), admin: signer.pubkey(), system_program: system_program::ID },
            ixs::InitHouseLimits { round_cap, daily_cap },
        );
        self.send(vec![i], signer, &[signer])
    }

    fn update_house_limits(&mut self, signer: &Keypair, round_cap: u64, daily_cap: u64) -> Result<(), String> {
        let i = ix(
            acc::UpdateHouseLimits { config: config_pda(), house_limits: house_limits_pda(), admin: signer.pubkey() },
            ixs::UpdateHouseLimits { round_cap, daily_cap },
        );
        self.send(vec![i], signer, &[signer])
    }

    fn init_oracle(&mut self, signer: &Keypair, attestor: Pubkey, required: bool) -> Result<(), String> {
        let i = ix(
            acc::InitOracle { config: config_pda(), oracle: oracle_pda(), admin: signer.pubkey(), system_program: system_program::ID },
            ixs::InitOracle { attestor, required },
        );
        self.send(vec![i], signer, &[signer])
    }

    fn set_oracle(&mut self, signer: &Keypair, attestor: Pubkey, required: bool) -> Result<(), String> {
        self.set_oracle_cosigned(signer, attestor, required, None)
    }

    /// `current`: the attestor in office co-signs, which weakening a required oracle needs.
    fn set_oracle_cosigned(&mut self, signer: &Keypair, attestor: Pubkey, required: bool, current: Option<&Keypair>) -> Result<(), String> {
        let i = ix(
            acc::SetOracle { config: config_pda(), oracle: oracle_pda(), admin: signer.pubkey(), current_attestor: current.map(|k| k.pubkey()) },
            ixs::SetOracle { attestor, required },
        );
        match current {
            Some(co) => self.send(vec![i], signer, &[signer, co]),
            None => self.send(vec![i], signer, &[signer]),
        }
    }

    /// The admin (price authority and fee payer) sends `i` co-signed by `attestor`.
    fn send_attested(&mut self, i: Instruction, attestor: &Keypair) -> Result<(), String> {
        let admin = self.admin.insecure_clone();
        self.send(vec![i], &admin, &[&admin, attestor])
    }

    /// Anyone may close a position; a stranger pays the fee, so no wallet of the owner moves.
    fn close_position(&mut self, id: u64, owner: &Pubkey) -> Result<Vec<String>, String> {
        let round = round_pda(id);
        let i = ix(
            acc::ClosePosition { config: config_pda(), round, position: position_pda(&round, owner), vault: vault_pda(owner) },
            ixs::ClosePosition {},
        );
        let stranger = Keypair::new();
        self.svm.airdrop(&stranger.pubkey(), SOL).unwrap();
        self.send_logs(vec![i], &stranger, &[&stranger])
    }

    /// The admin closes a round whose positions are all closed and whose fees went to the treasury;
    /// the round's rent goes back to the admin.
    fn close_empty_round(&mut self, id: u64) -> Result<(), String> {
        self.send_admin(ix(
            acc::CloseEmptyRound { config: config_pda(), round: round_pda(id), admin: self.admin.pubkey() },
            ixs::CloseEmptyRound {},
        ))
    }

    fn withdraw(&mut self, owner: &Keypair, amount: u64) -> Result<(), String> {
        let i = ix(
            acc::Withdraw { config: config_pda(), vault: vault_pda(&owner.pubkey()), authority: owner.pubkey() },
            ixs::Withdraw { amount },
        );
        self.send(vec![i], owner, &[owner])
    }

    /// What a position account costs; since this upgrade the owner's vault pays it.
    fn position_rent(&self) -> u64 {
        self.svm.minimum_balance_for_rent_exemption(8 + Position::INIT_SPACE)
    }

    /// Config holds exactly its own rent, every lamport the vaults count, and the fees of rounds
    /// that are fully claimed but not swept. Exact, so a lamport moved without its booking shows.
    fn assert_books(&self, rounds: &[u64]) {
        let c: Config = self.read(&config_pda());
        let reserve = self.svm.minimum_balance_for_rent_exemption(8 + Config::INIT_SPACE);
        let mut fees = 0;
        for &id in rounds {
            let r = self.round(id);
            assert!(r.claimed_count == 0 || r.claimed_count == r.position_count, "round {id} is claimed only in part");
            // Fully claimed, whether or not its positions were closed since (closing lowers both counts
            // together, down to 0 and 0): the remainder waits in Config for the sweep.
            if r.status == RoundStatus::Final && r.claimed_count == r.position_count && !r.fees_swept {
                fees += r.raw_up + r.raw_down - r.total_paid;
            }
        }
        assert_eq!(self.lamports(&config_pda()), reserve + c.total_available + c.total_locked + fees, "Config books");
    }

    /// Rewrites the books as the October program left them for a position it opened: the device
    /// or house key paid the rent, so neither the owner's vault nor Config was charged.
    fn as_if_a_key_paid_the_rent(&mut self, owner: &Pubkey) {
        let rent = self.position_rent();
        let mut vault: Vault = self.read(&vault_pda(owner));
        vault.available += rent;
        self.write(&vault_pda(owner), &vault, 0);
        let mut config: Config = self.read(&config_pda());
        config.total_available += rent;
        self.write(&config_pda(), &config, rent);
    }

    fn write<T: AccountSerialize>(&mut self, key: &Pubkey, value: &T, add_lamports: u64) {
        let mut account = self.svm.get_account(key).expect("account exists");
        account.data.clear();
        value.try_serialize(&mut account.data).unwrap();
        account.lamports += add_lamports;
        self.svm.set_account(*key, account).unwrap();
    }

    fn house_limits(&self) -> HouseLimits {
        self.read(&house_limits_pda())
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

    fn revoke_session(&mut self, owner: &Keypair, signer: &Pubkey) -> Result<(), String> {
        let vault = vault_pda(&owner.pubkey());
        let i = ix(
            acc::RevokeSession { vault, session: session_pda(&vault, signer), authority: owner.pubkey() },
            ixs::RevokeSession {},
        );
        self.send(vec![i], owner, &[owner])
    }

    fn close_session_ix(owner: &Pubkey, signer: &Pubkey) -> Instruction {
        let vault = vault_pda(owner);
        ix(acc::CloseSession { vault, session: session_pda(&vault, signer), authority: *owner }, ixs::CloseSession {})
    }

    /// The owner closes the session of device key `signer`. A stranger pays the network fee, so the
    /// owner's balance moves by the session's rent alone.
    fn close_session(&mut self, owner: &Keypair, signer: &Pubkey) -> Result<(), String> {
        let relayer = Keypair::new();
        self.svm.airdrop(&relayer.pubkey(), SOL).unwrap();
        self.send(vec![Self::close_session_ix(&owner.pubkey(), signer)], &relayer, &[&relayer, owner])
    }

    /// What a session account costs; start_session's payer (the owner) puts it up and closing returns it.
    fn session_rent(&self) -> u64 {
        self.svm.minimum_balance_for_rent_exemption(8 + Session::INIT_SPACE)
    }

    /// Round `id` opening at `open`, with the production cadence: 60 s entry, 30 s pause,
    /// 10 s strike window, exit window 60 s after the strike window starts.
    fn create_round(&mut self, id: u64, open: i64, max_bank: u64) -> Result<(), String> {
        self.create_round_with(id, round_args(open, max_bank))
    }

    fn create_round_with(&mut self, id: u64, args: CreateRoundArgs) -> Result<(), String> {
        self.send_admin(ix(
            acc::CreateRound { config: config_pda(), round: round_pda(id), admin: self.admin.pubkey(), system_program: system_program::ID },
            ixs::CreateRound { round_id: id, args },
        ))
    }

    /// Anyone may turn a round nobody priced in time into a refund; a stranger pays the fee here.
    fn expire(&mut self, id: u64) -> Result<(), String> {
        let stranger = Keypair::new();
        self.svm.airdrop(&stranger.pubkey(), SOL).unwrap();
        self.send(vec![ix(acc::RefundExpired { round: round_pda(id) }, ixs::RefundExpired {})], &stranger, &[&stranger])
    }

    /// New rounds get this refund fee (the live devnet config has 0).
    fn set_refund_fee(&mut self, bps: u16) {
        let mut params = self.params();
        params.fee_refund_bps = bps;
        self.send_admin(ix(acc::AdminConfig { config: config_pda(), admin: self.admin.pubkey() }, ixs::UpdateConfig { params })).unwrap();
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
                house_limits: house_limits_pda(),
                position: position_pda(&round, &signer.pubkey()),
                house_authority: signer.pubkey(),
                system_program: system_program::ID,
            },
            ixs::HouseFill { amount },
        );
        self.send(vec![i], signer, &[signer])
    }

    fn set_strike(&mut self, id: u64, signer: &Keypair, samples: Vec<PriceSample>) -> Result<(), String> {
        let i = price_ix(id, &signer.pubkey(), None, ixs::SetStrike { samples });
        self.send(vec![i], signer, &[signer])
    }

    fn settle(&mut self, id: u64, samples: Vec<PriceSample>) -> Result<(), String> {
        let admin = self.admin.insecure_clone();
        let i = price_ix(id, &admin.pubkey(), None, ixs::Settle { samples });
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

/// The keeper's cadence from `open`: cutoff +60, strike window +90..+100, exit window +150..+160,
/// settle deadline 600 s after the exit window.
fn round_args(open: i64, max_bank: u64) -> CreateRoundArgs {
    let cutoff = open + 60;
    CreateRoundArgs {
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
    }
}

fn samples(first_slot: u64, prices: &[u64]) -> Vec<PriceSample> {
    prices.iter().enumerate().map(|(i, &price)| PriceSample { slot: first_slot + i as u64, price }).collect()
}

fn certificate_ixs(id: u64, round: &Round, kind: u8, values: Vec<PriceSample>, attestor: &Keypair) -> Vec<Instruction> {
    let message = flip_the_meme::attestation::message(&round_pda(id), round, kind, &values);
    let mut data = vec![1u8, 0];
    for field in [16u16, u16::MAX, 80, u16::MAX, 112, message.len() as u16, u16::MAX] { data.extend_from_slice(&field.to_le_bytes()); }
    data.extend_from_slice(attestor.sign_message(&message).as_ref());
    data.extend_from_slice(attestor.pubkey().as_ref());
    data.extend_from_slice(&message);
    let proof = Instruction { program_id: anchor_lang::prelude::pubkey!("Ed25519SigVerify111111111111111111111111111"), accounts: vec![], data };
    let accounts = acc::AttestedPrice { round: round_pda(id), oracle: oracle_pda(), instructions: solana_instructions_sysvar::ID };
    let price = if kind == 0 { ix(accounts, ixs::SetStrikeAttested { samples: values }) } else { ix(accounts, ixs::SettleAttested { samples: values }) };
    vec![proof, price]
}

fn assert_err<T>(res: Result<T, String>, needle: &str) {
    match res {
        Ok(_) => panic!("expected failure containing {needle}"),
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
    // A: 0.015 of 0.06 played (0.02 * 0.06 / 0.08), 0.045 back, 0.015 * 1.96 won. Every vault
    // also paid its position's rent, which comes back when the position is closed.
    let rent = env.position_rent();
    assert_eq!(env.vault(&a.owner.pubkey()).available, SOL - 6 * CSOL + 4_500_000 * 10 + 15_000_000 * 196 / 100 - rent);
    assert_eq!(env.vault(&c.owner.pubkey()).available, SOL - 2 * CSOL + 15_000_000 + 5_000_000 * 196 / 100 - rent);
    assert_eq!(env.vault(&b.owner.pubkey()).available, SOL - 2 * CSOL - rent);
    for p in [&a, &b, &c] {
        assert_eq!(env.vault(&p.owner.pubkey()).locked, 0);
    }

    let before = env.lamports(&env.treasury.pubkey());
    env.assert_books(&[0]);
    env.sweep(0).unwrap();
    // 2% of the accepted bank 0.04.
    assert_eq!(env.lamports(&env.treasury.pubkey()) - before, 4 * CSOL * 2 / 100);
    assert_err(env.sweep(0), "NotSweepable");
    env.assert_books(&[0]);
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
    assert_eq!(env.vault(&a.owner.pubkey()).available, SOL - 5 * CSOL - env.position_rent());
    assert_eq!(env.vault(&admin.pubkey()).available, house_before + 5 * CSOL * 196 / 100);
    env.assert_books(&[0]);
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
    // The whole stake is back; the position rent returns when the position is closed.
    let v = env.vault(&a.owner.pubkey());
    assert_eq!((v.available, v.locked), (SOL - env.position_rent(), 0));
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
    assert_eq!(env.vault(&a.owner.pubkey()).available, SOL - 5 * CSOL + 5 * CSOL * 99 / 100 - env.position_rent());
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
    assert_eq!(env.vault(&b.owner.pubkey()).available, SOL - 5 * CSOL + 5 * CSOL * 99 / 100 - env.position_rent());
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
    // Locked: the stake. Spent until the position closes: its rent. The rest can leave.
    let free = 5 * CSOL - env.position_rent();
    assert_err(env.withdraw(&owner, free + 1), "InsufficientAvailable");
    let before = env.lamports(&owner.pubkey());
    env.withdraw(&owner, free).unwrap();
    assert_eq!(env.lamports(&owner.pubkey()), before + free - 5_000);
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
    assert_eq!(env.vault(&b.owner.pubkey()).available, SOL - 5 * CSOL + 5 * CSOL * 196 / 100 - env.position_rent());
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
    // Each strike goes in its own window, from strike_end up to exit_start.
    env.warp(T0 + 100);
    env.set_strike(0, &admin, vec![]).unwrap();
    env.warp(T0 + 160);
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

/// Closed: no lamports, no data, owned by the System Program (or gone from the ledger entirely).
fn assert_closed(env: &Env, key: &Pubkey) {
    if let Some(account) = env.svm.get_account(key) {
        assert_eq!((account.lamports, account.data.len(), account.owner), (0, 0, system_program::ID));
    }
}

#[test]
fn a_bet_takes_the_position_rent_from_the_vault_and_the_device_key_pays_only_the_fee() {
    let mut env = Env::new();
    let a = env.player(SOL);
    let rent = env.position_rent();
    env.create_round(0, T0, SOL).unwrap();
    let owner = a.owner.pubkey();
    let (key_before, config_lamports) = (env.lamports(&a.key.pubkey()), env.lamports(&config_pda()));
    let before: Config = env.read(&config_pda());
    env.bet(0, &a, Side::Up, 5 * CSOL).unwrap();

    let v = env.vault(&owner);
    assert_eq!((v.available, v.locked), (SOL - 5 * CSOL - rent, 5 * CSOL));
    let c: Config = env.read(&config_pda());
    assert_eq!((c.total_available, c.total_locked), (before.total_available - 5 * CSOL - rent, before.total_locked + 5 * CSOL));
    // Exactly the rent left Config, into the position; the device key paid the signature fee alone.
    let position = position_pda(&round_pda(0), &owner);
    assert_eq!((env.lamports(&config_pda()), env.lamports(&position)), (config_lamports - rent, rent));
    assert_eq!(env.lamports(&a.key.pubkey()), key_before - 5_000);
    let p: Position = env.read(&position);
    assert_eq!((p.round, p.authority, p.side, p.stake, p.face), (round_pda(0), owner, Side::Up, 5 * CSOL, [1, 2, 3, 4, 5, 0, 0, 0]));
    assert_eq!((p.is_house, p.claimed, p.payout), (false, false, 0));
    assert_eq!(env.svm.get_account(&position).unwrap().owner, ID);
    // The session budget counts the stake, never the rent.
    let s: Session = env.read(&session_pda(&vault_pda(&owner), &a.key.pubkey()));
    assert_eq!(s.spent, 5 * CSOL);
    env.assert_books(&[0]);

    // Stake plus rent must be available.
    let b = env.player(2 * CSOL + rent - 1);
    assert_err(env.bet(0, &b, Side::Down, 2 * CSOL), "InsufficientAvailable");
    env.bet(0, &b, Side::Down, 2 * CSOL - 1).unwrap();
    assert_eq!(env.vault(&b.owner.pubkey()).available, 0);
    env.assert_books(&[0]);
}

#[test]
fn a_house_fill_takes_the_position_rent_from_the_house_vault() {
    let mut env = Env::new();
    let (a, b) = (env.player(SOL), env.player(SOL));
    let admin = env.admin.insecure_clone();
    let rent = env.position_rent();
    env.create_round(0, T0, SOL).unwrap();
    env.create_round(1, T0 + 60, SOL).unwrap();
    env.bet(0, &a, Side::Up, 5 * CSOL).unwrap();
    env.warp(T0 + 60);
    let house = env.vault(&admin.pubkey());
    let (wallet, config_lamports) = (env.lamports(&admin.pubkey()), env.lamports(&config_pda()));
    env.house_fill(0, &admin, 5 * CSOL).unwrap();
    let after = env.vault(&admin.pubkey());
    assert_eq!((after.available, after.locked), (house.available - 5 * CSOL - rent, house.locked + 5 * CSOL));
    // The house key signed and, as fee payer here, paid the fee alone; the caps count the stake.
    assert_eq!(env.lamports(&admin.pubkey()), wallet - 5_000);
    assert_eq!(env.lamports(&config_pda()), config_lamports - rent);
    assert_eq!(env.house_limits().spent, 5 * CSOL);
    env.assert_books(&[0, 1]);

    // A house vault without stake plus rent cannot fill.
    env.bet(1, &b, Side::Up, 5 * CSOL).unwrap();
    env.warp(T0 + 120);
    let keep = 5 * CSOL + rent - 1;
    let available = env.vault(&admin.pubkey()).available;
    env.withdraw(&admin, available - keep).unwrap();
    assert_err(env.house_fill(1, &admin, 5 * CSOL), "InsufficientAvailable");
    env.house_fill(1, &admin, 5 * CSOL - 1).unwrap();
    assert_eq!(env.vault(&admin.pubkey()).available, 0);
    env.assert_books(&[0, 1]);
}

#[test]
fn a_pre_funded_position_address_takes_only_what_it_lacks() {
    let mut env = Env::new();
    let (a, b) = (env.player(SOL), env.player(SOL));
    let rent = env.position_rent();
    env.create_round(0, T0, SOL).unwrap();
    let (a_position, b_position) = (position_pda(&round_pda(0), &a.owner.pubkey()), position_pda(&round_pda(0), &b.owner.pubkey()));
    // Anyone can send lamports to an address: part of the rent to one, twice the rent to the other.
    let gift = 1_000_000;
    assert!(gift < rent);
    env.svm.airdrop(&a_position, gift).unwrap();
    env.svm.airdrop(&b_position, 2 * rent).unwrap();
    let config_lamports = env.lamports(&config_pda());
    env.bet(0, &a, Side::Up, 5 * CSOL).unwrap();
    env.bet(0, &b, Side::Down, 5 * CSOL).unwrap();
    // Only the missing part moved, and only that was charged.
    assert_eq!(env.vault(&a.owner.pubkey()).available, SOL - 5 * CSOL - (rent - gift));
    assert_eq!(env.vault(&b.owner.pubkey()).available, SOL - 5 * CSOL);
    assert_eq!((env.lamports(&a_position), env.lamports(&b_position)), (rent, 2 * rent));
    assert_eq!(env.lamports(&config_pda()), config_lamports - (rent - gift));
    assert_eq!(env.read::<Position>(&b_position).stake, 5 * CSOL);
    env.assert_books(&[0]);

    // Closing hands every lamport of the position to its owner's vault, the gift included.
    env.price_round(0, 1_000, 1_100);
    env.claim(0, &a.owner.pubkey()).unwrap();
    env.claim(0, &b.owner.pubkey()).unwrap();
    env.warp(env.round(0).exit_end + POSITION_CLOSE_DELAY_SECS);
    env.close_position(0, &a.owner.pubkey()).unwrap();
    env.close_position(0, &b.owner.pubkey()).unwrap();
    assert_eq!(env.vault(&a.owner.pubkey()).available, SOL - 5 * CSOL + 5 * CSOL * 196 / 100 + gift);
    assert_eq!(env.vault(&b.owner.pubkey()).available, SOL - 5 * CSOL + 2 * rent);
    env.assert_books(&[0]);
}

#[test]
fn an_existing_position_cannot_be_created_again() {
    let mut env = Env::new();
    let a = env.player(SOL);
    env.create_round(0, T0, SOL).unwrap();
    env.bet(0, &a, Side::Up, 2 * CSOL).unwrap();
    let position = position_pda(&round_pda(0), &a.owner.pubkey());
    let (vault, config_lamports, data) = (env.vault(&a.owner.pubkey()), env.lamports(&config_pda()), env.svm.get_account(&position).unwrap().data);
    // Same key, or another session key of the same owner: the position address is the same.
    assert_err(env.bet(0, &a, Side::Down, 2 * CSOL), "already in use");
    let other = Keypair::new();
    env.svm.airdrop(&other.pubkey(), SOL).unwrap();
    env.start_session(&a.owner, &other, T0 + 3_600, 10 * CSOL, SOL).unwrap();
    let again = Player { owner: a.owner.insecure_clone(), key: other };
    assert_err(env.bet(0, &again, Side::Down, 2 * CSOL), "already in use");
    // Nothing moved.
    assert_eq!(env.vault(&a.owner.pubkey()).available, vault.available);
    assert_eq!(env.lamports(&config_pda()), config_lamports);
    assert_eq!(env.svm.get_account(&position).unwrap().data, data);
    assert_eq!(env.round(0).position_count, 1);
}

#[test]
fn a_claimed_position_closes_an_hour_after_the_exit_window_and_its_rent_goes_back_into_the_vault() {
    let mut env = Env::new();
    let a = env.player(SOL);
    let admin = env.admin.insecure_clone();
    let owner = a.owner.pubkey();
    let rent = env.position_rent();
    env.create_round(0, T0, SOL).unwrap();
    env.bet(0, &a, Side::Up, 5 * CSOL).unwrap();
    env.warp(T0 + 60);
    env.house_fill(0, &admin, 5 * CSOL).unwrap();
    // Open and Live rounds: nothing closes.
    assert_err(env.close_position(0, &owner), "NotFinal");
    let r = env.round(0);
    env.warp(r.strike_end);
    env.set_strike(0, &admin, samples(100, &[1_000; 6])).unwrap();
    assert_err(env.close_position(0, &owner), "NotFinal");
    env.warp(r.exit_end);
    env.settle(0, samples(200, &[1_100; 6])).unwrap();
    // Final but not paid: the stake is still locked in the vault and claim needs the account.
    assert_err(env.close_position(0, &owner), "NotClaimed");
    env.claim(0, &owner).unwrap();
    env.claim(0, &admin.pubkey()).unwrap();
    env.warp(r.exit_end + POSITION_CLOSE_DELAY_SECS - 1);
    assert_err(env.close_position(0, &owner), "NotDue");

    env.warp(r.exit_end + POSITION_CLOSE_DELAY_SECS);
    let position = position_pda(&round_pda(0), &owner);
    let (wallet, key, config_lamports) = (env.lamports(&owner), env.lamports(&a.key.pubkey()), env.lamports(&config_pda()));
    let (vault_before, books): (Vault, Config) = (env.vault(&owner), env.read(&config_pda()));
    let logs = env.close_position(0, &owner).unwrap();
    // The rent is available in the vault again; no wallet moved (a stranger paid the fee).
    let v = env.vault(&owner);
    assert_eq!((v.available, v.locked), (vault_before.available + rent, vault_before.locked));
    assert_eq!(v.available, SOL - 5 * CSOL + 5 * CSOL * 196 / 100);
    let c: Config = env.read(&config_pda());
    assert_eq!((c.total_available, c.total_locked), (books.total_available + rent, books.total_locked));
    assert_eq!(env.lamports(&config_pda()), config_lamports + rent);
    assert_eq!((env.lamports(&owner), env.lamports(&a.key.pubkey())), (wallet, key));
    assert_closed(&env, &position);
    let event = PositionClosed { round_id: 0, authority: owner, is_house: false, lamports: rent };
    assert!(logs.contains(&format!("Program data: {}", base64(&event.data()))), "{logs:?}");
    env.assert_books(&[0]);

    // Gone for good: no second close, no second claim, and no bet can create it again.
    assert_err(env.close_position(0, &owner), "AccountNotInitialized");
    assert_err(env.claim(0, &owner), "AccountNotInitialized");
    assert_err(env.bet(0, &a, Side::Up, 5 * CSOL), "RoundNotOpen");
    assert_closed(&env, &position);
    assert_eq!(env.vault(&owner).available, v.available);

    // The house position closes into the house vault, and the house cannot fill the final round again.
    let house_vault = env.vault(&admin.pubkey()).available;
    let admin_wallet = env.lamports(&admin.pubkey());
    env.close_position(0, &admin.pubkey()).unwrap();
    assert_eq!(env.vault(&admin.pubkey()).available, house_vault + rent);
    assert_eq!(env.lamports(&admin.pubkey()), admin_wallet);
    assert_err(env.house_fill(0, &admin, CSOL), "NotFillWindow");
    assert_closed(&env, &position_pda(&round_pda(0), &admin.pubkey()));

    // Closing took both counts down together, so the fee sweep still works with every position closed.
    let r = env.round(0);
    assert_eq!((r.position_count, r.claimed_count), (0, 0));
    let before = env.lamports(&env.treasury.pubkey());
    env.sweep(0).unwrap();
    assert_eq!(env.lamports(&env.treasury.pubkey()) - before, 10 * CSOL * 2 / 100);
    env.assert_books(&[0]);
}

#[test]
fn a_position_from_before_the_upgrade_closes_into_the_vault_too() {
    let mut env = Env::new();
    let (a, b) = (env.player(SOL), env.player(SOL));
    let rent = env.position_rent();
    env.create_round(0, T0, SOL).unwrap();
    env.bet(0, &a, Side::Up, 5 * CSOL).unwrap();
    env.bet(0, &b, Side::Down, 5 * CSOL).unwrap();
    // As the October program left them: same account bytes, but the device keys paid the rent.
    env.as_if_a_key_paid_the_rent(&a.owner.pubkey());
    env.as_if_a_key_paid_the_rent(&b.owner.pubkey());
    assert_eq!(env.vault(&a.owner.pubkey()).available, SOL - 5 * CSOL);
    env.assert_books(&[0]);
    env.price_round(0, 1_000, 900);
    env.claim(0, &a.owner.pubkey()).unwrap();
    env.claim(0, &b.owner.pubkey()).unwrap();
    env.warp(env.round(0).exit_end + POSITION_CLOSE_DELAY_SECS);
    env.close_position(0, &a.owner.pubkey()).unwrap();
    env.close_position(0, &b.owner.pubkey()).unwrap();
    // The rent a device key paid lands in the game balance, which is intended.
    assert_eq!(env.vault(&a.owner.pubkey()).available, SOL - 5 * CSOL + rent);
    assert_eq!(env.vault(&b.owner.pubkey()).available, SOL - 5 * CSOL + 5 * CSOL * 196 / 100 + rent);
    env.assert_books(&[0]);
}

#[test]
fn closing_needs_the_owners_vault_and_the_round_of_the_position() {
    let mut env = Env::new();
    let (a, b) = (env.player(SOL), env.player(SOL));
    env.create_round(0, T0, SOL).unwrap();
    env.create_round(1, T0 + 60, SOL).unwrap();
    env.bet(0, &a, Side::Up, 5 * CSOL).unwrap();
    env.bet(0, &b, Side::Down, 5 * CSOL).unwrap();
    env.price_round(0, 1_000, 900);
    env.claim(0, &a.owner.pubkey()).unwrap();
    env.claim(0, &b.owner.pubkey()).unwrap();
    env.warp(env.round(0).exit_end + POSITION_CLOSE_DELAY_SECS);
    let anyone = Keypair::new();
    env.svm.airdrop(&anyone.pubkey(), SOL).unwrap();
    let round = round_pda(0);
    let a_position = position_pda(&round, &a.owner.pubkey());
    let close = |round, vault| ix(acc::ClosePosition { config: config_pda(), round, position: a_position, vault }, ixs::ClosePosition {});
    // The rent cannot go into another player's vault.
    assert_err(env.send(vec![close(round, vault_pda(&b.owner.pubkey()))], &anyone, &[&anyone]), "ConstraintSeeds");
    // Nor can another round (here an open one) stand in for the position's own final round.
    assert_err(env.send(vec![close(round_pda(1), vault_pda(&a.owner.pubkey()))], &anyone, &[&anyone]), "ConstraintSeeds");
    assert!(env.lamports(&a_position) > 0);
    env.close_position(0, &a.owner.pubkey()).unwrap();
    env.close_position(0, &b.owner.pubkey()).unwrap();
    env.assert_books(&[0]);
}

#[test]
fn refunded_positions_are_claimed_like_any_other_and_close_the_same_way() {
    let mut env = Env::new();
    let (a, b, c) = (env.player(SOL), env.player(SOL), env.player(SOL));
    let admin = env.admin.insecure_clone();
    env.create_round(0, T0, SOL).unwrap();
    env.create_round(1, T0 + 60, SOL).unwrap();
    // Round 0: a lone bet, NotActivated at the strike. Round 1: matched, but nobody prices it.
    env.bet(0, &a, Side::Up, 5 * CSOL).unwrap();
    env.warp(T0 + 60);
    env.bet(1, &b, Side::Up, 5 * CSOL).unwrap();
    env.bet(1, &c, Side::Down, 5 * CSOL).unwrap();
    env.warp(T0 + 100);
    env.set_strike(0, &admin, vec![]).unwrap();
    assert_eq!(env.round(0).outcome, Outcome::NotActivated);
    let r1 = env.round(1);
    env.warp(r1.settle_deadline + 1);
    let anyone = Keypair::new();
    env.svm.airdrop(&anyone.pubkey(), SOL).unwrap();
    env.send(vec![ix(acc::RefundExpired { round: round_pda(1) }, ixs::RefundExpired {})], &anyone, &[&anyone]).unwrap();
    assert_eq!((env.round(1).outcome, env.round(1).refund_reason), (Outcome::Refund, RefundReason::Expired));
    // A refund is paid by claim like a win, and only claim sets the flag: unpaid, it stays.
    env.warp(r1.exit_end + POSITION_CLOSE_DELAY_SECS);
    assert_err(env.close_position(1, &b.owner.pubkey()), "NotClaimed");
    let rent = env.position_rent();
    for (id, p) in [(0, &a), (1, &b), (1, &c)] {
        env.claim(id, &p.owner.pubkey()).unwrap();
        let before = env.vault(&p.owner.pubkey()).available;
        env.close_position(id, &p.owner.pubkey()).unwrap();
        assert_eq!(env.vault(&p.owner.pubkey()).available, before + rent);
    }
    // The lone bet is back in full, rent included.
    assert_eq!(env.vault(&a.owner.pubkey()).available, SOL);
    env.assert_books(&[0, 1]);
}

#[test]
fn a_played_round_closes_once_every_position_is_closed_and_its_fees_are_swept() {
    let mut env = Env::new();
    let (a, b) = (env.player(SOL), env.player(SOL));
    let admin = env.admin.insecure_clone();
    let (owner_a, owner_b, house) = (a.owner.pubkey(), b.owner.pubkey(), admin.pubkey());
    env.create_round(0, T0, SOL).unwrap();
    let round_rent = env.lamports(&round_pda(0));
    env.bet(0, &a, Side::Up, 5 * CSOL).unwrap();
    env.bet(0, &b, Side::Down, 3 * CSOL).unwrap();
    env.warp(T0 + 60);
    env.house_fill(0, &admin, 2 * CSOL).unwrap();
    env.price_round(0, 1_000, 1_100);
    for owner in [owner_a, owner_b, house] {
        env.claim(0, &owner).unwrap();
    }
    let r = env.round(0);
    assert_eq!((r.position_count, r.claimed_count), (3, 3));
    // Final and paid, but its positions are still on chain.
    assert_err(env.close_empty_round(0), "NotClosable");

    // Each closed position takes one off both counts, so they stay equal and the sweep stays open.
    env.warp(r.exit_end + POSITION_CLOSE_DELAY_SECS);
    env.close_position(0, &owner_a).unwrap();
    assert_eq!((env.round(0).position_count, env.round(0).claimed_count), (2, 2));
    env.close_position(0, &owner_b).unwrap();
    assert_eq!((env.round(0).position_count, env.round(0).claimed_count), (1, 1));
    env.assert_books(&[0]);

    // The fees are swept with two positions already closed, and the last one still blocks the close.
    let treasury_before = env.lamports(&env.treasury.pubkey());
    env.sweep(0).unwrap();
    assert_eq!(env.lamports(&env.treasury.pubkey()) - treasury_before, 10 * CSOL * 2 / 100);
    assert_err(env.close_empty_round(0), "NotClosable");
    assert!(env.svm.get_account(&round_pda(0)).is_some());
    env.assert_books(&[0]);

    // The house position closes the same way; then nobody is left and the round closes for good.
    env.close_position(0, &house).unwrap();
    let r = env.round(0);
    assert_eq!((r.position_count, r.claimed_count, r.fees_swept), (0, 0, true));
    let admin_before = env.lamports(&admin.pubkey());
    env.close_empty_round(0).unwrap();
    assert_closed(&env, &round_pda(0));
    assert_eq!(env.lamports(&admin.pubkey()), admin_before + round_rent - 5_000, "the round's rent goes back to the admin");
    assert_err(env.close_empty_round(0), "AccountNotInitialized");
    env.assert_books(&[]);
}

#[test]
fn a_played_round_whose_fees_are_not_swept_stays_so_the_fee_cannot_be_stranded() {
    let (mut env, a, b) = matched_round();
    env.price_round(0, 1_000, 900);
    for p in [&a, &b] {
        env.claim(0, &p.owner.pubkey()).unwrap();
    }
    env.warp(env.round(0).exit_end + POSITION_CLOSE_DELAY_SECS);
    for p in [&a, &b] {
        env.close_position(0, &p.owner.pubkey()).unwrap();
    }
    let r = env.round(0);
    assert_eq!((r.position_count, r.claimed_count, r.fees_swept), (0, 0, false));
    // The 2% fee still sits in Config: closing the round now would leave it there for good.
    assert_err(env.close_empty_round(0), "NotClosable");
    assert!(env.svm.get_account(&round_pda(0)).is_some());
    env.assert_books(&[0]);

    // The sweep still works with both counts at 0, and only after it the round closes.
    let treasury_before = env.lamports(&env.treasury.pubkey());
    env.sweep(0).unwrap();
    assert_eq!(env.lamports(&env.treasury.pubkey()) - treasury_before, 10 * CSOL * 2 / 100);
    env.close_empty_round(0).unwrap();
    assert_closed(&env, &round_pda(0));
    env.assert_books(&[]);
}

#[test]
fn a_round_with_an_unclaimed_position_cannot_be_swept_or_closed_however_many_others_are_closed() {
    let (mut env, a, b) = matched_round();
    // Down wins: b (unclaimed, stake still locked) is the winner, a has lost.
    env.price_round(0, 1_000, 900);
    env.claim(0, &a.owner.pubkey()).unwrap();
    env.warp(env.round(0).exit_end + POSITION_CLOSE_DELAY_SECS);
    env.close_position(0, &a.owner.pubkey()).unwrap();
    let r = env.round(0);
    assert_eq!((r.position_count, r.claimed_count), (1, 0));
    // (assert_books only handles rounds claimed whole or not at all, so Config is compared directly.)
    let config_before = env.lamports(&config_pda());
    assert_err(env.sweep(0), "NotSweepable");
    assert_err(env.close_empty_round(0), "NotClosable");
    assert_err(env.close_position(0, &b.owner.pubkey()), "NotClaimed");
    assert_eq!(env.lamports(&config_pda()), config_before);

    // The player who has not claimed yet still gets paid in full, and then everything closes.
    env.claim(0, &b.owner.pubkey()).unwrap();
    env.close_position(0, &b.owner.pubkey()).unwrap();
    assert_eq!(env.vault(&b.owner.pubkey()).available, SOL - 5 * CSOL + 5 * CSOL * 196 / 100);
    env.sweep(0).unwrap();
    env.close_empty_round(0).unwrap();
    assert_closed(&env, &round_pda(0));
    env.assert_books(&[]);
}

#[test]
fn a_round_with_nothing_left_to_sweep_closes_without_a_sweep() {
    let mut env = Env::new();
    env.set_refund_fee(0);
    let (a, b) = (env.player(SOL), env.player(SOL));
    env.create_round(0, T0, SOL).unwrap();
    env.bet(0, &a, Side::Up, 5 * CSOL).unwrap();
    env.bet(0, &b, Side::Down, 5 * CSOL).unwrap();
    env.price_round(0, 1_000, 1_000);
    assert_eq!((env.round(0).outcome, env.round(0).refund_reason), (Outcome::Refund, RefundReason::Tie));
    for p in [&a, &b] {
        env.claim(0, &p.owner.pubkey()).unwrap();
    }
    env.warp(env.round(0).exit_end + POSITION_CLOSE_DELAY_SECS);
    for p in [&a, &b] {
        env.close_position(0, &p.owner.pubkey()).unwrap();
    }
    // Everything went back to the players, so there is no fee to strand: the sweep is not needed.
    let r = env.round(0);
    assert_eq!((r.position_count, r.fees_swept, r.total_paid), (0, false, r.raw_up + r.raw_down));
    let treasury_before = env.lamports(&env.treasury.pubkey());
    env.close_empty_round(0).unwrap();
    assert_closed(&env, &round_pda(0));
    assert_eq!(env.lamports(&env.treasury.pubkey()), treasury_before);
    env.assert_books(&[]);
}

#[test]
fn every_position_of_a_round_closes_in_one_transaction_as_the_keeper_sends_them() {
    let mut env = Env::new();
    let (a, b) = (env.player(SOL), env.player(SOL));
    let admin = env.admin.insecure_clone();
    env.create_round(0, T0, SOL).unwrap();
    env.bet(0, &a, Side::Up, 5 * CSOL).unwrap();
    env.bet(0, &b, Side::Down, 3 * CSOL).unwrap();
    env.warp(T0 + 60);
    env.house_fill(0, &admin, 2 * CSOL).unwrap();
    env.price_round(0, 1_000, 1_100);
    let owners = [a.owner.pubkey(), b.owner.pubkey(), admin.pubkey()];
    for owner in owners {
        env.claim(0, &owner).unwrap();
    }
    env.warp(env.round(0).exit_end + POSITION_CLOSE_DELAY_SECS);
    let round = round_pda(0);
    let closes: Vec<Instruction> = owners
        .iter()
        .map(|owner| {
            ix(
                acc::ClosePosition { config: config_pda(), round, position: position_pda(&round, owner), vault: vault_pda(owner) },
                ixs::ClosePosition {},
            )
        })
        .collect();
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), SOL).unwrap();
    env.send(closes, &stranger, &[&stranger]).unwrap();
    let r = env.round(0);
    assert_eq!((r.position_count, r.claimed_count), (0, 0));
    for owner in owners {
        assert_closed(&env, &position_pda(&round, &owner));
    }
    env.assert_books(&[0]);
    env.sweep(0).unwrap();
    env.close_empty_round(0).unwrap();
    assert_closed(&env, &round);
    env.assert_books(&[]);
}

#[test]
fn closing_a_position_needs_the_round_account_writable() {
    let (mut env, a, b) = matched_round();
    env.price_round(0, 1_000, 900);
    for p in [&a, &b] {
        env.claim(0, &p.owner.pubkey()).unwrap();
    }
    env.warp(env.round(0).exit_end + POSITION_CLOSE_DELAY_SECS);
    let round = round_pda(0);
    let owner = a.owner.pubkey();
    let mut old_meta = ix(
        acc::ClosePosition { config: config_pda(), round, position: position_pda(&round, &owner), vault: vault_pda(&owner) },
        ixs::ClosePosition {},
    );
    // What an app built before this change sent: the round account read-only.
    assert!(old_meta.accounts[1].is_writable, "the current builder marks the round writable");
    old_meta.accounts[1].is_writable = false;
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), SOL).unwrap();
    assert_err(env.send(vec![old_meta], &stranger, &[&stranger]), "ConstraintMut");
    assert!(env.lamports(&position_pda(&round, &owner)) > 0, "nothing was closed");
    assert_eq!((env.round(0).position_count, env.round(0).claimed_count), (2, 2));
    env.close_position(0, &owner).unwrap();
}

#[test]
fn only_the_admin_sets_house_limits_and_without_them_the_house_cannot_fill() {
    let mut env = Env::bare();
    let a = env.player(SOL);
    let admin = env.admin.insecure_clone();
    env.create_round(0, T0, SOL).unwrap();
    env.bet(0, &a, Side::Up, 5 * CSOL).unwrap();
    env.warp(T0 + 60);
    assert_err(env.house_fill(0, &admin, 5 * CSOL), "AccountNotInitialized");
    let mallory = Keypair::new();
    env.svm.airdrop(&mallory.pubkey(), SOL).unwrap();
    assert_err(env.init_house_limits(&mallory, u64::MAX, u64::MAX), "Unauthorized");
    env.init_house_limits(&admin, 5 * CSOL, 8 * CSOL).unwrap();
    let limits = env.house_limits();
    assert_eq!(
        (limits.round_cap, limits.daily_cap, limits.day, limits.spent),
        (5 * CSOL, 8 * CSOL, (T0 + 60).div_euclid(SECS_PER_DAY), 0)
    );
    assert_err(env.init_house_limits(&admin, SOL, SOL), "already in use");
    env.house_fill(0, &admin, 5 * CSOL).unwrap();
    assert_eq!(env.house_limits().spent, 5 * CSOL);
    assert_err(env.update_house_limits(&mallory, u64::MAX, u64::MAX), "Unauthorized");
    // New caps apply at once; what the house spent today still counts.
    env.update_house_limits(&admin, 2 * CSOL, 6 * CSOL).unwrap();
    let limits = env.house_limits();
    assert_eq!((limits.round_cap, limits.daily_cap, limits.spent), (2 * CSOL, 6 * CSOL, 5 * CSOL));
}

#[test]
fn the_round_cap_limits_the_house_total_in_a_round_even_across_house_keys() {
    let mut env = Env::new();
    let a = env.player(SOL);
    let admin = env.admin.insecure_clone();
    env.update_house_limits(&admin, 4 * CSOL, SOL).unwrap();
    env.create_round(0, T0, SOL).unwrap();
    env.bet(0, &a, Side::Up, 5 * CSOL).unwrap();
    env.warp(T0 + 60);
    assert_err(env.house_fill(0, &admin, 5 * CSOL), "HouseRoundCapExceeded");
    env.house_fill(0, &admin, 3 * CSOL).unwrap();
    // A rotated house key has its own position seed and could fill the same round again.
    let second = Keypair::new();
    env.svm.airdrop(&second.pubkey(), 3 * SOL).unwrap();
    env.open_and_deposit(&second, SOL);
    let mut params = env.params();
    params.house_authority = second.pubkey();
    env.send_admin(ix(acc::AdminConfig { config: config_pda(), admin: admin.pubkey() }, ixs::UpdateConfig { params })).unwrap();
    assert_err(env.house_fill(0, &second, 2 * CSOL), "HouseRoundCapExceeded");
    env.house_fill(0, &second, CSOL).unwrap();
    let r = env.round(0);
    assert_eq!((r.raw_up, r.raw_down, r.house_amount, r.position_count), (5 * CSOL, 4 * CSOL, 4 * CSOL, 3));
    assert_eq!(env.house_limits().spent, 4 * CSOL);
}

#[test]
fn the_daily_cap_counts_per_utc_day() {
    let mut env = Env::new();
    let (a, b, c) = (env.player(SOL), env.player(SOL), env.player(SOL));
    let admin = env.admin.insecure_clone();
    env.update_house_limits(&admin, 5 * CSOL, 7 * CSOL).unwrap();
    let day = T0.div_euclid(SECS_PER_DAY);
    env.create_round(0, T0, SOL).unwrap();
    env.create_round(1, T0 + 60, SOL).unwrap();
    env.bet(0, &a, Side::Up, 5 * CSOL).unwrap();
    env.warp(T0 + 60);
    env.house_fill(0, &admin, 5 * CSOL).unwrap();
    env.bet(1, &b, Side::Up, 5 * CSOL).unwrap();
    env.warp(T0 + 120);
    assert_err(env.house_fill(1, &admin, 5 * CSOL), "HouseDailyCapExceeded");
    env.house_fill(1, &admin, 2 * CSOL).unwrap();
    let limits = env.house_limits();
    assert_eq!((limits.day, limits.spent), (day, 7 * CSOL));

    // The next UTC day starts from zero. A round may open at most 15 minutes ahead, so the clock
    // moves close to midnight before round 2 is created.
    let midnight = (day + 1) * SECS_PER_DAY;
    env.warp(midnight - 60);
    env.create_round(2, midnight, SOL).unwrap();
    env.warp(midnight);
    env.start_session(&c.owner, &c.key, midnight + 3_600, 10 * CSOL, SOL).unwrap();
    env.bet(2, &c, Side::Up, 5 * CSOL).unwrap();
    env.warp(midnight + 60);
    env.house_fill(2, &admin, 5 * CSOL).unwrap();
    let limits = env.house_limits();
    assert_eq!((limits.day, limits.spent), (day + 1, 5 * CSOL));
}

#[test]
fn only_the_admin_configures_the_oracle_and_prices_need_its_account() {
    let mut env = Env::bare();
    let (a, b) = (env.player(SOL), env.player(SOL));
    let admin = env.admin.insecure_clone();
    env.create_round(0, T0, SOL).unwrap();
    env.bet(0, &a, Side::Up, 5 * CSOL).unwrap();
    env.bet(0, &b, Side::Down, 5 * CSOL).unwrap();
    env.warp(T0 + 100);
    assert_err(env.set_strike(0, &admin, samples(1, &[1_000; 6])), "AccountNotInitialized");
    let mallory = Keypair::new();
    env.svm.airdrop(&mallory.pubkey(), SOL).unwrap();
    let attestor = Keypair::new();
    assert_err(env.init_oracle(&mallory, mallory.pubkey(), false), "Unauthorized");
    // A required attestor must be a key that can sign.
    assert_err(env.init_oracle(&admin, Pubkey::default(), true), "InvalidAttestor");
    assert_err(env.init_oracle(&admin, ID, true), "InvalidAttestor");
    env.init_oracle(&admin, attestor.pubkey(), false).unwrap();
    let oracle: OracleConfig = env.read(&oracle_pda());
    assert_eq!((oracle.attestor, oracle.required), (attestor.pubkey(), false));
    assert_err(env.init_oracle(&admin, attestor.pubkey(), false), "already in use");
    assert_err(env.set_oracle(&mallory, mallory.pubkey(), false), "Unauthorized");
    env.set_oracle(&admin, attestor.pubkey(), true).unwrap();
    assert!(env.read::<OracleConfig>(&oracle_pda()).required);
    // Switching it off again takes the attestor's co-signature (see the next test).
    env.set_oracle_cosigned(&admin, attestor.pubkey(), false, Some(&attestor)).unwrap();
    // Not required: prices go through exactly as before, and a co-signature is simply ignored.
    env.set_strike(0, &admin, samples(1, &[1_000; 6])).unwrap();
    env.warp(env.round(0).exit_end);
    let stranger = Keypair::new();
    env.send_attested(price_ix(0, &admin.pubkey(), Some(stranger.pubkey()), ixs::Settle { samples: samples(50, &[900; 6]) }), &stranger)
        .unwrap();
    assert_eq!(env.round(0).outcome, Outcome::Down);
}

#[test]
fn a_stolen_admin_key_alone_cannot_weaken_a_required_oracle() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let (first, second, third) = (Keypair::new(), Keypair::new(), Keypair::new());
    let oracle = |env: &Env| {
        let o: OracleConfig = env.read(&oracle_pda());
        (o.attestor, o.required)
    };
    // Not required yet: the admin alone picks an attestor and turns the requirement on.
    env.set_oracle(&admin, second.pubkey(), false).unwrap();
    env.set_oracle(&admin, first.pubkey(), false).unwrap();
    env.set_oracle(&admin, first.pubkey(), true).unwrap();
    // Required: the admin alone can neither switch it off nor replace the attestor.
    assert_err(env.set_oracle(&admin, first.pubkey(), false), "AttestorRequired");
    assert_err(env.set_oracle(&admin, second.pubkey(), true), "AttestorRequired");
    assert_err(env.set_oracle(&admin, second.pubkey(), false), "AttestorRequired");
    // Only the attestor in office counts as co-signer, and it must really sign.
    assert_err(env.set_oracle_cosigned(&admin, first.pubkey(), false, Some(&second)), "InvalidAttestor");
    let mut unsigned = ix(
        acc::SetOracle { config: config_pda(), oracle: oracle_pda(), admin: admin.pubkey(), current_attestor: Some(first.pubkey()) },
        ixs::SetOracle { attestor: first.pubkey(), required: false },
    );
    unsigned.accounts[3].is_signer = false;
    assert_err(env.send_admin(unsigned), "AccountNotSigner");
    // The attestor alone is no admin either.
    env.svm.airdrop(&first.pubkey(), SOL).unwrap();
    assert_err(env.set_oracle_cosigned(&first, first.pubkey(), false, Some(&first)), "Unauthorized");
    // Nothing above changed it; repeating the current setting needs no co-signer.
    assert_eq!(oracle(&env), (first.pubkey(), true));
    env.set_oracle(&admin, first.pubkey(), true).unwrap();

    // Admin and the attestor in office together: rotate, then switch off.
    env.set_oracle_cosigned(&admin, second.pubkey(), true, Some(&first)).unwrap();
    assert_eq!(oracle(&env), (second.pubkey(), true));
    assert_err(env.set_oracle_cosigned(&admin, second.pubkey(), false, Some(&first)), "InvalidAttestor");
    env.set_oracle_cosigned(&admin, second.pubkey(), false, Some(&second)).unwrap();
    assert_eq!(oracle(&env), (second.pubkey(), false));
    // Off again: the admin alone may rotate and require once more.
    env.set_oracle(&admin, third.pubkey(), false).unwrap();
    env.set_oracle(&admin, third.pubkey(), true).unwrap();
    assert_eq!(oracle(&env), (third.pubkey(), true));
}

#[test]
fn a_required_attestor_must_sign_every_price() {
    let mut env = Env::new();
    let (a, b) = (env.player(SOL), env.player(SOL));
    let admin = env.admin.insecure_clone();
    let attestor = Keypair::new();
    env.set_oracle(&admin, attestor.pubkey(), true).unwrap();
    env.create_round(0, T0, SOL).unwrap();
    env.bet(0, &a, Side::Up, 5 * CSOL).unwrap();
    env.bet(0, &b, Side::Down, 5 * CSOL).unwrap();
    let r = env.round(0);
    env.warp(r.strike_end);
    let strike = |attestor: Option<Pubkey>| price_ix(0, &admin.pubkey(), attestor, ixs::SetStrike { samples: samples(100, &[1_000; 6]) });
    assert_err(env.send_admin(strike(None)), "DetachedPriceRequired");
    let impostor = Keypair::new();
    assert_err(env.send_attested(strike(Some(impostor.pubkey())), &impostor), "DetachedPriceRequired");
    let mut unsigned = strike(Some(attestor.pubkey()));
    unsigned.accounts[4].is_signer = false;
    assert_err(env.send_admin(unsigned), "AccountNotSigner");
    assert_err(env.send_attested(strike(Some(attestor.pubkey())), &attestor), "DetachedPriceRequired");
    let free_payer = Keypair::new();
    env.svm.airdrop(&free_payer.pubkey(), SOL).unwrap();
    let mut wrong = certificate_ixs(0, &r, 0, samples(100, &[1_000; 6]), &impostor);
    assert_err(env.send(wrong.clone(), &free_payer, &[&free_payer]), "AttestationInvalid");
    wrong = certificate_ixs(0, &r, 0, samples(100, &[1_000; 6]), &attestor);
    wrong[1].data[20] ^= 1;
    assert_err(env.send(wrong, &free_payer, &[&free_payer]), "AttestationInvalid");
    let valid = certificate_ixs(0, &r, 0, samples(100, &[1_000; 6]), &attestor);
    assert_err(env.send(vec![valid[1].clone()], &free_payer, &[&free_payer]), "AttestationInvalid");
      let mut zero_signatures = valid.clone();
      zero_signatures[0].data[0] = 0;
      // The native precompile may reject this before our program is invoked.
      assert!(env.send(zero_signatures, &free_payer, &[&free_payer]).is_err());
      let mut other_pool = env.round(0);
      other_pool.pool = Pubkey::new_unique();
      assert_err(env.send(certificate_ixs(0, &other_pool, 0, samples(100, &[1_000; 6]), &attestor), &free_payer, &[&free_payer]), "AttestationInvalid");
      let mut other_window = env.round(0);
      other_window.strike_end += 1;
      assert_err(env.send(certificate_ixs(0, &other_window, 0, samples(100, &[1_000; 6]), &attestor), &free_payer, &[&free_payer]), "AttestationInvalid");
      let mut other_round = certificate_ixs(1, &r, 0, samples(100, &[1_000; 6]), &attestor);
      other_round[1] = valid[1].clone();
      assert_err(env.send(other_round, &free_payer, &[&free_payer]), "AttestationInvalid");
      let mut other_kind = certificate_ixs(0, &r, 1, samples(100, &[1_000; 6]), &attestor);
      other_kind[1] = valid[1].clone();
      assert_err(env.send(other_kind, &free_payer, &[&free_payer]), "AttestationInvalid");
    env.send(valid, &free_payer, &[&free_payer]).unwrap();
    assert_eq!((env.round(0).status, env.round(0).strike_price), (RoundStatus::Live, 1_000));

    env.warp(r.exit_end);
    let settle = |attestor: Option<Pubkey>| price_ix(0, &admin.pubkey(), attestor, ixs::Settle { samples: samples(200, &[1_100; 6]) });
    assert_err(env.send_admin(settle(None)), "DetachedPriceRequired");
    assert_err(env.send_attested(settle(Some(impostor.pubkey())), &impostor), "DetachedPriceRequired");
    let valid = certificate_ixs(0, &r, 1, samples(200, &[1_100; 6]), &attestor);
    env.send(valid.clone(), &free_payer, &[&free_payer]).unwrap();
    assert_err(env.send(valid, &free_payer, &[&free_payer]), "NotDue");
    assert_eq!((env.round(0).status, env.round(0).outcome), (RoundStatus::Final, Outcome::Up));
}

#[test]
fn an_attestor_outage_ends_in_the_normal_refund_and_unmatched_rounds_need_no_attestor() {
    let mut env = Env::new();
    let (a, b, c) = (env.player(SOL), env.player(SOL), env.player(SOL));
    let admin = env.admin.insecure_clone();
    env.set_oracle(&admin, Keypair::new().pubkey(), true).unwrap();
    env.create_round(0, T0, SOL).unwrap();
    env.create_round(1, T0 + 60, SOL).unwrap();
    env.bet(0, &a, Side::Up, 5 * CSOL).unwrap();
    env.bet(0, &b, Side::Down, 5 * CSOL).unwrap();
    env.warp(T0 + 60);
    env.bet(1, &c, Side::Up, 5 * CSOL).unwrap();
    // Round 0 is matched and the attestor never signs its price.
    env.warp(env.round(0).strike_end);
    assert_err(env.set_strike(0, &admin, samples(100, &[1_000; 6])), "DetachedPriceRequired");
    // Round 1 has no matched bank: it ends NotActivated at the strike, no price, no attestor.
    let r1 = env.round(1);
    env.warp(r1.strike_end);
    env.set_strike(1, &admin, vec![]).unwrap();
    assert_eq!(env.round(1).outcome, Outcome::NotActivated);
    // After the deadline anyone refunds round 0.
    env.warp(env.round(0).settle_deadline + 1);
    let anyone = Keypair::new();
    env.svm.airdrop(&anyone.pubkey(), SOL).unwrap();
    env.send(vec![ix(acc::RefundExpired { round: round_pda(0) }, ixs::RefundExpired {})], &anyone, &[&anyone]).unwrap();
    assert_eq!((env.round(0).outcome, env.round(0).refund_reason), (Outcome::Refund, RefundReason::Expired));
    for p in [&a, &b] {
        env.claim(0, &p.owner.pubkey()).unwrap();
        assert_eq!(env.vault(&p.owner.pubkey()).available, SOL - 5 * CSOL + 5 * CSOL * 99 / 100 - env.position_rent());
    }
    env.claim(1, &c.owner.pubkey()).unwrap();
    assert_eq!(env.vault(&c.owner.pubkey()).available, SOL - env.position_rent());
}

/// Two matched players on round 0 (opens T0): `a` UP and `b` DOWN, 5 CSOL each.
fn matched_round() -> (Env, Player, Player) {
    let mut env = Env::new();
    let (a, b) = (env.player(SOL), env.player(SOL));
    env.create_round(0, T0, SOL).unwrap();
    env.bet(0, &a, Side::Up, 5 * CSOL).unwrap();
    env.bet(0, &b, Side::Down, 5 * CSOL).unwrap();
    (env, a, b)
}

#[test]
fn the_strike_window_opens_exactly_at_strike_end() {
    let (mut env, _a, _b) = matched_round();
    let admin = env.admin.insecure_clone();
    let r = env.round(0);
    env.warp(r.strike_end - 1);
    assert_err(env.set_strike(0, &admin, samples(100, &[1_000; 6])), "NotDue");
    env.warp(r.strike_end);
    env.set_strike(0, &admin, samples(100, &[1_000; 6])).unwrap();
    assert_eq!((env.round(0).status, env.round(0).strike_price), (RoundStatus::Live, 1_000));
}

#[test]
fn the_last_second_before_the_exit_window_still_takes_a_strike() {
    let (mut env, _a, _b) = matched_round();
    let admin = env.admin.insecure_clone();
    let r = env.round(0);
    env.warp(r.exit_start - 1);
    env.set_strike(0, &admin, samples(100, &[1_000; 6])).unwrap();
    assert_eq!(env.round(0).status, RoundStatus::Live);
}

#[test]
fn no_strike_can_be_set_once_the_exit_window_has_started() {
    let (mut env, _a, _b) = matched_round();
    let admin = env.admin.insecure_clone();
    let r = env.round(0);
    // From exit_start on, through the time the exit price is known and up to the deadline.
    for now in [r.exit_start, r.exit_start + 1, r.exit_end, r.settle_deadline] {
        env.warp(now);
        assert_err(env.set_strike(0, &admin, samples(100, &[1_000; 6])), "StrikeWindowClosed");
    }
    let r = env.round(0);
    assert_eq!((r.status, r.strike_price, r.strike_samples), (RoundStatus::Open, 0, 0));
}

#[test]
fn a_round_whose_strike_was_never_set_ends_through_refund_expired() {
    let mut env = Env::new();
    let (a, b, c) = (env.player(SOL), env.player(SOL), env.player(SOL));
    let admin = env.admin.insecure_clone();
    env.create_round(0, T0, SOL).unwrap();
    env.create_round(1, T0, SOL).unwrap();
    // Round 0 is matched, round 1 holds a lone bet; nobody sets a strike in time.
    env.bet(0, &a, Side::Up, 5 * CSOL).unwrap();
    env.bet(0, &b, Side::Down, 5 * CSOL).unwrap();
    env.bet(1, &c, Side::Up, 5 * CSOL).unwrap();
    let r = env.round(0);
    env.warp(r.exit_start);
    assert_err(env.set_strike(0, &admin, samples(100, &[1_000; 6])), "StrikeWindowClosed");
    assert_err(env.set_strike(1, &admin, vec![]), "StrikeWindowClosed");
    env.warp(r.exit_end);
    assert_err(env.settle(0, samples(200, &[900; 6])), "NotDue");
    // Strict: the round is still open at the deadline itself and expires one second later.
    env.warp(r.settle_deadline);
    assert_err(env.expire(0), "NotDue");
    env.warp(r.settle_deadline + 1);
    env.expire(0).unwrap();
    env.expire(1).unwrap();
    let (r0, r1) = (env.round(0), env.round(1));
    assert_eq!((r0.status, r0.outcome, r0.refund_reason), (RoundStatus::Final, Outcome::Refund, RefundReason::Expired));
    assert_eq!((r1.status, r1.outcome, r1.refund_reason), (RoundStatus::Final, Outcome::NotActivated, RefundReason::None));
    let rent = env.position_rent();
    for p in [&a, &b] {
        env.claim(0, &p.owner.pubkey()).unwrap();
        assert_eq!(env.vault(&p.owner.pubkey()).available, SOL - 5 * CSOL + 5 * CSOL * 99 / 100 - rent);
    }
    env.claim(1, &c.owner.pubkey()).unwrap();
    assert_eq!(env.vault(&c.owner.pubkey()).available, SOL - rent);
    env.assert_books(&[0, 1]);
}

/// Round 0 on a fresh env: UP players [0] and [1], DOWN player [2], and the house fills the
/// whole gap on DOWN. Returns the players in that order.
fn house_backed_round(env: &mut Env, stakes: [u64; 3]) -> [Player; 3] {
    let admin = env.admin.insecure_clone();
    let players = [env.player(SOL), env.player(SOL), env.player(SOL)];
    env.create_round(0, T0, SOL).unwrap();
    env.bet(0, &players[0], Side::Up, stakes[0]).unwrap();
    env.bet(0, &players[1], Side::Up, stakes[1]).unwrap();
    env.bet(0, &players[2], Side::Down, stakes[2]).unwrap();
    env.warp(T0 + 60);
    let r = env.round(0);
    env.house_fill(0, &admin, r.raw_up - r.raw_down).unwrap();
    players
}

#[test]
fn an_expired_round_takes_the_house_stake_and_the_players_share_it() {
    let mut env = Env::new();
    env.set_refund_fee(0);
    let admin = env.admin.insecure_clone();
    let [a, c, b] = house_backed_round(&mut env, [6 * CSOL, 2 * CSOL, 2 * CSOL]);
    let rent = env.position_rent();
    let r = env.round(0);
    assert_eq!((r.raw_up, r.raw_down, r.house_amount), (8 * CSOL, 8 * CSOL, 6 * CSOL));
    let house = env.vault(&admin.pubkey());
    assert_eq!(house.locked, 6 * CSOL);

    env.warp(r.settle_deadline + 1);
    env.expire(0).unwrap();
    let r = env.round(0);
    assert_eq!((r.status, r.outcome, r.refund_reason), (RoundStatus::Final, Outcome::Refund, RefundReason::Expired));
    for owner in [a.owner.pubkey(), c.owner.pubkey(), b.owner.pubkey(), admin.pubkey()] {
        env.claim(0, &owner).unwrap();
    }
    // The other stakes total 0.10 SOL and the house put in 0.06: each gets its stake back (refunds
    // are free at 0 bps) plus 0.06 * stake / 0.10.
    assert_eq!(env.vault(&a.owner.pubkey()).available, SOL - rent + 36 * CSOL / 10);
    assert_eq!(env.vault(&c.owner.pubkey()).available, SOL - rent + 12 * CSOL / 10);
    assert_eq!(env.vault(&b.owner.pubkey()).available, SOL - rent + 12 * CSOL / 10);
    // The house gets nothing back: its stake is unlocked and gone.
    let after = env.vault(&admin.pubkey());
    assert_eq!((after.available, after.locked), (house.available, 0));
    let house_position: Position = env.read(&position_pda(&round_pda(0), &admin.pubkey()));
    assert_eq!((house_position.is_house, house_position.claimed, house_position.payout), (true, true, 0));
    // Every lamport of the bank went to the players, so the treasury gets nothing.
    let r = env.round(0);
    assert_eq!(r.total_paid, r.raw_up + r.raw_down);
    env.assert_books(&[0]);
    let before = env.lamports(&env.treasury.pubkey());
    env.sweep(0).unwrap();
    assert_eq!(env.lamports(&env.treasury.pubkey()), before);
}

#[test]
fn the_share_of_a_forfeited_house_stake_is_floored_and_the_dust_goes_to_the_treasury() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let stakes = [6 * CSOL + 7, 2 * CSOL + 3, 2 * CSOL + 1];
    let [a, c, b] = house_backed_round(&mut env, stakes);
    let rent = env.position_rent();
    let r = env.round(0);
    let (house, bank) = (r.house_amount, r.raw_up + r.raw_down);
    let others = bank - house;
    assert_eq!(others, stakes.iter().sum::<u64>());
    env.warp(r.settle_deadline + 1);
    env.expire(0).unwrap();

    // Refunds still cost 1% here (100 bps): the fee applies to the player's own stake and the
    // forfeited house stake comes on top, floored.
    let mut paid = 0;
    for (p, stake) in [(&a, stakes[0]), (&c, stakes[1]), (&b, stakes[2])] {
        env.claim(0, &p.owner.pubkey()).unwrap();
        let payout = stake * 99 / 100 + (house as u128 * stake as u128 / others as u128) as u64;
        assert_eq!(env.vault(&p.owner.pubkey()).available, SOL - stake - rent + payout);
        paid += payout;
    }
    env.claim(0, &admin.pubkey()).unwrap();
    assert_eq!(env.round(0).total_paid, paid);
    assert!(paid <= bank);
    env.assert_books(&[0]);
    // The remainder (1% of the players' stakes plus rounding dust) goes to the treasury.
    let before = env.lamports(&env.treasury.pubkey());
    env.sweep(0).unwrap();
    assert_eq!(env.lamports(&env.treasury.pubkey()) - before, bank - paid);
    env.assert_books(&[0]);
}

#[test]
fn a_round_priced_at_the_start_but_never_settled_also_takes_the_house_stake() {
    let mut env = Env::new();
    let a = env.player(SOL);
    let admin = env.admin.insecure_clone();
    let rent = env.position_rent();
    env.create_round(0, T0, SOL).unwrap();
    env.bet(0, &a, Side::Up, 5 * CSOL).unwrap();
    env.warp(T0 + 60);
    env.house_fill(0, &admin, 5 * CSOL).unwrap();
    let house = env.vault(&admin.pubkey());
    let r = env.round(0);
    env.warp(r.strike_end);
    env.set_strike(0, &admin, samples(100, &[1_000; 6])).unwrap();
    assert_eq!(env.round(0).status, RoundStatus::Live);

    // The exit price never comes (say the house would lose); anyone expires the Live round.
    env.warp(r.exit_end);
    env.warp(r.settle_deadline);
    assert_err(env.expire(0), "NotDue");
    env.warp(r.settle_deadline + 1);
    env.expire(0).unwrap();
    let r = env.round(0);
    assert_eq!((r.status, r.outcome, r.refund_reason), (RoundStatus::Final, Outcome::Refund, RefundReason::Expired));
    assert_eq!((r.strike_price, r.exit_price), (1_000, 0));
    env.claim(0, &a.owner.pubkey()).unwrap();
    env.claim(0, &admin.pubkey()).unwrap();
    // The player's own stake less the 1% refund fee, plus the whole house stake.
    assert_eq!(env.vault(&a.owner.pubkey()).available, SOL - 5 * CSOL - rent + 5 * CSOL * 99 / 100 + 5 * CSOL);
    let after = env.vault(&admin.pubkey());
    assert_eq!((after.available, after.locked), (house.available, 0));
    env.assert_books(&[0]);
    let before = env.lamports(&env.treasury.pubkey());
    env.sweep(0).unwrap();
    assert_eq!(env.lamports(&env.treasury.pubkey()) - before, 5 * CSOL / 100);
}

#[test]
fn an_expired_round_without_a_house_position_pays_as_before() {
    let (mut env, a, b) = matched_round();
    let rent = env.position_rent();
    let r = env.round(0);
    env.warp(r.settle_deadline + 1);
    env.expire(0).unwrap();
    for p in [&a, &b] {
        env.claim(0, &p.owner.pubkey()).unwrap();
        assert_eq!(env.vault(&p.owner.pubkey()).available, SOL - 5 * CSOL + 5 * CSOL * 99 / 100 - rent);
    }
    env.assert_books(&[0]);
    let before = env.lamports(&env.treasury.pubkey());
    env.sweep(0).unwrap();
    assert_eq!(env.lamports(&env.treasury.pubkey()) - before, 10 * CSOL / 100);
}

#[test]
fn rotating_the_house_key_does_not_rescue_a_forfeited_stake() {
    let mut env = Env::new();
    let a = env.player(SOL);
    let admin = env.admin.insecure_clone();
    env.create_round(0, T0, SOL).unwrap();
    env.bet(0, &a, Side::Up, 5 * CSOL).unwrap();
    env.warp(T0 + 60);
    env.house_fill(0, &admin, 5 * CSOL).unwrap();
    let house = env.vault(&admin.pubkey());
    // The operator hands the house role to another key before the round expires.
    let mut params = env.params();
    params.house_authority = Keypair::new().pubkey();
    env.send_admin(ix(acc::AdminConfig { config: config_pda(), admin: admin.pubkey() }, ixs::UpdateConfig { params })).unwrap();
    env.warp(env.round(0).settle_deadline + 1);
    env.expire(0).unwrap();
    env.claim(0, &admin.pubkey()).unwrap();
    // The position says it is the house's, whoever holds the role now.
    assert_eq!(env.vault(&admin.pubkey()).available, house.available);
    env.claim(0, &a.owner.pubkey()).unwrap();
    env.assert_books(&[0]);
}

#[test]
fn a_tie_still_returns_the_house_stake() {
    let mut env = Env::new();
    let a = env.player(SOL);
    let admin = env.admin.insecure_clone();
    let rent = env.position_rent();
    env.create_round(0, T0, SOL).unwrap();
    env.bet(0, &a, Side::Up, 5 * CSOL).unwrap();
    env.warp(T0 + 60);
    env.house_fill(0, &admin, 5 * CSOL).unwrap();
    env.price_round(0, 1_000, 1_000);
    let r = env.round(0);
    assert_eq!((r.outcome, r.refund_reason), (Outcome::Refund, RefundReason::Tie));
    env.claim(0, &a.owner.pubkey()).unwrap();
    env.claim(0, &admin.pubkey()).unwrap();
    // A tie is a real price, not a withholding case: the house is refunded like everyone (99% at 100 bps).
    let kept = 5 * CSOL - 5 * CSOL * 99 / 100;
    assert_eq!(env.vault(&admin.pubkey()).available, 5 * SOL - rent - kept);
    assert_eq!(env.vault(&a.owner.pubkey()).available, SOL - rent - kept);
    let house_position: Position = env.read(&position_pda(&round_pda(0), &admin.pubkey()));
    assert_eq!((house_position.is_house, house_position.payout), (true, 5 * CSOL * 99 / 100));
    env.assert_books(&[0]);
}

#[test]
fn an_unpriceable_round_takes_the_house_stake_whichever_window_was_too_thin() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    // Round 0 refunds for free (clean numbers), round 1 at 100 bps with odd stakes (floors).
    env.set_refund_fee(0);
    env.create_round(0, T0, SOL).unwrap();
    env.set_refund_fee(100);
    env.create_round(1, T0, SOL).unwrap();
    let [a, c, b] = [env.player(SOL), env.player(SOL), env.player(SOL)];
    let stakes: [[u64; 3]; 2] = [[6 * CSOL, 2 * CSOL, 2 * CSOL], [6 * CSOL + 7, 2 * CSOL + 3, 2 * CSOL + 1]];
    for (id, s) in stakes.iter().enumerate() {
        env.bet(id as u64, &a, Side::Up, s[0]).unwrap();
        env.bet(id as u64, &c, Side::Up, s[1]).unwrap();
        env.bet(id as u64, &b, Side::Down, s[2]).unwrap();
    }
    env.warp(T0 + 60);
    for id in [0, 1] {
        let r = env.round(id);
        env.house_fill(id, &admin, r.raw_up - r.raw_down).unwrap();
    }
    let house = env.vault(&admin.pubkey());
    assert_eq!(house.locked, env.round(0).house_amount + env.round(1).house_amount);

    // Round 0: the strike window holds 4 observations (the minimum is 5). Round 1: the strike is
    // fine and the exit window holds 4. The attestor's signature would not change either: the
    // program refunds a window it cannot price, and the house forfeits like on expiry.
    env.warp(T0 + 100);
    env.set_strike(0, &admin, samples(100, &[1_000; 4])).unwrap();
    env.set_strike(1, &admin, samples(100, &[1_000; 6])).unwrap();
    assert_eq!((env.round(0).status, env.round(0).outcome, env.round(0).refund_reason), (RoundStatus::Final, Outcome::Refund, RefundReason::Unpriceable));
    assert_eq!(env.round(1).status, RoundStatus::Live);
    env.warp(T0 + 160);
    env.settle(1, samples(200, &[900; 4])).unwrap();
    assert_eq!((env.round(1).status, env.round(1).outcome, env.round(1).refund_reason), (RoundStatus::Final, Outcome::Refund, RefundReason::Unpriceable));

    for (id, s) in stakes.iter().enumerate() {
        let id = id as u64;
        let r = env.round(id);
        let (house_amount, bank) = (r.house_amount, r.raw_up + r.raw_down);
        let others = bank - house_amount;
        assert_eq!(others, s.iter().sum::<u64>());
        let fee_refund = if id == 0 { 100 } else { 99 };
        let mut paid = 0;
        for (p, stake) in [(&a, s[0]), (&c, s[1]), (&b, s[2])] {
            let before = env.vault(&p.owner.pubkey()).available;
            env.claim(id, &p.owner.pubkey()).unwrap();
            // Its own stake less the refund fee (none for round 0), plus its floored share of the house stake.
            let payout = stake * fee_refund / 100 + (house_amount as u128 * stake as u128 / others as u128) as u64;
            assert_eq!(env.vault(&p.owner.pubkey()).available - before, payout);
            paid += payout;
        }
        env.claim(id, &admin.pubkey()).unwrap();
        assert_eq!(env.round(id).total_paid, paid);
        assert!(paid <= bank);
        env.assert_books(&[0, 1]);
    }
    // The house gets nothing of either round: both stakes are unlocked and gone.
    let after = env.vault(&admin.pubkey());
    assert_eq!((after.available, after.locked), (house.available, 0));
    for id in [0, 1] {
        let position: Position = env.read(&position_pda(&round_pda(id), &admin.pubkey()));
        assert_eq!((position.is_house, position.claimed, position.payout), (true, true, 0));
    }
    // Round 0 paid out its whole bank; round 1 leaves the 1% refund fee and rounding dust for the treasury.
    for id in [0, 1] {
        let r = env.round(id);
        let before = env.lamports(&env.treasury.pubkey());
        env.sweep(id).unwrap();
        assert_eq!(env.lamports(&env.treasury.pubkey()) - before, r.raw_up + r.raw_down - r.total_paid);
    }
    assert_eq!(env.round(0).total_paid, env.round(0).raw_up + env.round(0).raw_down);
    assert!(env.round(1).total_paid < env.round(1).raw_up + env.round(1).raw_down);
    env.assert_books(&[0, 1]);
}

#[test]
fn an_unmatched_round_returns_a_house_stake_that_was_too_small_to_activate_it() {
    let mut env = Env::new();
    let a = env.player(SOL);
    let admin = env.admin.insecure_clone();
    let rent = env.position_rent();
    // Round 0 ends at the strike window, round 1 is never priced and expires: either way NotActivated.
    env.create_round(0, T0, SOL).unwrap();
    env.create_round(1, T0, SOL).unwrap();
    env.bet(0, &a, Side::Up, 5 * CSOL).unwrap();
    env.bet(1, &a, Side::Up, 5 * CSOL).unwrap();
    env.warp(T0 + 60);
    // The fill is no more than 0.005 SOL: 2 x 0.005 stays under min_bank (0.02 SOL).
    let fill = CSOL / 2;
    let house_before = env.vault(&admin.pubkey());
    env.house_fill(0, &admin, fill).unwrap();
    env.house_fill(1, &admin, fill).unwrap();
    assert_eq!(env.round(0).house_amount, fill);
    env.warp(T0 + 100);
    env.set_strike(0, &admin, vec![]).unwrap();
    env.warp(env.round(1).settle_deadline + 1);
    env.expire(1).unwrap();
    for id in [0, 1] {
        let r = env.round(id);
        assert_eq!((r.status, r.outcome, r.refund_reason), (RoundStatus::Final, Outcome::NotActivated, RefundReason::None));
        env.claim(id, &a.owner.pubkey()).unwrap();
        env.claim(id, &admin.pubkey()).unwrap();
        // Nothing is forfeited: the player's stake and the house's come back whole, no fee.
        let r = env.round(id);
        assert_eq!(r.total_paid, r.raw_up + r.raw_down);
        let position: Position = env.read(&position_pda(&round_pda(id), &admin.pubkey()));
        assert_eq!((position.is_house, position.payout), (true, fill));
    }
    let house = env.vault(&admin.pubkey());
    assert_eq!((house.available, house.locked), (house_before.available - 2 * rent, 0));
    assert_eq!(env.vault(&a.owner.pubkey()).available, SOL - 2 * rent);
    env.assert_books(&[0, 1]);
    // No remainder: the treasury gets nothing.
    let before = env.lamports(&env.treasury.pubkey());
    env.sweep(0).unwrap();
    env.sweep(1).unwrap();
    assert_eq!(env.lamports(&env.treasury.pubkey()), before);
}

#[test]
fn refunds_cost_nothing_at_zero_refund_bps() {
    let mut env = Env::new();
    env.set_refund_fee(0);
    let (a, b) = (env.player(SOL), env.player(SOL));
    let rent = env.position_rent();
    env.create_round(0, T0, SOL).unwrap();
    env.create_round(1, T0 + 60, SOL).unwrap();
    env.bet(0, &a, Side::Up, 6 * CSOL).unwrap();
    env.bet(0, &b, Side::Down, 4 * CSOL).unwrap();
    env.warp(T0 + 60);
    env.bet(1, &a, Side::Up, 6 * CSOL).unwrap();
    env.bet(1, &b, Side::Down, 4 * CSOL).unwrap();
    // Round 0 ties, round 1 expires: the matched part and the surplus both come back whole.
    env.price_round(0, 1_000, 1_000);
    assert_eq!((env.round(0).outcome, env.round(0).refund_reason), (Outcome::Refund, RefundReason::Tie));
    env.warp(env.round(1).settle_deadline + 1);
    env.expire(1).unwrap();
    assert_eq!((env.round(1).outcome, env.round(1).refund_reason), (Outcome::Refund, RefundReason::Expired));
    for id in [0, 1] {
        env.claim(id, &a.owner.pubkey()).unwrap();
        env.claim(id, &b.owner.pubkey()).unwrap();
        assert_eq!(env.round(id).total_paid, 10 * CSOL);
    }
    assert_eq!(env.vault(&a.owner.pubkey()).available, SOL - 2 * rent);
    assert_eq!(env.vault(&b.owner.pubkey()).available, SOL - 2 * rent);
    env.assert_books(&[0, 1]);
    let before = env.lamports(&env.treasury.pubkey());
    env.sweep(0).unwrap();
    env.sweep(1).unwrap();
    assert_eq!(env.lamports(&env.treasury.pubkey()), before);
}

#[test]
fn a_winning_house_position_is_paid_after_the_house_key_rotates() {
    let mut env = Env::new();
    let a = env.player(SOL);
    let admin = env.admin.insecure_clone();
    env.create_round(0, T0, SOL).unwrap();
    env.bet(0, &a, Side::Up, 5 * CSOL).unwrap();
    env.warp(T0 + 60);
    env.house_fill(0, &admin, 5 * CSOL).unwrap();
    let house = env.vault(&admin.pubkey());
    let mut params = env.params();
    params.house_authority = Keypair::new().pubkey();
    env.send_admin(ix(acc::AdminConfig { config: config_pda(), admin: admin.pubkey() }, ixs::UpdateConfig { params })).unwrap();
    env.price_round(0, 1_000, 900);
    // Claim is permissionless and pays the position's own authority, not the current house key.
    env.claim(0, &admin.pubkey()).unwrap();
    let after = env.vault(&admin.pubkey());
    assert_eq!((after.available, after.locked), (house.available + 5 * CSOL * 196 / 100, 0));
    env.claim(0, &a.owner.pubkey()).unwrap();
    env.assert_books(&[0]);
}

#[test]
fn the_house_fill_respects_the_depth_cap() {
    let mut env = Env::new();
    let a = env.player(SOL);
    let admin = env.admin.insecure_clone();
    env.create_round(0, T0, 4 * CSOL).unwrap();
    env.bet(0, &a, Side::Up, 5 * CSOL).unwrap();
    env.warp(T0 + 60);
    // Matching 3 would make the accepted bank 6, above the cap of 4; matching 2 reaches it.
    assert_err(env.house_fill(0, &admin, 3 * CSOL), "BankTooLargeForPool");
    assert_eq!((env.round(0).raw_down, env.round(0).house_amount, env.house_limits().spent), (0, 0, 0));
    env.house_fill(0, &admin, 2 * CSOL).unwrap();
    let r = env.round(0);
    assert_eq!((r.raw_up, r.raw_down, r.house_amount), (5 * CSOL, 2 * CSOL, 2 * CSOL));
    env.assert_books(&[0]);
}

#[test]
fn issuing_a_session_again_resets_its_budget_and_revocation() {
    let mut env = Env::new();
    let a = env.player(SOL);
    let owner = a.owner.insecure_clone();
    let vault = vault_pda(&owner.pubkey());
    let session = session_pda(&vault, &a.key.pubkey());
    for (id, open) in [(0, T0), (1, T0 + 60), (2, T0 + 120), (3, T0 + 125)] {
        env.create_round(id, open, SOL).unwrap();
    }
    env.bet(0, &a, Side::Up, 5 * CSOL).unwrap();
    assert_eq!(env.read::<Session>(&session).spent, 5 * CSOL);

    // Revoked: the key is dead until the owner issues it again, which also starts a fresh budget.
    let revoke = ix(acc::RevokeSession { vault, session, authority: owner.pubkey() }, ixs::RevokeSession {});
    env.send(vec![revoke], &owner, &[&owner]).unwrap();
    env.warp(T0 + 60);
    assert_err(env.bet(1, &a, Side::Up, CSOL), "SessionInvalid");
    env.start_session(&owner, &a.key, T0 + 7_200, 10 * CSOL, SOL).unwrap();
    let s: Session = env.read(&session);
    assert_eq!((s.revoked, s.spent, s.expiry), (false, 0, T0 + 7_200));
    env.bet(1, &a, Side::Up, 5 * CSOL).unwrap();
    assert_eq!(env.read::<Session>(&session).spent, 5 * CSOL);

    // Expired: same story with a second device key.
    let k2 = Keypair::new();
    env.svm.airdrop(&k2.pubkey(), SOL).unwrap();
    env.warp(T0 + 120);
    env.start_session(&owner, &k2, T0 + 125, 10 * CSOL, SOL).unwrap();
    let p2 = Player { owner: owner.insecure_clone(), key: k2 };
    env.bet(2, &p2, Side::Up, 5 * CSOL).unwrap();
    let session2 = session_pda(&vault, &p2.key.pubkey());
    assert_eq!(env.read::<Session>(&session2).spent, 5 * CSOL);
    env.warp(T0 + 125);
    assert_err(env.bet(3, &p2, Side::Up, CSOL), "SessionInvalid");
    env.start_session(&owner, &p2.key, T0 + 7_200, 10 * CSOL, SOL).unwrap();
    let s2: Session = env.read(&session2);
    assert_eq!((s2.revoked, s2.spent, s2.expiry), (false, 0, T0 + 7_200));
    env.bet(3, &p2, Side::Up, 5 * CSOL).unwrap();
    assert_eq!(env.read::<Session>(&session2).spent, 5 * CSOL);
}

#[test]
fn closing_a_revoked_session_returns_exactly_its_rent_to_the_owner() {
    let mut env = Env::new();
    let a = env.player(SOL);
    let owner = a.owner.insecure_clone();
    let vault = vault_pda(&owner.pubkey());
    let session = session_pda(&vault, &a.key.pubkey());
    let rent = env.session_rent();
    assert_eq!(env.lamports(&session), rent, "start_session left exactly the rent-exempt minimum");
    env.revoke_session(&owner, &a.key.pubkey()).unwrap();

    let (owner_before, config_before) = (env.lamports(&owner.pubkey()), env.lamports(&config_pda()));
    let (vault_before, books_before): (Vault, Config) = (env.vault(&owner.pubkey()), env.read(&config_pda()));
    env.close_session(&owner, &a.key.pubkey()).unwrap();

    // The whole rent, to the owner and nobody else; the account is gone.
    assert_eq!(env.lamports(&owner.pubkey()), owner_before + rent);
    assert_closed(&env, &session);
    // The rent never passed through the game books: Config and the vault did not move.
    assert_eq!(env.lamports(&config_pda()), config_before);
    let (vault_after, books_after): (Vault, Config) = (env.vault(&owner.pubkey()), env.read(&config_pda()));
    assert_eq!((vault_after.available, vault_after.locked), (vault_before.available, vault_before.locked));
    assert_eq!(
        (books_after.total_available, books_after.total_locked),
        (books_before.total_available, books_before.total_locked)
    );
    env.assert_books(&[]);

    // Closed for good: a second close finds nothing.
    assert_err(env.close_session(&owner, &a.key.pubkey()), "AccountNotInitialized");
}

#[test]
fn an_expired_session_closes_from_its_expiry_second_on() {
    let mut env = Env::new();
    let a = env.player(SOL);
    let owner = a.owner.insecure_clone();
    let vault = vault_pda(&owner.pubkey());
    let short = Keypair::new();
    env.start_session(&owner, &short, T0 + 30, CSOL, SOL).unwrap();
    let rent = env.session_rent();
    let short_session = session_pda(&vault, &short.pubkey());

    // One second before the expiry the session can still bet, so it stays.
    env.warp(T0 + 29);
    assert_err(env.close_session(&owner, &short.pubkey()), "SessionStillActive");
    assert_eq!(env.lamports(&short_session), rent);

    // place_bet refuses from `now >= expiry`, and so does the guard: the same second.
    env.warp(T0 + 30);
    let owner_before = env.lamports(&owner.pubkey());
    env.close_session(&owner, &short.pubkey()).unwrap();
    assert_eq!(env.lamports(&owner.pubkey()), owner_before + rent);
    assert_closed(&env, &short_session);
    // The unexpired session next to it is untouched.
    assert!(!env.read::<Session>(&session_pda(&vault, &a.key.pubkey())).revoked);
    env.assert_books(&[]);
}

#[test]
fn an_active_session_cannot_be_closed_not_even_when_its_budget_is_used_up() {
    let mut env = Env::new();
    let a = env.player(SOL);
    let owner = a.owner.insecure_clone();
    let vault = vault_pda(&owner.pubkey());
    let rent = env.session_rent();

    // A cap that one bet reaches exactly: used up, but neither revoked nor expired.
    let used = Keypair::new();
    env.svm.airdrop(&used.pubkey(), SOL).unwrap();
    env.start_session(&owner, &used, T0 + 3_600, 10 * CSOL, 2 * CSOL).unwrap();
    env.create_round(0, T0, SOL).unwrap();
    let p = Player { owner: owner.insecure_clone(), key: used };
    env.bet(0, &p, Side::Up, 2 * CSOL).unwrap();
    let used_session = session_pda(&vault, &p.key.pubkey());
    let s: Session = env.read(&used_session);
    assert_eq!(s.spent, s.session_cap);

    let before = env.svm.get_account(&used_session).unwrap();
    assert_err(env.close_session(&owner, &p.key.pubkey()), "SessionStillActive");
    assert_err(env.close_session(&owner, &a.key.pubkey()), "SessionStillActive");
    assert_eq!(env.svm.get_account(&used_session).unwrap(), before, "a refused close changes nothing");
    assert_eq!(env.lamports(&session_pda(&vault, &a.key.pubkey())), rent);

    // Revoking is what makes it closable; the bet it placed stays on chain, in its own account.
    env.revoke_session(&owner, &p.key.pubkey()).unwrap();
    env.close_session(&owner, &p.key.pubkey()).unwrap();
    assert_closed(&env, &used_session);
    assert_eq!(env.read::<Position>(&position_pda(&round_pda(0), &owner.pubkey())).stake, 2 * CSOL);
    env.assert_books(&[0]);
}

#[test]
fn only_the_owner_can_close_a_session_and_the_device_key_cannot() {
    let mut env = Env::new();
    let (a, b) = (env.player(SOL), env.player(SOL));
    let (vault_a, vault_b) = (vault_pda(&a.owner.pubkey()), vault_pda(&b.owner.pubkey()));
    let session_a = session_pda(&vault_a, &a.key.pubkey());
    // Revoked, so that closability is not what stops the attempts below.
    env.revoke_session(&a.owner, &a.key.pubkey()).unwrap();
    let before = env.svm.get_account(&session_a).unwrap();
    let rent = env.session_rent();
    let b_before = env.lamports(&b.owner.pubkey());

    let attempts = [
        // Another owner with their own vault and A's session.
        (acc::CloseSession { vault: vault_b, session: session_a, authority: b.owner.pubkey() }, &b.owner),
        // Another owner naming A's vault.
        (acc::CloseSession { vault: vault_a, session: session_a, authority: b.owner.pubkey() }, &b.owner),
        // The device key as the authority, over the owner's vault.
        (acc::CloseSession { vault: vault_a, session: session_a, authority: a.key.pubkey() }, &a.key),
        // The device key over a vault of its own address, which does not exist.
        (acc::CloseSession { vault: vault_pda(&a.key.pubkey()), session: session_a, authority: a.key.pubkey() }, &a.key),
    ];
    for (accounts, signer) in attempts {
        let res = env.send(vec![ix(accounts, ixs::CloseSession {})], signer, &[signer]);
        assert!(res.is_err(), "a foreign signature must not close the session");
    }
    assert_eq!(env.svm.get_account(&session_a).unwrap(), before);
    assert!(env.lamports(&b.owner.pubkey()) <= b_before, "the attacker gained nothing (the failed attempts only cost fees)");
    assert_eq!(env.lamports(&session_a), rent);

    // The owner still can.
    env.close_session(&a.owner, &a.key.pubkey()).unwrap();
    assert_closed(&env, &session_a);
}

#[test]
fn after_closing_the_device_key_starts_again_and_the_closed_session_cannot_bet() {
    let mut env = Env::new();
    let a = env.player(SOL);
    let owner = a.owner.insecure_clone();
    let vault = vault_pda(&owner.pubkey());
    let session = session_pda(&vault, &a.key.pubkey());
    let rent = env.session_rent();
    for (id, open) in [(0, T0), (1, T0 + 60)] {
        env.create_round(id, open, SOL).unwrap();
    }
    env.bet(0, &a, Side::Up, 5 * CSOL).unwrap();
    env.revoke_session(&owner, &a.key.pubkey()).unwrap();
    env.close_session(&owner, &a.key.pubkey()).unwrap();

    // With the session gone the device key cannot bet, and nothing moved.
    env.warp(T0 + 60);
    let vault_before = env.vault(&owner.pubkey());
    assert_err(env.bet(1, &a, Side::Up, CSOL), "AccountNotInitialized");
    assert_eq!(env.vault(&owner.pubkey()).available, vault_before.available);

    // The owner grants the same device key again: init_if_needed makes a fresh account, paid by the owner.
    let owner_before = env.lamports(&owner.pubkey());
    env.start_session(&owner, &a.key, T0 + 7_200, 10 * CSOL, SOL).unwrap();
    assert_eq!(env.lamports(&owner.pubkey()), owner_before - rent - 5_000);
    let s: Session = env.read(&session);
    assert_eq!(
        (s.authority, s.vault, s.signer, s.expiry, s.spent, s.revoked),
        (owner.pubkey(), vault, a.key.pubkey(), T0 + 7_200, 0, false)
    );
    env.bet(1, &a, Side::Up, 5 * CSOL).unwrap();
    assert_eq!(env.read::<Session>(&session).spent, 5 * CSOL);
    env.assert_books(&[0, 1]);
}

#[test]
fn many_finished_sessions_close_in_one_transaction_and_one_active_one_stops_the_batch() {
    // The app closes this many per approval (MAX_CLOSES_PER_TX in apps/mobile/src/wallet/sessionClose.ts).
    const BATCH: usize = 12;
    let mut env = Env::new();
    let a = env.player(SOL);
    let owner = a.owner.insecure_clone();
    let vault = vault_pda(&owner.pubkey());
    let rent = env.session_rent();
    let old: Vec<Keypair> = (0..BATCH).map(|_| Keypair::new()).collect();
    for key in &old {
        env.start_session(&owner, key, T0 + 100, CSOL, SOL).unwrap();
    }
    env.warp(T0 + 100);
    let closes: Vec<Instruction> = old.iter().map(|k| Env::close_session_ix(&owner.pubkey(), &k.pubkey())).collect();

    // The whole transaction fails together: nothing is closed.
    let mut with_active = closes.clone();
    with_active.push(Env::close_session_ix(&owner.pubkey(), &a.key.pubkey()));
    assert_err(env.send(with_active, &owner, &[&owner]), "SessionStillActive");
    for key in &old {
        assert_eq!(env.lamports(&session_pda(&vault, &key.pubkey())), rent);
    }

    let before = env.lamports(&owner.pubkey());
    let logs = env.send_logs(closes, &owner, &[&owner]).unwrap();
    assert_eq!(env.lamports(&owner.pubkey()), before + BATCH as u64 * rent - 5_000);
    // Each close is cheap (a few thousand units of the 200_000 every instruction may use), so the
    // size of the transaction, not its compute, is what caps a batch.
    let used: Vec<u64> = logs
        .iter()
        .filter_map(|l| l.strip_prefix(&format!("Program {ID} consumed "))?.split(' ').next()?.parse().ok())
        .collect();
    assert_eq!(used.len(), BATCH);
    assert!(used.iter().all(|&u| u < 20_000), "{used:?}");
    for key in &old {
        assert_closed(&env, &session_pda(&vault, &key.pubkey()));
    }
    assert_eq!(env.lamports(&session_pda(&vault, &a.key.pubkey())), rent, "the session that can still bet stays");
    env.assert_books(&[]);
}

#[test]
fn sixteen_samples_are_accepted_and_a_zero_price_is_rejected() {
    let (mut env, _a, _b) = matched_round();
    let admin = env.admin.insecure_clone();
    let r = env.round(0);
    env.warp(r.strike_end);
    let mut zero = samples(100, &[1_000; 6]);
    zero[3].price = 0;
    assert_err(env.set_strike(0, &admin, zero), "InvalidSamples");
    env.set_strike(0, &admin, samples(100, &[1_000; 16])).unwrap();
    let s = env.round(0);
    assert_eq!((s.status, s.strike_price, s.strike_samples), (RoundStatus::Live, 1_000, 16));

    env.warp(r.exit_end);
    let mut zero = samples(200, &[900; 6]);
    zero[0].price = 0;
    assert_err(env.settle(0, zero), "InvalidSamples");
    assert_eq!(env.round(0).status, RoundStatus::Live);
    env.settle(0, samples(200, &[900; 16])).unwrap();
    let s = env.round(0);
    assert_eq!((s.status, s.outcome, s.exit_price, s.exit_samples), (RoundStatus::Final, Outcome::Down, 900, 16));
}

#[test]
fn anyone_may_sweep_but_only_to_the_configured_treasury() {
    let (mut env, a, b) = matched_round();
    env.price_round(0, 1_000, 900);
    env.claim(0, &a.owner.pubkey()).unwrap();
    env.claim(0, &b.owner.pubkey()).unwrap();
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), SOL).unwrap();
    let sweep_to = |treasury: Pubkey| ix(acc::SweepFees { config: config_pda(), round: round_pda(0), treasury }, ixs::SweepFees {});
    // A wrong destination, even the sender's own account, is refused: only the fee is charged.
    let before = env.lamports(&stranger.pubkey());
    assert_err(env.send(vec![sweep_to(stranger.pubkey())], &stranger, &[&stranger]), "Unauthorized");
    assert_eq!(env.lamports(&stranger.pubkey()), before - 5_000);
    assert!(!env.round(0).fees_swept);
    // Sweeping needs no admin: a stranger pays the fee and the 2% lands at the treasury.
    let treasury_before = env.lamports(&env.treasury.pubkey());
    env.send(vec![sweep_to(env.treasury.pubkey())], &stranger, &[&stranger]).unwrap();
    assert_eq!(env.lamports(&env.treasury.pubkey()) - treasury_before, 10 * CSOL * 2 / 100);
    assert!(env.round(0).fees_swept);
    env.assert_books(&[0]);
}

#[test]
fn round_times_and_the_bank_cap_are_bounded() {
    let mut env = Env::new();
    // The keeper's cadence is inside every bound.
    let ok = round_args(T0, SOL);
    assert_eq!((ok.exit_end - ok.opens_at, ok.settle_deadline - ok.exit_end), (160, 600));

    // The deadline for a price: at most an hour after the exit window.
    for deadline in [ok.exit_end + 3_601, i64::MAX] {
        assert_err(env.create_round_with(0, CreateRoundArgs { settle_deadline: deadline, ..ok.clone() }), "SettleDeadlineTooFar");
    }
    // Opening to the end of the exit window: at most 15 minutes.
    let ending = |exit_end: i64| CreateRoundArgs { exit_end, settle_deadline: exit_end + 600, ..ok.clone() };
    assert_err(env.create_round_with(0, ending(T0 + 901)), "RoundTooLong");
    let day_long_entry = CreateRoundArgs {
        cutoff_at: T0 + 86_400,
        strike_start: T0 + 86_430,
        strike_end: T0 + 86_440,
        exit_start: T0 + 86_490,
        exit_end: T0 + 86_500,
        settle_deadline: T0 + 87_100,
        ..ok.clone()
    };
    assert_err(env.create_round_with(0, day_long_entry), "RoundTooLong");
    assert_err(env.create_round_with(0, CreateRoundArgs { opens_at: i64::MIN, ..ok.clone() }), "RoundTooLong");
    // The bank cap may not sit below the configured minimum bank (0.02 SOL here).
    assert_err(env.create_round_with(0, CreateRoundArgs { max_bank: 2 * CSOL - 1, ..ok.clone() }), "MaxBankBelowMin");
    assert_err(env.create_round_with(0, CreateRoundArgs { max_bank: 0, ..ok.clone() }), "InvalidAmount");
    // Nothing above created a round or used up an id.
    assert_eq!(env.read::<Config>(&config_pda()).next_round_id, 0);

    // The limits themselves are allowed.
    env.create_round_with(0, ending(T0 + 900)).unwrap();
    env.create_round_with(1, CreateRoundArgs { settle_deadline: ok.exit_end + 3_600, ..ok.clone() }).unwrap();
    env.create_round_with(2, CreateRoundArgs { max_bank: 2 * CSOL, ..ok.clone() }).unwrap();
    env.create_round_with(3, ok).unwrap();
    assert_eq!(env.read::<Config>(&config_pda()).next_round_id, 4);
}

#[test]
fn a_round_may_open_at_most_fifteen_minutes_ahead() {
    let mut env = Env::new();
    // The keeper creates the next minute's round 5 to 15 seconds ahead: far inside the bound.
    env.create_round(0, T0 + 15, SOL).unwrap();
    // The bound itself passes, one second more does not, a day or a year ahead neither.
    env.create_round(1, T0 + MAX_ROUND_SECS, SOL).unwrap();
    for ahead in [MAX_ROUND_SECS + 1, 24 * 3_600, 365 * 24 * 3_600] {
        assert_err(env.create_round(2, T0 + ahead, SOL), "RoundOpensTooFar");
    }
    // Nothing above burned the round id or created an account.
    assert_eq!(env.read::<Config>(&config_pda()).next_round_id, 2);
    assert!(env.svm.get_account(&round_pda(2)).is_none());
    // The same round is fine once the clock has caught up by a second.
    env.warp(T0 + 1);
    env.create_round(2, T0 + MAX_ROUND_SECS + 1, SOL).unwrap();
    assert_eq!(env.read::<Config>(&config_pda()).next_round_id, 3);
}

#[test]
fn the_deadline_second_belongs_to_settle_and_refund_expired_starts_one_second_later() {
    let (mut env, a, b) = matched_round();
    let admin = env.admin.insecure_clone();
    let rent = env.position_rent();
    env.create_round(1, T0, SOL).unwrap();
    env.bet(1, &a, Side::Up, 5 * CSOL).unwrap();
    env.bet(1, &b, Side::Down, 5 * CSOL).unwrap();
    let r = env.round(0);
    env.warp(r.strike_end);
    for id in [0, 1] {
        env.set_strike(id, &admin, samples(100, &[1_000; 6])).unwrap();
    }
    // At the deadline itself the price may still land, and nobody can expire the round yet.
    env.warp(r.settle_deadline);
    assert_err(env.expire(0), "NotDue");
    env.settle(0, samples(200, &[1_100; 6])).unwrap();
    let s = env.round(0);
    assert_eq!((s.status, s.outcome, s.exit_price), (RoundStatus::Final, Outcome::Up, 1_100));
    // One second later it is the other way round: a price is late, the refund is open.
    env.warp(r.settle_deadline + 1);
    assert_err(env.settle(1, samples(200, &[1_100; 6])), "NotDue");
    env.expire(1).unwrap();
    assert_eq!((env.round(1).outcome, env.round(1).refund_reason), (Outcome::Refund, RefundReason::Expired));
    for id in [0, 1] {
        for p in [&a, &b] {
            env.claim(id, &p.owner.pubkey()).unwrap();
        }
    }
    // Round 0: a wins 1.96x of 0.05. Round 1: both get 99% back (no house in it, so nothing is forfeited).
    assert_eq!(env.vault(&a.owner.pubkey()).available, SOL - 2 * rent - 10 * CSOL + 5 * CSOL * 196 / 100 + 5 * CSOL * 99 / 100);
    assert_eq!(env.vault(&b.owner.pubkey()).available, SOL - 2 * rent - 10 * CSOL + 5 * CSOL * 99 / 100);
    env.assert_books(&[0, 1]);
}

#[test]
fn a_pause_stops_the_house_fill_but_not_settlement_refunds_claims_or_withdrawals() {
    let mut env = Env::new();
    let (a, b) = (env.player(SOL), env.player(SOL));
    let admin = env.admin.insecure_clone();
    let pause = |env: &mut Env, paused: bool| {
        env.send_admin(ix(acc::AdminConfig { config: config_pda(), admin: admin.pubkey() }, ixs::SetPause { paused })).unwrap();
    };
    let rent = env.position_rent();
    // Round 0: a lone bet the house could fill. Round 1: matched and settled. Round 2: matched, never priced.
    for id in [0, 1, 2] {
        env.create_round(id, T0, SOL).unwrap();
    }
    env.bet(0, &a, Side::Up, 5 * CSOL).unwrap();
    for id in [1, 2] {
        env.bet(id, &a, Side::Up, 5 * CSOL).unwrap();
        env.bet(id, &b, Side::Down, 5 * CSOL).unwrap();
    }
    env.warp(T0 + 60);

    pause(&mut env, true);
    let (limits, house, config_lamports) = (env.house_limits(), env.vault(&admin.pubkey()), env.lamports(&config_pda()));
    assert_err(env.house_fill(0, &admin, 5 * CSOL), "Paused");
    // Nothing moved: not the round, not the house caps, not the house vault, not Config.
    let r = env.round(0);
    assert_eq!((r.raw_down, r.house_amount, r.position_count), (0, 0, 1));
    assert_eq!(env.house_limits().spent, limits.spent);
    assert_eq!(env.vault(&admin.pubkey()).available, house.available);
    assert_eq!(env.lamports(&config_pda()), config_lamports);
    assert!(env.svm.get_account(&position_pda(&round_pda(0), &admin.pubkey())).is_none());
    // The pause was the only obstacle: the same fill goes through once it is lifted.
    pause(&mut env, false);
    env.house_fill(0, &admin, 5 * CSOL).unwrap();
    assert_eq!(env.round(0).house_amount, 5 * CSOL);

    // Paused again, pricing, expiry, claims and withdrawals all keep working.
    pause(&mut env, true);
    assert!(env.read::<Config>(&config_pda()).paused);
    env.price_round(0, 1_000, 900);
    env.price_round(1, 1_000, 1_100);
    assert_eq!((env.round(0).outcome, env.round(1).outcome), (Outcome::Down, Outcome::Up));
    env.warp(env.round(2).settle_deadline + 1);
    env.expire(2).unwrap();
    for (id, owner) in [
        (0, a.owner.pubkey()),
        (0, admin.pubkey()),
        (1, a.owner.pubkey()),
        (1, b.owner.pubkey()),
        (2, a.owner.pubkey()),
        (2, b.owner.pubkey()),
    ] {
        env.claim(id, &owner).unwrap();
    }
    // a: lost round 0, won round 1, got 99% of round 2. b: lost round 1, got 99% of round 2.
    assert_eq!(env.vault(&a.owner.pubkey()).available, SOL - 3 * rent - 15 * CSOL + 5 * CSOL * 196 / 100 + 5 * CSOL * 99 / 100);
    assert_eq!(env.vault(&b.owner.pubkey()).available, SOL - 2 * rent - 10 * CSOL + 5 * CSOL * 99 / 100);
    env.assert_books(&[0, 1, 2]);
    let (owner_a, owner_admin) = (a.owner.insecure_clone(), admin.insecure_clone());
    env.withdraw(&owner_a, CSOL).unwrap();
    env.withdraw(&owner_admin, CSOL).unwrap();
    env.sweep(0).unwrap();
    env.assert_books(&[1, 2]);
    assert!(env.read::<Config>(&config_pda()).paused, "all of it happened under the pause");
}

#[test]
fn the_house_key_cannot_fill_a_round_where_it_already_holds_a_player_position() {
    let mut env = Env::new();
    let a = env.player(SOL);
    let admin = env.admin.insecure_clone();
    // The admin is also a player: a device key with a session over the admin's own vault. Its
    // position address, [position, round, admin], is the one a house fill would need.
    let device = Keypair::new();
    env.svm.airdrop(&device.pubkey(), SOL).unwrap();
    env.start_session(&admin, &device, T0 + 3_600, 10 * CSOL, SOL).unwrap();
    let admin_as_player = Player { owner: admin.insecure_clone(), key: device };
    let rent = env.position_rent();
    env.create_round(0, T0, SOL).unwrap();
    env.bet(0, &a, Side::Up, 5 * CSOL).unwrap();
    env.bet(0, &admin_as_player, Side::Down, 2 * CSOL).unwrap();
    env.warp(T0 + 60);

    let position = position_pda(&round_pda(0), &admin.pubkey());
    let (round, vault, limits, config_lamports) = (env.round(0), env.vault(&admin.pubkey()), env.house_limits(), env.lamports(&config_pda()));
    let data = env.svm.get_account(&position).unwrap().data;
    // The gap is 3 CSOL, but the address is taken: the allocate of the new position fails, and
    // the whole transaction with it.
    assert_err(env.house_fill(0, &admin, 3 * CSOL), "already in use");
    let after = env.round(0);
    assert_eq!((after.raw_up, after.raw_down, after.house_amount, after.position_count), (round.raw_up, round.raw_down, 0, 2));
    assert_eq!(env.vault(&admin.pubkey()).available, vault.available);
    assert_eq!(env.vault(&admin.pubkey()).locked, vault.locked);
    assert_eq!(env.house_limits().spent, limits.spent);
    assert_eq!(env.lamports(&config_pda()), config_lamports);
    assert_eq!(env.svm.get_account(&position).unwrap().data, data);
    // That position is the player's: not the house's, so the forfeit rule can never apply to it.
    let p: Position = env.read(&position);
    assert_eq!((p.is_house, p.side, p.stake), (false, Side::Down, 2 * CSOL));
    env.assert_books(&[0]);

    // The round plays as it stands: 0.02 matched on each side, the other 0.03 of a returns.
    env.price_round(0, 1_000, 900);
    env.claim(0, &a.owner.pubkey()).unwrap();
    env.claim(0, &admin.pubkey()).unwrap();
    assert_eq!(env.vault(&a.owner.pubkey()).available, SOL - 5 * CSOL - rent + 3 * CSOL);
    assert_eq!(env.vault(&admin.pubkey()).available, vault.available + 2 * CSOL * 196 / 100);
    env.assert_books(&[0]);
    let before = env.lamports(&env.treasury.pubkey());
    env.sweep(0).unwrap();
    // The fee: 2% of the accepted bank of 0.04.
    assert_eq!(env.lamports(&env.treasury.pubkey()) - before, 4 * CSOL * 2 / 100);
    env.assert_books(&[0]);
}

#[test]
fn rotating_the_price_authority_mid_round_locks_out_the_old_key_and_the_new_one_settles_with_the_same_attestor() {
    let mut env = Env::new();
    let (a, b) = (env.player(SOL), env.player(SOL));
    let admin = env.admin.insecure_clone();
    let (attestor, new_authority) = (Keypair::new(), Keypair::new());
    env.svm.airdrop(&new_authority.pubkey(), SOL).unwrap();
    env.set_oracle(&admin, attestor.pubkey(), true).unwrap();
    env.create_round(0, T0, SOL).unwrap();
    env.bet(0, &a, Side::Up, 5 * CSOL).unwrap();
    env.bet(0, &b, Side::Down, 5 * CSOL).unwrap();
    let r = env.round(0);

    // The old key (with the attestor) prices the strike.
    env.warp(r.strike_end);
    let strike = certificate_ixs(0, &r, 0, samples(100, &[1_000; 6]), &attestor);
    env.send(strike, &admin, &[&admin]).unwrap();
    assert_eq!((env.round(0).status, env.round(0).strike_price), (RoundStatus::Live, 1_000));

    // Mid-round the admin hands the price role to another key; the attestor stays.
    let mut params = env.params();
    params.price_authority = new_authority.pubkey();
    env.send_admin(ix(acc::AdminConfig { config: config_pda(), admin: admin.pubkey() }, ixs::UpdateConfig { params })).unwrap();
    env.warp(r.exit_end);
    let settle = |authority: &Pubkey, attestor: Option<Pubkey>| price_ix(0, authority, attestor, ixs::Settle { samples: samples(200, &[1_100; 6]) });
    // The old key is out, whatever the attestor adds to it ...
    assert_err(env.send_attested(settle(&admin.pubkey(), Some(attestor.pubkey())), &attestor), "Unauthorized");
    assert_err(env.send_admin(settle(&admin.pubkey(), None)), "Unauthorized");
    // ... and the new key alone is not enough while the attestor is required.
    let new = new_authority.insecure_clone();
    assert_err(env.send(vec![settle(&new.pubkey(), None)], &new, &[&new]), "DetachedPriceRequired");
    assert_eq!(env.round(0).status, RoundStatus::Live);
    // New key plus the same attestor settle the round that the old key opened.
    let settle = certificate_ixs(0, &r, 1, samples(200, &[1_100; 6]), &attestor);
    env.send(settle, &new, &[&new]).unwrap();
    let s = env.round(0);
    assert_eq!((s.status, s.outcome, s.strike_price, s.exit_price), (RoundStatus::Final, Outcome::Up, 1_000, 1_100));
    env.claim(0, &a.owner.pubkey()).unwrap();
    env.claim(0, &b.owner.pubkey()).unwrap();
    env.assert_books(&[0]);
}

#[test]
fn the_treasury_is_read_at_sweep_time_so_a_rotation_redirects_the_fees_of_rounds_already_played() {
    // Pins the behaviour the audit of 2026-10-07 lists as L4/N6: Round holds no treasury of its own,
    // sweep_fees pays whatever `config.treasury` is when it runs. Snapshotting the treasury in Round
    // would be a layout change, so if this ever changes it is a decision, not an accident.
    let (mut env, a, b) = matched_round();
    env.price_round(0, 1_000, 900);
    for p in [&a, &b] {
        env.claim(0, &p.owner.pubkey()).unwrap();
    }
    let old_treasury = env.treasury.pubkey();
    let new_treasury = Keypair::new();
    env.svm.airdrop(&new_treasury.pubkey(), SOL).unwrap();
    let mut params = env.params();
    params.treasury = new_treasury.pubkey();
    env.send_admin(ix(acc::AdminConfig { config: config_pda(), admin: env.admin.pubkey() }, ixs::UpdateConfig { params })).unwrap();

    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), SOL).unwrap();
    let sweep_to = |treasury: Pubkey| ix(acc::SweepFees { config: config_pda(), round: round_pda(0), treasury }, ixs::SweepFees {});
    // The treasury of the day the round was played is no longer accepted ...
    let old_before = env.lamports(&old_treasury);
    assert_err(env.send(vec![sweep_to(old_treasury)], &stranger, &[&stranger]), "Unauthorized");
    assert!(!env.round(0).fees_swept);
    // ... the current one gets the whole 2% of the old round.
    let new_before = env.lamports(&new_treasury.pubkey());
    env.send(vec![sweep_to(new_treasury.pubkey())], &stranger, &[&stranger]).unwrap();
    assert_eq!(env.lamports(&new_treasury.pubkey()) - new_before, 10 * CSOL * 2 / 100);
    assert_eq!(env.lamports(&old_treasury), old_before);
    assert!(env.round(0).fees_swept);
    env.assert_books(&[0]);
}

#[test]
fn anyone_may_close_an_empty_final_round_and_the_rent_still_goes_to_the_admin() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    env.create_round(0, T0, SOL).unwrap();
    env.warp(T0 + 100);
    // Nobody bet: the round ends at the strike window with no position and nothing to sweep.
    env.set_strike(0, &admin, vec![]).unwrap();
    let r = env.round(0);
    assert_eq!((r.status, r.outcome, r.position_count), (RoundStatus::Final, Outcome::NotActivated, 0));

    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), SOL).unwrap();
    let rent = env.lamports(&round_pda(0));
    let close = |admin_account: Pubkey| {
        ix(acc::CloseEmptyRound { config: config_pda(), round: round_pda(0), admin: admin_account }, ixs::CloseEmptyRound {})
    };
    // The rent cannot be redirected: the account that receives it is pinned to config.admin.
    let before = env.lamports(&stranger.pubkey());
    assert_err(env.send(vec![close(stranger.pubkey())], &stranger, &[&stranger]), "Unauthorized");
    assert_eq!(env.lamports(&stranger.pubkey()), before - 5_000);
    assert_eq!(env.lamports(&round_pda(0)), rent);

    // The admin does not have to sign: a stranger sends it, pays the fee, and the admin gets the rent.
    let (admin_before, stranger_before) = (env.lamports(&admin.pubkey()), env.lamports(&stranger.pubkey()));
    env.send(vec![close(admin.pubkey())], &stranger, &[&stranger]).unwrap();
    assert_closed(&env, &round_pda(0));
    assert_eq!(env.lamports(&admin.pubkey()), admin_before + rent, "the whole rent, and no fee, to the admin");
    assert_eq!(env.lamports(&stranger.pubkey()), stranger_before - 5_000, "the stranger paid only the network fee");
    assert_err(env.send(vec![close(admin.pubkey())], &stranger, &[&stranger]), "AccountNotInitialized");
    env.assert_books(&[]);
}

#[derive(Clone, Copy)]
enum Fate {
    Win,
    Lose,
    Tie,
}

/// What the rules give back for a stake, in plain integer arithmetic and without payout.rs: the
/// larger side's stakes play pro rata (floored), the surplus returns whole, a win pays 2 x (1 - 2%),
/// a tie returns the played part less 1%.
fn rule_payout(side_total: u64, other_total: u64, stake: u64, fate: Fate) -> u64 {
    let (stake, side_total, other_total) = (stake as u128, side_total as u128, other_total as u128);
    let accepted = if side_total <= other_total { stake } else { stake * other_total / side_total };
    let played = match fate {
        Fate::Win => accepted * 2 * (10_000 - 200) / 10_000,
        Fate::Lose => 0,
        Fate::Tie => accepted * (10_000 - 100) / 10_000,
    };
    (stake - accepted + played) as u64
}

fn claim_and_check(env: &mut Env, id: u64, p: &Player, expected: u64) -> u64 {
    let owner = p.owner.pubkey();
    let before = env.vault(&owner).available;
    env.claim(id, &owner).unwrap();
    assert_eq!(env.vault(&owner).available - before, expected, "payout of {owner} in round {id}");
    expected
}

/// One book of odd stakes played to the end three times (UP wins, DOWN wins, tie): every claim is
/// the exact floor of the rule, the payouts never exceed the bank, the sweep takes exactly what is
/// left (the fee and at most a few lamports of dust) and Config's lamports match the books throughout.
fn play_odd_book(up: &[u64], down: &[u64]) {
    let mut env = Env::new();
    let ups: Vec<Player> = up.iter().map(|_| env.player(SOL)).collect();
    let downs: Vec<Player> = down.iter().map(|_| env.player(SOL)).collect();
    let (up_total, down_total) = (up.iter().sum::<u64>(), down.iter().sum::<u64>());
    let (bank, matched, positions) = (up_total + down_total, up_total.min(down_total), (up.len() + down.len()) as u64);
    assert!(up.len().max(down.len()) >= 5 && up.iter().chain(down).all(|s| s % 2 == 1));
    // (strike, exit, fate of an UP position, fate of a DOWN position)
    let rounds = [(1_000, 1_100, Fate::Win, Fate::Lose), (1_000, 900, Fate::Lose, Fate::Win), (1_000, 1_000, Fate::Tie, Fate::Tie)];
    for id in 0..rounds.len() as u64 {
        env.create_round(id, T0, SOL).unwrap();
        for (p, &s) in ups.iter().zip(up) {
            env.bet(id, p, Side::Up, s).unwrap();
        }
        for (p, &s) in downs.iter().zip(down) {
            env.bet(id, p, Side::Down, s).unwrap();
        }
    }
    for (id, &(strike, exit, up_fate, down_fate)) in rounds.iter().enumerate() {
        let id = id as u64;
        env.price_round(id, strike, exit);
        let mut paid = 0;
        for (p, &s) in ups.iter().zip(up) {
            paid += claim_and_check(&mut env, id, p, rule_payout(up_total, down_total, s, up_fate));
        }
        for (p, &s) in downs.iter().zip(down) {
            paid += claim_and_check(&mut env, id, p, rule_payout(down_total, up_total, s, down_fate));
        }
        assert_eq!(env.round(id).total_paid, paid);
        assert!(paid <= bank, "round {id} paid {paid} of a bank of {bank}");
        env.assert_books(&[0, 1, 2]);

        // The fee is 2% of the accepted bank (1% on a tie), give or take the floors.
        let left = bank - paid;
        let fee = 2 * matched * if matches!(up_fate, Fate::Tie) { 1 } else { 2 } / 100;
        assert!(left + positions >= fee && left <= fee + 2 * positions, "round {id}: left {left}, fee {fee}, positions {positions}");
        let before = env.lamports(&env.treasury.pubkey());
        env.sweep(id).unwrap();
        assert_eq!(env.lamports(&env.treasury.pubkey()) - before, left);
        env.assert_books(&[0, 1, 2]);
    }
    for p in ups.iter().chain(&downs) {
        assert_eq!(env.vault(&p.owner.pubkey()).locked, 0);
    }
}

#[test]
fn eight_players_on_the_larger_side_with_odd_stakes_pay_to_the_lamport_and_the_books_close() {
    let up = [3 * CSOL + 7, 2 * CSOL + 3, 5 * CSOL + 11, CSOL + 1, 4 * CSOL + 9, 2 * CSOL + 13, 3 * CSOL + 5, 6 * CSOL + 17];
    let down = [4 * CSOL + 1, 3 * CSOL + 3, 2 * CSOL + 5];
    play_odd_book(&up, &down);
}

#[test]
fn ten_players_on_the_larger_down_side_with_odd_stakes_pay_to_the_lamport_and_the_books_close() {
    let down = [
        CSOL + 3,
        2 * CSOL + 9,
        3 * CSOL + 1,
        4 * CSOL + 7,
        CSOL + 5,
        2 * CSOL + 11,
        5 * CSOL + 13,
        3 * CSOL + 15,
        2 * CSOL + 17,
        6 * CSOL + 19,
    ];
    let up = [4 * CSOL + 1, 3 * CSOL + 3];
    play_odd_book(&up, &down);
}

/// The live program's own positions under this build. Needs the program as it runs on devnet:
///   solana program dump 5kUCKYAYxZyaSz18xEajhSDNwdXvVLp2AvBp4LDxWuCz <file> --url devnet
///   FTM_LIVE_SO=<file> cargo test --manifest-path programs/flip-the-meme/Cargo.toml --test flow -- --ignored
#[test]
#[ignore = "needs FTM_LIVE_SO, a dump of the program live on devnet"]
fn positions_opened_by_the_live_program_close_into_the_vault_after_the_upgrade() {
    let live = std::fs::read(std::env::var("FTM_LIVE_SO").expect("FTM_LIVE_SO")).expect("read FTM_LIVE_SO");
    let mut env = Env::new_with(&live);
    let (a, b) = (env.player(SOL), env.player(SOL));
    let admin = env.admin.insecure_clone();
    let rent = env.position_rent();
    env.create_round(0, T0, SOL).unwrap();
    let key = env.lamports(&a.key.pubkey());
    env.bet(0, &a, Side::Up, 5 * CSOL).unwrap();
    env.bet(0, &b, Side::Down, 3 * CSOL).unwrap();
    env.warp(T0 + 60);
    env.house_fill(0, &admin, 2 * CSOL).unwrap();
    // The live program: the device key paid the rent, the vault only the stake.
    assert_eq!(env.lamports(&a.key.pubkey()), key - 5_000 - rent);
    assert_eq!(env.vault(&a.owner.pubkey()).available, SOL - 5 * CSOL);
    env.assert_books(&[0]);

    // Upgrade in the middle of the round, as on devnet; the rest runs on this build.
    env.svm.add_program(ID, &program()).unwrap();
    env.price_round(0, 1_000, 1_100);
    for owner in [a.owner.pubkey(), b.owner.pubkey(), admin.pubkey()] {
        env.claim(0, &owner).unwrap();
    }
    env.warp(env.round(0).exit_end + POSITION_CLOSE_DELAY_SECS);
    let house = env.vault(&admin.pubkey()).available;
    for owner in [a.owner.pubkey(), b.owner.pubkey(), admin.pubkey()] {
        env.close_position(0, &owner).unwrap();
        assert_closed(&env, &position_pda(&round_pda(0), &owner));
    }
    assert_eq!(env.vault(&a.owner.pubkey()).available, SOL - 5 * CSOL + 5 * CSOL * 196 / 100 + rent);
    assert_eq!(env.vault(&admin.pubkey()).available, house + rent);
    env.assert_books(&[0]);
    // A new bet on this build: the rent comes out of the vault.
    env.create_round(1, env.round(0).exit_end + POSITION_CLOSE_DELAY_SECS + 10, SOL).unwrap();
    let r1 = env.round(1);
    env.warp(r1.opens_at);
    env.start_session(&a.owner, &a.key, r1.opens_at + 3_600, 10 * CSOL, SOL).unwrap();
    let before = env.vault(&a.owner.pubkey()).available;
    env.bet(1, &a, Side::Up, CSOL).unwrap();
    assert_eq!(env.vault(&a.owner.pubkey()).available, before - CSOL - rent);
    env.assert_books(&[0, 1]);
}
