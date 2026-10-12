# FlipTheMeme Solana: build for the 9 October submission

Date: 5 October 2026. Status: agreed with Sofia in the session of 5 October (approach, mechanics from RHC, timings, the house).
Replaces the money mechanics of [DEVELOPMENT_BRIEF.md](../../archive/DEVELOPMENT_BRIEF.md) §6-8 and the program's mock mode.
The arena, pixel faces, the MWA session and the brief's prohibitions (§3 "Do not implement") remain in force.

## 1. What we submit and when

| Hackathon | Deadline | What is needed |
|---|---|---|
| [CLOCK IN](https://solanamobile.com/blog/clock-in-the-solana-mobile-hackathon) (Solana Mobile) | 12.10, 13:59 GMT+2 (Sofia's local time, CEST; moved by the organizers, was 9.10 08:59; judging 13.10-9.11, results 11.11) | APK with MWA, source code on GitHub, demo video, presentation |
| [Perps and Prediction Markets](https://hackathons.solana.com/hackathons/perps-and-prediction-markets) (Solana Foundation) | the hackathon page currently says 5.12.2026 (was 9.10), for Sofia to check | the same app; reference from the Foundation's previous hackathon: a working prototype, a video of up to 3 minutes, GitHub |

Internal deadline for all materials: the evening of 8 October. One video of up to 3 minutes in English for both.

Decisions taken on the submission: the test device and filming - Sofia's Seeker; the APK is built by GitHub Actions in the
private `Sofiia7` repository, which becomes public before submission only with Sofia's consent; the video - screen
recording by Sofia following a script, editing and English voice-over (TTS) by the assistant.

## 2. What is carried over from memepred (Robinhood Chain)

Decisions 23, 24 and 26 from `docs/rhc/DECISIONS.md` of the earlier memepred project and the rules of `POSITIVE-EV.md` are carried over to Solana:

1. **1:1 bank.** What goes into play is `m = min(UP, DOWN)`. The excess of the larger side is returned proportionally and
   without a fee. The winner receives exactly **1.96x the accepted amount** with any book. The brief's pari-mutuel betting is cancelled:
   with a floating multiplier, betting on both sides earns on the skew of the book without any price prediction.
2. **Fee:** 2% of the accepted bank `2m` on an UP/DOWN outcome; 1% on a refund of an activated round (tie,
   no price, expired). A non-activated round returns the stakes in full, with no fee.
   **Changed 5.10 (after the audit `docs/audits/2026-10-05-product-code-ux-audit.md`, A10):** refunds are free,
   `update_config` set `fee_refund_bps = 0` (devnet tx
   `Cvi4ce8bW9bLnxXHQjRvsxSrQ6tKNx1dcRbxaCKDzo81urHX6bWJrupqpMvTXhpvKUtCKJCM4CBwp5SJRtvMQNv`, script
   `services/keeper/scripts/set-fees.ts`). Rounds created earlier keep 1% from their own snapshot.
3. **Activation:** both sides are present and `2m >= min_bank`. Otherwise the round is not played.
4. **Strike in the future:** the reference price is taken after a pause from the close of betting. The player bets on the movement between the
   strike and the exit, not from the price at the moment of the bet; the interface says this before signing.
5. **Bank cap from pool depth:** `max_bank = quote_reserve / K`, `K = 2500` (as on RHC). A bet that
   would raise `2m` above `max_bank` is rejected; a bet on the larger side does not increase `m` and goes through.
6. One bet per player per round, bets are visible to everyone, any failure exits into money, settlement and refund are not
   blocked by the pause, the payout recipient is only the position owner's Vault.
7. **The house tops up the missing side** (Sofia's decision of 5.10 for devnet): after betting closes, the keeper house
   bets on the smaller side until equal, within the per-round cap and the daily budget. It is labeled
   `HOUSE` in the interface. RHC referrals are not carried over.

The devnet timing (movement 60 s, pause 30 s, strike window 10 s) was not measured on RHC: measurements with the 1:1 bank exist
only for rounds of 300 s and up. The closest measurement (`POSITIVE-EV.md`, the table "What the pause gives"; decision 26 in
`DECISIONS.md`): on 300-second rounds with a 300 s pause, a 60 s strike window instead of 300 s raises the loss of an ordinary
player against the worst bot from 4.3% to 7.2% at 2 bets per hour and from 2.2% to 3.3% at 5. All these figures were obtained on
Robinhood Chain (15 Uniswap v3 pools, 743 127 swaps, 15-29.09), not on Solana. For devnet the short timing is accepted and
named a limitation in the README.

## 3. The round

A new round every 60 s, with boundaries aligned to UTC minutes. While one round accepts bets, the previous two
are in the pause and in measurement. `T0 = opens_at`:

| Moment | Time | What happens |
|---|---|---|
| `opens_at` | T0 | betting is open (the keeper created the Round in advance, 5-15 s ahead) |
| `cutoff_at` | T0 + 60 | betting is closed by the program clock; the next round is already open |
| house | cutoff + 1..29 | the keeper house equalizes the sides (`house_fill`) |
| `strike_start`..`strike_end` | cutoff + 30 .. + 40 | strike window, 10 s |
| `exit_start`..`exit_end` | cutoff + 90 .. + 100 | exit window: 60 s after the start of the strike window |
| settlement | after `exit_end` | the keeper submits the price; then claim for all positions |
| `settle_deadline` | exit_end + 600 | after it anyone moves an unsettled round into refund |

The result comes about 105 s after betting closes; from bet to result is 100-160 s plus transaction confirmations
(60 s is the measured movement, not the player's wait). The devnet clock lags real time by 1-2 s
(measured 5.10); betting is limited by the program's time.

Devnet parameters (snapshot into the Round at creation; a change to Config applies only to future rounds):
`min_stake = 0.01 SOL`, `max_stake = 0.1 SOL`, `min_bank = 0.02 SOL`, `fee_win_bps = 200`,
`fee_refund_bps = 0` (was 100 before 5.10), `max_bank = min(quote_reserve / 2500, 1 SOL)`.

**Position payout** (whole lamports, rounded down). `U`, `D` are the stake totals of the sides, `m = min(U, D)`,
`L = max(U, D)`:

- accepted: on the smaller side (or when `U = D`) `accepted = stake`; on the larger side `accepted = stake * m / L`;
  `excess = stake - accepted`;
- win: `excess + accepted * 2 * (10000 - fee_win_bps) / 10000` (that is, `1.96 * accepted`);
- loss: `excess`;
- refund of an activated round: `excess + accepted * (10000 - fee_refund_bps) / 10000`;
- non-activated round: `stake`.

After all positions are processed, `U + D - total_paid` (the fee plus rounding dust) goes to the treasury by a separate
instruction. The program checks `total_paid <= U + D` on every claim.

Tie: the exit average equals the strike average (exact equality of integers). No price: fewer than 5 observations in the window.

## 4. Price source

- **Pool type:** only PumpSwap (`pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`) on mainnet, quote = wSOL.
  With `POOL_PUMP_ONLY=true` (as in the deployment) the keeper takes only pools whose base mint ends in `pump` (the suffix of
  pump.fun addresses): this is a sign of a pump.fun graduate, not strict proof, and a pool's age is not equal to a
  verified moment of graduation. The price is TOKEN/SOL, not USD. The layout was verified on 5.10 on a live pool:
  `base_mint` @43, `quote_mint` @75, `pool_base_token_account` @139, `pool_quote_token_account` @171; the amount of a token account @64 (Token and Token-2022).
- **Price:** `price = quote_amount * 10^12 / base_amount` (u128, the result is u64). Read directly from the pool's two
  token accounts (`getMultipleAccounts`, commitment `confirmed`), with the slot number.
- **Token selection** (changed 5.10 after the owner's remark: the arena had a pool aged 17-38 h, while a young one is
  about 40 minutes, as on pump.fun). Eligibility: a pool of 10-120 minutes, at least 50 trades in 5 minutes, a quote reserve of
  50 SOL or more (`K x min_bank`) on chain. Score `txM5 * (1 + (120 - age_min) / 120)`: activity with a bonus for
  youth. A token is held for at least 10 minutes; then it is replaced if a candidate scores 1.5 times more or
  the current one dropped out of eligibility (fewer than 20 trades in 5 minutes, older than 180 minutes); below 50 SOL - immediately. If there are no fresh
  ones - a ladder: age up to 6 h, up to 24 h, then the most active pool of any age. Source: GeckoTerminal
  cannot sort a single dex by creation time, so the keeper reads `new_pools` once a minute (all dexes,
  newest on top) and watches PumpSwap pools for 180 minutes, refreshes the figures via `pools/multi`, and for the ladder takes
  the top PumpSwap pool by trades over 24 h; no more than 4 requests per minute, on error a pause of 1, 2, 4, 8 minutes. Thresholds
  are set by the `POOL_*` variables (services/keeper/deploy/README.md).
- **Observations:** the keeper reads the pool once a second. Strike and exit are the integer average of the observations of their window
  (minimum 5, maximum 16; a simple average, not time-weighted). The program checks that the slots
  grow and the prices are positive, but cannot prove that the observations were taken from this mainnet pool. The observations themselves
  (mainnet slot and price) are passed into the instruction and stay in the transaction forever; the program computes the average. Anyone can check them against the pool history.
- **Trust boundary:** the price is signed by the keeper (`price_authority`), the devnet program does not read mainnet. This is
  stated plainly in the README and in the app: the money settlement is in the program, the source of the outcome is trusted.

## 5. Program (Anchor 1.1.2, devnet)

A new program ID (its own keypair), `MOCK_ONLY` is removed entirely. All users' SOL lies on the Config PDA,
accounting is by Vault.

**Accounts:**

- `Config` [`config`]: admin, price_authority, house_authority, treasury, paused, next_round_id,
  min_stake, max_stake, min_bank, fee_win_bps, fee_refund_bps, total_available, total_locked.
- `Vault` [`vault`, authority]: authority, available, locked.
- `Session` [`session`, vault, signer]: authority, vault, signer, expiry, max_per_bet, session_cap, spent, revoked.
- `Round` [`round`, id u64 LE]: id, token_mint, pool, seven times, snapshot of parameters, max_bank, raw_up, raw_down,
  house_amount, position_count, claimed_count, total_paid, fees_swept, status, outcome, refund_reason,
  strike_price, exit_price, strike_samples, exit_samples.
- `Position` [`position`, round, authority]: round, authority, side, stake, face `[u8; 8]`, is_house, claimed, payout.

**Instructions:**

| Instruction | Who signs | Rule |
|---|---|---|
| `initialize_config`, `update_config`, `set_pause` | admin | update affects only new rounds |
| `open_vault`, `deposit`, `withdraw` | owner (MWA) | withdraw only from available |
| `start_session`, `revoke_session` | owner (MWA) | the session key does not withdraw money and does not change limits |
| `create_round(id, args)` | admin | `id == next_round_id`, order of times, `max_bank > 0` |
| `place_bet(side, amount, face)` | session key, also the payer | `[opens_at, cutoff_at)`, session and round limits, depth rule |
| `house_fill(amount)` | house_authority | after cutoff and before strike_start; only the smaller side, no more than the difference |
| `set_strike(samples)` | price_authority | from `strike_end`; activation first: not activated - NotActivated; fewer than 5 observations - Refund |
| `settle(samples)` | price_authority | from `exit_end` to deadline; Up / Down / Refund(Tie, Unpriceable) |
| `refund_expired` | anyone | after deadline; non-activated - in full, activated - minus the round's `fee_refund_bps` (0 for rounds from 5.10, 1% for earlier ones) |
| `claim` | anyone | once per position, the money goes to the owner's Vault |
| `sweep_fees` | anyone | after all positions are claimed; the remainder of the bank goes to treasury |
| `close_empty_round` | anyone | a final round with no positions; rent returns to admin |

Empty rounds are closed, rounds with bets and positions remain on chain as history. The rent of a position (100 bytes,
about 0.00116 SOL by RPC on 5.10) is paid by the session key; closing a position with a rent refund does not exist yet, which is a limitation of the
devnet build. Events: `BetPlaced`, `StrikeSet`, `RoundSettled`, `Claimed`.

**Tests** (LiteSVM from TypeScript, through the same client as the keeper and the app): win and loss on an uneven
book with excess, the house equalizes, non-activated round, tie, few observations, expired deadline, repeated
claim and settle, cutoff and session expiry boundaries, session limit, depth rule, withdrawal of locked funds, sweep before and
after all claims, closing an empty round, a foreign signer on every role, the sum of payouts is no more than the bank.

## 6. Shared client `packages/client` (TypeScript, @solana/kit)

PDAs, account codecs, instruction builders, payout calculation (the same as in the program, for the preview), reading the
PumpSwap pool and the price. Written by hand on kit codecs, without a generator. Used by the keeper, the tests and the app.

## 7. Keeper (`services/keeper`)

A single Node 22 process, no public API. Loops: token selection (every 60 s), pool observations (every 1 s),
round scheduler (1 s tick): create the round, house, strike, settlement, claim in batches, sweep, closing empty ones.
On start it picks up unfinished rounds from the chain and brings them to completion; overdue ones it moves to refund.

Devnet keys: one keeper key = admin + price_authority + house_authority + treasury + program upgrade authority. The house is an ordinary
Vault of the keeper key. The house cap per round is `min(max_bank / 2, 0.05 SOL)`, the daily budget is
2 SOL; the counter is in a state file.

Hosting: a Docker container on the operator's VPS next to another operator service, outgoing connections only, no DNS and no Caddy.
Deploy in one visit via `<your VPS wrapper> push`; before deploying - Sofia's consent.
For development and filming the keeper can be kept on a laptop.

## 8. The app (`apps/mobile`, Expo 57, React Native 0.86)

There is no server of its own. The app reads:

- devnet RPC: Config, the latest rounds, the positions of rounds (`getProgramAccounts` by round), own Vault, Session,
  positions (by authority);
- mainnet RPC: the token accounts of the current round's pool every 1.5 s for the chart;
- GeckoTerminal/DexScreener: name, ticker, image, age, liquidity of the token. 1m candles for the chart history
  are not loaded: the chart history starts from the opening of the app.

**Screens** (interface in English):

1. **Arena:** the token and signals (age, liquidity, trades in 5 minutes); a chart with the strike line and windows;
   one labeled timer "Entry closes in" / "Result in" / "Confirming"; UP and DOWN groups with faces, names
   (shortened address, `HOUSE`) and amounts; a payout preview under the 1:1 bank rules; amount and side selection; own
   rounds in flight ("winning now" relative to the strike); the result of the previous round.
2. **Wallet:** available / locked, session (term, spend from the limit, key gas), Top up, Withdraw, Revoke,
   devnet airdrop.
3. **History:** all own positions: token, time, side, stake, accepted, strike and exit, outcome, payout,
   a link to the account in Explorer; a Claim button if the keeper did not make it in time.
4. **Profile:** a pixel-face editor (skin, hairstyle, hair color, eyes, accessory), statistics.

**Wallet and session.** Connection via MWA (`solana:devnet`). "Top up & play" is one MWA signature on one
transaction: `open_vault` (if absent) + `deposit` + `start_session` (24 hours, `max_per_bet = 0.1`, the session limit
equal to the top-up) + a transfer of 0.03 SOL to the session key for fees and rent. The session key is ed25519, stored in
`expo-secure-store`. MWA signs the transactions (`signTransactions`), the app sends them to devnet - this
works with whatever network is selected in the wallet. A bet is one tap with the session key, without a wallet window. Withdraw and
revoke go through MWA.

> Note of 6 October 2026 (the text above is left as it was): the session now lasts 7 days, not 24 hours, and
> the app transfers 0.005 SOL to the device key (called "device key" in the interface), not 0.03: the rent of
> positions is taken from the game balance, the key needs only network fees.

**States:** loading, no network / stale data, sending, confirming, transaction rejected, expired session,
betting closed, not activated, awaiting settlement, settled, refund. A position appears in a group only after
confirmation on chain.

**The face** travels in every bet (`face`, 8 bytes), there are no separate transactions. Before the wallet is connected - a random
face from a local seed; edits are saved locally.

**Share:** after a bet "Challenge a friend to take the other side" and a result card via the system Share; in
the caption the link `https://sol.flipthememe.com/r/<round>` (`services/link`): Android App Links open the app on
this round, without the app the page offers the APK.

## 9. Build and release

- Private repository `Sofiia7/flipthememe-solana`; the workflow builds a signed release APK
  (`expo prebuild` + Gradle) and the program (`cargo build-sbf`) for verification.
- The APK signing key is generated once, kept outside the repository by Sofia and in GitHub secrets. The same key
  is needed for publishing in the dApp Store.
- README for judges: what this is, how to play (wallet on devnet, airdrop), program ID, the 1:1 bank rules,
  price source and trust boundary, build and tests.

## 10. Video and presentation

A video of up to 3 minutes: the problem, the arena, connecting and one MWA signature, a bet in one tap, the house, the result and payout,
history, faces, transactions in Explorer, honest devnet limitations. Screen recording of the Seeker - Sofia; editing,
titles and voice (edge-tts) - the assistant. A presentation of 10-12 slides in English.

## 11. Done when

- [ ] Program tests pass; the program is on devnet; the keeper creates and settles rounds for an hour without stopping.
- [ ] On the Seeker: APK installation, MWA connection, Top up, bet, outcome, payout into the Vault, Withdraw.
- [ ] A round in which the house plays and a round with two humans are settled on devnet, the transactions are visible in Explorer.
- [ ] README, video, presentation, application texts; the repository is opened with Sofia's consent.

## 12. Out of scope before submission

SGT, free predictions, SKR cosmetics, push, referrals, mainnet. `.skr` names - only if the core is ready by 7.10.
