# FlipTheMeme Solana: build plan for 9 October

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a working APK on the Seeker with MWA, the 1:1 bank program on devnet without lockups, a keeper on the real PumpSwap price, a video and a presentation by 8 October.

**Architecture:** The Anchor program holds all the money and rules; the keeper (Node) creates a round every minute, tops up a side with the house and signs prices from the mainnet pool; the app (Expo) reads devnet and mainnet directly and bets with a session key. The shared TS client `packages/client` is used by the keeper, the app and the cross-check tests.

**Tech Stack:** Rust + anchor-lang 1.1.2, Agave CLI 3.1.x (Windows), litesvm (Rust, tests), TypeScript + @solana/kit 7, Node 22, Expo 57 / React Native 0.86, @wallet-ui/react-native-kit 4.3 (MWA), GitHub Actions (APK), edge-tts + ffmpeg (video).

**Specification:** [2026-10-05-flipthememe-solana-hackathon-build-design.md](../specs/2026-10-05-flipthememe-solana-hackathon-build-design.md).

**Deviation from the skill format:** because of the deadline the plan fixes interfaces, files, commands and acceptance criteria, but does not duplicate all the code: the code is written once, in the task. The interfaces below are mandatory for all executors.

---

## General rules for executors

- Do not commit: commits are made by the coordinator after review. Do not run `pnpm install` without the coordinator (one lockfile, Windows).
- No long dashes (U+2014) or en dash (U+2013), neither in code nor in texts. Only `-`.
- Secrets (keypair, keystore, passwords) only outside the repository: `<secrets-dir>` (a folder outside the repository on the developer machine).
- For the VPS - only through the wrapper `<your VPS wrapper>`, one visit at a time, and only on the coordinator's command.

## File map

```
programs/flip-the-meme/src/lib.rs        program: accounts, instructions, events, errors
programs/flip-the-meme/src/payout.rs     pure payout math (unit tests)
programs/flip-the-meme/tests/flow.rs     litesvm: round scenarios
programs/flip-the-meme/tests/vectors.rs  printing reference bytes for the TS client
packages/client/src/constants.ts         program id, seeds, parameters, mainnet addresses
packages/client/src/pda.ts               findConfig/Vault/Session/Round/PositionPda
packages/client/src/accounts.ts          decoders for Config/Vault/Session/Round/Position
packages/client/src/instructions.ts      builders for all instructions
packages/client/src/payout.ts            mirror of payout.rs + preview for the UI
packages/client/src/pumpswap.ts          reading the PumpSwap pool, price, pool selection
packages/client/src/index.ts             re-export
packages/client/test/*.test.ts           reference vectors against Rust, math, pumpswap
services/keeper/src/*.ts                 keeper (section C)
apps/mobile/...                          app (section D)
.github/workflows/android.yml            APK build
```

## Program contract (source of truth for the client)

Seeds: `config` = [`config`]; `vault` = [`vault`, authority]; `session` = [`session`, vault, signer];
`round` = [`round`, id u64 LE]; `position` = [`position`, round, authority].
Anchor discriminators: instruction `sha256("global:<snake_name>")[..8]`, account `sha256("account:<Name>")[..8]`.
An enum in Borsh is one byte: `Side {Up, Down}`, `RoundStatus {Open, Live, Final}`,
`Outcome {Pending, Up, Down, Refund, NotActivated}`, `RefundReason {None, Tie, Unpriceable, Expired}`.

