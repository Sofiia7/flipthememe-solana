> Status: superseded on 2026-10-05 by [README.md](../../README.md) and [docs/superpowers/specs/2026-10-05-flipthememe-solana-hackathon-build-design.md](../superpowers/specs/2026-10-05-flipthememe-solana-hackathon-build-design.md). Kept for history; the economics (pari-mutuel bank, 1% of the losing pool, no house) and the build state described here are not current.

# FlipTheMeme / MemePred - MVP development brief

**Version:** 11 September 2026. **Purpose:** handoff to a developer or coding agent.
**Status:** a single product specification for starting implementation. The application and program code has not been created yet. The technical questions of the first stage are listed separately; they are not presented as resolved.

This file is the main entry point into development. It replaces the map, the deck, the one-on-one matches and the full-body avatars from earlier discussions. In case of conflict with archived files, use this document and Sofia's subsequent direct instructions.

## 1. What we are building

An Android app for the Solana dApp Store and for the CLOCK IN submission by **8 October 2026**.

**Product:** a shared arena of short UP/DOWN forecasts on fresh Solana tokens. All participants in one round see the same token, share the same start and end moments of the price measurement, and see the other players by their pixel face and .skr name.

**Wording for the user:** "A fresh memecoin. A shared start. 60 seconds to test your forecast against other Seeker players - without buying the token itself."

The submission has been accepted as a direction of work. Clarifying the terms with the organizers is not a development dependency. There is no pause for Arbitrum. Do not stop development to re-discuss the already chosen shape of the product.

## 2. Decisions we start from

| Area | Decision |
|---|---|
| Main screen | One shared arena, a central chart, two groups UP/DOWN |
| Money mechanic | Pari-mutuel: a shared bank and a proportional payout to the winners |
| Bet currency | SOL; program amounts in lamports |
| Duration | 60 seconds of measured movement, the full cycle including entry is longer |
| Counterparty | Other participants; no house and no external LP pool in the MVP |
| Positions | One paid position per authority in each round; no top-ups, side changes or cancellation of an accepted bet |
| Fee | Working setting: 1% of net winnings, that is 1% of the losing bank; ceiling 1% |
| Wallet | MWA for connection, funds and permissions; a restricted session for play |
| Avatars | Only customizable pixel faces/heads in the direction of Pixels and MattleFun |
| Return to the game | Shared short sessions, a free forecast, history, recognizable participants |
| SKR | Cosmetics in the same arena after the core is ready; no separate room and no staking |

The pari-mutuel mechanic and the fee base were chosen as working decisions, on the user's instruction to pick the mechanic. These are not A/B test results and not a claim of proven retention.

## 3. Scope of the first version

**Mandatory core:**

- A working Android APK and MWA on a physical Android device.
- One arena, one supported pool source, one movement duration.
- A shared round, real transactions on devnet, entry/closing/settlement/payout/refund.
- Available balance, locked amount, history and settlement details.
- A restricted session, protection against repeated actions, recovery after being offline.
- Pixel faces with a simple editor.

**After the full money scenario, before submission:**

- .skr names, SGT verification, one free forecast per day for a verified SGT.
- Invitation via the system Share, a result card.
- A schedule of shared sessions; without a promise of a constantly filled arena.

**Only if the core is ready:** one SKR cosmetic, a push about a session, a simple weekly accuracy ranking.

**Do not implement:** the map, the deck, reels, walking, bodies/clothing/full-body characters, 3D, 1:1 pairing, Order/Match, a five-minute queue, the house, external LP deposits, a separate SKR room, auto-betting of winnings, cashout in the middle of a round, 16 badges, free chat, iOS, a custom token/avatar NFT.

## 4. User scenario

1. The app immediately shows the current arena, its phase and the chart. No wallet is needed to watch.
2. If entry is open, one can choose a free forecast or a money position. If entry is closed, watch and wait for the next round.
3. For a money position, connect a wallet, top up the game balance and grant a restricted session permission via MWA. These actions are not repeated for each bet within the permission.
4. Choose the amount and UP/DOWN. Before sending, the risk, the fee and the preliminary payout, taking one's own bet into account, are visible.
5. Until the transaction is confirmed, the position is shown as pending. After confirmation the face appears in the corresponding group and the amount is locked.
6. Closing of entry fixes the banks and the potential payouts. The starting price is determined after entry closes, by a rule published in advance.
7. When the movement ends, the result is shown, then the settlement confirmation and the credit/refund. The timer running out is not the same as a confirmed payout.
8. Winnings remain available on the balance. The next bet is only a new user action.

Entering the face editor must not delay the first view/forecast: a starter look already exists, and the setup can be skipped.

## 5. Screens and states

### Arena

