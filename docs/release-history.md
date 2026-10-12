# Release history, October 2026

Notes from the audit passes of 8 to 10 October. They describe the state at the time they were written and can be out of date: the [README](../README.md) and the install page at https://sol.flipthememe.com/get describe the current build.

## Audit revision, 10 October 2026

The implementation of the requested audit changes is tracked in [the fix checklist, in Russian](audits/2026-10-10-fixes-ru.md). Source changes do not update an already installed APK or the deployed keeper. The APK build now produces a manifest binding the binary to its commit, dependency lock and program source files; deployed program bytes and physical-device acceptance are separate checks.

Final positions are archived in signed, paginated per-wallet snapshots before this keeper closes player accounts. A claim update invalidates the publication acknowledgement; restart requires republication. Mobile restores the newest 500 archived results, retaining local history during network errors. Records already closed before indexing cannot be recovered by this mechanism. The public leaderboard reports chain indexing time independently of publication time.

Local diagnostics can be exported voluntarily in Profile. They contain events, request counts and bounded latency summaries from the current app process, without wallet addresses, signatures or keys. They are not global user analytics or evidence of D1/D7 retention. The default session permission is conservative; turnover is not a maximum-loss limit and other sessions must be revoked separately.

Use [Android acceptance](android-acceptance.md), [Solana validation](research/solana-validation.md) and the revised [submission text](submission/submission-texts.md) for release evidence. No practice predictions have been added.

## 8 October audit follow-up

Earlier candidate **0.1.0 (23)** introduced explicit round phases, live market-check status and measured-minute progress, pixel headings/buttons/tabs, leaderboard player avatars, daily record, persistent rival score, away results, result sharing and the memoized chart. Release signature verification passed in [Android build 23](https://github.com/Sofiia7/flipthememe-solana/actions/runs/37771581966).

Current LAN candidate **0.1.0 (27)** contains the 9 October screen, round-focus and notification-avatar fixes below, plus the Wallet session button layout fix. Its signed release and signing-certificate verification passed in [Android build 27](https://github.com/Sofiia7/flipthememe-solana/actions/runs/37918775518), built from `493093e`. APK SHA-256: `096d42a468c180a723134419f6e02730b33ab8fd535f1107801f8d9aa10f9fa9`. The operator's LAN page serves this build for Seeker acceptance; the public APK release has not been replaced. Keeper-only changes are deployed independently of the APK.

The arena keeps detailed phase explanations behind **RULES** in the header, in an overlay near the top of the screen. The 9 October follow-up removes arena scrolling and the pinned invitation: the chart takes the remaining height so the token, timer, players and friend invitation fit together. The most recently accepted bet owns the chart, timer and panel, including before entry closes; older calls stay in RULES and History. The token symbol is left-aligned and its duplicated name removed. Android reminders carry a locally persisted pixel avatar and use a pixel face notification icon. These changes are in candidate 26. Candidate 27 additionally constrains Wallet session REVOKE/CLOSE buttons to the card width and lets usage text wrap alongside them; this layout still needs a Seeker check.

Live monitoring on 9 October showed continuing directional bias and incomplete reserve measurements. Continuous selection now penalizes either direction reaching 70% after at least five measured outcomes. Measured directional balance takes priority over buy/sell and drift proxies, which otherwise could favour a quietly rising pool over a demonstrably balanced reserve. Safe warming backups are retained for up to 15 minutes so they can reach ten samples; temporary RPC failures do not discard their observations or authorize a handover from an unreadable check. Mainnet price sampling batches pool vault pairs into one confirmed RPC response per tick, reducing rate-limit pressure; each pair still passes its normal mint, owner and amount checks. No outcome is changed to enforce a 50/50 split.

The keeper runs continuous rounds with a measured reserve; drift, flow and shadow outcomes rank replacement markets without stopping valid rounds for warmup. Canonical certificates passed [the reproducible program workflow](https://github.com/Sofiia7/flipthememe-solana/actions/runs/37746139155): two identical clean SBF builds, 25 unit tests, 74 LiteSVM flows and the client-vector fixture. One optional migration test is excluded unless a previous live binary is supplied. The verified binary is deployed on devnet at slot **508782630**, and the VPS keeper reports `detached-canonical`; betting is resumed. The downloaded live binary exactly matches SHA-256 `9101e2743179d58e6ca430fe1e729573c94965935a01abd48be686f383295968`. The canonical on-chain IDL was published and fetched back with an identical hash. See [deployment evidence](devnet-2026-10-08.md). See [the price protocol](price-certificates.md).

Local notification reminders are implemented; server push containing a confirmed win/loss is not. Seeker battery/frame-time measurements and acceptance of this new APK remain device checks.

To serve a candidate on the same Wi-Fi network, put its signed APK in `dist/serve`, run `node apps/mobile/scripts/lan-page.mjs`, then `python -m http.server 8000 --bind 0.0.0.0 --directory dist/serve`. Use the LAN address printed by the page generator; DHCP can change it.

## 11 and 12 October 2026: builds 29 to 41

| Build | Source | What changed | Published |
|---|---|---|---|
| 29 and 31 | 31: `db3fbec` | Seeker layout fixes, install page fallback metadata | 31 yes |
| 34 | `375de02` | Arena avatars, saved-stake feedback, direct account reads | no |
| 35 | `08508e8` | Friend challenge in RULES, missed results in the bet row, clearer notices, dead code removed | no |
| 37 | `7d9e930` | The first call is bound to the coin, not the round; a card when the coin changed | no |
| 40 | `09f3efb` | A connected wallet's first tap is remembered; a challenge link offers the other side | no |
| 41 | `5c3ec6f` | The offer cards fit 360 dp screens and return with every new link | yes, the build in the CLOCK IN submission |

Operations on 12 October: the main Cloudflare account used up its daily Durable Objects quota, a backup attestor on a second free account took over, the faucet moved to the working Alchemy key and the house vault was topped up to about 4.6 SOL. See the README Limits and `services/attestor/README.md`.
