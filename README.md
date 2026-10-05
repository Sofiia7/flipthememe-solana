# FlipTheMeme on Solana

Android-first shared arena for 60-second UP/DOWN forecasts on fresh Solana tokens. It is being built for the Solana Mobile CLOCK IN hackathon; submissions close on **8 October 2026**.

The current product is one common round, not a feed, map, duel, or full-body avatar world. Players see the same chart and the same UP/DOWN pools. They participate against the crowd through a parimutuel pool, without buying the token itself. Avatars are compact custom pixel faces only.

The complete product brief is [DEVELOPMENT_BRIEF.md](DEVELOPMENT_BRIEF.md). It is authoritative over archived map/duel documents.

## What is implemented

- Dependency-free money/state model in [`packages/arena-core`](packages/arena-core/src/arena.mjs): cutoff, one position per authority, 1% of the losing pool, pro-rata payout, claims, ties and timeouts.
- Expo 57 React Native app in [`apps/mobile`](apps/mobile/App.tsx): shared arena UI, pixel faces, amount/side selection, devnet Mobile Wallet Adapter provider.
- Mock-only keeper API in [`services/keeper`](services/keeper/src/server.mjs), which makes the absence of an approved live price source explicit.
- Anchor program draft in [`programs/flip-the-meme`](programs/flip-the-meme/src/lib.rs): Config, Vault, session restriction, Round, Position, settlement, refund and claim instructions.

The app is intentionally development-network only. `Config` starts in an irreversible `MOCK_ONLY` state, so the program rejects both deposits and round creation until a separately audited live-price implementation replaces it. No program ID, live price source, signing key, monetary production deployment, or APK is claimed as complete.

## Local setup

Prerequisites for the mobile app: Node 22.13+, pnpm 11, Android SDK/Java and an MWA-compatible Android wallet. A custom Expo development build is required; Expo Go cannot load MWA native modules.

```powershell
pnpm install
pnpm test
pnpm --filter @flipthememe/mobile typecheck
pnpm --filter @flipthememe/keeper start
pnpm android
```

The current workspace has Node and pnpm installed. Rust, Anchor, Solana CLI, Java/Android SDK are not installed here yet, so `anchor build` and `pnpm android` still require their toolchains.

## Validation run

On 15 September 2026:

- `pnpm --filter @flipthememe/mobile typecheck` passed.
- `node --test packages/arena-core/test/*.test.mjs` passed 8/8 scenarios.
- `cargo check --manifest-path programs/flip-the-meme/Cargo.toml` passed with the pinned Anchor 1.1.2 dependencies (the native MSVC environment is required on Windows).

The contract must be compiled and tested with a pinned Anchor/Solana toolchain before it is trusted with devnet funds. See [price-source.md](docs/implementation/price-source.md) and [mwa.md](docs/implementation/mwa.md) for the two remaining integration gates.

## Product and research documents

- [Arena decision and UX rationale](docs/superpowers/specs/2026-09-11-flipthememe-arena-design.md)
- [Solana Mobile research](docs/research/2026-09-10-solana-mobile/review.md)
- [Pixel-face direction](docs/design-references/pixel-faces-concept.md)
- [Price-source gate](docs/implementation/price-source.md)
- [MWA setup](docs/implementation/mwa.md)
