> Status: superseded on 2026-10-05 by [README.md](../../README.md) and [2026-10-05-flipthememe-solana-hackathon-build-design.md](../superpowers/specs/2026-10-05-flipthememe-solana-hackathon-build-design.md). Kept for history; the economics and code described here are not current.

# FlipTheMeme on Solana: a mobile entry for Clock In

> Archived version. The decisions on the arena, the pari-mutuel pool, avatar
> personalization and the calendar without Arbitrum are reflected in the
> [design of 11 September](2026-09-11-flipthememe-arena-design.md).
> The text below is kept as the history of the previous design.

Date: 2026-09-10. Status: design agreed, implementation plan not yet written.

## 1. What and why

An Android app for the Solana dApp Store: continuous PvP up/down on fresh
tokens from Solana launchpads, presented as a walk around a map. An entry for
the Clock In hackathon (Solana Mobile and Radiants DAO), submissions accepted
until 8 October 2026, results on 10 November.

The product thesis carries over from the Robinhood Chain pivot word for word
and sounds stronger on Solana: **on a chain with thousands of tokens a day,
there is exactly one thing you can do with a token: buy it.** You cannot short
a graduation, hedge a bag, or bet "it will pump or fizzle within a minute"
without buying the token itself.

## 2. Hard hackathon requirements

Checked on the rules page `solanamobile.radiant.nexus`, not from the announcement.

- Android only, a working APK is required.
- Solana Mobile Stack and Mobile Wallet Adapter are required.
- Mobile design from scratch. Direct ports and PWA wrappers "will score poorly".
- Meaningful interaction with the Solana network.
- To submit: APK, repository with sources, a three-minute demo video, a pitch deck.
- Must run on a live device, not only in an emulator.
- One entry per participant.
- USDC prizes only for teams without VC or angel money.
- KYC through Sumsub, a list of eligible countries.
- Publication in the dApp Store is not needed by the deadline, only for winners
  within 30 days after the announcement.

Criteria, 25% each: stickiness and PMF with the Seeker audience, UX,
innovation, quality of presentation. There is no separate item for technical
complexity.

A separate prize: $10,000 in SKR for a creative and meaningful SKR integration.

## 3. What the store reconnaissance showed

The catalog was exported through `seekertracker.com/api/dappstore`, 1361 active
apps. A rating without a review count is useless: half of the "five-star" apps
have one or two reviews.

- Serious trading tools on the phone are dead. Manic.Trade
  ("predict the price in 1-5 minutes, 1-100x leverage"), that is, literally our
  mechanic as a professional product, has 5 reviews. Snipers, signals, order
  books, perps, options, prediction DEXes: all below 40.
- Game-like and swipe-style predictions are alive: Klout 776, Chartz 527,
  Polyswipe 439, TBD 407, Vibe Predict 374, PredictTok 247. Ratings 3.5-3.9,
  the bar is low.
- The Top Picks showcase, where hackathon winners end up, consists of seven
  apps with a median of 3693 reviews versus 41 in the DeFi & Trading category.

The conclusion that determines the design: **the Seeker audience does not trade
seriously from a phone, it plays.** So the product is presented as a game with
real onchain settlement, not as a terminal.

## 4. Decisions made

| Decision | Choice | Why |
|---|---|---|
| Form of the main screen | Map-lite plus a deck as the quick mode | The map gives the product a face and stickiness, the deck gives "you can play in five seconds" for the demo |
| Bet screen | A duel with a visible opponent | The market is PvP anyway. None of the 27 competing apps shows this |
| Walking on the map | Tap and an instant animated transfer | A full walking game with paths, fog and time cost eats the polish budget, and UX is 25% of the score |
| Signing bets | Session key | MWA sends the user to the wallet for every signature, which kills a one-minute game |
| Bet currency | SOL | The audience's unit of account, deep liquidity, native lamports |
| Role of SKR | Staking opens map sectors | SKR gives what cannot be bought for SOL, and is tied specifically to the main mechanic |

