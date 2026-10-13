# FlipTheMeme price attestor

The canonical protocol publishes one immutable certificate per round and measurement window through public `GET /v1/attestation?round=<id>&kind=strike|exit`. The attestor measures mainnet PumpSwap pools independently, filters observations inside the exact window before deduplicating slots, and fixes the samples in SQLite before signing. Any funded devnet payer can relay the certificate with a native Ed25519 verification instruction to `set_strike_attested` or `settle_attested`.

The program binds the certificate to its program ID, round PDA, pool, window, kind and complete samples. Required-oracle rounds refuse the old priced instructions after upgrade. There is no keeper subset, drift tolerance or keeper coverage threshold in canonical pricing. Fewer than five certified observations produce an unpriceable refund; an unavailable certificate eventually permits `refund_expired`.

The maintainer still controls the attestor and the program upgrade authority. A compromised attestor key can certify a false price: public relaying removes the keeper submission monopoly, not oracle trust. See [the protocol, trust boundary and relay CLI](../../docs/price-certificates.md).

## Legacy co-signing reference

The following describes the authenticated transaction co-signing endpoint retained for compatibility with the previous program. Its tolerance and coverage rules do not describe the canonical certificate endpoint.

A second, independent signer for `set_strike` (the strike price, shown as START PRICE in the app)
and `settle`: one Cloudflare Worker with one SQLite-backed Durable Object, on infrastructure apart
from the keeper. It finds the rounds on devnet
and samples each round's PumpSwap pool on mainnet by itself, and co-signs a strike or exit price
only when the keeper's samples agree with its own.

While the on-chain OracleConfig says `required`, the program fixes no price without this signature
(`AttestorRequired`, `InvalidAttestor`). `refund_expired` never needs it, so an attestor outage, or a
refusal, only delays a round into that refund.

## How it finds rounds and samples

- **Rounds.** Every 15 s one devnet `getMultipleAccounts` reads Config (`next_round_id`), the
  OracleConfig and the Round PDAs `next_round_id - 4 .. next_round_id`. A refresh that falls due
  inside a window waits until that window's sampling is over, so a slow devnet never delays a read.
- **Samples.** For each round's strike window while the round is Open, and its exit window until it
  is Final, from 1.5 s before the window to 1.5 s after it, an alarm fires about once a second and
  reads the pool's two vaults with the client's `observePrice`: one `getMultipleAccounts`,
  commitment `confirmed`, price `quote * 10^12 / base` (`priceOf`), with the reply's context slot.
  The vault addresses come from the pool account (`loadPool`), read once per pool. Round N's exit
  window and round N+1's strike window are the same 10 seconds, so one read serves both.
- **Storage.** One SQLite row per pool and read: pool, time, slot, price, and the strike and exit
  round it served. Rows older than an hour are deleted.
- **Between windows** the next alarm is the next window's start or the next refresh, whichever is
  first. A cron trigger pings the object every minute and re-arms the alarm when none is pending
  (first start, eviction, an alarm dropped after failed retries).

## What it checks before it signs

Every refusal is HTTP 422 with `{"error": "<what is wrong>", "reason": "<code>"}`.

