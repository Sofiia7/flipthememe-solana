# FlipTheMeme price attestor

A second, independent signer for `set_strike` and `settle`: one Cloudflare Worker with one
SQLite-backed Durable Object, on infrastructure apart from the keeper. It finds the rounds on devnet
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
| At least 5 keeper samples (fewer fix no price: the program would refund the round) | `unpriced` |
| The attestor holds at least 3 of its own reads inside the window | `too_few_samples` |
| Every keeper slot lies within the slots the attestor read for the window (margins included), widened by 10 slots (`SLOT_MARGIN`) | `slot_out_of_range` |
| A keeper sample at a slot the attestor read too has exactly the attestor's price there | `slot_price_mismatch` |
| The keeper's mean, `floor(sum / n)` as the program computes it, is within `ATTEST_TOLERANCE_BPS` of the attestor's mean of its reads inside the window | `price_mismatch` |

The order is the table's: the checks that need no network run first. The accounts are the
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

One exception: `set_strike` with an empty sample list for a round without a matched bank (checked on
devnet) is co-signed without a comparison. The program ends such a round as NotActivated and returns
every stake without reading the samples or the attestor, so the keeper may just as well send it
without the attestor (the program id in the slot).

Other answers: 400 `bad_request` (not `{"tx": "<base64>"}`), 401 `unauthorized` (only with
`ATTEST_TOKEN`), 405, 413 `body_too_large` (over 4 KB), 503 `not_configured`,
`devnet_unavailable` or `unavailable` (try again), 500 `internal`.

## Endpoints

```
POST /v1/attest     {"tx": "<base64 wire transaction>"}, body at most 4 KB
                    200 {"signature": "<base58>", "attestor": "<base58 public key>"}
GET  /v1/attestor   {"attestor": "<base58 public key>", "toleranceBps": 150,
                     "sampler": {"lastSampleAt", "lastSampleSlot", "lastRefreshAt", "nextAlarmAt",
                                 "nextRoundId", "windowsObserved", "samplesStored",
                                 "rounds": [{"id", "status", "pool", "strike": {"start", "end", "samples", "slots"}, "exit": {...}}],
                                 "errors": {"devnet" | "mainnet": {"at", "error"}}, "devnet": [...], "mainnet": [...]},
                     "attests": {"since", "attests", "signed", "compared", "keeperSamples", "sharedSlots", "coverage",
                                 "recent": [{"at", "round", "instruction", "result", "keeperSamples", "sharedSlots"}]},
                     "oracle": {"attestor", "required", "matchesKey"} or null until OracleConfig exists}
```

The signature is Ed25519 over the transaction's message bytes (WebCrypto; the tests check it against
`@noble/curves`). `windowsObserved` counts the strike and exit windows with stored reads in the last
hour. `attests` counts the calls since the object started (a deploy or an eviction restarts it),
keeps the last 20, and `coverage` is `sharedSlots / keeperSamples` over the calls that reached the
slot-by-slot comparison (`compared`). Every call also leaves one `"event": "attest"` log line with
its `result`, `keeperSamples` and `sharedSlots` (null when no comparison ran). The health answers
503 when the key or the tolerance is not usable.

## Secrets and vars

| Name | Kind | |
| --- | --- | --- |
| `ATTESTOR_SECRET` | secret, required | base58 of the attestor's 64-byte Solana secret key (a keypair JSON's 64 numbers as bytes), or of its 32-byte seed. Never logged; errors about it never quote it. |
| `ATTEST_TOLERANCE_BPS` | var, default 150 | largest gap between the two means, in basis points of the attestor's mean (0 to 10000) |
| `MAINNET_RPC` | secret, optional | keyed mainnet RPC URL, tried before publicnode |
| `DEVNET_RPC` | secret, optional | keyed devnet RPC URL, tried before OnFinality; recommended (see below) |
| `ATTEST_TOKEN` | secret, optional | when set, `POST /v1/attest` needs `Authorization: Bearer <token>`. Leave it unset until the keeper sends that header: its client (`services/keeper/src/attest.ts`) does not yet, so every call would get 401 and, while the oracle is required, every priced round would end in `refund_expired`. |

Public RPCs as seen from a Worker (checked 2026-10-06 with the `CF-Worker` header Cloudflare adds to
every subrequest, and from local `wrangler dev`): `api.devnet.solana.com` and
`api.mainnet-beta.solana.com` answer 403 "Your IP or provider is blocked from this endpoint";
`solana-devnet.api.onfinality.io/public` and `solana-rpc.publicnode.com` answer. OnFinality's public
endpoint once answered 429 while two local instances polled it at the same time, and Workers share
their outgoing addresses, so a keyed `DEVNET_RPC` is the safer setting for a deployed attestor.

## Workers Free plan budget

One round a minute (the keeper's cadence), as measured by the `budget` test and seen live:

| Per minute | | Per day | Free plan |
| --- | --- | --- | --- |
| 13 alarms reading the pool (1.5 s + 10 s + 1.5 s), 4 refresh alarms, 1 cron ping, about 2 attest calls | 20 Durable Object requests | about 28,800 | 100,000 requests |
| 17 `setAlarm`, 13 sample rows, 13 deleted rows | 43 rows written | about 62,000 | 100,000 rows written |
| the prune scans the table every 10 minutes (about 800 rows), an attest reads about 20 | | under 300,000 | 5,000,000 rows read |
| 13 mainnet reads, 4 devnet reads, 1 devnet read per attest | at most a few per invocation | | 50 subrequests per invocation |

`GET /v1/attestor` costs one Durable Object request each, so poll it once a minute at most. Anyone
may call `POST /v1/attest`: nobody gets a signature for what the checks refuse (and a signature is
useless without the keeper's), but every call costs a request and a devnet read. `ATTEST_TOKEN`
closes that once the keeper sends the header.

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
   bank needs no attestor, and the keeper sends it without one.

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
rule that failed. `window_open` and `round_state` can clear (the window ends, the strike lands); the
attestor's reads of a past window never change, so `too_few_samples`, `slot_out_of_range`,
`price_mismatch` and `unpriced` stay refused and that round ends through `refund_expired`. A 503 or
a timeout is worth a retry.

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
`set_strike` (a throwaway key stands in for the keeper; nothing is ever sent to a chain), verifies
it, and checks that prices 5% off are refused.

Deploy (not done yet), from `services\attestor`:

```
npx wrangler deploy
node scripts\secret.ts C:\keys\attestor.json | npx wrangler secret put ATTESTOR_SECRET
npx wrangler secret put DEVNET_RPC
```

`scripts\secret.ts` turns a solana-keygen keypair file into the base58 value on stdout only (the
pipe keeps it off the screen) and prints the public key to stderr. Then `GET /v1/attestor` on the
`workers.dev` URL shows the key and, a minute later, the rounds; `node scripts\smoke.ts <url>` runs
the end-to-end check against it.

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