- Token, age, source/pool; 2-3 signals available for the decision, selected after the data is verified.
- The chart is the main element. Before the start show the history and its period; during the round show the change from the shared P0 and the starting line.
- One labeled timer: "Entry closes", "Until the result" or the status "Confirming the settlement".
- Two groups with banks and preliminary/final payouts. Do not label the share of money as the probability of the event.
- Compact participant rows: **pixel face + .skr name/shortened address + amount**. Spectators and free forecasts are not depicted as money positions.
- One's own position, free balance and the amount at risk; UP/DOWN presented as equals before entry.
- When entry is closed, show viewing and the next round; when there is no eligible token, an honest wait. Do not present a recording or bots as live people.
- Mandatory separate states: loading, offline/stale data, sending, confirmation, transaction rejection, expired session, closed entry, pending settlement, settled, refunded.

### Balance and history

Available / locked, top-up, withdrawal of free funds, the terms of the active session and its revocation. The history contains all outcomes, not only wins. Position details: token, times, side, bet, P0/P1, price rule, fee, credit, refund reason and a link to the transaction. A direct claim/refund path is available if the automatic servicing fails.

### Profile and face editor

Verified name, own face, editor, notification/sound/vibration settings. We do not create a separate game world or a body wardrobe.

## 6. Pari-mutuel: exact math

For the winning side with bank W and the losing side with bank L, with the winner's stake s:

```text
fee    = floor(L * fee_bps / 10_000)
prize  = L - fee
payout = s + floor(prize * s / W)
```

Working value `fee_bps = 100`, maximum 100. The program uses integer lamports and checked arithmetic with a wide intermediate product. The fee is charged once for the whole round, not repeatedly with each claim. A winning bet gets back its principal s; a losing one receives 0.

Example with final banks UP = 0.6 SOL, DOWN = 0.2 SOL. A bet of 0.01 SOL is already included in the bank of its side:

| Outcome | Round fee | Payout to the owner of the specified winning bet |
|---|---:|---:|
| UP | 0.002 SOL | 0.0133 SOL |
| DOWN | 0.006 SOL | 0.0397 SOL |

This is the payout together with the principal, not the net profit. In the preview of a position that has not been sent yet, first add its amount to the chosen side. Before cutoff the amount changes with new bets; after cutoff it is fixed.

A fee on profit yields lower revenue than 1% of the total bank: with equal sides it is 0.5% of the bank. Do not calculate costs and sponsorship on the basis of the old fee base.

Rounding: each winning position receives a share of the profit rounded down. The remainder is recorded in Round; after all winning positions have been processed, a remainder of fewer lamports than the number of those positions may be transferred to the fee treasury by a separate verifiable instruction. The remainder must not be taken earlier, and unclaimed payouts must not be treated as rounding. There is no automatic burning of the user's right to claim in the MVP.

If one side is missing, in a refund outcome, with invalid data or an allowed timeout: return exactly the accepted bet, with a protocol fee of 0. Network costs are separate and are not promised to be refunded.

## 7. Lifecycle and time

```text
SCHEDULED → OPEN → LOCKED → ACTIVE → SETTLED_UP / SETTLED_DOWN
                        ↘ REFUNDABLE ← price failure / tie / timeout
```

- Entry is bounded by the program's clock, even if the keeper has not yet called the close. At the boundary and later, a new bet is rejected.
- The moment of signing/the client tap gives no right of entry. The state of the network after the transaction executes is the source of truth.
- After cutoff the banks are immutable. If one side is empty, the round can be moved to refund without requesting a price.
- The shared starting price window lies entirely after cutoff. The final window measures the result 60 seconds later relative to the chosen reference point of the starting window.
- The entry time, the margin between cutoff and the observations, the window durations, the precision, the equality zone and the deadline are fixed before entry and do not change for an open round.
- A valid sharp drop is an ordinary DOWN outcome. Do not refund money just because the token crashed.
- Before the deadline, settlement is possible only with the valid required observations. After the deadline an unsettled round is moved to refund; a late keeper cannot cancel a refund that has already been set.
- The outcome is finalized once. Repeated settlement/claim/refund do not create repeated credits.

The scheme above gives behavior requirements; choose the exact enum/instructions during implementation. Verify terminal transitions and settlement/refund races in the program.

## 8. Price source: the mandatory first stage

**The source has not been chosen yet.** Do not promise pump.fun before checking the required stage of the token: bonding curve, migration and CLMM/DLMM are not interchangeable sources. The mere existence of an oracle account is not sufficient.

The first engineering task:

1. Choose one source/pool type; check its program, data format, quote and the required observations on real young pools.
2. Define a reproducible P0/P1 rule: exact intervals, averaging method, units, rounding, minimum window coverage and permitted staleness.
3. Check rare trades, absent observations, migration and a halted pool. Record when a round is not opened and when it is refunded.
4. Set admission filters and the total bank limit, taking market depth into account. A separate per-wallet cap does not replace the total limit.
5. Record the result in `docs/archive/price-source.md`, attach a reproducible check and sample data. Then include this adapter in a working round.

In parallel one may build the UI on an explicitly labeled mock source and the money program on devnet with test values. The mock is not presented as a live market.

If the MVP uses a price signed by our server, this is an explicitly stated trust boundary: onchain money settlement does not make the price provider independent. The program checks the authority, Round/pool, times, format and the possibility of the transition; the server stores the source observations for reproduction. An arbitrary price from a client request is not accepted.

## 9. Architecture

Proposed stack: React Native/Expo for Android, Anchor/Rust for the program, TypeScript for the API/keeper and the shared client. Pin specific compatible versions after the first working APK and the MWA test. The existence of ready watcher code in other projects has not been checked yet; do not treat porting it as free or done.

**Program state:**

- Config/Market: allowed sources, configuration administrator, pause of new entries, parameters for future rounds.
- Vault: the authority's available money and the accounting of locks.
- Session: signer, authority, expiry, max_per_bet, gross session_cap and accumulated spend.
- Round: source, all times and the price rule, snapshot of fee/limits, banks, result, price, obligations and remainders.
- Position: a unique Round + authority pair, side, amount, processed flag.

**Main actions:** open/top up the vault; withdraw free funds; start/revoke a session; create a round; place a bet; record valid observations and the outcome; set a refund according to the rules; credit a payout/refund exactly once. Instruction names are not mandatory; the behavior is mandatory.

**API/keeper:** selection of an eligible token, the round schedule, chart delivery, an index of confirmed states, servicing of settlement/claim, profiles and invitations. The client restores an authoritative snapshot after reconnecting; a websocket event is not the sole proof of a position.

The API/profile has no authority to change a money result. The onchain price authority and the program's upgrade authority are described explicitly in the build documentation.

## 10. Permissions and invariants

- MWA confirms the connection/sign-in signature, money operations and the granting/revocation of permissions. The session key does not withdraw money, does not raise the limit and does not extend its own term.
- The program checks the limits. A session-key library does not replace financial constraints.
- Session spend is counted as the sum of accepted money bets. Winnings and refunds do not reset the counter; the user grants a new permission.
- One position per authority/round; retries and a repeated tap do not duplicate the debit.
- Locked money is unavailable for withdrawal. A pause of new entries must not block the intended payouts/refunds.
- All obligations are fully backed; user money, fees, rent and money for paying transaction costs are accounted for separately. Do not compare the sum of user balances with the lamports of some single account without taking the storage structure into account.
- A configuration change applies only to future rounds. An already open round keeps its parameters.
- A claim/refund may be serviced by the keeper or another permitted caller, but the recipient is fixed to the original authority/Vault and is not chosen by the caller.

## 11. Pixel faces: the mandatory direction

![Pixel faces concept](../design-references/pixel-faces-concept.png)

The image is a saved direction for the look, not a finished atlas and not proof that all combinations work. It was created with the built-in ImageGen; the exact prompt and purpose are recorded in the [reference description](../design-references/pixel-faces-concept.md).

- References: Pixels / MattleFun. Sims applies only to the ability to customize appearance.
- Only the face/head with hair. No bodies, shoulders or full-length figures, even in the editor.
- Settings: skin, hairstyle, hair color, simple facial features and accessories.
- Starting scope: up to 6 skin tones, 8 hairstyles, 6 hair colors; if time is short, reduce the variety while keeping the ability to choose.
- Trial grid 24×24 or 32×32; after checking legibility, choose one. Shared palettes, anchor points and scaling without smoothing.
- Layers: back hair → skin/face shape → eyes/brows/mouth → front hair → accessories. Check overlaps on all permitted combinations.
- One appearance and one set of data in the profile, the editor, the arena and the result card. Changing sides does not recolor skin/hair.
- The basic appearance is free. No NFT and no transactions on every hairstyle change.
- In the arena the faces are compact and subordinate to the chart. Visibility priority goes to oneself/friends; the rest are shown through a counter.
- The editor lives in the profile. Reactions are compact and can be turned off; there is no free walking.

## 12. Free mode, identity, invitations and SKR

**Viewing:** available without a wallet. **Training:** may use a recording labeled as a recording; no money payouts.

**Daily forecast:** one free attempt per UTC day per unique SGT mint, on the same price movement and cutoff. Points, no money bet in the bank. Needed: proof of wallet ownership, verification of the authenticity/current owner of the SGT, and server-side replay protection. Transferring an SGT between wallets does not create a new attempt. When a round is cancelled, the attempt is returned for the same day; reservation/consume/release are idempotent. Repeating requests must not be able to double the points.