| Rule | Reason |
| --- | --- |
| A Solana wire transaction, nothing after the message, no repeated account, at most 1232 bytes | `bad_transaction` |
| Legacy or v0 message | `unsupported_version` |
| No address lookup tables: every account is in the message | `lookup_tables` |
| The attestor key is a required signer, read-only, and not account 0 (the fee payer) | `attestor_not_signer`, `attestor_writable`, `attestor_is_fee_payer` |
| At most 2 ComputeBudget instructions: one SetComputeUnitLimit and one SetComputeUnitPrice, no accounts | `compute_budget` |
| No instruction to any other program than ComputeBudget and FlipTheMeme (exactly `5kUCKYAYxZyaSz18xEajhSDNwdXvVLp2AvBp4LDxWuCz`) | `foreign_instruction` |
| Exactly one FlipTheMeme instruction | `instruction_count` |
| Its discriminator is `set_strike` or `settle` | `unknown_discriminator` |
| Its data is what the program accepts: 8 + 4 + 16 n bytes, n at most 16, slots strictly increasing, no zero price | `bad_samples` |
| Exactly 5 accounts, account 0 the Config PDA, account 3 the OracleConfig PDA | `wrong_accounts` |
| Account 4 is the attestor | `attestor_not_in_instruction` |
| Account 1, read from devnet for this request, is a Round of the program at its PDA | `round_not_found` |
| `set_strike` needs an Open round, `settle` a Live one | `round_state` |
| The attestor's clock is past `strike_end` / `exit_end` | `window_open` |
| `set_strike` only: the attestor's clock is before the round's `exit_start` (the program rejects a later strike, also for a round without a matched bank) | `strike_too_late` |
| No other sample set was signed for this round and window before (one signature per round and window: see below) | `already_signed` |
| Fewer than `ATTEST_MAX_TRIES` (6) earlier attempts reached the samples for this round and window | `too_many_attempts` |
| At least 5 keeper samples, unless the attestor itself holds fewer than 5 reads inside the window (a corroborated outage, which is signed: see below) | `unpriced` |
| The attestor holds at least 3 of its own reads inside the window | `too_few_samples` |
| The keeper sent at least `max(5, floor(0.6 * n))` samples, `n` being the attestor's reads inside the window, and never more than the program's 16 are asked | `samples_withheld` |
| Every keeper slot lies within the slots the attestor read for the window (margins included), widened by 10 slots (`SLOT_MARGIN`) | `slot_out_of_range` |
| A keeper sample at a slot the attestor read too has exactly the attestor's price there | `slot_price_mismatch` |
| The keeper's mean, `floor(sum / n)` as the program computes it, is within `ATTEST_TOLERANCE_BPS` of the attestor's mean of its reads inside the window | `price_mismatch` |

The order is the table's: the checks that need no network run first, then the round's window, then
the samples (counts, slots, prices, means). The accounts are the
program's PriceUpdate, as confirmed by the program agent: 0 config
`A6k9oP8NT249nCM1g6DupAKgVT7dHLyGwbFn5VLbA8RQ`, 1 round PDA, 2 price_authority, 3 oracle
`EMXqXiGXcuzvf9ZD1P6B4HjDVF7earLVNJqah7YLwDZ1`, 4 attestor (`ROUND_ACCOUNT_INDEX` and its siblings
in `src/check.ts`; the PDAs are derived from the client, and a test pins them).

