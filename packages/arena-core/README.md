> Status: superseded on 2026-10-05 by [README.md](../../README.md) and [docs/superpowers/specs/2026-10-05-flipthememe-solana-hackathon-build-design.md](../../docs/superpowers/specs/2026-10-05-flipthememe-solana-hackathon-build-design.md). Kept for history; the economics in this package are not current.

# @flipthememe/arena-core (legacy)

A dependency-free JavaScript model of one round from the September design ([DEVELOPMENT_BRIEF.md](../../DEVELOPMENT_BRIEF.md)): a pari-mutuel bank in which the winners get their stake back and share the losing side pro rata, minus a 1% fee on the losing side, with the phases `SCHEDULED`, `OPEN`, `LOCKED`, `ACTIVE`, `SETTLED_UP` / `SETTLED_DOWN` and `REFUNDABLE`.

The current program uses a different model: a matched 1:1 bank (`m = min(UP, DOWN)`), a fixed 1.96x payout on the matched part of a stake, a 2% fee on the matched bank on an UP or DOWN result, and free refunds. That model lives in `programs/flip-the-meme/src/payout.rs` and its mirror `packages/client/src/payout.ts`.

Nothing in the program, the keeper or the app imports this package (`apps/mobile/package.json` still lists it as a workspace dependency). Its 8 tests run with `corepack pnpm run test:legacy` from the repository root and say nothing about the current economics; `corepack pnpm test` runs the current suites.
