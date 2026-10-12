# Submission texts, revised 12 October 2026

These texts describe the implementation. Fill the TODO items below and attach verification for the exact public APK before submitting. A build, a devnet deployment and a physical Seeker acceptance test are separate evidence.

## Shared facts

- Name: FlipTheMeme.
- One-liner: A shared mobile arena for UP/DOWN calls on a Solana memecoin’s next one-minute TOKEN/SOL move, with a bounded stake and one-to-one matching.
- Repository: https://github.com/Sofiia7/flipthememe-solana
- Install page: https://sol.flipthememe.com/get
- APK: https://github.com/Sofiia7/flipthememe-apk/releases/latest/download/FlipTheMeme.apk (the install page names the exact version and SHA-256)
- Demo video: TODO before submitting: link to the three-minute recording of the submitted APK on a Seeker.
- Pitch deck (public PDF, 13 slides): https://github.com/Sofiia7/flipthememe-apk/releases/download/pitch-deck/FlipTheMeme-pitch-deck.pdf
- Money: Solana devnet test SOL. Price reads: Solana mainnet PumpSwap. Program: `5kUCKYAYxZyaSz18xEajhSDNwdXvVLp2AvBp4LDxWuCz`.
- Wallets checked over Mobile Wallet Adapter: Seed Vault Wallet (Seeker), Solflare, Jupiter Mobile. Phantom opened but returned no signature.
- First two-person round on two phones: round 8723 on 12 October (0.02 UP vs 0.02 DOWN, no house, settled DOWN), explorer: https://explorer.solana.com/address/DWrxSr4hsoXUaKqHaycLT5FnQRGCXQX97naNF785auyg?cluster=devnet

## Description

Memecoin attention moves quickly. FlipTheMeme turns a view about a token into a small, shared UP/DOWN call without buying that token. The arena opens rounds when market and oracle checks pass. A scheduled round accepts entries for 60 seconds, waits 30 seconds, averages a ten-second reference window, then averages a ten-second exit window one minute later. A result normally arrives 100-160 seconds after entry, plus network confirmation and claim time.

The price is TOKEN/SOL, not USD. Stakes match one to one against the other side. A win returns 1.96 times the matched stake at the configured 2% fee; unmatched surplus comes back separately in the same payout. A tie, no match, unavailable price or expired settlement returns the stake under the program’s refund rules. Position rent is a separate refundable account deposit, and device transaction fees are another separate cost. The receipt shows stake, matching, total return and net change.

Mobile Wallet Adapter prepares a vault and a limited device session. The default is one hour, a 0.02 SOL maximum bet and a conservative turnover allowance; the player can choose longer sessions and larger limits. Turnover is permission to spend cumulatively, not a maximum loss guarantee. Existing device sessions remain active until revoked. The device key cannot withdraw, increase its limits or extend its own lifetime. A remembered first call is placed only into its original round with its original amount if it is still valid after wallet approval. Otherwise the app asks for a new call. Subsequent calls use the device key without another wallet approval.

The app combines pixel identities carried inside positions, result receipts, streaks, a friend score, verified .skr names, challenge links, Android sharing, haptics and result reminders. The friend status comes from a confirmed on-chain position, not inferred online presence. Players can inspect multiple active calls and keep the chart, round clock and token identity on the same selected round. There are no practice predictions.

## Oracle and custody trust

The active price protocol uses a detached canonical certificate. An attestor samples the mainnet pool and freezes one ordered sample list for each round/window, signs a domain-separated message bound to the program, round and window, and publishes the certificate. A keeper or another relayer can submit the same certificate; the program verifies its Ed25519 signature and computes the arithmetic mean of those signed samples. Empty canonical samples produce the protocol’s unpriceable/refund path. These are discrete observations, not a time-weighted or independently verified cross-chain oracle.

