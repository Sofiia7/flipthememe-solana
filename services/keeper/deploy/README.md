# FlipTheMeme keeper: deploy

**Neutral selection (8 October correction).** Production defaults to `POOL_NEUTRAL=true`, disables trending discovery and forces the youth score bonus to zero. Age is not a ranking priority: balanced activity wins across the old age rungs. New pools need at least ten minutes of age, the configured activity minimum (50 trades/5 minutes by default), a complete buys/sells split, and flow imbalance at most 0.3 (65/35). Current pools need at least 20 trades/5 minutes and the same flow limit; these checks bypass the ten-minute hold, including during partial discovery failures. Missing usable statistics reject a pool. Both new and current pools must have a reported five-minute price change within +/-1%; missing drift data rejects them. A pool must complete ten priced shadow minutes before real rounds begin. Up to three candidates are observed in parallel; an already prepared candidate takes priority, and a ready healthy current market is never replaced with an unprepared one. While it warms up, the keeper retains a healthy current pool even after the normal hold expires; failing flow, drift, depth or momentum checks still drops it. The last 20 directional shadow minutes in the last 30 minutes also veto a pool when at least ten exist and at least 80% go in either direction. That veto survives restarts through `shadow.jsonl`. A vetoed current pool is replaced, or dropped if nothing qualifies; new rounds wait, while existing rounds keep being priced, settled and refunded. `status.json.selectionPolicy` records the effective settings. Old UP-heavy samples remain in the 200-minute statistics until they age out; this policy is a selection fix, not a promise that subsequent outcomes will be exactly 50/50. `POOL_NEUTRAL=false` explicitly restores the compatibility age ladder; `POOL_OVERRIDE` is still an explicit operator override of selection.

One container, `ftm-sol-keeper`, on a Linux VPS with Docker Compose (the host may run other compose
projects too). It only makes outbound connections (devnet RPC, mainnet RPC, GeckoTerminal): no
ports, no DNS, no reverse proxy.

Only one keeper may run at a time. A laptop keeper and the VPS keeper would race for the same round
ids and keep separate house budgets, so stop one before starting the other. The keeper notices a
second one (see "A second keeper and clock drift" below) and stops creating rounds for 5 minutes,
but nothing replaces stopping the other one.

Placeholders used below:

- `<vps-user>`, `<vps-host>`: the Linux user that owns the deploy folder, and the host name or IP;
- `<deploy-dir>`: the deploy folder on the VPS, for example `/home/<vps-user>/ftm-sol-keeper`;
- `<secrets-dir>`: a folder on the operator's own machine, outside the repository, that holds the
  key files (`keeper.json`, later `price.json`, `house.json`, `upgrade.json`, `attestor.json`).
  A key file never goes into the repository, an image or a log.

## Canonical price rollout

The deployed program and keeper must use the same price protocol. `LEGACY_PRICES=true` is only for the previous program during a coordinated upgrade. Pause new bets, finish or refund existing rounds, deploy the verified program, then set `LEGACY_PRICES=false` and recreate the keeper container before resuming. The upgraded required-oracle program rejects priced legacy instructions; this flag cannot bypass it.

In canonical mode the keeper obtains the public attestor certificate, verifies its context and signature locally, then relays it. A certificate outage does not fall back to keeper-selected samples. Any funded payer can also use [the standalone relay CLI](../../../docs/price-certificates.md). `status.json.priceProtocol` reports the effective mode. Production neutral settings include `POOL_MAX_PRICE_MOVE_M5=1` and the ten-minute shadow warmup above.

## Before the first deploy

1. The project owner has agreed to the deploy.
2. The program is deployed on devnet, and Config plus the house Vault exist. This is done once by
   `scripts/init-config.ts` (it skips whatever already exists); `scripts/status.ts` shows the result.
3. The keeper key has devnet SOL for fees and round rent (see "Costs" below).

## Layout on the VPS

```
<deploy-dir>/
  .dockerignore                 narrows the build context to dist/keeper.mjs
  dist/keeper.mjs               the bundle
  deploy/Dockerfile
  deploy/docker-compose.yml
  deploy/.env                   optional overrides (see Configuration)
  deploy/data/                  state.json, status.json, observations.json, shadow.jsonl, rounds.jsonl; owned by uid 1000
  deploy/secrets/keeper.json    the keeper key, mode 600, owned by uid 1000
```

The compose project is named `ftm-sol-keeper` explicitly (network `ftm-sol-keeper_default`): the
folder name `deploy` alone would make it the same compose project as any other `deploy` folder on
the host.

The image runs as the unprivileged `node` user (uid 1000) of `node:22-alpine`, so `data/` and the
key files belong to uid 1000 on the host. Create `secrets/keeper.json` before `docker compose up`:
for a missing file Docker would create a directory in its place and the keeper would not start.

## 1. Build (from the repository root)

```
corepack pnpm --filter @flipthememe/keeper test
corepack pnpm --filter @flipthememe/keeper exec tsc --noEmit
corepack pnpm --filter @flipthememe/keeper run build
```

The result is `services/keeper/dist/keeper.mjs` (one ESM file with the shared client and
`@solana/kit` inside; Node 22 runs it without any `node_modules`).

## 2. Deploy

Two plain steps over SSH: copy the files, then run one script on the VPS. Any tool that copies
files and runs commands does the same (`scp`/`ssh`, `rsync`, a wrapper of your own).

Copy, from `services/keeper`. The key goes only with the first deploy (and again when it changes);
every update leaves it where it is:

```bash
cd services/keeper
ssh <vps-user>@<vps-host> "mkdir -p <deploy-dir>/incoming"
scp dist/keeper.mjs deploy/Dockerfile deploy/docker-compose.yml .dockerignore <vps-user>@<vps-host>:<deploy-dir>/incoming/
# first deploy only:
scp <secrets-dir>/keeper.json <vps-user>@<vps-host>:<deploy-dir>/incoming/
```

Then on the VPS (`ssh <vps-user>@<vps-host> bash -s`, script on stdin):