Free positions do not affect the money coefficients. Money prizes of a free league, distribution of spendable betting credits and unlimited rewards are not part of the MVP.

**.skr:** resolving a name to an address and back; the name does not replace owner verification and is not a push address. There is a fallback to a shortened address.

**Invitation:** the system Share with a deep link to a session/round. An expired link leads to the current arena, not to a dead end. The friend chooses a side and confirms the bet themselves. Push only to registered, subscribed users.

**SKR, if time allows:** purchase of a specific cosmetic item/frame/emote. It does not change payouts, entry time or the quality of market data. The server verifies a confirmed payment of the required mint/amount/recipient, and issuance is protected against repeats. A separate SKR bank and a staking program are not created.

## 13. Implementation order

| Stage | Output | Transition criterion |
|---|---|---|
| 1. Foundation and price research | Build repository, APK, MWA, adapter interface, pixel face | The APK runs on Android; the price source and rule are verified, or the missing result is explicitly described |
| 2. Full devnet scenario | Program, Vault/Session/Round/Position, minimal arena and keeper | Two wallets go through deposit → bet → settle → claim and an independent refund scenario |
| 3. Full mobile UX | History, reconnect, background, chart and faces | No loss/duplication of a position after a restart; the user understands the risk and the payout |
| 4. Seeker and re-engagement | Editor, SGT/.skr, free forecast, Share | Transfer of SGT, repeated requests and a stale invitation are verified |
| 5. Polish and submission | Signed APK, build from the README, video and presentation | Install check on a device, an acceptance run, materials accessible to the judge |

Planned dates: 11-14 September - foundation; 15-21 - full devnet; 22-28 - faces and Seeker; 29 September - 3 October - bugs/polish; 4-6 October - materials and submission; 7-8 - reserve. The calendar is a guide; readiness is confirmed by the exit criterion.

## 14. Readiness checks

**Money program:**

- [ ] UP and DOWN with equal, unequal and heavily skewed banks; small amounts and rounding.
- [ ] Empty side, tie, unreliable price, deadline, settlement/refund race.
- [ ] Repeated bet, settlement, claim and refund; wrong signer/authority/round; arithmetic overflow.
- [ ] Cutoff and expiry at the boundary; exhausted budget; withdrawal/raising of permissions forbidden to the session key.
- [ ] The sum of credits, fees and remainder does not exceed the deposited bank; the winner's main balance does not decrease because of the fee on profit.
- [ ] Keeper stopped: a documented claim/refund path remains available.

**Android and data:**

- [ ] The APK installs and runs on a physical Android device, MWA works in the chosen combination.
- [ ] Two devices show the same Round and the same outcome/coefficients after sync.
- [ ] Weak network, RPC response lost after execution, double tap, going to the background, restart: the state is restored without repeated spending.
- [ ] A stale chart and a pending settlement are explicitly marked.
- [ ] Faces are legible at real size, without bodies; settings are saved and compatible.
- [ ] Free participants/spectators do not increase the money banks.

**Handoff and submission:**

- [ ] The README describes the environment, variables without secrets, running, tests, building the APK and the program.
- [ ] Versions, program IDs per environment, administrator permissions and the price source are recorded.
- [ ] The demo shows a working scenario, the network used and the real limitations; a recording/mock is not presented as live.
- [ ] There is a signed APK, accessible sources, a video and a presentation; the materials are checked before the deadline.

## 15. What the developer must determine first

These are the only substantial unresolved technical parameters; do not replace them with arbitrary production constants:

1. Source/pool type, sufficiency of observations and the P0/P1 method.
2. Price windows, equality tolerance, freshness and deadline.
3. MIN_BET, MAX_BET, the total bank limit, the session term and limit - based on market verification and costs.
4. Specific stack versions, the storage mechanism for the game key, the fee payer and compatibility with a physical Android device.

First implement the check and propose values with justification. For mock/devnet, explicitly marked test parameters are acceptable. Do not open mainnet intake of funds just because the UI is ready. Handing over this document is not a separate instruction to publish the app, send messages or deploy the money program.

## 16. Context, if needed

- [Working design of 11 September](2026-09-11-flipthememe-arena-design.md) - explanation of the choice of mechanics.
- [Research of 10 September](../research/2026-09-10-solana-mobile/review.md) - facts and hypotheses about the market; not a source of the old 1:1 decisions.
- The design of 10 September with the map and the old interactive 1:1 mockup - history. Do not use them as the current specification.

**Start with stage 1, then bring one full devnet scenario to working on a device. Do not re-choose the shape of the arena, the pari-mutuel mechanic or the pixel faces.**