**Prices, two lines.** Two reads of the same pool at the same context slot come from the same
confirmed bank, so they hold the same vault balances and give the same price. Wherever a keeper
sample sits at a slot the attestor read too, the prices must be equal to the unit
(`slot_price_mismatch`; the slot and both prices go to the attestor's log, not to the answer). The
mean check bounds what remains, the slots only the keeper read. Checked live on 2026-10-06: a
PumpSwap pool trading about 14 times a second, 294 reads from publicnode and mainnet-beta in 40 s,
109 slots read more than once (94 of them by both providers), no price differed at any of them.
With both sides reading once a second, about 4 in 10 keeper samples land on a slot the attestor
read; `sharedSlots` in the log and `attests.coverage` in the health show the real share.

**The strike window.** On chain `set_strike` is valid only while `strike_end <= now < exit_start`: with
the exit window open a strike could be chosen with the exit in sight, so the program rejects it and
the round ends through `refund_expired` at `settle_deadline`. The attestor mirrors this with its own
clock: `window_open` before `strike_end`, `strike_too_late` from `exit_start` on, also for a round
without a matched bank (the program checks the window before it ends such a round as NotActivated).
`settle` keeps its rule: a Live round past `exit_end`.

**A fair share of the window.** The keeper chooses which of its readings go into `set_strike` and
`settle`; on chain only the order, the sign and the limit of 16 are checked, so a keeper that kept
the five highest (or lowest) of its ten readings would move the mean by up to the tolerance, in its
favour, without breaking another rule. Both services read the pool once a second, so each holds about
ten reads of a ten-second window and misses a few of its own (a failed request, a late alarm). The
keeper must send at least `max(5, floor(0.6 * n))` samples, `n` being the attestor's reads inside the
window (one per slot), and at most 16 are ever asked (`KEEPER_MIN_SHARE_PERCENT` and
`requiredKeeperSamples` in `src/samples.ts`). With ten own reads that is 6: an honest keeper that
lost up to four passes, one that keeps only five is refused as `samples_withheld`. The share was 70
percent until 2026-10-07 and is 60 now: an honest keeper on a slow mainnet RPC (one hung answer of its
first endpoint costs several seconds of a once-a-second sampler) could hold 6 reads against the
attestor's 10 and was refused for good, so its round waited for `refund_expired`. The share only keeps
a keeper from dropping a lot; what stops it from choosing among subsets is the next paragraph. Only
the counts are compared, never the slots: the two services share about 4 in 10 of their slots, so
asking the keeper's slots to be a subset of the attestor's would refuse honest keepers.

**One signature per round and window.** The first signature for a round's strike window, or for its
exit window, stores a SHA-256 of the sample list it priced (table `attest_windows` in the object's
SQLite, so an eviction forgets nothing). The same list may be signed again at any time, also in a
transaction with another blockhash or fee payer (a retry after a timeout); any different list for
that round and window is refused as `already_signed`. Without this a stolen keeper key and token
could ask for signatures for many subsets of its own readings (every one of them passes the checks
above: C(10,7) = 120 of them) and send the one that suits it after the fact. The strike and the exit
window of a round, and different rounds, are locked apart. Every call that gets as far as the samples
(the round exists, is in the right state, its window is over) and is not a repeat of the signed list
counts as an attempt for its round and window; after `ATTEST_MAX_TRIES` (default 6) of them without a
signature the attestor answers `too_many_attempts`, whatever the list. Calls that stop earlier
(`window_open`, `round_state`, `strike_too_late`, `devnet_unavailable`, a malformed transaction) are
not attempts, and neither are repeats of a signed list. The records are deleted 6 hours after their
last change (a round can be priced for about 12 minutes). Both refusals are final for that round and
window; the round then ends through `refund_expired` as before. One case to know: a keeper that was
restarted after its signature went out and rebuilt a slightly different sample list gets
`already_signed` and the round also ends through `refund_expired`; the keeper keeps its samples on
disk, so this needs a crash within seconds of the window's end.

**A corroborated outage is signed.** When the keeper sends fewer than 5 samples the program ends the
round on the spot as a free `Unpriceable` refund, but while the OracleConfig says `required` it needs
this signature to do so (`set_strike` and `settle` check the attestor before they count the samples).
So when the attestor too holds fewer than 5 reads inside the window (one per slot, margins left out)
it signs without a comparison: both sides saw the same outage, and the round refunds right after its
window instead of waiting for `refund_expired`, which opens 10 minutes after `exit_end`. When the
attestor holds 5 or more reads the keeper is withholding or faulty and the call is refused as
`unpriced`. Five or more keeper samples are always compared, even when the attestor read few: with
3 or 4 reads it still checks them, with fewer it cannot (`too_few_samples`). A signed outage is
marked `"verdict": "unpriceable"` in the log line and in `attests.recent`.

**The other signature without a comparison.** `set_strike` with an empty sample list for a round
without a matched bank (checked on devnet) is co-signed whatever the attestor read. The program ends
such a round as NotActivated and returns every stake without reading the samples or the attestor,
so the keeper may just as well send it without the attestor (the program id in the slot). Verdict
`not_activated`; the strike window above still applies to it.

Other answers: 400 `bad_request` (not `{"tx": "<base64>"}`), 401 `unauthorized` (only with
`ATTEST_TOKEN`), 405, 413 `body_too_large` (over 4 KB), 503 `not_configured`,
`devnet_unavailable` or `unavailable` (try again), 500 `internal`.

## Endpoints

```
POST /v1/attest     {"tx": "<base64 wire transaction>"}, body at most 4 KB
                    200 {"signature": "<base58>", "attestor": "<base58 public key>"}
GET  /v1/attestor   {"attestor": "<base58 public key>", "toleranceBps": 150, "maxTries": 6,
                     "sampler": {"lastSampleAt", "lastSampleSlot", "lastRefreshAt", "nextAlarmAt",
                                 "nextRoundId", "windowsObserved", "samplesStored",
                                 "rounds": [{"id", "status", "pool", "strike": {"start", "end", "samples", "slots"}, "exit": {...}}],
                                 "errors": {"devnet" | "mainnet": {"at", "error"}}, "devnet": [...], "mainnet": [...]},
                     "attests": {"since", "attests", "signed", "compared", "keeperSamples", "sharedSlots", "maxDiffBps", "coverage",
                                 "recent": [{"at", "round", "instruction", "result", "verdict", "keeperSamples", "sharedSlots", "diffBps"}]},
                     "oracle": {"attestor", "required", "matchesKey"} or null until OracleConfig exists}
```

The signature is Ed25519 over the transaction's message bytes (WebCrypto; the tests check it against
`@noble/curves`). `windowsObserved` counts the strike and exit windows with stored reads in the last
hour. `attests` counts the calls since the object started (a deploy or an eviction restarts it),
keeps the last 20, and `coverage` is `sharedSlots / keeperSamples` over the calls that reached the
slot-by-slot comparison (`compared`). `diffBps` is the gap between the keeper's mean and the
attestor's in basis points (null when no comparison got that far) and `maxDiffBps` the largest one
of the signed calls; `verdict` is `agree`, `not_activated` or `unpriceable` for a signature and null
for a refusal. Every call also leaves one `"event": "attest"` log line with its `result`,
`keeperSamples`, `sharedSlots` (null when no comparison ran) and, when it got that far, `diffBps`.
The health answers 503 when the key, the tolerance or `ATTEST_MAX_TRIES` is not usable.