```bash
set -e
cd <deploy-dir>
mkdir -p dist deploy/data deploy/secrets
mv incoming/keeper.mjs dist/keeper.mjs
mv incoming/Dockerfile incoming/docker-compose.yml deploy/
mv incoming/.dockerignore .dockerignore
if [ -f incoming/keeper.json ]; then mv incoming/keeper.json deploy/secrets/keeper.json; fi
rm -rf incoming
test -f deploy/secrets/keeper.json || { echo "deploy/secrets/keeper.json is missing"; exit 3; }
chmod 600 deploy/secrets/*.json
sudo chown -R 1000:1000 deploy/data deploy/secrets
cd deploy
docker compose up -d --build
sleep 20
docker compose ps
docker compose logs --tail 40
cat data/status.json
```

To roll back, copy the previous `dist/keeper.mjs` and run the same script.

## 3. Operate

Over SSH, in `<deploy-dir>/deploy`:

| Task | Command |
|---|---|
| status | `cat data/status.json` |
| logs | `docker compose logs --tail 200` |
| restart | `docker compose restart` |
| stop | `docker compose stop` (waits up to 40 s for transactions in flight) |
| start again | `docker compose up -d` |

`status.json` is rewritten every second: last round id, last successful action, keeper SOL balance,
house vault available, house budget of the UTC day, current pool and its rung, GeckoTerminal
discovery (tracked pools, candidates, last good refresh, failures), age of the newest price
observation per pool, devnet clock offset (`clockOffsetWarning` when it is beyond 3 s), `shadow`
(the share of UP over the last 200 minutes, see "Shadow rounds and statistics") and `anotherKeeper`
(`suspected`, `createPausedUntil`). The container health check fails when it is older than
30 s; Docker only marks the container unhealthy for that, the restart comes from the self-watchdog
below.

Log lines are JSON: one per action, `{"t","round","step","sig"}` or `{"t","round","step","error"}`
with step `create`, `fill`, `strike`, `settle`, `claim`, `sweep`, `close` or `expire`; everything
else carries an `event` field (`pool_selected`, `chain_clock`, `mainnet_rpc_error`, ...).

### Failing loops in the log

A loop that fails every second (devnet down for an hour) no longer writes a line per second. The
first failure of a loop is logged at once as `loop_error` (`loop`, `error`); after that at most one
`loop_error` line per 30 s, with `suppressed` (how many failures the line stands for besides itself),
`failures` (since the outage began) and the latest `error`; when the loop works again one
`loop_recovered` line (`failures`, `suppressed`, `downMs`).

### Self-watchdog

The keeper watches its own scheduler loop. When no tick has completed for 120 s while the process is
up (a request or promise that never settles), it saves the observations, logs `keeper_stalled`
(`idleMs`) and exits with code 1; `restart: unless-stopped` starts it again. A tick that fails
(devnet down) still completes, so an outage is not a stall: it shows as `loop_error` lines and in
the watchdog script below, and the keeper keeps running. A process whose whole event loop is
blocked cannot check itself either: its `status.json` goes stale, which the container health check
and the watchdog script below report.

### Observations survive a restart

The price observations of the last 15 minutes (the samples that go into `set_strike` and `settle`)
are kept in `observations.json` next to `state.json`, in the `data/` volume: written every 5 s from
20 s before a price window until it ends (seconds 10 to 40 of every minute: both windows of every round
fall on seconds 30 to 40), once a minute otherwise, and on a graceful stop (a temp file, then a rename),
read back at start. Entries older than 15 minutes, stamped in the future or malformed are dropped, a corrupt file
is ignored (`observations_restore_failed`), slots and prices are stored as strings. A restart inside
a strike or exit window therefore keeps the window's samples and the round is priced as usual,
instead of waiting for `settle_deadline` and a refund. A restart that lasts longer than the window
still loses it. Log line at start: `observations_restored` (`pools`, `observations`, `dropped`).
The file is about 65 KB per sampled pool. With rounds every minute both windows fall on the same
seconds, so the keeper writes 7 times a minute (seconds 10, 15, ... 40) instead of 12 times, about
40 % less disk traffic. The pace follows the clock, not the rounds, so a minute with no round in it
is written the same way. Delete the file to start without history.

### Sampler

The sampler ticks every second whatever the reads do (`sampler.ts`): each pool may have two reads in
flight, a read is given up on after 3 s (the failover moves to the next endpoint, a late answer is
thrown away) and two answers with the same slot are stored once. One hung mainnet answer therefore costs
one read, not the seconds around it; before, a 5 s hang left a 10 s window with 4 samples and the
attestor, which wants a share of its own reads, refused the keeper's. The attestor request itself
(`ATTEST_TIMEOUT_MS`) waits 8 s: the attestor reads devnet with 3 s on each of two endpoints. In a
log: `sample_failed` (pool, error, at most one per 30 s per pool).

### Shadow rounds and statistics

Two files next to `state.json` give the numbers that the chain forgets (rounds and positions are
closed a day after they are played):

- `shadow.jsonl`: at every minute boundary the keeper notes the pool it holds and, once the exit window
  of the round that would have opened there is over (opens_at + 160 s), prices the strike and exit
  windows from the observations it already has, with the real rounds' own window function (one sample
  per slot, at most 16, at least 5, a whole-number mean). One line per minute, bets or not: `ts`,
  `opensAt`, `pool`, `mint`, `name`, `rung`, `strikeMean`, `exitMean`, `strikeSamples`, `exitSamples`
  and `dir` (`up`, `down`, `tie`, `unpriced`). The same line goes to the log as `shadow_round`. This is
  the honest share of UP of the pools the arena plays. The last 200 minutes are aggregated in
  `status.json` (`shadow`: `rounds`, `up`, `down`, `tie`, `unpriced`, `upShare` = up / (up + down)).
  Candidate-only rows carry `observedOnly: true`: they inform readiness and momentum checks but are excluded from the arena aggregate and the statistics CLI. The file keeps the last `SHADOW_MAX_LINES` lines (20000; retention depends on the number of observed candidates).
