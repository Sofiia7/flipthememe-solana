> Status: superseded on 2026-10-05 by [README.md](../../README.md) ("Price source and trust") and [docs/superpowers/specs/2026-10-05-flipthememe-solana-hackathon-build-design.md](../superpowers/specs/2026-10-05-flipthememe-solana-hackathon-build-design.md) (section 4). Kept for history; the `MOCK_ONLY` mode, the mock keeper API and `services/keeper/src/price-adapter.mjs` described here no longer exist.

# Price source: engineering status

**Status as of 15 September 2026:** the source for a real-money round has not been approved yet. The app and the keeper currently use `MOCK_ONLY`; this is not a live market and cannot open a round with real funds. The program also initializes `Config.mock_only = true` and rejects `deposit` and `create_round`, so this prohibition is enforced by more than the interface.

The prohibition is intentional: a pump.fun bonding curve, a migrated Raydium pool and a Meteora DLMM are different token states. One cannot be substituted for another just because they all have a price.

## Adapter contract

`services/keeper/src/price-adapter.mjs` fixes the single integration point. A real adapter must return, for each window:

- the address of the admitted pool itself;
- the price as a whole fixed-point integer, without a JavaScript `number`;
- the window boundaries, the number of samples, the observation time and a link/identifier of the source data;
- sufficient coverage of the window, not just the latest quote.

The client does not send a price to the program. The keeper publishes P0/P1 only after `assertObservation`; the program accepts a price only from a dedicated price authority and only for the specified Round/pool/time.

## Before enabling a real source

1. Choose one pool type on real young tokens.
2. Fix P0/P1: the intervals, the averaging method, the fixed precision, the permitted staleness and the exact equality zone.
3. Run through no trades, migration, a halted pool, an incomplete window and a sharp price move.
4. Measure depth and determine the overall cap, `MIN_BET` and `MAX_BET`.
5. Add reproducible fixtures with tx/signatures and an adapter test. Only after this prepare a separate audited migration that will replace `MOCK_ONLY`; the current program intentionally contains no admin switch to bypass this check.

## Temporary mock

`pnpm --filter @flipthememe/keeper start` brings up `GET /v1/arena/current` and `/v1/arena/current/observations`. It is needed for interface development and state recovery; the response is marked `MOCK_ONLY` and is not evidence of a market price.