```rust
pub struct Config { admin: Pubkey, price_authority: Pubkey, house_authority: Pubkey, treasury: Pubkey,
  paused: bool, next_round_id: u64, min_stake: u64, max_stake: u64, min_bank: u64,
  fee_win_bps: u16, fee_refund_bps: u16, total_available: u64, total_locked: u64, bump: u8 }
pub struct Vault { authority: Pubkey, available: u64, locked: u64, bump: u8 }
pub struct Session { authority: Pubkey, vault: Pubkey, signer: Pubkey, expiry: i64, max_per_bet: u64,
  session_cap: u64, spent: u64, revoked: bool, bump: u8 }
pub struct Round { id: u64, token_mint: Pubkey, pool: Pubkey, opens_at: i64, cutoff_at: i64,
  strike_start: i64, strike_end: i64, exit_start: i64, exit_end: i64, settle_deadline: i64,
  min_stake: u64, max_stake: u64, min_bank: u64, max_bank: u64, fee_win_bps: u16, fee_refund_bps: u16,
  raw_up: u64, raw_down: u64, house_amount: u64, position_count: u32, claimed_count: u32,
  total_paid: u64, fees_swept: bool, status: RoundStatus, outcome: Outcome, refund_reason: RefundReason,
  strike_price: u64, exit_price: u64, strike_samples: u8, exit_samples: u8, bump: u8 }
pub struct Position { round: Pubkey, authority: Pubkey, side: Side, stake: u64, face: [u8; 8],
  is_house: bool, claimed: bool, payout: u64, bump: u8 }
pub struct PriceSample { slot: u64, price: u64 }
pub struct ConfigParams { price_authority: Pubkey, house_authority: Pubkey, treasury: Pubkey,
  min_stake: u64, max_stake: u64, min_bank: u64, fee_win_bps: u16, fee_refund_bps: u16 }
pub struct CreateRoundArgs { token_mint: Pubkey, pool: Pubkey, opens_at: i64, cutoff_at: i64,
  strike_start: i64, strike_end: i64, exit_start: i64, exit_end: i64, settle_deadline: i64, max_bank: u64 }
```

Instructions and account order (`w` - writable, `s` - signer):

| Instruction | Arguments | Accounts |
|---|---|---|
| `initialize_config` | `params: ConfigParams` | config w, admin ws, system_program |
| `update_config` | `params: ConfigParams` | config w, admin s |
| `set_pause` | `paused: bool` | config w, admin s |
| `open_vault` | - | config, vault w, authority ws, system_program |
| `deposit` | `amount: u64` | config w, vault w, authority ws, system_program |
| `withdraw` | `amount: u64` | config w, vault w, authority ws |
| `start_session` | `expiry: i64, max_per_bet: u64, session_cap: u64` | config, vault, session w, authority ws, session_signer, system_program |
| `revoke_session` | - | vault, session w, authority s |
| `create_round` | `round_id: u64, args: CreateRoundArgs` | config w, round w, admin ws, system_program |
| `place_bet` | `side: Side, amount: u64, face: [u8; 8]` | config w, round w, vault w, session w, position w, session_signer ws, system_program |
| `house_fill` | `amount: u64` | config w, round w, house_vault w, position w, house_authority ws, system_program |
| `set_strike` | `samples: Vec<PriceSample>` | config, round w, price_authority s |
| `settle` | `samples: Vec<PriceSample>` | config, round w, price_authority s |
| `refund_expired` | - | round w |
| `claim` | - | config w, round w, position w, vault w |
| `sweep_fees` | - | config w, round w, treasury w |
| `close_empty_round` | - | config, round w, admin w |

The position payout - section 3 of the spec; `payout.rs` and `payout.ts` must match on shared vectors.

---

## Track A. The program