- `rounds.jsonl`: one line per round when its sweep is due: `id`, `ts`, `opensAt`, `pool`, `name`,
  `outcome` (`up`, `down`, `refund`, `not_activated`), `refundReason`, `strike`, `exit`, `rawUp`,
  `rawDown`, `houseAmount`, `humans` (positions that are not the house's), `wallets` (distinct owners),
  `players` (those wallets, at most 50: the unique wallets of the whole file cannot be added up from
  counts), `positions`. `humans`, `wallets` and `players` are null when the positions were already
  closed or could not be read. Bounded by `ROUNDS_MAX_LINES` (20000).

`scripts/stats.ts` reads both (only Node, the one file runs anywhere next to the data):

```
node services/keeper/scripts/stats.ts --dir <deploy-dir>/deploy/data [--days 7] [--json]
```

It prints rounds recorded and played (priced), rounds with 1+ and with 2+ people, unique wallets, the
share of UP among played rounds and among shadow rounds (also by rung). Wallets that smoke tests fund
from the keeper key are not told apart.

`scripts/census.ts` is the read-only look at the chain itself (no key, no keeper, only devnet reads):
vault accounts (wallets that ever put SOL in), sessions, rounds and positions still on the chain, human
and house positions (by the `is_house` byte, `OFFSETS.positionIsHouse` = 89), distinct human wallets and
rounds with 2+ people:

```
node services/keeper/scripts/census.ts
```

`DEVNET_RPC` picks the endpoint (default `https://api.devnet.solana.com`; a dedicated one is kinder
to it). It is not in the keeper's package.json scripts: run it from the repository root.

### A second keeper and clock drift

Two keepers do no harm to the money, but they race for round ids. The keeper logs
`another_keeper_suspected` (`sign`: `round_exists`, a round stands at the next boundary that this
process did not create, or `invalid_round_id`, its create failed with InvalidRoundId; one line per boundary,
at most one per 30 s) and after three boundaries in a row stops creating rounds for 5 minutes
(`another_keeper_create_paused`, then `create_paused_another_keeper` while it lasts); strike, settle and
claims go on. One create of its own resets the count, so a restart never gets near three. Stop the other
keeper.

`clock_offset_warning` (`offsetMs`, at most one line per 10 minutes) says the devnet clock and this
host differ by more than 3 s: the windows are cut on the local clock and the attestor judges the slots
on its own, so a drift that large ends in `slot_out_of_range` refusals. Containers take the time of
the host (no NTP of their own): fix it on the host. `scripts/watchdog.ts` reports the same condition
(`clock_offset`).

### Watchdog script and alerts

`scripts/watchdog.ts` is the operator's check from outside the container. It reads `status.json`
(the folder of `STATE_FILE`, like `status.ts`; on the host that is the path of `deploy/data/state.json`),
optionally the attestor's public health (`GET <attestor>/v1/attestor`), prints one line per problem
and exits with 1 when there is any (0: all fine, 2: the script itself failed). It needs Node 22.18
or newer and nothing else: the one file runs on its own, copied anywhere.

It reports:

| Problem | When |
|---|---|
| `status_missing` / `status_stale` | `status.json` is unreadable or older than 3 minutes (judged alone: its other numbers are not current) |
| `no_recent_action` | rounds exist, the arena is not paused and `lastSuccessfulActionAt` is older than 5 minutes |
| `keeper_low_balance` | `keeperLamports` below 0.2 SOL |
| `house_vault_low` | `houseVaultAvailable` below 0.1 SOL |
| `clock_offset` | `chainClockOffsetMs` beyond 3 s (either way) |
| `attestor_key_mismatch` | the Worker's key is not the attestor in OracleConfig (`oracle.matchesKey` is false) |
| `attestor_signing_low` | from 10 attests on, `signed / attests` below 0.8 |
| `attestor_unreachable` | `ATTESTOR_HEALTH_URL` is set and the request fails or answers with an HTTP error |

Environment: `STATE_FILE`, `ATTESTOR_HEALTH_URL` (optional), `TELEGRAM_BOT_TOKEN` and
`TELEGRAM_CHAT_ID` (optional, both needed), `WATCHDOG_STATE_FILE` (optional, where the last set of
problems is remembered; default `watchdog-state.json` next to `status.json`). With both Telegram
variables set it posts the problems to the chat, and only when the set of problems changed since
the last run (plus one "all clear" when they are gone); the token is never printed. Without them it
only prints and sets the exit code, which any other monitor can use.

Cron example, every two minutes, as a user that can read `<deploy-dir>/deploy/data`. The variables
live in a file only that user can read (`chmod 600`), not in the crontab:

```
# /etc/ftm-watchdog.env
export STATE_FILE=<deploy-dir>/deploy/data/state.json
export ATTESTOR_HEALTH_URL=https://<attestor-worker-host>/v1/attestor
export TELEGRAM_BOT_TOKEN=<bot-token>
export TELEGRAM_CHAT_ID=<chat-id>
export WATCHDOG_STATE_FILE=/var/tmp/ftm-watchdog-state.json

# crontab
*/2 * * * * . /etc/ftm-watchdog.env && node <path-to>/watchdog.ts >> /var/log/ftm-watchdog.log 2>&1
```

## Token choice

Once a minute (`src/poolgate.ts`, `src/discovery.ts`, `src/selector.ts`):

- Entry gate: pool 10-120 minutes old, 50+ trades in the last 5 minutes, quote wSOL, owner
  PumpSwap, at least 50 SOL in the quote vault on chain (K x min_bank), and, with
  `POOL_PUMP_ONLY=true`, a mint that ends in `pump` (pump.fun graduates only; pools made on
  PumpSwap directly get drained fast). The compose file turns the filter on, the code default is
  off. Score `txM5 * (1 - |buys - sells| / txM5) * (1 + (120 - age_min) / 120)`: activity, with up to
  twice the weight for the youngest, penalised for one-sided flow (a pool whose trades are all buys
  scores 0; `POOL_YOUTH_WEIGHT=0` drops the youth bonus). The split comes from the buys and sells of
  GeckoTerminal's `transactions.m5`, which the keeper reads off the raw rows (the client package only
  keeps their sum); a candidate without the split counts as balanced.
- Neutral choice (a one-sided stream is momentum, and a round that reads 2.5 minutes of price turns
  momentum into UP: 11 of 12 rounds went UP on 6 October). Soft gate: a candidate with
  `|buys - sells| > POOL_MAX_IMBALANCE * txM5` (0.5) is ranked behind every balanced one while a balanced
  pool of the fresh or fallback rungs exists; with none, or when the balanced ones fail the depth or
  token check, it serves as before. The `trending_pools` list is only used to find pools to track,
  never for ranking: every ranked candidate gets its numbers from `pools/multi` or the top list.
