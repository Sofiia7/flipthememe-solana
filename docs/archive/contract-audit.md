> Status: superseded on 2026-10-05 by [README.md](../../README.md) and [docs/superpowers/specs/2026-10-05-flipthememe-solana-hackathon-build-design.md](../superpowers/specs/2026-10-05-flipthememe-solana-hackathon-build-design.md). Kept for history; it reviews the September program draft (`MOCK_ONLY`, `lock_round` / `activate_round`, `settle_round` with two prices, the example program id), which was replaced. The later review notes (5 and 6 October 2026) were local working notes and are not part of the repository.

# Static audit - 15 September 2026

**Scope of the review.** This is an internal source-code audit, not an independent opinion and not permission to accept money. Reviewed: `programs/flip-the-meme/src/lib.rs`, the `packages/arena-core` model, the keeper and the mobile screen. Rust/Solana/Anchor are not installed on the machine, so the Anchor build, the IDL, account sizes and runtime/integration tests are not yet confirmed.

## Summary

The repository correctly labels the current mode as a mock/devnet draft. The money-handling program must not be deployed or used even on devnet until the P0 items are closed. The most dangerous problem found is that the administrator can modify an already finalized round again through unrestricted `lock_round`/`activate_round` transitions; and the result is still determined by two unverifiable values from the price authority.

## Status of fixes

- Fixed in the source: exact transitions `Scheduled → Open → Locked → Active → terminal`; a final round can no longer be re-locked, re-activated or re-settled.
- Fixed in the source: strict session expiry, safe re-issuing of a revoked/expired session and accounting of the shared available/locked obligations.
- Fixed in the source: `withdraw_round_fees` is available to the treasury only after every position has been claimed, and it checks the reserve plus all user obligations.
- Closed defensively: `MOCK_ONLY` now rejects deposit and round creation on-chain; mobile does not create a false local position.
- Confirmed: `cargo check` passes with the pinned `anchor-lang 1.1.2`; Rust, MSVC Build Tools and the Windows SDK have been prepared locally.
- Remains an external dependency: the program keypair/ID, a verifiable live-price adapter, the Solana/Anchor runtime and integration tests. These items cannot be declared closed until the corresponding infrastructure and the market rule exist.

## Findings

| Priority | Where | Observation and risk | Condition required to close |
|---|---|---|---|
| P0 | `lib.rs`: `lock_round`, `activate_round` | The instructions check only the time, not the previous state. After `SETTLED_*` or `REFUNDABLE`, the admin can call `lock_round`, then `activate_round`, and the price authority can call a new settlement. Those who have already claimed do not participate in the new result; the others receive a changed result. | Allow only `Scheduled → Open → Locked → Active → terminal`; restrict each instruction to the exact previous `RoundStatus`. Final statuses must be irreversible; cover retry and calls after each terminal state. |
| P0 | `lib.rs`: `settle_round`, `Round`; keeper | The contract accepts two bare prices from a single trusted key. Round has no source/observation identifier, no P0/P1 boundaries, no aggregation method and no proof of a link to the `pool`. The price authority can settle a different market or an arbitrary outcome. | Until a verifiable adapter is implemented, keep the program in `MOCK_ONLY` and do not accept deposits. Record in Round the source/pool/rule/window and a hash or verifiable references to the observations; add fixtures and negative tests. |
| P0 | `declare_id!`, `Anchor.toml` | Both places use the standard Anchor example `Fg6Pa…`; this is not a deployment key and clients cannot safely determine which program they are calling. | Generate a separate program keypair for devnet, replace `declare_id!`, `Anchor.toml`, the generated IDL and the mobile environment in sync; fix the upgrade authority. |
| P0 | build/tests | The current machine has no `cargo`, `anchor` or `solana`; the program draft has not been compiled. Consequently the PDA constraints, `InitSpace`, lamport mutations and instructions have not been executed. | Pin compatible Anchor/Solana/Rust versions, run `anchor build` and integration tests with two wallets: deposit → session bet → settle → claim; refund; replay; cutoff/expiry/deadline boundaries; overflow and wrong accounts. |
| P1 | `lib.rs`: fee/dust | The fee and the lamport rounding remainder stay in the shared Config, but there is no ledger, no counter of processed winners and no safe `withdraw_fee`. They cannot be transparently separated from unclaimed payouts. | Store fee/dust/claimed obligations separately; transfer only the proven remainder after all permitted claims, or do not introduce fee withdrawal in the MVP. Do not treat unclaimed claims as rounding. |
| P1 | `lib.rs`: `start_session` | The Session PDA is created with `init` and is never closed/re-initialized. After revoke or expiry, the same vault + session signer pair can no longer obtain a new permission. | Either document signer rotation for every new session, or add safe re-issuing/closing with the authority's consent and verify that the old key cannot be revived. |
| P2 | `lib.rs`: session expiry | A bet is allowed at `now == expiry` (`now <= expiry`). If expiry is the moment of expiration, this extends the permission by one slot/second relative to the usual semantics. | Fix the semantics and, if expiry is exclusive, apply `now < expiry`; add a boundary test. |
| P2 | mobile `App.tsx` | Pressing "SELECT" after connecting changes only the local `entered`; there is no deposit, session, signed `place_bet`, confirmation, recovery or claim/refund. The screen also shows mock pools/chart as OPEN. | Until the wallet flow exists, keep the action explicitly as demo/mock and do not present it as a position. For devnet, connect an authoritative snapshot, the transaction lifecycle and direct claim/refund. |
| P2 | mobile/keeper config | `apiBaseUrl` uses `10.0.2.2`, which works only in the Android emulator, and the App itself does not consume the API. On a physical device the keeper is unreachable at this address. | Use a reachable HTTPS endpoint or a configurable LAN URL for the development build; test on a physical Android device. |

## Positive properties verified

- `withdraw` holds back the rent-exempt reserve of Config and reduces only `vault.available`; a locked bet cannot be withdrawn.
- The Position PDA includes `(round, authority)` and `init` prevents a second position on the same round.
- Session checks the signer, revoke, the amount of a single bet and the accumulated cap; the session key has no withdrawal instruction.
- `claim` binds Config to `round.config`; the recipient of the payout is the original Vault, not the calling keeper.
- The calculation uses lamports and `u128` for the prize × stake product; a tie, an empty side and a timeout result in a refund without a fee.
- The JS model uses `bigint`; `pnpm test` passed 7/7, `pnpm --filter @flipthememe/mobile typecheck` passed.

## Mandatory re-check

After the P0 items, compiled Anchor tests and an independent review are needed. Until then mainnet, real funds, claims of a finished APK and claims of live market-price settlement are prohibited. Separately, walk through the following manually on two devices: a lost RPC response after execution, double tap, going to the background, restart, keeper stop and permissionless refund after the deadline.