**The health is cached at the edge for 20 seconds.** `GET /v1/attestor` is answered from the Workers
cache (`caches.default`, key = the URL without its query, so `?x=1` does not get around it) with
`Cache-Control: public, max-age=20`, and the Durable Object is asked only when the cache has nothing:
at most one Durable Object request per 20 s per data centre however often it is polled (audit of
2026-10-07, M1: 1 call a second would have been 86,400 Durable Object requests a day, the whole Free
quota). Only a 200 is stored; an error is never cached. The header `x-cache: hit | miss` says which one
answered. So the numbers in it (`attests`, `sampler`) are up to 20 s old. The cache works on the
custom domain route `sol.flipthememe.com/v1/attestor`; on a `workers.dev` host the Cache API does
nothing, so poll the custom domain. `POST /v1/attest` is never cached.

## Secrets and vars

| Name | Kind | |
| --- | --- | --- |
| `ATTESTOR_SECRET` | secret, required | base58 of the attestor's 64-byte Solana secret key (a keypair JSON's 64 numbers as bytes), or of its 32-byte seed. Never logged; errors about it never quote it. |
| `ATTEST_TOLERANCE_BPS` | var, default 150 | largest gap between the two means, in basis points of the attestor's mean (0 to 10000). Not calibrated yet: after a day of real rounds read `attests.maxDiffBps` and the `diffBps` of `attests.recent` in `GET /v1/attestor` (or of the `attest` log lines) and tighten it to just above what honest keepers show; the audit suggests 30 to 50. The tighter it is, the less a keeper can move the mean at the slots the attestor did not read. To change it: edit `vars` in `wrangler.jsonc` and deploy. |
| `ATTEST_MAX_TRIES` | var, default 6 | attempts per round and window that reach the samples before the attestor answers `too_many_attempts` (1 to 100). Repeats of an already signed sample list are not attempts. |
| `MAINNET_RPC` | secret, optional | keyed mainnet RPC URL, tried before publicnode |
| `DEVNET_RPC` | secret, optional | keyed devnet RPC URL, tried before OnFinality; recommended (see below) |
| `ATTEST_TOKEN` | secret, **required in production** | `POST /v1/attest` needs `Authorization: Bearer <token>`, and a call without it gets 401. The keeper's client (`services/keeper/src/attest.ts`) already sends the header when the keeper runs with the same `ATTEST_TOKEN`. With no token configured the Worker lets every caller in (`authorized()` in `src/http.ts`), so anyone could burn the Free plan's request budget and, while the oracle is required, push every priced round into `refund_expired`. Set it with `wrangler secret put ATTEST_TOKEN` and in the keeper's environment. |

