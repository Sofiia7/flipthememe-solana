# Submission texts (draft)

Fields in [brackets] are filled in right before submitting.

## Shared facts

- **Name:** FlipTheMeme
- **One-liner:** UP/DOWN calls on the next 60-second move of a fresh Solana memecoin, matched 1:1 against the other side, built for Seeker.
- **Links:** repository https://github.com/Sofiia7/flipthememe-solana · APK [release link] · demo video [video link] · pitch deck [deck link] · program `5kUCKYAYxZyaSz18xEajhSDNwdXvVLp2AvBp4LDxWuCz` on devnet.
- **Network:** Solana devnet for money; Solana mainnet (read only) for prices.

## Description (long form)

**Problem.** New memecoins launch on Solana all day, and the first hours are where the attention is. Yet acting on a view about a fresh token usually means buying it: rug risk, slippage and a bag to watch. There is no simple way to say "this goes up in the next minute" with a bounded stake, together with other people.

**What FlipTheMeme does.** One shared arena on your phone. Every minute a new round opens on one busy memecoin, preferably one whose PumpSwap pool is 10-120 minutes old. You call UP or DOWN on its price in SOL (TOKEN/SOL). Your stake is matched one to one against the other side: only the amount both sides cover plays, the unmatched surplus comes back without a fee, and a win pays 1.96x the matched part of your stake. The 60 seconds is the measured move; the result arrives roughly 100-160 seconds after your tap, plus confirmations, and is credited to your in-app balance. You do not buy the token.

**Rules shaped by research.** The rules were carried over from research on an earlier version of the project on Robinhood Chain, not on Solana: 743,127 swaps in 15 Uniswap v3 memecoin pools over 14 days (15-29 September 2026). There, a strike taken before the bet let a bot win 89% of resolved 60-second matches against a fixed-payout vault, and in simulations at 2-10 bets per hour a payout multiplier that follows the book cost ordinary players 9-22% of their accepted stake. So in FlipTheMeme:
- the strike is the average pool price in a 10-second window that starts 30 seconds after entry closes, so it is still unknown when anyone taps;
- a matched 1:1 bank pays the same 1.96x whatever the book looks like, so betting both sides of a skewed book only costs the fee;
- the matched bank is capped by the pool's SOL reserve divided by 2,500 (and by 1 SOL), which limits what one round can win relative to the pool;
- no match, a tie, missing prices or a missed deadline return the stake in full (refunds are free since 5 October 2026);
- the fee is 2% of the matched bank on an UP or DOWN result.

The devnet timing has not been measured against bots yet, and no Solana backtest has been run.

**Mobile first.** Mobile Wallet Adapter is used where it matters: one approval deposits test SOL, opens a 7-day session with a budget and funds a device key. After that every call is one tap; the device key can bet within its budget, and the program gives it no instruction to withdraw or raise its own limit. Seed Vault Wallet on Seeker and Solflare work on devnet. Each player has a pixel face that rides inside every bet (8 bytes, no NFT, no extra transaction). Android Share sends a "take the other side" challenge with a round link that opens the app on that round, and outside a bet "Play with a friend" sends an invitation the same way.

**Price source and trust.** The keeper reads the PumpSwap pool's vault balances on mainnet every second. Every observation used for a strike or an exit (mainnet slot and price) is written into the devnet transaction, and the program computes the plain mean itself. The devnet program cannot read mainnet, so a second, independent signer checks every price: an attestor on Cloudflare samples the same pool on its own and co-signs a strike or exit only when the keeper's samples match its reads (exactly at shared slots, within 1.5% on the mean). The program refuses a price without that signature, and the admin key alone cannot switch the attestor off. Price, house, treasury and upgrade authority sit on separate keys. Claims do not depend on any of them, and after the deadline anyone can refund a round, so a withheld price ends in a refund, never in a wrong result.

**Architecture.** Anchor program on devnet (vaults, sessions, rounds, positions), a keeper crank (creates rounds, fills the short side with a house account capped on chain, posts prices, credits winners, returns position rent), and an Expo / React Native Android app that reads devnet and mainnet directly: there is no game server. Three Cloudflare Workers co-sign prices, serve shared round links and serve live X posts.

**State.** Program deployed on devnet with 34 LiteSVM scenarios and a payout invariant test; the TypeScript client is checked byte for byte against the program; signed release APK built in GitHub Actions; keeper and attestor running continuously. Since the 6 October upgrades, position rent is held from the game balance and returns to it a day after the round, house fills are capped on chain, and every priced round carries the attestor's signature. Known devnet limits are listed in the README: both signers are run by us, the mean is not time-weighted, history is kept on the phone. [devnet rounds settled: __]

**Next.** Solana dApp Store release, then a mainnet gate: an audit, the admin key in a multisig, the attestor run by an independent party, and round length set from measurements on Solana data. Later: SGT perks and SKR cosmetics (.skr names are in already).

## CLOCK IN specifics

- **Mobile integration:** Mobile Wallet Adapter (authorize, sign transactions; tested with Seed Vault Wallet on Seeker and with Solflare), device session key in Android secure storage with a list of every session and one-tap revoke, Seeker ID (.skr) names next to players, Android Share with App Links, haptics, built and tested on Seeker.
- **SKR:** not integrated in this build (planned: cosmetics paid in SKR).

## Perps and Prediction Markets specifics

- **Market type:** short-horizon binary prediction market on the TOKEN/SOL spot price of fresh memecoins, matched 1:1 peer to peer, settled on chain.
- **Oracle:** TOKEN/SOL from the pool's vault balances on mainnet; every sample is in the settlement transaction, and an independent attestor must co-sign each strike and exit before the program accepts it.
- **Why it fits:** it offers prediction markets on tokens whose pools are minutes to hours old, which few venues offer, resolves roughly 100-160 seconds after a call, and pays from a matched bank; the devnet house fill is a bootstrap for one-sided rounds, not part of the mainnet design.