### A0. Solana toolchain on Windows
- [ ] Download `solana-release-x86_64-pc-windows-msvc.tar.bz2` (Agave 3.1.x, the latest patch with a Windows build) from GitHub `anza-xyz/agave`, unpack into `<tools-dir>\agave\`, add `bin` to the session PATH.
- [ ] `solana --version`, `cargo-build-sbf --version`.
- [ ] `cargo build-sbf --manifest-path programs/flip-the-meme/Cargo.toml` on the current draft. Expected: `target/deploy/flip_the_meme.so`.
- [ ] If the Windows build does not work within 40 minutes: build the `.so` in GitHub Actions (ubuntu, `agave-install`) and download the artifact with `gh run download`.
- [ ] Keys: `solana-keygen new --no-bip39-passphrase -o <secrets-dir>\keeper.json` and `...\program-id.json`. Devnet airdrop to the keeper: `solana airdrop 2 -u devnet` (repeat up to 6 SOL; on a 429, ask Sofia to top up via faucet.solana.com).

### A1. Rewrite the program per the contract
- [ ] `payout.rs`: `pub fn position_payout(raw_up, raw_down, outcome, fee_win_bps, fee_refund_bps, side, stake) -> Option<u64>` and `pub fn is_activated(raw_up, raw_down, min_bank) -> bool`, u128 inside.
- [ ] Unit tests of `payout.rs` (`cargo test -p flip-the-meme --lib`): equal sides 1.96x; book 0.40/0.10 (the excess 0.30 is returned); loss with excess; refund of 1% of an activated round; non-activated in full; the sum of payouts per round is no more than the bank on 1000 random books.
- [ ] `lib.rs` per the instruction table, `declare_id!` from `program-id.json`, `Anchor.toml` with the same id.
- [ ] `cargo check` and `cargo build-sbf` without error warnings.

### A2. litesvm integration tests
- [ ] `programs/flip-the-meme/tests/flow.rs`, dev-dependency `litesvm` (a version compatible for the build; on a type conflict - a Pubkey/Instruction converter via bytes).
- [ ] Scenarios: a full UP round with an uneven book and excess; the house equalizes a lone bet and the round is played; non-activated; tie; fewer than 5 observations; expired deadline via `refund_expired`; repeated claim and settle rejected; a bet exactly at `cutoff_at` rejected; a bet after the session `expiry` rejected; session limit; depth rule; withdraw above available rejected; sweep before the last claim rejected, after it - the treasury receives `U + D - total_paid`; closing an empty round; a foreign signer for admin, price_authority, house_authority, session.
- [ ] Command: `cargo test --manifest-path programs/flip-the-meme/Cargo.toml` - all green.

### A3. Reference vectors for the client
- [ ] `tests/vectors.rs` writes `packages/client/test/vectors.json`: the data bytes of each instruction on fixed arguments, the bytes of serialized accounts, payouts on 50 books.

### A4. Devnet deploy
- [ ] `solana program deploy target/deploy/flip_the_meme.so --program-id program-id.json -u devnet -k keeper.json`.
- [ ] Script `services/keeper/scripts/init-config.ts`: `initialize_config` with devnet parameters (min_stake 0.01, max_stake 0.1, min_bank 0.02 SOL, 200/100 bps), `open_vault` + `deposit 3 SOL` for the house. Amendment 5.10: the refund was switched to 0 bps (`services/keeper/scripts/set-fees.ts --refund-bps 0`, `DEVNET_PARAMS.feeRefundBps = 0`), see the spec, section 2.
- [ ] Write the program id and addresses into `docs/implementation/deployments.md`.

## Track B. Client `packages/client`

- [ ] B1. `package.json` (`@flipthememe/client`, `type: module`, `@solana/kit` ^7.1.1, tests `node --test` via `tsx` or `--experimental-strip-types`).
- [ ] B2. `constants.ts`, `pda.ts`, `accounts.ts` (decoders with a discriminator check), `instructions.ts` (one builder per instruction, returning a kit `Instruction`).
- [ ] B3. `payout.ts`: a mirror of `payout.rs` on bigint + `previewBet(round, side, stake)` for the UI (what will be accepted and how much comes out on a win, if the book does not change).
- [ ] B4. `pumpswap.ts`: `readPool(rpc, pool)` -> `{ baseMint, quoteMint, baseVault, quoteVault }` (check owner and quote = wSOL), `readPrice(rpc, vaults)` -> `{ slot, price, quoteReserve }`, `priceOf(base, quote) = quote * 10^12 / base`; `discoverPools(fetch)` - GeckoTerminal, the spec's filters.
- [ ] B5. Tests: the `vectors.json` reference vectors byte for byte; payout against the vectors; `priceOf` on the numbers of the HIGGS pool from the 5.10 measurement.

## Track C. Keeper `services/keeper`

- [ ] C1. Config from env: `DEVNET_RPC`, `MAINNET_RPCS` (a list), `KEEPER_KEYPAIR`, `STATE_FILE`, `HOUSE_DAILY_BUDGET`, `HOUSE_ROUND_CAP`.
- [ ] C2. `selector.ts`: pool selection once per 60 s, a hold of at least 10 minutes (`POOL_HOLD_MIN`), an on-chain check.
- [ ] C3. `sampler.ts`: polling the token accounts once per 1 s, a ring of observations per pool, sampling the window `[start, end)` by server time; a log of the devnet clock lag.
- [ ] C4. `scheduler.ts`: on each tick, for rounds `next_round_id - 3 .. next_round_id`, execute the first unexecuted step: create (10 s before the minute boundary), house_fill (cutoff + 2 s), set_strike (strike_end + 1 s), settle (exit_end + 1 s), claim in batches of 6, sweep, close_empty. Each step is idempotent by account state, errors do not bring down the loop.
- [ ] C5. `house.ts`: the fill amount `min(difference, round cap, max_bank/2 - smaller side, remaining budget)`; the budget by UTC day in the state file.
- [ ] C6. Recovery on start and `refund_expired` for overdue ones.
- [ ] C7. A 30-minute run on a laptop against devnet: rounds every minute, empty ones are closed, a log without exceptions.
- [ ] C8. Build into a single file (esbuild), `Dockerfile`, `docker-compose.yml` (a volume for the state and key). Deploy to the VPS with one call to `<your VPS wrapper> push` after Sofia's consent.

## Track D. App `apps/mobile`

- [ ] D1. Dependencies (via the coordinator): `@solana/kit@^7.1.1`, `expo-secure-store`, `react-native-svg`, `@react-native-async-storage/async-storage`, `expo-linking`, `@flipthememe/client`. `app.json`: name, icon, `scheme: flipthememe`, MWA identity `https://flipthememe.com`.
- [ ] D2. `src/chain/`: `useArena()` (Config, rounds, positions, polling 2 s), `useMyAccount()` (Vault, Session, my positions), `usePoolPrice(pool)` (mainnet, 1.5 s, a ring of 10 minutes), `useTokenInfo(mint)`.
- [ ] D3. `src/wallet/`: `topUpAndPlay(amount)`, `withdraw(amount)`, `revokeSession()`, `airdrop()`; MWA `signTransactions`, sending to devnet, waiting for confirmation.
- [ ] D4. `src/session/`: the session key in secure-store, `placeBet(round, side, amount, face)`, `claim(position)`; double-tap protection, recovery of a pending bet after a restart by the position PDA.
- [ ] D5. Arena: chart (svg), a timer with a phase label, UP/DOWN groups with faces, the 1.96x preview, amount selection, my rounds in flight, a result toast.
- [ ] D6. Wallet, History, Profile (face editor), bottom navigation.
- [ ] D7. Share: a challenge to the other side and a result card.
- [ ] D8. Error and offline states from the spec; `tsc --noEmit` green.
- [ ] D9. Icon and splash from the pixel face (PIL), 1024x1024.