Public RPCs as seen from a Worker (checked 2026-10-06 with the `CF-Worker` header Cloudflare adds to
every subrequest, and from local `wrangler dev`): `api.devnet.solana.com` and
`api.mainnet-beta.solana.com` answer 403 "Your IP or provider is blocked from this endpoint";
`solana-devnet.api.onfinality.io/public` and `solana-rpc.publicnode.com` answer. OnFinality's public
endpoint once answered 429 while two local instances polled it at the same time, and Workers share
their outgoing addresses, so a keyed `DEVNET_RPC` is the safer setting for a deployed attestor.

## Deployment on 12 October 2026

Two deployments run the same code and the same signing key:

| | Account | Address | Used by |
|---|---|---|---|
| main | sofiaseremeteva | `sol.flipthememe.com/v1/attest*` and `ftm-attestor.sofiaseremeteva.workers.dev` | public certificate URL in the README |
| backup | second free account | `https://ftm-attestor.flipthememe-attestor.workers.dev` (`wrangler.backup.jsonc`, no custom route) | the keeper (`ATTEST_URL` on the VPS) |

Why: at about 08:50 UTC the main account used up its daily Durable Objects rows-read quota ("Exceeded allowed rows read in Durable Objects free tier"), the attestor answered 503 and the keeper, which refuses new rounds while readiness is false, stopped creating rounds. The keeper polls `/v1/attestor/ready` every 5 seconds without a cache, and that ran the whole `health()`, a full scan of the samples table. Changes since: `ready()` answers the readiness verdict alone and reads only the windows open right now; the whole-table counts in `health()` are recomputed at most every 5 minutes; a round that nobody entered is not sampled, but only with proof (its account was read at least 10 seconds after the entry closed and holds no position and no stake), otherwise it is sampled as before.

Two attestors must not both serve one window: they would each sign their own sample set. Since 13 October the main deployment is a proxy (`ATTEST_PROXY` in `wrangler.jsonc`, `src/proxy.ts`): its public routes (`sol.flipthememe.com/v1/attest*`) forward to the backup, which does all the sampling and signing, and its own Durable Object stops sampling and uses no quota. To serve directly from the main account again, remove `ATTEST_PROXY`, deploy, and point the keeper's `ATTEST_URL` at it (VPS `deploy/.env`, then `docker compose up -d --force-recreate`). The backup config `wrangler.backup.jsonc` must never set `ATTEST_PROXY`. A deploy from this folder after a deploy to the other account needs `CLOUDFLARE_ACCOUNT_ID` set, because wrangler caches the account per project (`node_modules/.cache/wrangler/wrangler-account.json`).

## Workers Free plan budget