### 4.1 Why the session key is not a way around the requirement

Checked on 2026-09-10:

- Solana has its own guide
  `solana.com/developers/guides/advanced/auto-approve`, where session keys are
  named as the recommended solution, with a link to the MagicBlock crate.
- The program lives on mainnet: `getAccountInfo` at the address
  `KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5` returns `executable = true`,
  owner BPF Upgradeable Loader.
- The `session-keys` crate version 3.1.1, published 2026-05-26, 29,526
  downloads, MIT license, the repository `magicblock-labs/session-keys` is not
  abandoned.
- The scope is set by the target program, lifetime, maximum spend and number of
  transactions.

Not confirmed: an audit, compatibility with the specific Anchor version, a
wrapper for React Native. The first party integrated this into the Unity SDK.

MWA is still used for everything that concerns money and permissions:
connecting, opening the vault, topping up, starting a session, revoking a
session, withdrawing, staking SKR. Only `place_bet` is signed with the session
key.

**The blast radius is limited by our own code.** The money sits in our own PDA
vault, and the limits are checked by our program. The session program only
answers the question "is this ephemeral key authorized by this user for this
program and not expired".

Fallback if the crate clashes with the Anchor version: a session PDA inside
our program, about 150 lines. The design does not change, only the line in the
pitch about the adopted standard goes away.

## 5. Boundaries

### Ships

- An Anchor program: vault, markets, orders and matches, settlement, SKR stake.
- An Expo app: map, deck, duel, vault, profile with badges.
- Keeper and API: pool detection, rug-check gate, market creation, batch
  settlement, push notifications.
- The game layer: sixteen badges, streak, depth.

### Does not ship, deliberately