- Token check (`src/tokencheck.ts`, after the depth gate, cached per mint for 30 minutes, `TOKEN_CHECK=off`
  switches it off): the mint authority and the freeze authority must be revoked (SPL Mint layout: COption
  at 0 and at 46 of 82 bytes), the mint must belong to the Token or Token-2022 program, a Token-2022 mint
  with a TransferFee, TransferHook, PermanentDelegate, NonTransferable or Pausable extension or with a
  frozen DefaultAccountState is refused (Token-2022 without them is fine: pump.fun mints can be), and the
  biggest token account that is not the pool's own base vault may hold at most `HOLDER_MAX_PCT` (20) percent
  of the supply (`getTokenLargestAccounts`). A refused candidate is skipped (`pool_rejected_unsafe`: pool,
  reason); a current pool that fails is replaced like a shallow one. The mint checks fail closed: when the
  mint cannot be read (RPC error) the candidate is skipped in this refresh (`token_check_failed`, at most
  one line per 5 minutes per pool) and the current pool is left as it is. The holder check is best effort:
  the public mainnet RPCs rate limit `getTokenLargestAccounts` (429) or block it (checked on 2026-10-07:
  api.mainnet-beta.solana.com answers 429, publicnode answers "Request blocked"), so when the list cannot be
  read the verdict stands on the mint checks, is marked `holders: 'unchecked'` and is read again after
  5 minutes. Give `MAINNET_RPCS` a keyed endpoint that serves the method to get the holder check.
  `POOL_OVERRIDE` skips the check (an operator's decision).
- The current pool stays at least 10 minutes. After that it is replaced when a deep enough candidate
  scores 1.5x higher, or when it drops below 20 trades in 5 minutes or gets older than 180 minutes.
  Below 50 SOL it is replaced at once, or dropped when no deep enough pool is left: then no new round
  opens until one qualifies. A failed reserve read (RPC errors) replaces it but never drops it. Only
  rounds created after a switch use the new pool; rounds in flight are still struck, settled and
  claimed.
- Right before each round the scheduler checks the depth again on the newest observation (with
  `POOL_OVERRIDE` too): max_bank = reserve / 2500 must reach Config's min_bank, or the round could
  never activate and is not created (`round_skipped_shallow_pool`).
- Nothing fresh: the ladder widens the age to 6 h, then 24 h, then takes the most active pool of any
  age. Log events `pool_selected` (rung `fresh`) and `pool_selected_fallback` (rung `within-6h`,
  `within-24h` or `any-age`), plus `pool_kept_on_rung`, `pool_none_qualifies`, `pool_dropped`,
  `pool_check_failed`.
- GeckoTerminal (free API, about 30 requests per minute per IP): at most 4 requests per minute.
  It has no creation-time sort for one dex, so the keeper reads `new_pools` (every dex, newest
  first) every minute and tracks its PumpSwap pools for 180 minutes (the 5-minute trending list adds
  its PumpSwap pools to that set); `pools/multi` refreshes up to 30 of them plus the current pool; the
  PumpSwap top list (pages 1-2 every 5 minutes) feeds the ladder. A failed request skips the next 1,
  2, 4, then 8 minutes (`pool_discovery_failed`), the refresh is then not complete (the current pool
  is not rotated on it), and numbers up to 15 minutes old stay in use meanwhile.
- The tracked set lives in memory. After a restart pools qualify again once they are 10 minutes
  old, so for the first 10 minutes or so the ladder (or the restored pool, if it still passes)
  plays.

### House policy

The house tops up the smaller side of a lone bet, within the on-chain `HouseLimits` and the keeper's
own softer limits (`src/house.ts`, `scheduler.ts`):

- No fill while `config.paused`: the program refuses `house_fill` then (Paused, 6015), so the keeper does
  not ask (`house_fill_paused`, `skipped: paused`).
- No fill in the first `HOUSE_SWITCH_PAUSE_SECS` (60) after the pool of the round was selected
  (`skipped: pool-switch-pause`): a pool that was chosen a moment ago has not shown its flow yet. The
  round gets no match then and refunds.
- The daily budget is spread over the UTC day: a fill takes at most
  `remaining / max(1, roundsLeftToday / HOUSE_PACE_DIVISOR)` (divisor 4: one round in four is expected to
  need a fill; 0 turns the spreading off). With 2 SOL that makes lone stakes last the day (about 200 fills)
  instead of 40 minutes. The cap never goes below what the round needs to activate (2 x its smaller side
  reaching min_bank) while the budget, the vault and the chain's caps allow it, and the line of the fill carries
  `paced` when the cap made it smaller. The player is then matched on part of the stake, the rest comes back.
- At most `HOUSE_WALLET_DAILY_FILLS` (30) fills per wallet and UTC day (0 = no limit): the wallet is the
  owner of the biggest human stake on the side the fill matches (the positions are read when a fill is
  about to go out). Counters live in `state.json` (`house.fills`, reset on a new UTC day, at most 2000 wallets);
  a fill found on the chain after a restart has no wallet to name and is counted against the day's spend
  only. Over the limit: `skipped: wallet-limit`, `fill_skipped_wallet_limit` (wallet, fillsToday, limit).

Read-only check of the choice on live data (2 GeckoTerminal requests, mainnet reads, no key, no
devnet; it does not race the VPS keeper):

```
node services/keeper/scripts/select-dry-run.ts packages/client/test/fixtures/geckoterminal-new-pools-page1.json
```

## Configuration

Optional `deploy/.env` next to `docker-compose.yml` (compose passes the variables listed here; an
empty value means the keeper's own default):

| Variable | Default | Meaning |
|---|---|---|
| `DEVNET_RPC` | `https://api.devnet.solana.com` | devnet RPC for reads and transactions |
| `MAINNET_RPCS` | `https://api.mainnet-beta.solana.com,https://solana-rpc.publicnode.com` | price source RPCs, tried in order with backoff |
| `HOUSE_ROUND_CAP_LAMPORTS` | `50000000` (0.05 SOL) | most the house adds to one round |
| `HOUSE_DAILY_BUDGET_LAMPORTS` | `2000000000` (2 SOL) | most the house adds per UTC day |
| `ATTEST_URL` | empty | base URL of the price attestor service; empty = the keeper sends prices alone (only possible while OracleConfig does not require the attestor) |
| `ATTEST_TOKEN` | empty | the attestor Worker's shared secret, sent as `authorization: Bearer ...`; the start line shows only whether it is set, never the value |
| `PRICE_KEYPAIR` | empty = the keeper key | key file that signs `set_strike` and `settle` (`/secrets/price.json` after `split-roles.ts`) |
| `HOUSE_KEYPAIR` | empty = the keeper key | key file that signs `house_fill` and owns the house vault (`/secrets/house.json` after `split-roles.ts`) |
| `CLOSE_AFTER_SECS` | `86400` (a day) | the keeper closes paid positions this long after their round's exit window; never below the program's 3600 |
| `POOL_OVERRIDE` | empty | force one PumpSwap pool address instead of the GeckoTerminal choice |
| `POOL_PUMP_ONLY` | `true` in compose (`false` in the code) | only mints that end in `pump` (pump.fun graduates) |
| `POOL_MIN_AGE_MIN` | `10` | entry gate: youngest pool age, minutes |
| `POOL_MAX_AGE_MIN` | `120` | entry gate: oldest pool age, minutes (also where the youth bonus ends) |
| `POOL_MIN_TX_M5` | `50` | entry gate: trades in the last 5 minutes |
| `POOL_HOLD_MIN` | `10` | minutes the current pool stays at least |
| `POOL_SWITCH_RATIO` | `1.5` | after the hold, a candidate needs this many times the current score |
| `POOL_KEEP_MIN_TX_M5` | `20` | after the hold, fewer trades in 5 minutes replace the current pool |
| `POOL_KEEP_MAX_AGE_MIN` | `180` | after the hold, an older fresh pool is replaced |
| `POOL_MAX_IMBALANCE` | `0.5` | one-sided flow gate: `\|buys - sells\| > this * txM5` ranks a candidate behind the balanced ones (0 to 1) |
| `POOL_YOUTH_WEIGHT` | `1` | weight of the youth bonus in the score; `0` = no bonus |
| `TOKEN_CHECK` | `true` | token check at selection (authorities, Token-2022 extensions, top holder); `false` / `off` skips it |
| `HOLDER_MAX_PCT` | `20` | the biggest holder outside the pool may have this percent of the supply (above 0, at most 100) |
| `TOKEN_CHECK_TTL_MIN` | `30` | minutes a token verdict is kept per mint |
| `HOUSE_SWITCH_PAUSE_SECS` | `60` | no house fill in rounds of a pool selected less than this long ago; `0` = off |
| `HOUSE_WALLET_DAILY_FILLS` | `30` | house fills per wallet and UTC day; `0` = no limit |
| `HOUSE_PACE_DIVISOR` | `4` | spreads the daily budget: a fill takes at most `remaining / max(1, roundsLeftToday / this)`; `0` = no spreading |
| `SHADOW_MAX_LINES` | `20000` | lines kept in `shadow.jsonl` (at least 100) |
| `ROUNDS_MAX_LINES` | `20000` | lines kept in `rounds.jsonl` (at least 100) |

`KEEPER_KEYPAIR=/secrets/keeper.json` and `STATE_FILE=/data/state.json` are set by the image
(`status.json`, `observations.json`, `shadow.jsonl` and `rounds.jsonl` go next to the state file). RPC URLs may carry API keys: the
keeper logs only their host names.

`TREASURY` is not needed. It is an address that only `scripts/split-roles.ts` reads (to name a new
treasury in `update_config`); the running keeper takes the treasury from `config.treasury` on chain
at every `sweep_fees`, and compose does not pass it.

## Run on the laptop instead

```
node services/keeper/scripts/status.ts
node services/keeper/src/main.ts
```

It reads the key from the `.flipthememe` folder in the user's home directory (`keeper.json`) unless
`KEEPER_KEYPAIR` names another file, and keeps `keeper-state.json`, `status.json` and
`observations.json` in `services/keeper` (all ignored by git). Ctrl+C stops it after the
transactions in flight. Stop the VPS container first.

## Costs (keeper wallet)

Measured on devnet on 5 October 2026 (rent there is 5080 lamports per byte including overhead):

- Empty round (nobody bets): create, strike (ends NotActivated), close = 3 fees of 5000 lamports;
  the round rent (0.00184 SOL) comes back on close. 0.0009 SOL per hour.
- Played round: 6 fees (create, house fill, strike, settle, claim, sweep) plus the round's rent
  (0.00184 SOL), which stays on chain until the round is closed (next paragraph). Since 6 October
  the house position's rent (0.00116 SOL) comes out of the house Vault and goes back into it when
  the keeper closes the position a day later, and the 2% fee goes to the separate treasury at the
  sweep; the house stake itself is won or lost inside the house Vault.

The round rent comes back too (audit L2; about 3.6 SOL a day on mainnet at one round a minute).
After the keeper has closed the last position of a round it reads the round again and, when it is
Final with no positions left and its fees swept (or no bank), sends `close_empty_round` (up to 10
rounds per transaction, the rent goes to `config.admin`, the keeper key). This works only for rounds
whose positions are closed by the upgraded program, which makes `close_position` decrement
`round.position_count`: on a round whose positions the old program closed the count stays above 0
for ever, so its rent stays on chain. A refused round close is left alone for an hour and given up
after 3 refusals; the list of rounds to watch lives in memory only, so a round whose last position
was closed just before a restart is not found again. New log events: `round_closed` (round,
lamports, sig), `round_close_failed` (round, error, retry), `rounds_checked`, `round_check_failed`;
the `positions` block of `status.json` gains `closedRounds`, `closedRoundLamports`, `roundsQueued`
and `roundsPending`. Deploy the new keeper image together with the program upgrade: the old
keeper's `close_position` passes the round read-only, which the upgraded program refuses (it has to
write the counters), so an old keeper would stop returning position rent altogether.

## RPC limits

The public devnet RPC rejects bursts with HTTP 429. The keeper keeps at most two transactions in
flight (create and house fill first), polls confirmations every 1.2 s and pauses 4 s after a 429.
A 429 while confirming does not mean the transaction failed: such log lines carry the signature
and `"landed":"unknown"`, and the next tick decides from the chain state. If 429s keep appearing,
set `DEVNET_RPC` to a dedicated devnet endpoint.

## Retries and what a failed step costs

A failed step is retried on a later tick, never in a tight loop:

- Most failures back off 2 s, 4 s, 8 s, 16 s, then every 30 s; `NotDue` (the devnet clock is a
  little behind) retries after 1 s.
- The attestor refusing a price (`attest_refused`) backs off by its reason, because every try is one
  request on the Worker's free plan. A refusal that can clear up by itself (`too_few_samples` right
  after a window ended, `round_not_found`, `window_open`, `round_state`, a reason this keeper does
  not know) is asked again after 5 s, 15 s, 60 s, then every 120 s. A refusal about samples that no
  longer change (`price_mismatch`, `slot_out_of_range`, `slot_price_mismatch`, `unpriced`,
  `samples_withheld`, `strike_too_late`, `already_signed`, `too_many_attempts`), a wrong `ATTEST_TOKEN` (`unauthorized`) or a transaction
  the attestor will never sign goes straight to every 120 s. An attestor that is down (`attest_failed`,
  a timeout of 8 s per request, 5xx, 429) keeps the 2 s .. 30 s backoff. All of it ends at `settle_deadline`, after
  which the round takes its refund (`refund_expired` needs no attestor).