The attestor and keeper are currently operated by the project team. The attestor is a separate signing role, not an independent organization. Its key can sign false price data; the signature proves authorization and message integrity, not market truth. The upgrade authority can replace the program and remains a custody trust assumption. Claims and expired refunds are permissionless instructions, but still require a functioning RPC and a transaction fee payer. Key separation and deadline refunds reduce specific failure modes; they do not remove operator trust.

## Architecture and reliability

An Anchor program holds vaults, sessions, rounds and positions. A keeper selects markets, schedules rounds, bootstraps the short side with bounded house fills, relays certificates, claims payouts and returns account rent. An Expo / React Native Android app reads the chain. Cloudflare services provide the attestor, challenge/install pages, a signed keeper index and social posts.

The audit revision adds separate liveness/readiness, fresh sampling checks, bounded RPC failover, a scheduler refusal when dependencies are unhealthy, aggregate exposure budgeting across overlapping rounds on the same pool, and archive-before-close gating. The signed archive preserves newly indexed final positions after account closure; mobile recovery currently reads the newest 500 records. It cannot reconstruct records already closed before indexing. A fresh public status publication does not make an old leaderboard scan fresh.

## Evidence to attach

Use the exact release manifest: commit, APK version/SHA-256, dependency lock hash, program source hashes, build URL. Separately attach deployed-program byte verification and the program test artifact. Attach the latest TypeScript test and typecheck logs and a completed physical-device matrix from `docs/android-acceptance.md`.

Do not claim continuous healthy operation, measured retention, anti-bot profitability, independent oracle operation or current Seeker acceptance without evidence. Earlier research was on Robinhood Chain/Uniswap v3 and is hypothesis-generating; it does not validate PumpSwap execution or Solana latency. `docs/research/solana-validation.md` defines the missing held-out replay, manipulation and economics checks. Empty/shadow rounds are observations, not user activity.

## CLOCK IN emphasis

Show the actual phone journey: understand TOKEN/SOL → choose a side and amount → inspect and approve session permissions → see a confirmed position → understand matching and the delayed reference → inspect the payout receipt → share and rejoin a friend → inspect and revoke sessions or withdraw. Use a three-minute video of the exact submitted APK. State MWA, secure device storage, .skr, App Links, notifications and SGT verification as implemented features; claim device compatibility only for completed acceptance runs. SKR purchases are not implemented.

## Solana Perps & Prediction Markets emphasis

This is a short-horizon binary spot prediction market, not leveraged perpetual futures. Its strongest differentiators are the delayed reference, fixed payout on the matched stake, visible unmatched refunds and mobile session permissions. Its largest remaining validation risks are oracle/custody trust, manipulation of young pools, thin matching, correlated overlapping exposure and operation through RPC outages. Confirm organizer eligibility before submitting to a separate competition. Mainnet requires independent review, measured PumpSwap adversarial replay, sustainable costs and a stronger authority/oracle model.

## Clock In form answers (paste)

**Has the team or project received venture or angel funding?** No.

**Built in the last 3 months?** Yes. The round rules were designed in an earlier EVM web prototype (April 2026). The Anchor program, keeper, attestor and the Android app were written from scratch from 10 September 2026.

**Won a previous hackathon with this project?** N/A.

**Major new mobile development:** Mobile Wallet Adapter top-up and session flow with one approval, a device key in Android secure storage for one-tap bets, Android App Links for challenge pages, local reminders after leaving a round, native share sheets, Seed Vault Wallet support on Seeker, .skr names, a Seeker Genesis Token badge, and a non-scrolling arena tuned on a Seeker at 360 to 412 dp widths.

**SKR integration:** No SKR token flows. Seeker identity is used instead: .skr names replace wallet addresses in the arena and on the leaderboard, and Seeker Genesis Token holders get a SEEKER badge. SKR cosmetics for pixel faces are a planned next step, not part of this build.

**Repository:** https://github.com/Sofiia7/flipthememe-solana

**Android APK:** https://github.com/Sofiia7/flipthememe-apk/releases/latest/download/FlipTheMeme.apk
