# Real PumpSwap baseline - October 10, 2026

Source: the shadow journal of the live keeper on the VPS. These are observations of market prices, not executed trades of the research strategies. The snapshot contains 15,938 rows, of which 3,780 are selected arena windows across 98 pools; candidate-only observations are excluded. There are no JSON errors and no repeats of a selected `(pool, opensAt)`. Selected period: October 7, 14:51:41.700 UTC - October 10, 10:10:41.700 UTC, about 67 hours.

SHA-256 of the source snapshot: `4ddaa191857c90766c16ab368bb02556cf0c1fefc54c2d95a944ad61e196b900`. The local source data and JSON reports are in the ignored folder `docs/audits/real-data/`. Reproduction: `node services/keeper/scripts/research.ts replay docs/audits/real-data/shadow.jsonl`.

The first 70% of observations are calibration (2,646), the last 30% are held-out (1,134). Held-out directions: 590 UP, 532 DOWN, 12 ties; unpriced - 0 in this snapshot.

| Policy | Wins | Losses | Refunds | Conditional net in stake units |
|---|---:|---:|---:|---:|
| Deterministic random | 528 | 594 | 12 | −87.12 |
| Always UP | 590 | 532 | 12 | +34.40 |
| Always DOWN | 532 | 590 | 12 | −79.28 |

Net assumes full opposite-side coverage, a winner fee of 200 bps and zero network costs. It is not earned profit and not a forecast. Momentum, contrarian and late momentum skipped all rows: pre-cutoff features were not recorded. Substituting future prices would have distorted the study.

For UP, the descriptive Wilson 95% interval: [0.4966, 0.5549]. The windows are dependent. In addition, a bootstrap was run over 18 pool/UTC-day blocks, 5,000 resamples, seed 20261010: UP share range [0.4785, 0.5624]. It includes both 50% and the fee break-even of 51.0204%; a durable UP advantage is not established. The short period and the dependence between blocks do not allow treating the bootstrap as independent validation.

Next required data collection: pre-cutoff features, pool selection at decision time, failed/skipped windows, matching and actual costs, confirmation latency. To claim resistance to manipulation, separate attacks on both windows are needed, covering arbitrage, MEV, unwind and the entire overlapping pool bank. This baseline did not test them. Operator devnet wallets are excluded from user acquisition and retention counts.