- A claim that the program refuses for one position no longer blocks the round: when a batch
  fails with a program error, its positions are claimed one per transaction, the refused one is
  named in the log (`claim_position_failed`: `round`, `owner`, `position`, `error`), and the step
  asks for the leftovers again after 60 s. A position the player already claimed in the app
  (`AlreadyClaimed`) is not a failure. The keeper sweeps a round's fees only once every position
  of the round is claimed (`steps.ts`), so a position that stays refused holds the sweep of its
  round, but not the payout of the others. A failure that is not a program error (a timeout,
  HTTP 429) is not split up: the outcome is unknown and the next tick reads the chain.

## Program upgrade (October 2026): position rent, house limits, price attestor

What changes on chain. Existing accounts keep their layout; old error numbers stay, new ones
are appended (6023 `NotClaimed`, 6024 `HouseRoundCapExceeded`, 6025 `HouseDailyCapExceeded`,
6026 `AttestorRequired`, 6027 `InvalidAttestor`).

- `close_position` (anyone): a claimed position of a Final round closes once its exit window ended
  at least an hour ago; the rent (0.00116 SOL) goes to the owner's wallet (since the next
  upgrade, below: back into the owner's vault). The keeper closes them
  a day after the round (`CLOSE_AFTER_SECS`, default 86400): the app keeps a finished round in the
  phone's history only while it still sees the position on chain.
