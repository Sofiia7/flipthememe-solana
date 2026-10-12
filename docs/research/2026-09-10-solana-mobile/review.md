# FlipTheMeme / MemePred: checking the idea for CLOCK IN

Research as of September 10, 2026. These are proposals for discussion, not new agreed decisions. The original design is unchanged. Read: the README and `docs/archive/2026-09-10-flipthememe-solana-mobile-design.md`, the text from the message and three images. There is no implementation in the current repository yet; portability of code from other projects was not checked.

**Recommendation:** one shared arena with short rounds on fresh tokens, recognizable players and explicit settlement rules. Keep the pixel style; remove the map, the deck and the reels from the first version. Check the value of the game itself and the fairness of the outcome before building additional rewards.

## Participation conditions: a significant omission

Under the [mandatory Terms, §6.1](https://solanamobile.radiant.nexus/legal/clock-in-terms.pdf), a project must have been started no earlier than three months before the hackathon launch. Permission to continue developing an existing product does not cancel this condition. With a launch on September 8, the boundary is June 8, 2026. If MemePred is older, you need to describe to the organizers the age of the base, the reused code and the new mobile part, and obtain a written clarification on eligibility. A new repository does not by itself make an old project new.

[CLOCK IN announcement](https://solanamobile.com/blog/clock-in-the-solana-mobile-hackathon): submission by October 8; $125 thousand in USDC and a separate $10 thousand in SKR; APK, source code, video, presentation. The site and the Terms confirm four criteria at 25% each, MWA and substantial mobile development. To receive the prize, publication in the store within 30 days after the announcement is required, not merely submission for review. In the announcement the results are due in early November; the site text says November 10; the embedded calendar contains yet another judging end date. Do not tie commitments to an exact day without current confirmation.

USDC prizes are limited to teams without VC/angel funding. Age, country of residence and KYC also affect eligibility. In the verified requirements a video is mandatory, but a hard limit of "exactly three minutes" is not established; three minutes is a reasonable presentation target.

**Ready-made question for the organizers, not sent:**

> I am building a new Android-first Solana application for CLOCK IN using parts of my existing MemePred project. The original project started on [date]; the new mobile application started on [date]. Reused components: [list]. New work includes the Android/MWA experience, synchronized rounds and Solana settlement. Under section 6.1, is this eligible as a new Project, or does the original project's start date control eligibility?

## Who won

[First Solana Mobile Hackathon, 2025](https://solanamobile.com/blog/solana-mobile-hackathon-winners-announced): Nomadz, Gib Meme, Blormmy, SP3ND, Plutus, Memeshot, dePlay, DojoDuel, Scrolly, Mattle. The BONK prize went to Rampa. Honorary recipients include Crypto Fantasy League, Trepa, Lince and DOLERO. The page was moved to the new blog and shows July 2026; this is not the date the first contest was held.

[MONOLITH, 2026](https://solanamobile.com/blog/solana-mobile-monolith-hackathon-winners-announced): NOMI, Echo Protocol, Pumpville, Tramplin, PredictTok, Cue, Backyard Fi, Foresee, SeekerClaw, Cashflow. SKR prize - Seek. Honorable mentions: Cherry, Timebent, Kickr, Kinlog, Hunters of Faenora.

Practical references: Gib Meme - memecoin cards; CFL - competition on market moves; Pumpville - a shared world and short sessions; Foresee - social predictions; PredictTok - mobile presentation of real markets; Cherry - recognizable identity and communities; Cashflow - SKR utility through fee payment. These are different ways to make an app useful on a phone. No requirement for a map, swiping, pixel graphics or mandatory daily bets can be derived from the awards.

## What "in the top" and "alive" mean

A public export from [Seeker Tracker](https://seekertracker.com/api/dappstore) was downloaded on September 10, 2026, around 18:33 UTC. This is a third-party index, not direct access to the phone's storefront. `dappstore-snapshot.json` contains the source data; `catalog-summary.json` contains the deduplication by Android package. Received **1,365 unique entries with active status**. The number of ratings is computed as the sum of `reviewsByRating`. This is not installs, DAU, paying users or the number of written text reviews. In places, the web pages of the search index lag behind the API.

| Application | Ratings | Rating | Latest version in the index, UTC (DD.MM.YYYY) |
|---|---:|---:|---|
| Jupiter Mobile | 7,098 | 4.8 | 09.09.2026 |
| TokenRun | 6,630 | 4.5 | 06.07.2026 |
| URnetwork | 5,939 | 4.4 | 25.03.2026 |
| Crypto Fantasy League | 5,930 | 4.2 | 06.12.2025 |
| MattleFun | 5,798 | 4.5 | 10.09.2026 |
| Scrolly | 5,483 | 3.9 | 06.09.2025 |
| Seed Vault Wallet | 5,255 | 4.7 | 05.09.2026 |
| LootGO | 5,109 | 4.3 | 20.03.2026 |
| Backpack | 4,744 | 4.6 | 29.08.2026 |
| Jito | 4,690 | 4.6 | 29.08.2025 |
| Cherry Messenger | 4,639 | 4.8 | 05.07.2026 |
| PumpFun | 4,116 | 4.3 | 25.08.2026 |
| SP3ND | 3,701 | 4.4 | 07.08.2026 |
| Moonwalk Fitness | 3,694 | 4.3 | 04.09.2026 |

The first ten rows are the ten leaders by number of ratings in this export. Especially useful reference points are added below them. Fresh APKs are a positive sign of support. An old APK does not prove death: web content and the server can change independently. The APK on the device, successful bets/withdrawals and competitors' retention were not checked in this research.

The **Top Picks** category currently contains: Cherry, Jito, LootGO, Lulo, Moonwalk Fitness, ORE, Sanctum. This is an editorial selection. It does not coincide with the list of winners. Its median does not prove that winning causally produces such a volume of users.

| Close product | Ratings | Rating | Version (DD.MM.YYYY) | Verified description / meaning |
|---|---:|---:|---|---|
| Gib Meme | 2,297 | 3.9 | 17.06.2026 | Cards whose strength changes with the market |
| BananaZone | 1,331 | 4.1 | 19.08.2026 | Trading presented as an arcade; more useful as a fresh neighbor in the category |
| Klout | 775 | 3.9 | 12.12.2025 | In the store - trend forecasting with cards; the current site is already about something else |
| Chartz | 527 | 3.8 | 10.11.2025 | Historical charts; the site also shows a PvP beta |
| Polyswipe | 439 | 3.5 | 17.10.2025 | Swipes on markets, Polymarket liquidity claimed |
| TBD | 407 | 3.9 | 03.12.2025 | Forecasting popular answers, USDC |
| Vibe Predict | 374 | 3.8 | 22.01.2026 | Tokenized Kalshi / DFlow markets |
| PredictTok | 247 | 3.9 | 18.03.2026 | Jupiter prediction markets and video |
| Kickr | 162 | 4.1 | 09.09.2026 | Sports markets; fresh version |
| Manic.Trade | 5 | 4.0 | 09.06.2026 | Higher/lower across different assets, early open beta |

Among the MONOLITH winners: Tramplin has 821 ratings; Seek 484; SeekerClaw 440, updated September 10; NOMI 410; Backyard Finance 390, updated September 6; Pumpville 389, updated August 30; Cashflow 188; Echo 61; Cue 9. Cherry has 4,639, Hunters of Faenora - 1,562, Kinlog - 247, Timebent - 216. Winning and demand are different facts. Foresee, Memeshot, dePlay, Plutus and Blormmy were not found under those names in the export; this is not proof of closure or of the absence of a rebrand.

**Corrections to the original reconnaissance:**

- "Serious trading on Seeker is dead" - not supported. Jupiter, PumpFun and Backpack have a large accumulated footprint and fresh versions. [Solana Mobile](https://solanamobile.com/blog/skr-season-1-claims-wrap-monolith-crowns-winners-and-seeker-goes-shopping) also reported a notable volume of DEX operations from Seeker in Q1; this is the organizer's data, not an independent study of users.
- [Chartz](https://www.chartz.xyz/) uses history, not a live chart. The site has a competition on identical charts. You cannot claim uniqueness simply from the combination of a chart and PvP.
- [The Klout card](https://seekertracker.com/dapps/com.kloutgg.app) describes a game on internet trends; [the current klout.gg](https://klout.gg/) is paid link promotion. The reliability of the old reference is in question.
- "Competitors have only simulation and points" is incorrect for the whole list: several products directly use real-money prediction markets.
- 3.5-3.9 stars do not mean competition is easy: the cause may be unclear payouts, the wallet, delays or expectations of rewards. To choose, real reviews and tests are needed, which are not available here.

## Proposed product shape

Working pitch: **"A fresh memecoin. A shared start. 60 seconds to test your forecast against other Seeker players - without buying the token itself."**

The wording "you can only buy" is too absolute: the availability of shorts and other products changes. The exact problem is the ability to express a short bearish/bullish view on a very fresh supported token without buying its spot. This is not a full hedge: partial execution, the term and the limited payout change its properties.

A shared arena concentrates attention and opposing orders well. But the thesis "there is no content" is excessive. There are the price trajectory, age, liquidity depth, activity and participants. Enough information to decide should be shown, rather than forcing a reaction to an empty ticker.

Do not turn the absence of video into an argument against any feed. A new-token card may work. The choice of an arena here is a deliberate bet on a shared moment and an affordable development scope, not a proven single correct form.

For the start - **one arena, one pair of sides, one duration and one pool source**. Daily announced sessions of 3-5 rounds gather a small audience better than a round-the-clock promise of a crowd. Outside sessions - free viewing/practice with an explicit note that this is a recording. Do not pass off recorded events and bots as live people.

## The round must be defined before implementation

Example for a prototype, not verified optimal intervals:

1. About 20 seconds of accepting forecasts. Everyone sees the current data but understands that the reference price will be determined after closing.
2. Entry is closed by program time. A short margin for transaction delivery and confirmation; late ones are rejected. The time of the client's tap is not proof of participation.
3. A shared P0 is formed over a predefined observation window after the cutoff.
4. 60 seconds of measured movement; at the end - a predefined P1 window. No bet may be added and no side changed after closing.
5. UP/DOWN settlement; on a tie within the set zone - refund. If there is no reliable data - the provided refund procedure.

"60 seconds of movement" does not mean "a full cycle in 60 seconds": with intake, price windows and settlement the cycle will be longer. The timer bar must label the phase. The actual outcome must be confirmed before promising a received payout.

Define separately: the quote currency; arithmetic or geometric mean; precision; minimum number of observations; allowed staleness; pause rules; pool migration; postponement/cancellation of a market; the settlement deadline. A rug with a valid price is an ordinary market outcome, while a technical loss of price is a different situation. An automatic refund on any drop creates wrong incentives.

**Main difference from the old plan:** instead of individual `entry_price` and `settle_at` per match, a shared `Round` with fixed time, price source, windows and rules is needed. A five-minute queue does not combine with a shared current round.

## Matching: pick one economy

| Option | Plus | Cost of the decision |
|---|---|---|
| 1:1 pair coverage, settlement by the whole round | Predictable win on the executed portion | Return of one side's excess; a clear partial fill is needed |
| Shared pari-mutuel pool, winners split the pot | Easier to assemble a single pot; both sides are executed in full when both are present | The odds change before closing; a different program and economics |
| Pair coverage plus a house | Can reduce refunds | Capital, manipulation risk, conflict of interest, reserve accounting |

To preserve the core idea, start with the first option, without promising full execution of every order. Honestly show "submitted", "covered", "returned". Allocation of the excess: a pre-chosen pro rata or another transparent policy; this matters more than the avatar animation.

Example without a house: UP = 2.3 SOL, DOWN = 7.1 SOL. 2.3 is matched on each side, the pot is 4.6; 4.8 of DOWN is returned. If the fee equals 1% specifically of the entire matched pot, the winner receives 1.98× the executed amount, with the returned original principal taken into account. Another way of charging the fee gives a different result - the words "rake 1%" are not enough.

The crowd does not change the odds in such a 1:1 variant: the minority's advantage is above all the probability of full execution. In a pari-mutuel pool the minority affects the odds. These models cannot be mixed in the interface.

The house, if it appears, must reserve funds in advance, have its side and executed amount explicitly displayed, and observe the same entry boundary. The label `HOUSE · REKT` does not prove fairness. A special conflict: one side chooses the token, provides the price and accepts the opposing bet. Do not hide these roles. A percentage of one's own bankroll does not protect other participants from price manipulation.

## Price source - the main technical fork

The reference says `pump.fun`, while the design plans to study Meteora DLMM / Raydium CLMM. These are different states and pool types. A TWAP found in a CLMM does not guarantee price availability for a launchpad token that has not yet migrated. First define the supported source and the stage of the token's life, then promise an age of "four minutes".

[Raydium](https://docs.raydium.io/security/oracle-and-token-risks) describes internal observations and warns against using the instantaneous price for derivative products. But the presence of an oracle field does not prove sufficient history or economic robustness of the chosen one-minute market. On a young, thinly traded pool, averaging does not create information from nothing.

Minimum admission criteria must be checked on real pools: availability of the needed window, staleness of observations, liquidity depth, activity, token extensions and the ability to obtain a reproducible result. What should be capped is the aggregate payout per market, not only the stake of an individual wallet. Numerical limits are chosen after analysis of the supported pools, not from the assumption that Solana fees are small.

If the MVP uses a signed price from its own server, say so plainly: the money settlement is performed by the program, but the source of the result is still trusted. Store the parameters and the observations/references used, provide a finite deadline and a self-service claim/refund if the keeper stops. Do not call such a construction fully trustless.

## For Solana Mobile

- **MWA + limited session:** the budget and term are confirmed through the wallet. After that, quick actions with a local key. [Solana recommends session keys](https://solana.com/developers/cookbook/wallets/auto-approve), but bet limits and allowed instructions must be checked by your program. The [SessionToken](https://raw.githubusercontent.com/magicblock-labs/session-keys/master/programs/gpl_session/src/lib.rs) has an authority, signer, target program and expiry; there are no general limits on your turnover there. Pin a version, rather than assuming the current master is audited.
- **Do not restore the spent limit with winnings by default.** Separate total turnover, open risk and available balance. `withdraw`, authority change and limit increase must not be available to the game key.
- **SGT:** verification of wallet ownership and SGT authenticity; daily uniqueness by SGT mint, not by wallet address. [The current recipe](https://docs.solanamobile.com/recipes/general/detecting-seeker-users) explicitly accounts for transfer between wallets. A device is not a unique person, and `.skr` is not a delivered push.
- **Names:** [.skr resolves to an address via AllDomains](https://docs.solanamobile.com/solana-mobile-stack/skr-domain). An invitation is delivered only through the installed app and notification consent, or as an ordinary link through the system Share. If the round has expired, open the next one, not an error.
- **Practical mobile UX:** large thumb targets, distinct phase labels, a short vibration on a confirmed entry/outcome, the ability to turn off sound and vibration, state recovery after backgrounding, a notification about a scheduled session. Do not send a push for every bet to the whole room.

## Which mechanics to keep and replace

**Keep:** recognizable avatars, the shared scene, a free daily forecast, the history of results, a meaningful share card, a button to repeat the previous amount with an explicit tap. Reward accuracy and participation under equal conditions, not deposits or losses.

**Daily return:** 3-5 shared rounds as a short tournament; a free forecast in the same events; a small friends/weekly leaderboard. For the free league, the same number of attempts and the same rules; money does not buy accuracy. The history should show the number of forecasts next to the percentage of correct answers. A complex confidence ranking and a Bayesian score can be deferred.

**Free by SGT:** safer for the economy is a free attempt with points; if a money prize is needed - a pre-fixed sponsor budget and rules. Issuing credits that are spent for real money in PvP requires protection against drains through a second participant. The presence of an SGT alone is insufficient.

**SKR:** do not use it to unlock sectors, faster entry or better market information. Do not split the early audience between SOL and SKR pots. A practical first option is a useful option in the same arena: payment for cosmetics/emotes or a budget-limited gas pass. This is not automatically a strong contest integration. A more pronounced idea for later - a sponsored free tournament with a pre-deposited SKR prize, common conditions and a verifiable payout; it requires a separate specification.

**Remove rolling a win into a new bet by default.** The win can stay available on the balance. A new bet is a separate action on a chosen token. After the round closes, you cannot promise that an already locked bet can be taken back "at any moment". Cashout requires a separate buyer/liquidity and new rules.

**Invitation to a friend:** invites the friend to watch and choose a side. If this is a strict duel with opposite sides, an explicit accept, amount and term are needed; this is a separate scenario. Do not make it mandatory in the MVP.

## Corrections to the supplied screen

Strong elements: your own character among others, short .skr names, a shared scene, a simple palette. Pixel graphics give recognizability without the cost of a full game world.

1. The large empty tiled area and the coin take the place of the chart. Give the center to the chart with a shared starting line; keep the coin as a small portrait of the token.
2. Two explicit UP and DOWN zones with labels, people and amounts. Color complements the direction and does not replace it. Avatars should mean confirmed positions. Spectators are counted separately.
3. On the original screen, on the right side, the visible players add up to 2.6 SOL, while the side total is 7.1. If the 4.5 difference is covered by the house, show it as a real position; `cap 4.5` means only a limit, not a deposited amount.
4. Label the timer: "Entry closes", "Until result", "Confirming payout". Do not mix these moments.
5. At the moment of choice, give UP and DOWN equal weight. After confirmation, show the participation amount; do not leave the ADD UP button available after the cutoff.
6. 0.1-1 SOL should not be the standard starting range for a first acquaintance. Pick exact small amounts from tests and economics; show the equivalent and the maximum risk.
7. Instead of an unlabeled `$422.30`, specify what it is: price or market cap. The main number during the round is the change from the shared P0, not an arbitrary +5.5% from an unknown moment.
8. Add 2-3 signals before the decision: token age, recent activity, liquidity/its understandable category. Do not call the filter a guarantee against a rug.
9. Move `session -0.7 SOL`, `week -1.8 SOL` and `HOUSE REKT` away from the center. What needs to be in view: free balance, locked amount and the permitted budget; the history of wins and losses belongs in the details.
10. The ticker of spot purchases must not be mixed with participants' bets. Make a separate expandable market feed or remove it from the MVP.
11. Result: the price outcome, the result of one's own position, the refund of the unexecuted part and the fee. General joy/animation does not replace a settlement receipt.
12. Limit the scene to a few avatars with priority to yourself/friends, and merge the rest into a counter. Do not build a full movement engine.

## Scope and order of work

| Priority | What is included |
|---|---|
| Required core | Android APK and MWA; one arena; a shared Round; price source; entry/closing/settlement/refund; limited session; balance and history; explicit network statuses |
| Next | SGT and .skr; free mode; result card; invitation link; a simple daily session |
| Only if the core is ready | One SKR utility; push; a minimal weekly leaderboard |
| After submission | Map, reels, separate rooms, own SKR staking, 16 badges, complex duels, LP from external users, auto-rollover, cashout |

**September 10-13:** clarify the project's eligibility, choose supported pools and price rules, release the first APK on a physical Android device, test the wallet. At the same time show the mockup to several people and find out whether they can explain the goal without a hint.

**September 14-21:** in the original calendar this week is taken by Arbitrum. Do not count this week as Solana production capacity.

**September 21-27:** a full vertical scenario on devnet: entry, confirmation, closing, settlement, refund, reopening the app. The base arena develops together with the program, not after the backend is finished.

**September 28 - October 2:** tests with a small group in a shared session. Less decorative development, more checking of understanding and network failures.

**October 3-5:** fixes, signed APK, reproducible build, video and presentation. **October 6-7:** submission with a margin; **October 8** - reserve.

If there is no reliable full scenario by September 27, cut the money mechanics and the expansion of sources, rather than hiding errors behind animation. The demo can clearly label devnet; check support for the required environment and the admissibility of a specific format against the current conditions. Do not replace a working Solana scenario with a video clip.

## What to actually verify

- Five testers explain in their own words what UP wins relative to, what the timer means and how much money is at risk.
- Median and slow cases of time to first action; share of those who completed the first round; return for the second announced session.
- Concurrent participants, side skew, share of the executed amount and reasons for refunds; these indicators matter more than the number of sign-ups.
- Expired session, repeated tap, lost RPC response, late transaction, repeated settlement/claim, offline and return from background.
- Equal prices, sparse observations, pool halt, migration and keeper stop; funds must not hang without a finite refund path.
- Money invariants separately from instruction coverage: obligations are backed; fees, reserves, rent and user money are kept separate; a payout does not create money; a session renewal does not bypass the limit.

The main economic check is whether a round can survive directional influence on the price at its own maximum pot. The absence of an audit and a low per-wallet cap do not resolve this question. Bets on a real market also do not automatically get an exemption from the rules for financial products/money games: the [Publisher Policy](https://docs.solanamobile.com/dapp-store/publisher-policy) requires compliance with applicable requirements. Store availability and contest eligibility do not equal permissibility of the money version in all countries.

**Demo for judges:** a shared token and two players on two devices → permission for a limited session → entry without a repeated wallet prompt → shared closing → a clear result and an onchain transaction → a free Seeker scenario/invitation → a brief explanation of the price source. The main selling value is a joint decision on a live market; the technical architecture supports it.