## Track E. Build and repository

- [ ] E1. `.gitattributes` (`* text=auto eol=lf`), private repository `Sofiia7/flipthememe-solana`, first push.
- [ ] E2. Signing key (PKCS12) in `<secrets-dir>\release.p12` + password in `release.txt`; GitHub secrets `ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`.
- [ ] E3. `.github/workflows/android.yml`: pnpm, `expo prebuild --platform android`, signing through the config plugin `apps/mobile/plugins/withReleaseSigning.js`, `assembleRelease`, artifact `FlipTheMeme-<version>.apk`.
- [ ] E4. The first build of the current skeleton - check that the native part (MWA, quick-crypto, nitro) builds, before the features are ready.

## Track F. Materials

- [ ] F1. README for judges (English): what this is, how to play on the Seeker in devnet, the 1:1 bank rules, the price source and trust boundary, program id, build, tests, limitations.
- [ ] F2. Video script and a list of shots for Sofia; edge-tts voice-over; ffmpeg editing; up to 3 minutes.
- [ ] F3. Presentation of 10-12 slides (Artifact slides), PDF export.
- [ ] F4. Application texts for CLOCK IN and Perps and Prediction Markets.

## Order and parallelism

| When | Coordinator | Executors in parallel |
|---|---|---|
| 5.10 day | A1 program | A0 toolchain; E1-E4 repository and skeleton APK; B4 pumpswap |
| 5.10 evening | A2-A3 tests, A4 deploy | B1-B3, B5 client |
| 6.10 | acceptance, integration | C keeper (run on a laptop); D1-D5 app |
| 7.10 | test on the Seeker with Sofia | D6-D9; C8 VPS deploy; F1, F3 |
| 8.10 | filming with Sofia, editing | F2, F4; final APK; repository public with Sofia's consent |