- `HouseLimits` (`init_house_limits`, `update_house_limits`, admin only): per-round and per-UTC-day
  caps of the house. `house_fill` needs the account and refuses anything above the caps.
- `OracleConfig` (`init_oracle`, `set_oracle`, admin only): the independent price attestor. While
  `required` is true, `set_strike` and `settle` of a matched round need its signature.
  `refund_expired` and claims never need it, so an attestor outage only ends rounds in the usual
  refund. `set_strike` and `settle` need the account even while `required` is false. The admin
  alone may only strengthen it: switching a required attestor off or replacing it needs the
  attestor in office to co-sign (its key file, `<secrets-dir>/attestor.json`), so a stolen keeper
  key cannot price rounds alone.

Sizes and costs, at the devnet rent measured on 5 October 2026 (5080 lamports per byte,
128 bytes of account overhead included):

| | bytes | lamports | SOL |
|---|---:|---:|---:|
| current program data | 398296 | | |
| new `flip_the_meme.so` | 473768 | | |
| `solana program extend` by the difference, permanent | 75472 | 383397760 | 0.383 |
| upload buffer (37 + 473768 bytes), returned after the deploy | 473805 | 2407579640 | 2.408 |
| about 475 buffer write transactions at 5000 lamports | | 2375000 | 0.002 |
| HouseLimits and OracleConfig accounts | 41, 42 | 1722120 | 0.002 |
| moving the upgrade authority (one transaction, two signatures) | | 10000 | 0.00001 |

At most about 2.79 SOL leaves the keeper wallet during the deploy; with 3.87 SOL there it keeps
about 1.08 SOL, and about 3.48 SOL once the buffer rent is back. If `solana rent` below shows the
older rate of 6960 lamports per byte, the buffer needs 3.299 SOL and the extension 0.525 SOL,
3.82 SOL together: then move SOL into the keeper wallet first.

Run nothing of this before the project owner agrees. Run the commands from the repository root with
the Solana (Agave) CLI tools on PATH; the two VPS steps go over SSH as in section 2.

1. Build and test, check the size, the authority and the money:

   ```
   cargo build-sbf --manifest-path programs/flip-the-meme/Cargo.toml
   cargo test --manifest-path programs/flip-the-meme/Cargo.toml
   node --test "packages/client/test/*.test.ts"
   node --test "services/keeper/test/*.test.ts"
   ls -l target/deploy/flip_the_meme.so
   solana program show 5kUCKYAYxZyaSz18xEajhSDNwdXvVLp2AvBp4LDxWuCz --url devnet
   solana balance --keypair <secrets-dir>/keeper.json --url devnet
   solana rent 473805 --url devnet
   ```

   `program show` must list the keeper key as `Authority` and `Data Length: 398296`. Keep a copy
   of the running program for a rollback:

   ```
   solana program dump 5kUCKYAYxZyaSz18xEajhSDNwdXvVLp2AvBp4LDxWuCz <secrets-dir>/flip_the_meme-2026-10-05.so --url devnet
   ```

2. Stop new bets, then wait until the last rounds are Final and claimed (about 4 minutes):

   ```
   node services/keeper/scripts/set-pause.ts on
   node services/keeper/scripts/status.ts 6
   ```

3. Stop the keeper on the VPS: the old keeper cannot strike, settle or fill against the new
   program, whose account lists changed.

   ```bash
   ssh <vps-user>@<vps-host> "cd <deploy-dir>/deploy && docker compose stop"
   ```

