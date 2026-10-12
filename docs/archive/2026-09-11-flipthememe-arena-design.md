> Status: superseded on 2026-10-05 by [README.md](../../README.md) and [2026-10-05-flipthememe-solana-hackathon-build-design.md](../superpowers/specs/2026-10-05-flipthememe-solana-hackathon-build-design.md). Kept for history; the pari-mutuel economics described here were replaced by the matched 1:1 bank, and the code described here is not current.

# FlipTheMeme: a shared arena and customizable pixel faces

> For handoff to development, use [DEVELOPMENT_BRIEF.md](DEVELOPMENT_BRIEF.md).
> It consolidates the decisions into a single assignment and refines the
> implementation criteria.

Date: 11 September 2026. The current working version of the design after the
discussion. Replaces the 10 September version with the map, the deck and
individual matches. Implementation has not started. The settings and numeric
parameters below are starting proposals to be tested, not results of user
testing.

## Fixed by the user

- We are applying to CLOCK IN; the request to the organizers is not a
  dependency of the work. The decision to participate does not mean the
  organizer has already confirmed eligibility.
- Arbitrum is excluded from the calendar of this work. The whole remaining
  time is Solana.
- The main form: one shared arena with short rounds on fresh tokens.
- The proposals from the 10 September review are accepted in general, except
  the appearance of the avatars. Chess-like/schematic figurines do not fit.
- The latest clarification: only PIXEL FACES in the direction of Pixels and
  MattleFun. There is no room on the arena for full-length figures. Skin, hair,
  face and accessories are customizable; clothing/body are excluded. Sims is a
  reference only for personalization capabilities, not for rendering. The
  smooth concept is rejected.
- The choice between 1:1 and the pari-mutuel pool was delegated to the
  assistant.

## Choice of mechanic: pari-mutuel

The recommendation is a shared round pool. All accepted bets on UP and DOWN go
in whole; when both sides are present, the winning side gets its stakes back
and splits the losing pool in proportion to the sizes of its bets.

Why this suits the current product:

1. The amounts on the two sides do not have to match. There is no need to
   explain partial fills and the constant refund of one side's excess.
2. The visible crowd affects the payout: the minority has a higher potential
   payout per unit of stake. This makes the choice of side a meaningful part of
   the arena.
3. No house is needed as a mandatory counterparty, and no trading bankroll for
   it either.
4. The program settles one round outcome, then each player's share. The
   individual Order/Match, pair search and queues go away.

The earlier proposal to keep 1:1 was motivated by continuity with the old
matching. For a new product with a shared arena the priority is a coherent game
scenario, so the recommendation has changed.

We do not claim that the pari-mutuel pool is proven to retain the audience
better. This is a choice based on the properties of the mechanic and the scope
of the first version. 1:1 suits future personal duels with an agreed amount; we
do not include it in the first version.

