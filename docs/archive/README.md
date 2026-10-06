# Archive: history, not current

The files here are the September 2026 planning and review documents. They are kept so the project's history stays readable, but **they do not describe the current product**. Read the root [README.md](../../README.md) and the [5 October build design](../superpowers/specs/2026-10-05-flipthememe-solana-hackathon-build-design.md) instead.

What is outdated in them:

- **Economics.** They describe a pari-mutuel bank (winners share the losing side pro rata, 1% fee, no house). The shipped game is a matched 1:1 bank with x1.96 for the winner, a 2% fee on the matched part and a capped house fill on devnet.
- **Price source.** They describe a `MOCK_ONLY` mode, a mock keeper API and `services/keeper/src/price-adapter.mjs`. None of these exist any more; the price comes from a real PumpSwap pool, signed by the keeper and checked by an independent attestor.
- **Program.** The reviewed draft used `lock_round` / `activate_round` and `settle_round` with two prices from one authority. It was replaced.

| File | What it is |
|---|---|
| [DEVELOPMENT_BRIEF.md](DEVELOPMENT_BRIEF.md) | The 11 September product brief for the first implementation. |
| [2026-09-10-flipthememe-solana-mobile-design.md](2026-09-10-flipthememe-solana-mobile-design.md) | First design of the mobile submission. |
| [2026-09-11-flipthememe-arena-design.md](2026-09-11-flipthememe-arena-design.md) | The shared arena and pixel faces design. |
| [contract-audit.md](contract-audit.md) | Static review of the September program draft. |
| [price-source.md](price-source.md) | The September state of the price-source question. |