4. Extend the program data account and deploy (the keeper key pays and, this one last time, is
   the upgrade authority):

   ```
   solana program extend 5kUCKYAYxZyaSz18xEajhSDNwdXvVLp2AvBp4LDxWuCz 75472 --keypair <secrets-dir>/keeper.json --url devnet
   solana program deploy target/deploy/flip_the_meme.so --program-id 5kUCKYAYxZyaSz18xEajhSDNwdXvVLp2AvBp4LDxWuCz --upgrade-authority <secrets-dir>/keeper.json --keypair <secrets-dir>/keeper.json --url devnet
   solana program show 5kUCKYAYxZyaSz18xEajhSDNwdXvVLp2AvBp4LDxWuCz --url devnet
   ```

   If the buffer writes stall, repeat the deploy with `--use-rpc`. A deploy that stops half way
   prints how to resume it with `--buffer`; a buffer left behind gives its rent back with
   `solana program close --buffers --keypair <secrets-dir>/keeper.json --url devnet`.

5. Move the upgrade authority off the keeper key, which sits on the VPS: a stolen keeper key must
   not be able to replace the program. The new key file never goes to the VPS; keep a backup
   (the seed phrase `solana-keygen` prints, or a copy of the file), because without it the
   program can never be upgraded again.

   ```
   solana-keygen new --no-bip39-passphrase -o <secrets-dir>/upgrade.json
   solana program set-upgrade-authority 5kUCKYAYxZyaSz18xEajhSDNwdXvVLp2AvBp4LDxWuCz --new-upgrade-authority <secrets-dir>/upgrade.json --upgrade-authority <secrets-dir>/keeper.json --keypair <secrets-dir>/keeper.json --url devnet
   solana program show 5kUCKYAYxZyaSz18xEajhSDNwdXvVLp2AvBp4LDxWuCz --url devnet
   ```

   Given as a key file, the new authority co-signs, which the CLI checks by default (agave
   3.1.14). `program show` must now list the address of upgrade.json as `Authority`. Every later
   deploy, the rollback below included, uses `--upgrade-authority <secrets-dir>/upgrade.json`; the
   keeper wallet still pays (`--keypair <secrets-dir>/keeper.json`).

6. Create the new accounts (dry run first; both scripts are idempotent):

   ```
   node services/keeper/scripts/init-house-limits.ts --dry-run
   node services/keeper/scripts/init-house-limits.ts
   node services/keeper/scripts/init-oracle.ts --required false
   node services/keeper/scripts/status.ts
   ```

   Defaults: `--round-cap 50000000` (0.05 SOL), `--daily-cap 2000000000` (2 SOL), the keeper's own
   defaults, which now act as a softer limit on top of the chain.

7. Optional, separate keys for the price and house roles (still paused). Make the keys and look
   at the plan; the script prints every amount and sends nothing without `--execute`:

   ```
   solana-keygen new --no-bip39-passphrase --outfile <secrets-dir>/price.json
   solana-keygen new --no-bip39-passphrase --outfile <secrets-dir>/house.json
   (set PRICE_KEYPAIR=<secrets-dir>/price.json and HOUSE_KEYPAIR=<secrets-dir>/house.json in the environment)
   node services/keeper/scripts/split-roles.ts
   node services/keeper/scripts/split-roles.ts --execute
   ```

   One transaction: withdraw the free house money from the keeper's vault, transfer it plus the
   new vault's rent (0.00094 SOL) to the house key (in October also 0.25 SOL for house position
   rent; since the next upgrade the house vault pays that rent and the reserve is gone), open its
   vault, deposit, and `update_config` with the new price authority,
   house authority and `TREASURY` (unset: unchanged). The keeper key stays admin and fee payer.
   Once the attestor is required (step 9), the admin alone cannot switch it off or replace it,
   so a stolen keeper key cannot price rounds alone; it can still pause betting, create rounds
   and change Config. Then copy both files to the VPS with the next step (like keeper.json in the
   first deploy), move them to `deploy/secrets/` (mounted as a whole at `/secrets`, read only) and
   set `PRICE_KEYPAIR=/secrets/price.json` and `HOUSE_KEYPAIR=/secrets/house.json` in `deploy/.env`.

8. Deploy the new keeper (build as in section 1, deploy as in section 2; it starts the
   container), check `cat data/status.json` for `houseLimits`, `oracle` and `positions`, then
   reopen betting:

   ```
   node services/keeper/scripts/set-pause.ts off
   ```