A known reference for the math of shared pools itself is
[PancakeSwap Prediction](https://docs.pancakeswap.finance/play/prediction).
This is not a benchmark for business size, not a promise of demand and not new
competitive intelligence. Our own differentiation is fresh tokens, a shared
moment, Seeker identity and personal avatars.

## Fee and a clear payout

The proposal is **1% of the net win**, not of the whole pool and not of the
returned stake principal. At the round level this is 1% of the losing pool.
This clarification changes the fee base compared with the example of 1% of the
whole pool in the previous review.

With a winning pool W, a losing pool L and a winner's stake s:

- fee = floor(L × fee_bps / 10_000), for the proposed 1% fee_bps = 100;
- prize = L − fee;
- payout = s + floor(prize × s / W).

The computations are integer, with a sufficiently wide intermediate type. The
fee is fixed at the round level once. Rounding remainders are accounted for
explicitly; the rules for withdrawing them after all obligations are closed
need to be specified.

An example of final pools: UP = 0.6 SOL, DOWN = 0.2 SOL.

| Outcome | Fee | Payout per unit of stake | Payout at a 0.01 SOL stake |
|---|---:|---:|---:|
| UP | 0.002 SOL | 1.33× | 0.0133 SOL |
| DOWN | 0.006 SOL | 3.97× | 0.0397 SOL |

These are amounts including the returned stake principal. The example assumes
that the 0.01 SOL is already included in the final pool of the chosen side. For
the preliminary calculation, the UI adds the new bet to the chosen side before
computing the payout.

A fee on profit prevents the situation where, with an extreme skew, a correct
prediction returns less than the stake principal because of a fee on the whole
pool. At the same time the protocol's income is lower than with 1% of the whole
pool; with equal sides it is 0.5% of the total pool. The economics of
RPC/settlement/transaction sponsoring must be computed from this base, and
payback must not be promised.

Before closing, show "the payout now, if entry closes with this composition".
After closing, show the final payout for each outcome. We must not promise the
first player a multiplier that does not change with subsequent bets. The
percentage of money on a side is not labeled as the probability of the outcome.

## Round boundaries

One pool source, one bet currency SOL, one movement duration of 60 s. The
tuning of the intake duration and the price windows comes after the source is
verified.

Sequence:

1. Bet intake is open, the side pools and preliminary payouts are visible.
2. Intake closes by the program's time. Confirmation of late bets does not move
   them into the already closed round. They do not become real on the strength
   of the client's tap time alone.
3. The presence of both sides is checked and the composition of the pools is
   fixed. If a side is empty, the round returns the bets without a fee; an
   unknown price is not needed to determine such a refund.
4. A shared start price is formed from a pre-agreed window AFTER intake stops.
   This prevents betting on an almost known outcome.
5. The movement is measured, and the final price is determined at the end.
6. The result is fixed; based on it, players receive a payout or a refund.

An equal price/a stated tie zone, a lack of reliable data and an expired
settlement deadline have predetermined refund rules without a fee. A price
collapse with valid data is an ordinary market outcome.

One paid position per player per round in the MVP. Changing sides, cancelling
after acceptance and topping up a position are not part of the first version.
Protection against a repeated tap and a replayed network request is mandatory.

The session budget limits, the per-bet cap and the overall round pool limit
tied to the resilience of the market in use are kept. A small per-wallet cap
is not sufficient protection against multiple wallets or price impact.

The pari-mutuel pool does not create people on an empty side. First we need
shared traffic, short announced sessions and free predictions in the same
events. A house, fake opponents, hidden seeding of pools and promises of
permanent liquidity are not part of the MVP.

## Onchain state and server duties

A working scheme for the implementation plan:

- Vault: the user's available balance, session permissions and limits.
- Market: the allowed source/pool and the round-creation configuration.
- Round: identifier, pool, open/lock/start/end/deadline, price windows, fee
  snapshot, total_up/total_down, P0/P1, outcome, accounting of payouts and
  refunds.
- Position: round, authority, side, stake, claim/refund status.
- Profile: separate non-monetary appearance data and verified identity.

No new Order, Match, LP exposures or SkrStake for the sake of map sectors.
MWA is for connecting, funds, and issuing/revoking permissions. The game key
may only perform actions the program allows within a limited budget, not
withdraw or raise its own limits. A win does not reset the permission spend
counter automatically.

The keeper determines the allowed markets, serves the observations and helps
with settlement. If the settlement price is signed by our server, trust in it
is stated explicitly. A user's claim/refund must have a finite path even if the
main keeper has stopped. Time closure and payout finality are different UI
states.

## Avatars: pixel faces only

Visual direction: expressive pixel heads/faces, without a body, shoulders,
clothing or full-length figures, including in the editor. Recognizable
hairstyles, facial features and accessories. Real 2D pixel-art sprites in the
direction of Pixels and MattleFun. The schematic chess-like figurines from the
old mockup are rejected, but the pixel style remains mandatory. Smooth 2.5D
illustrations, 3D, voxels and characters in the visual style of Sims do not
fit.

The proposed first set:

- 6 skin tones;
- 8 hairstyles, including short, long and curly;
- 6 hair colors;
- several face variants and optional accessories.

The numbers are a budget guideline; the set is fixed after the layer
compatibility is checked. We do not promise arbitrary on-the-fly generation or
thousands of verified combinations. We do not restrict hairstyles and
accessories by gender choice.

The base appearance is free. Changing the skin color is not a reward or a paid
option. A possible SKR utility later is additional head accessories, frames and
reactions; the look does not affect the multiplier or the chance of winning. A
clothing shop is not needed, since bodies are not shown.

Technical proposal: a square 2D pixel-art face made of compatible layers:
back hair → face shape/skin → eyes/eyebrows/mouth → front hair → accessories.
The first trial sprite size is 24×24 or 32×32 pixels; we choose the final size
by legibility on the arena. Shared dimensions, anchor points, palettes and
overlap checks are required. Scaling by integer multiples without smoothing, a
crisp pixel grid. In the editor the same portrait is shown larger. We do not
develop full-figure sprites or walking animations.

The appearance state is a compact set of identifiers and colors tied to the
wallet's signed profile. Minting an NFT and a transaction on every hair change
are not needed. The .skr name and the SGT check are separate profile
properties.

Entry to the editor is through the profile. On first launch a ready-made look
is offered with a "Customize" button; the choice can be postponed and the
round watched right away.

## Faces on the arena

- A face keeps its appearance when the side changes in the next round.
  UP/DOWN are encoded by group and marker, not by recoloring skin or hair.
- An accepted position adds the portrait to the group of the corresponding
  side. A pending transaction is not shown as an accepted bet.
- A compact row: face + .skr name + amount. One's own portrait is highlighted
  with a marker.
- Two compact groups under the chart; the large center of the screen stays
  with the chart.
- The reaction to the outcome is a small emotion/change of expression, without
  figures moving.
- With a large number of players, priority goes to oneself and friends; the
  rest are merged into a counter. There are no stands with figures and no
  mandatory space for walking.
- Emotes are limited to a ready-made set and by frequency. Free chat is not
  part of the MVP.
- Sound, vibration and decorative motion can be turned off.

## The rest of the agreed scope

One arena, balance/history, profile/face editor. Free predictions in the same
events, SGT check by a unique mint, .skr resolution, the system Share, a
result card. An invitation opens the current session/next round.

A new bet is always a separate action. Auto-rollover of winnings into a bet,
mid-round cashout, the map, the deck, reels, a separate SKR room, 16 badges
and external LP deposits are excluded. SKR cosmetics come after the core is
ready; do not introduce new staking for the sake of an optional feature.

## Calendar without a pause for Arbitrum

| Period | Result |
|---|---|
| 11-14 September | Android APK, MWA, the chosen price source; a clickable arena, a first test of the face layers |
| 15-21 September | The full devnet pari-mutuel scenario: deposit, bet, closing, price, claim/refund, history |
| 22-28 September | The pixel face editor, .skr/SGT, free mode, shared sessions with a small group |
| 29 September - 3 October | Network errors, limits, mobile polish, Share, SKR cosmetics if the core is ready |
| 4-6 October | Final APK, reproducible build, demo and presentation, submission |
| 7-8 October | A reserve for fixes and technical problems with the submission |

Control questions: do people understand a floating payout; how many rounds are
cancelled because of an empty side; do players come back without monetary
rewards; do they see their own look and their friends on the arena; does the
whole money scenario survive a network loss and an app restart.

First we test a working product on a real Android device. Accepting public
mainnet funds is a separate step after the chosen economics, the price source
and the readiness of the money program have been verified, not a consequence of
creating this document.
