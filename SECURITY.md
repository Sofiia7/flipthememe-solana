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

## Automated scan of 12 October 2026 and our answers

The hackathon's advisory scanner (Radiants Align) reviewed commit `25b0f94` and reported 97 findings: 10 high, 78 medium, 5 low, 4 info, with no score because not every check finished. We read each high finding against the code; none is an exploitable bug, two are documented trust limits. The full report is held by the organizers.

| Finding | What the code does |
|---|---|
| Missing signer on `SweepFees` (lib.rs, `treasury` writable) | Intended: anyone may crank it. `config` carries `has_one = treasury`, so the only account that can receive the fees is the configured treasury. |
| Missing signer on `CloseEmptyRound` (`admin` writable) | Intended: anyone may close an empty round. `has_one = admin` and `close = admin` pin the rent refund to the configured admin; the caller gets nothing. |
| `init_if_needed` on `session` in `start_session` | The session PDA is derived from the vault and the device key, and the vault carries `has_one = authority` with `authority` as the signer. Only the vault's owner can create or renew their own session; renewing resets the allowance, which is the renewal. |
| `initialize_config` assigns the admin to the first caller | A known bootstrap limit, listed under "Where this stands": it runs in the same step as the deploy, and there is no `set_admin`. Before mainnet the admin and the upgrade authority move to a multisig. |
| Signer passthrough CPI in `tests/flow.rs` | Test code, not part of the program. |
| Type cosplay at the position writer (lib.rs) | The helper allocates a fresh PDA through the System Program with the program's seeds, assigns it to this program and serializes a `Position` with its Anchor discriminator. It writes a new account; it never reads an unchecked one. Every read path uses typed `Account<T>` constraints. |
| Leaked secrets (4 files) | Storage key names (`ftm.diagnostics.v1`, `ftm.notifAsked.v1`, `ftm.pendingBet.v1`) and a made-up RPC key inside a redaction test. No credential is committed; keys live outside the repository (see "Where this stands"). |
| Unchecked arithmetic (62 medium) | The workspace builds with `overflow-checks = true`, and every lamport calculation uses checked or saturating operations; an overflow aborts the instruction instead of wrapping. |
| Dependency vulnerabilities (9 medium) | `pnpm audit --prod` names shell-quote, brace-expansion, node-forge, braces, source-map-js and uuid: transitive packages of the Expo and Metro build tooling that do not ship in the APK or in the Workers. They are upgraded with the next toolchain bump rather than hours before a deadline. |