9. Attestor, once the service runs: put `ATTEST_URL=https://...` and `ATTEST_TOKEN=...` (the same
   value as the Worker's `ATTEST_TOKEN` secret) in `deploy/.env` and recreate the container
   (`docker compose up -d`; `restart` does not read `.env` again), set its public key while not
   yet required, watch `attest_ok` / `attest_refused` for a while, then require it:

   ```
   node services/keeper/scripts/init-oracle.ts --attestor <ATTESTOR_PUBKEY> --required false
   node services/keeper/scripts/init-oracle.ts --required true
   ```

   From then on, switching the attestor off or replacing it needs the attestor in office to
   co-sign with its key file; without `--attestor-keypair` the script refuses before sending:

   ```
   node services/keeper/scripts/init-oracle.ts --required false --attestor-keypair <secrets-dir>/attestor.json
   node services/keeper/scripts/init-oracle.ts --attestor <NEW_ATTESTOR_PUBKEY> --attestor-keypair <secrets-dir>/attestor.json
   ```

   The keeper sends the attestor nothing but the transaction (`POST /v1/attest`, `{"tx": ...}`,
   with `authorization: Bearer <ATTEST_TOKEN>` when that is set). A missing or wrong token shows
   as `attest_refused` with reason `unauthorized`. While not required, a refusal or an outage is
   logged and the price goes out without it; while required, the step is retried until
   `settle_deadline` (see "Retries and what a failed step costs" for the pace), then the round
   refunds.

Rollback: deploy the dumped file the same way (step 4, with
`--upgrade-authority <secrets-dir>/upgrade.json` once step 5 ran) together with the previous
`dist/keeper.mjs`. The old program ignores the new accounts; the extended size stays.

New environment variables (all optional): `ATTEST_URL`; `ATTEST_TOKEN` (the start line shows only
whether it is set, never its value); `PRICE_KEYPAIR` and `HOUSE_KEYPAIR` (unset: the keeper key);
`CLOSE_AFTER_SECS` (default 86400, never below the program's 3600); `TREASURY` (an address, used
by `split-roles.ts` only).

New log events: `positions_scan` (claimed, closable, lamports, waiting, skipped),
`positions_closed` (positions, lamports, house, rounds, queued, sig), `positions_close_failed`,
`close_batch_shrunk`, `fill_skipped_onchain_cap` (with the caps and today's spend),
`house_limits_missing`, `oracle_missing`, `attest_ok`, `attest_refused` (reason, status),
`attest_failed`, `attestor_required_no_url` (and in October `house_wallet_low`, gone since the
house wallet pays no rent any more). Strike and settle lines carry
`"attested"` when an attestor is set up. Position closing runs only when nothing else is in
flight, in seconds 3 to 33 of the minute, one transaction of up to 8 closes every 10 s at most,
with a scan of claimed positions every 5 minutes.

## Program upgrade (October 2026, second): position rent from the game balance

What changes on chain. No account layout, no error code and no account list of `place_bet` or
`house_fill` changes, so the apps already on phones keep working.

- `place_bet`: the position's rent (0.00116 SOL at devnet's rent) comes out of the owner's vault,
  on top of the stake: the bet needs `available >= stake + rent`, else `InsufficientAvailable`.
  The session key pays only the 5000-lamport network fee, so one session approval lasts its
  week. The session budget counts the stake only.
- `house_fill`: the house position's rent comes out of the house vault the same way. The house
  key only signs; the house wallet needs no SOL any more.
- `close_position`: the position's lamports go back into the owner's vault as available balance,
  not to a wallet. New account list: config (w), round, position (w), the owner's vault (w).
  Positions opened before this upgrade (rent paid by a device key or the house wallet) also pay
  out into the vault, so players get that rent back as balance. House positions from before the
  role split return to the keeper's old vault, later ones to the house vault.
- Someone sending lamports to a future position address only lowers what the vault pays; a
  position that exists already fails as before ("already in use").

Size and costs, at devnet's rent of 5080 lamports per byte measured on 5 October:

| | bytes | lamports | SOL |
|---|---:|---:|---:|
| current program data (the October build) | 473768 | | |
| new `flip_the_meme.so`, smaller: no `solana program extend` | 467840 | | |
| upload buffer (37 + 467840 bytes), returned after the deploy | 467877 | 2377465400 | 2.377 |
| about 468 buffer write transactions at 5000 lamports | | 2340000 | 0.002 |

The keeper wallet needs about 2.38 SOL free while the deploy runs; all but the fees comes back.
At the older rate of 6960 lamports per byte the buffer would need 3.257 SOL.

Run nothing of this before the project owner agrees. Run the commands from the repository root with
the Solana (Agave) CLI tools on PATH; the VPS step goes over SSH as in section 2.

1. Build and test, check the authority and the money, and test the live program's own positions
   against the new build:

   ```
   cargo build-sbf --manifest-path programs/flip-the-meme/Cargo.toml
   cargo test --manifest-path programs/flip-the-meme/Cargo.toml
   node --test "packages/client/test/*.test.ts"
   node --test "services/keeper/test/*.test.ts"
   ls -l target/deploy/flip_the_meme.so
   solana program show 5kUCKYAYxZyaSz18xEajhSDNwdXvVLp2AvBp4LDxWuCz --url devnet
   solana balance --keypair <secrets-dir>/keeper.json --url devnet
   solana rent 467877 --url devnet
   solana program dump 5kUCKYAYxZyaSz18xEajhSDNwdXvVLp2AvBp4LDxWuCz <secrets-dir>/flip_the_meme-2026-10-06.so --url devnet
   (set FTM_LIVE_SO=<secrets-dir>/flip_the_meme-2026-10-06.so in the environment)
   cargo test --manifest-path programs/flip-the-meme/Cargo.toml --test flow -- --ignored
   ```

   `program show` must list `Authority 4ppbN5D5W5R6TiQ5LhG1BUBF7AvpqLYe6csXFa4gUs9q` (upgrade.json)
   and `Data Length: 473768`. The last test opens positions with the dumped live program, swaps
   in the new build in the middle of the round and checks that they close into the vaults with
   exact books; it must pass.

2. Stop new bets, then wait until the last rounds are Final and claimed (about 4 minutes):

   ```
   node services/keeper/scripts/set-pause.ts on
   node services/keeper/scripts/status.ts 6
   ```

3. Stop the keeper on the VPS: its `close_position` has the old account list.

   ```bash
   ssh <vps-user>@<vps-host> "cd <deploy-dir>/deploy && docker compose stop"
   ```

4. Deploy; the new program is smaller than the program data account, so nothing to extend:

   ```
   solana program deploy target/deploy/flip_the_meme.so --program-id 5kUCKYAYxZyaSz18xEajhSDNwdXvVLp2AvBp4LDxWuCz --upgrade-authority <secrets-dir>/upgrade.json --keypair <secrets-dir>/keeper.json --url devnet
   solana program show 5kUCKYAYxZyaSz18xEajhSDNwdXvVLp2AvBp4LDxWuCz --url devnet
   ```

   If the buffer writes stall, repeat with `--use-rpc`; a buffer left behind gives its rent back
   with `solana program close --buffers --keypair <secrets-dir>/keeper.json --url devnet`.

5. Deploy the new keeper: build as in section 1, deploy as in section 2 (it starts the container).
   Check `cat data/status.json`: `positionRent` appears after the first house fill, and the house
   fill now leaves the rent in the house vault.

6. Reopen betting and run one played round end to end:

   ```
   node services/keeper/scripts/set-pause.ts off
   node services/keeper/scripts/smoke-bet.ts
   ```

   The smoke bet deposits the stake plus the position rent; after the bet it prints
   `vault available 0 locked 50000000` and `session key paid 5000 lamports`.

7. Optional: the house wallet holds the 0.25 SOL position-rent reserve from the role split, which
   nothing needs any more. Send it back to the keeper wallet (the house key signs and pays):

   ```
   solana transfer <KEEPER_ADDRESS> ALL --from <secrets-dir>/house.json --fee-payer <secrets-dir>/house.json --url devnet
   ```

Rollback: deploy `<secrets-dir>/flip_the_meme-2026-10-06.so` as in step 4, with the previous
`dist/keeper.mjs`. Positions opened meanwhile are ordinary positions; the old program closes them
to the owner's wallet.

Apps on phones: their bets go through unchanged. A player whose available balance covers the
stake but not stake plus rent gets `InsufficientAvailable` until the app checks both.