An LP pool for outside depositors (our own wallet as a counterparty yes,
other people's deposits no), referrals, Genesis NFT, iOS, an audit, several
pool sources at the same time, withdrawal to fiat.

## 6. Architecture

Three parts with clear boundaries.

### 6.1 The Anchor program

Accounts:

- `Vault` (PDA per player): balance in lamports, `session_pubkey`,
  `session_expiry`, `max_per_bet`, `session_cap`, `spent_in_session`.
- `Market` (PDA per pair of pool and duration): pool address, duration, a
  snapshot of `fee_bps` at the moment of creation, pause flag.
- `Order` and `Match`: side, size, entry price, `settle_at`.
- `SkrStake` (PDA per player): stake amount, from which the number of open
  sectors is derived. How many sectors there are in total, how much SKR each
  next one costs and how many locations are visible in a sector are game
  balance parameters, not design ones. They are tuned in the week of 28
  September, when the map is already playable, and are set so that a zero
  stake stays playable: SKR widens the view, it does not unlock access.

Instructions through MWA: `open_vault`, `deposit`, `withdraw`, `start_session`,
`revoke_session`, `stake_skr`, `unstake_skr`.

Instructions without MWA: `create_market` (permissionless, with gates),
`place_bet` (signed with the session key), `settle_match` and its batch
variant, `refund_unmatched`.

Invariants the program must hold at all times:

1. Rake no higher than 1%, the ceiling is a constant in the code.
2. A bet no higher than `max_per_bet`.
3. `spent_in_session` no higher than `session_cap`.
4. The session has not expired.
5. The vault does not go negative.
6. LP exposure no higher than 5% per market and 10% in total.
7. The sum of vaults and escrow equals the program balance.

Bet limits: `MIN_BET` and `MAX_BET` as constants in the code. On Base and
Robinhood Chain the lower bound was set by the settlement gas, on Solana it is
pennies, so `MIN_BET` becomes a product decision, not a technical one.
`MAX_BET` is deliberately set low by the same logic as on Base: the product has
not been audited, and this must be visible in the interface, not only in the
text. The specific numbers are chosen in the week of 21-28 September, when the
typical liquidity of the pools that enter the game becomes clear.

### 6.2 Keeper and API

Moves over from `meteora_early_mem` and `mem_caller` almost without rewriting:

- A watcher for new pools through Helius, detection in 60-180 seconds.
- Gate: mint and freeze authority revoked, liquidity locked, the deployer is
  not blacklisted, minimum liquidity, minimum age.
- `create_market` for those that pass the gate.
- Batch settlement.
- Push notifications through Expo.
- A read API for the app: live pools, player state.

### 6.3 The app

Expo and React Native. MWA for money and permissions, the session key in
Android Keystore for play. Five screens: map, deck, duel, vault, profile.

### 6.4 Lifecycle of a bet

A new pool passes the rug check and gets a market, a location pops up in an
open sector of the map, the player taps and enters the duel, the bet is signed
with the session key without leaving for the wallet, matching finds an
opponent, the entry price is fixed, after 60 seconds the keeper closes the
match in a batch, 1% rake, the payout lands in the vault, a push arrives.

## 7. Cold start

Carried over from the existing Base solution unchanged. Three matching layers,
each next one switches on if the previous one did not work:

1. Order book, we look for a live opponent for 60 seconds. The best UX, no risk.
2. The LP pool as a counterparty, at most 5% of the deposit per market and 10%
   in total.
3. A five-minute queue with a notification, then an automatic refund.

This is what makes the duel fair from day one: an opponent is always found.

## 8. Open item for day one: the price source

Spot cannot be used: a fresh $20K pool moves in seconds, and a one-minute bet
turns into shooting yourself in the foot. On Robinhood Chain this is solved
through a TWAP from the pool's own `observe()`.

The Solana analogue has to be confirmed with code on live pools, not from
memory. Candidates: the observation accounts of Meteora DLMM and Raydium CLMM.
What specifically needs checking: what window they actually give on a pool four
minutes old, and whether it has to be widened beforehand, like
`increaseObservationCardinalityNext` on Uniswap v3.

The fallback, already written into the Robinhood Chain design as phase 2: the
keeper computes the TWAP from swap events and submits it to settlement with a
signature.

**Which pool source we take depends on this item, so it is done first.**

## 9. Paths where the balance breaks

Each one must be tested, all are already implemented and tested on Base:

- No opponent was found within 60 seconds.
- LP at the cap, the queue expired, a refund is needed.
- The pool died in the middle of a match and the price cannot be read.
- The price jumped beyond the allowed spread.
- The session expired between the tap and the confirmation.
- The player went offline after signing. A bet counts as real only after the
  transaction is confirmed, until then the screen shows waiting.

## 10. Acceptance

- Anchor tests for every instruction.
- The money invariant as a separate test.
- A soak with two bots on devnet, as on Base.
- A mandatory run on a live Android device. Rules: a video from which the app
  cannot be installed does not count as an entry.

## 11. Calendar

| When | What |
|---|---|
| 10-13 September | Confirm the price source on live pools, stand up the program skeleton |
| 14-21 September | Arbitrum Open House week. Solana stands still. Submit right at the end of the week |
| 21-28 September | Program and keeper to green tests on devnet |
| 28 September - 5 October | The app: map, duel, vault, badges, SKR |
| 5-8 October | Live device, soak, demo video, deck, submission |

## 12. What Sofia does herself

1. Register on Align and check that her country is on the eligible countries list.
2. Decide on repository access: public or by invitation. Judges look at the
   commit history.
3. Submit the Arbitrum Open House application at the end of the 14-21 September week.

## 13. Risks

1. **A price source may not be found** in a convenient form at either Meteora
   or Raydium. Then the keeper computes the TWAP itself, and this adds trust in
   it that has to be stated honestly in the UI.
2. **Three weeks solo on the program, the app, the video and the deck.** There
   is no reserve. The first thing cut if we fall behind is the map: the deck and
   the duel remain a working product on their own.
3. **The session-key crate is quiet**, last activity 26 May 2026. The fallback
   is described in 4.1.
4. **The category is crowded**: 27 prediction apps. The differentiation rests
   on the fact that competitors have simulation and points, while we have real
   onchain settlement, non-custody and a visible opponent.
