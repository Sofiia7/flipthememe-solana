# Security policy

FlipTheMeme is a hackathon-stage project. Please read the first section before you spend time on it.

## Where this stands

- **Devnet only, test SOL only.** The program runs on Solana devnet (`5kUCKYAYxZyaSz18xEajhSDNwdXvVLp2AvBp4LDxWuCz`). There is no mainnet deployment and nothing here holds real funds.
- **No independent audit.** The code has been reviewed by its author and with AI-assisted reviews only. Treat it as unaudited.
- **Trusted keys.** The upgrade authority, the admin key (the keeper's hot key) and the price attestor key are held by the maintainer. The README lists these trust assumptions under "Price trust" and the known limits; reports that only restate them are welcome but are not vulnerabilities.
- **No bounty.** There is no reward program and no promise of payment. If you report something real, you get a fix and public credit if you want it.

## In scope

- The on-chain program in `programs/flip-the-meme`.
- The keeper (`services/keeper`) and the attestor (`services/attestor`).
- The Cloudflare Workers: `services/attestor`, `services/link` and `services/chatter`.
- The Android app (`apps/mobile`) and the client package (`packages/client`).

Most interesting to us: ways to take or lock another player's funds, to get a price accepted without the attestor, to settle a round with a wrong or replayed price, to make `claim` or `sweep_fees` pay the wrong amount or the wrong account, to misuse the admin, house or session keys, and anything that leaks keys or secrets.

## Out of scope

- Third-party services and infrastructure (Solana itself, RPC providers, GeckoTerminal, PumpSwap, Cloudflare, X).
- Volumetric denial of service, spam, social engineering and physical attacks.
- Anything that needs a compromised phone or wallet.

## How to report

The owner plans to open this repository for the competition. While it remains private, the public reporting link below is not an available reporting channel. Once the repository is public and GitHub Private vulnerability reporting is enabled, use:

https://github.com/Sofiia7/flipthememe-solana/security/advisories/new

Please do not open a public issue or pull request for a vulnerability. Include what you found, the steps or transaction signatures to reproduce it, and the impact you see. This is a small project, so there is no response-time guarantee, but reports are read.

## Disclosure

Give us reasonable time to ship a fix before you publish details. Fixes to the program are upgrades of the devnet deployment, and the contact details also sit in the program's own security.txt.
