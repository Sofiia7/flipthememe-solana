# Submission texts (draft)

Fields in [brackets] are filled in right before submitting.

## Shared facts

- **Name:** FlipTheMeme
- **One-liner:** 60-second UP/DOWN calls on fresh Solana memecoins, matched 1:1 against other players, built for Seeker.
- **Links:** repository https://github.com/Sofiia7/flipthememe-solana · APK [release link] · demo video [video link] · pitch deck [deck link] · program `5kUCKYAYxZyaSz18xEajhSDNwdXvVLp2AvBp4LDxWuCz` on devnet.
- **Network:** Solana devnet for money; Solana mainnet (read only) for prices.

## Description (long form)

**Problem.** New memecoins launch on Solana all day, and the first hours are where the attention is. Yet the only thing you can do with a fresh token is buy it: rug risk, slippage and a bag to watch. There is no simple way to say "this goes up in the next minute" with a bounded stake, together with other people.

**What FlipTheMeme does.** One shared arena on your phone. Every minute a new round opens on the most active fresh PumpSwap token. You call UP or DOWN. Your stake is matched one to one against the other side: only the amount both sides cover plays, the surplus comes back without a fee, and a win pays exactly 1.96x of the stake that played. The result arrives about two minutes after entry closes and is credited to your in-app balance. You never touch the token.

**Fair by construction.** The rules come from a backtest we ran on 743 thousand real swaps across 15 memecoin pools for an earlier version of the project:
- the strike is the average pool price in a 10-second window that starts 30 seconds after entry closes, so nobody bets on a price they already see;
- a matched 1:1 bank means nobody profits from betting both sides of a skewed book;
- the accepted bank is capped by the pool's SOL reserve divided by 2,500;
- every failure path ends in a payout: no match, a tie, missing prices or a missed deadline all return stakes (a tie or a price failure keeps 1%).

**Mobile first.** Mobile Wallet Adapter is used where it matters: one approval deposits test SOL, opens a 24-hour session with a budget and funds a device key. After that every call is one tap; the device key can bet within the budget but can never withdraw or raise its own limit. Each player has a pixel face that rides inside every bet (8 bytes, no NFT, no extra transaction). Android Share sends a "take the other side" challenge.

**Price source and trust.** The keeper reads the PumpSwap pool's vault balances on mainnet every second. Every observation used for a strike or an exit (mainnet slot and price) is written into the devnet transaction, and the program computes the mean itself. The price signer is a trusted role on devnet and the app says so; claims never depend on it, and after the deadline anyone can refund a round.

**Architecture.** Anchor program on devnet (vaults, sessions, rounds, positions), a keeper crank (creates rounds, fills the short side with a budgeted house account on devnet, posts prices, credits winners), and an Expo / React Native Android app that reads devnet and mainnet directly: there is no app server.

**State.** Program deployed on devnet with 19 LiteSVM scenarios and a payout invariant test; the TypeScript client is checked byte for byte against the program; signed release APK built in GitHub Actions; keeper running continuously. [devnet rounds settled: __]

**Next.** Solana dApp Store release, then a mainnet gate: an audit, round length taken from the measurements (longer rounds lower the bot edge), independent price signing. Later: SGT daily free call, .skr names, SKR cosmetics.

## CLOCK IN specifics

- **Mobile integration:** Mobile Wallet Adapter (authorize, sign transactions), device session key in Android secure storage, Android Share, haptics, built and tested on Seeker.
- **SKR:** not integrated in this build (planned: cosmetics paid in SKR).

## Perps and Prediction Markets specifics

- **Market type:** short-horizon binary prediction market on spot memecoin prices, matched 1:1 peer to peer, settled on-chain.
- **Why it fits:** it lists markets that no venue lists (tokens a few hours old), resolves in two minutes, and pays from a matched bank without a house position on mainnet.