The Free plan limits are per Cloudflare account, and the attestor, `ftm-link` and `ftm-chatter` share
one: **100,000 Workers requests a day for all of them together** (the day ends at 00:00 UTC), and 100,000
Durable Object requests a day (the attestor's object only). Past the limit Cloudflare answers every
request of the account with an error, so the attestor stops co-signing and every priced round ends
through `refund_expired` until the day is over. Count both limits.

**Durable Object requests** (alarms, cron pings, attests, health cache misses), one round a minute
(the keeper's cadence), as measured by the `budget` test (the sampler: alarms and sample rows; the attest and
cache rows are added here by hand) and seen live:

| Per minute | | Per day | Free plan |
| --- | --- | --- | --- |
| 13 alarms reading the pool (1.5 s + 10 s + 1.5 s), 4 refresh alarms, 1 cron ping, about 2 attest calls | 20 Durable Object requests | about 28,800 | 100,000 requests |
| `GET /v1/attestor` cache misses: at most 1 per 20 s per data centre | up to 3 | up to 4,320 | |
| 17 `setAlarm`, 13 sample rows, 13 deleted rows, 6 `attest_windows` rows (2 writes per signed attest, 2 deletes) | about 49 rows written | about 70,000 | 100,000 rows written |
| the prune scans the table every 10 minutes (about 800 rows), an attest reads about 20 | | under 300,000 | 5,000,000 rows read |
| 13 mainnet reads, 4 devnet reads, 1 devnet read per attest | at most a few per invocation | | 50 subrequests per invocation |

About 33,000 of 100,000 Durable Object requests with the health cache; without it, one poll a second
alone would be 86,400.

**Workers requests** (every HTTP request and every cron run starts one; a hit in `caches.default` still
runs the Worker, so the cache saves Durable Object requests, CPU and upstream calls, not this count):

| Worker | Counts | Per day |
| --- | --- | --- |
| `ftm-attestor` | cron ping 1 a minute, about 2 attests a minute, health polls | 1,440 + 2,880 + polls, about 4,500 to 5,000 |
| `ftm-chatter` | one request per open app every 45 s (`useChatter.ts`) | 1,920 per app open all day, 27 per 20-minute session |
| `ftm-link` | a page view of a shared link (`/r/<id>`, `/get`), the Android link check, the faucet | a few hundred to a few thousand |

Worked example: attestor 5,000 + link 2,000 leaves about 93,000 for chatter: 48 apps open all day, or
about 3,400 twenty-minute sessions. During the judging window (13 October to 10 November 2026) ten
phones open at once and a demo day of 50 sessions is nowhere near the limit, but one forgotten app or a
script on the public chatter route is. To see where you are: Cloudflare dashboard, Workers & Pages,
Overview (requests today against 100,000, per Worker), and Workers & Pages, Durable Objects (requests
today). Check it after the first demo day and again before a push of traffic (a post on X).

**Recommendation: Workers Paid for the judging period.** It is $5 a month for the account (check the
current numbers on the Cloudflare pricing page: 10 million Workers requests and 1 million Durable
Object requests a month are included, each further million costs cents) and lifts the daily caps that
can kill the arena's price feed. Subscribe before 13 October, cancel after the judging window. If you
stay on Free, move the attestor to an account of its own so that chatter traffic cannot starve it:
deploy it there with the same `ATTESTOR_SECRET` (the on-chain OracleConfig keeps pointing at the same
key) and point the keeper's `ATTEST_URL` at the new Worker.

Anyone may call `POST /v1/attest`: nobody gets a signature for what the checks refuse (and a signature
is useless without the keeper's), but every call costs a Worker request, a Durable Object request and a
devnet read. `ATTEST_TOKEN` closes that (the keeper sends the header), which is why it must be set in
production.

**Time budgets.** One attest call reads devnet once (`findRound`) and gives all its endpoints, a keyed
`DEVNET_RPC`, OnFinality and the public one together, 6 seconds (`ATTEST_DEVNET_BUDGET_MS`; each endpoint
still has its own 3 s timeout): a slow first endpoint leaves a fallback only what remains, and the call
ends with 503 `devnet_unavailable` at 6 s. The keeper gives an attest call 8 s (`ATTEST_TIMEOUT_MS` in
`services/keeper/src/attest.ts`), so the 503 reaches it as an answer instead of a timeout.

## How the keeper uses it

`services/keeper/src/attest.ts` does all of this when the keeper runs with `ATTEST_URL` set to this
Worker's URL; the attestor address it uses is the one in the on-chain OracleConfig.

1. Once: the admin points the program at this key, `set_oracle` (`setOracle` in
   `packages/client`) with `attestor` = the `attestor` of `GET /v1/attestor`. With `required` =
   false the attestor runs alongside: the keeper asks it, logs the answer, and sends the price
   without it when it refuses. With `required` = true no price goes out without it.
2. For every priced `set_strike` and `settle`, after its window has ended (the keeper already waits
   1 s): build the instruction with the attestor as a bare address, sign as fee payer and price
   authority, ask for the co-signature, add it, send. A `set_strike` for a round without a matched
   bank needs no attestor, and the keeper sends it without one. The keeper sends a `set_strike`
   only from `strike_end` until the round's `exit_start`; later the program rejects it and the
   round waits for `refund_expired`.

```ts
const ix = await setStrike({ priceAuthority: keeper, roundId, samples, attestor: ATTESTOR }); // or settle(...)
// compile and sign with the keeper's signers as today; the attestor's signature slot stays empty
const res = await fetch(`${ATTESTOR_URL}/v1/attest`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ tx: getBase64EncodedWireTransaction(transaction) }),
});
const answer = await res.json();
if (!res.ok) throw new Error(`attestor: ${answer.reason}: ${answer.error}`);
const signed = { ...transaction, signatures: { ...transaction.signatures, [ATTESTOR]: getBase58Encoder().encode(answer.signature) } };
```

The attestor signs only the message bytes, so the keeper may sign before or after. A 422 names the
rule that failed. `window_open` and `round_state` can clear (the window ends, the strike lands).
`strike_too_late` is final for the round (the exit window has opened: the keeper stops, and the
round ends through `refund_expired`). The attestor's reads of a past window never change, so
`unpriced`, `too_few_samples`, `samples_withheld`, `slot_out_of_range`, `slot_price_mismatch` and
`price_mismatch` stay refused and that round ends through `refund_expired` too. So do `already_signed`
(a different sample list was signed for that round and window; only the signed one is answered again)
and `too_many_attempts` (6 attempts used up): the keeper should treat both as final and stop asking. A keeper that
sends fewer than 5 samples after an outage it shares with the attestor gets a signature, and the
program refunds the round as Unpriceable. A 503 or a timeout is worth a retry.

## Run, test, deploy

From the repository root (cmd.exe or Git Bash):

```
corepack pnpm --filter @flipthememe/attestor test
corepack pnpm --filter @flipthememe/attestor run typecheck
corepack pnpm --filter @flipthememe/attestor run dry-run
```

The tests use no network: node:sqlite stands in for the object's storage, the RPCs are scripted, and
transactions come from the client's builders.

Local run with a test key: put `ATTESTOR_SECRET=<base58>` into `services\attestor\.dev.vars`
(ignored by git), start `corepack pnpm --filter @flipthememe/attestor run dev`, then from
`services\attestor` run `node scripts\smoke.ts http://127.0.0.1:8787`. The smoke test waits for the
next round's strike window, samples the pool itself like the keeper, asks for a co-signature of a
`set_strike` (a throwaway key stands in for the keeper; nothing is ever sent to a chain), checks that
prices 5% off are refused and that the signature of the real set verifies. Run it against `wrangler dev`
only: the attestor signs one sample set per round and window, so against the deployed attestor the
signature would lock the round the script picked and the keeper's own samples for it would be refused
as `already_signed` (the script refuses a non-local URL without `--allow-live`).

Deploy (not done yet), from `services\attestor`:

```
npx wrangler deploy
node scripts\secret.ts C:\keys\attestor.json | npx wrangler secret put ATTESTOR_SECRET
npx wrangler secret put DEVNET_RPC
```

`scripts\secret.ts` turns a solana-keygen keypair file into the base58 value on stdout only (the
pipe keeps it off the screen) and prints the public key to stderr. Then `GET /v1/attestor` on the
`workers.dev` URL shows the key and, a minute later, the rounds. The first real round the keeper
prices is the end-to-end check of the deployed attestor (`attests` in the health, the `attest` log
lines); do not point `scripts\smoke.ts` at it, see above.

## Files

```
src/index.ts      Worker entry: routes to the Durable Object, cron ping, the Attestor class
src/http.ts       endpoints, body limit, optional bearer token
src/attestor.ts   the Durable Object's logic: rounds, sampling loop, storage, attest, health
src/check.ts      transaction decoding and the checks that need no network; refusal reasons
src/samples.ts    windows and the price comparison
src/key.ts        ATTESTOR_SECRET to an Ed25519 key
src/rpc.ts        RPC failover
scripts/smoke.ts  end-to-end check of a running attestor with live data
scripts/secret.ts keypair file to ATTESTOR_SECRET
```
