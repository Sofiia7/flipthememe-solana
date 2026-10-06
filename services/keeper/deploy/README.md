# FlipTheMeme keeper: deploy

One container, `ftm-sol-keeper`, on the openclaw VPS next to memepred-rhc. It only makes outbound
connections (devnet RPC, mainnet RPC, GeckoTerminal): no ports, no DNS, no Caddy.

Only one keeper may run at a time. A laptop keeper and the VPS keeper would race for the same round
ids and keep separate house budgets, so stop one before starting the other.

## Before the first deploy

1. Sofia agrees to the deploy (design doc, section 7).
2. The program is deployed on devnet, and Config plus the house Vault exist. This is done once by
   `scripts/init-config.ts` (it skips whatever already exists); `scripts/status.ts` shows the result.
3. The keeper key has devnet SOL for fees and round rent (see "Costs" below).

## Layout on the VPS

```
/home/openclaw/ftm-sol-keeper/
  .dockerignore                 narrows the build context to dist/keeper.mjs
  dist/keeper.mjs               the bundle
  deploy/Dockerfile
  deploy/docker-compose.yml
  deploy/.env                   optional overrides (see Configuration)
  deploy/data/                  state.json and status.json, owned by uid 1000
  deploy/secrets/keeper.json    the keeper key, mode 600, owned by uid 1000
```

The compose project is named `ftm-sol-keeper` explicitly (network `ftm-sol-keeper_default`):
the folder name `deploy` alone would make it the same compose project as memepred on this VPS.

The image runs as the unprivileged `node` user (uid 1000) of `node:22-alpine`, so `data/` and the
key file belong to uid 1000 on the host. Create `secrets/keeper.json` before `docker compose up`:
for a missing file Docker would create a directory in its place and the keeper would not start.

## 1. Build (from the repository root, cmd.exe or Git Bash)

```
corepack pnpm --filter @flipthememe/keeper test
corepack pnpm --filter @flipthememe/keeper exec tsc --noEmit
corepack pnpm --filter @flipthememe/keeper run build
```

The result is `services/keeper/dist/keeper.mjs` (one ESM file with the shared client and
`@solana/kit` inside; Node 22 runs it without any `node_modules`).

## 2. Deploy: one connection through the VPS wrapper (Git Bash)

`vps.sh` is a bash script, so this step runs from Git Bash. `push` uploads the files into
`incoming/` and runs the script below in the same SSH session.

First deploy, which also uploads the key (it travels inside the SSH session only):

```bash
cd /c/Server/memepred_solana/services/keeper
bash /c/Server/twitter_hermes/tools/vps.sh push dist/keeper.mjs deploy/Dockerfile deploy/docker-compose.yml .dockerignore /c/Users/sofia/.flipthememe/keeper.json /home/openclaw/ftm-sol-keeper/incoming <<'CMD'
set -e
cd /home/openclaw/ftm-sol-keeper
mkdir -p dist deploy/data deploy/secrets
mv incoming/keeper.mjs dist/keeper.mjs
mv incoming/Dockerfile incoming/docker-compose.yml deploy/
mv incoming/.dockerignore .dockerignore
if [ -f incoming/keeper.json ]; then mv incoming/keeper.json deploy/secrets/keeper.json; fi
rm -rf incoming
test -f deploy/secrets/keeper.json || { echo "deploy/secrets/keeper.json is missing"; exit 3; }
chmod 600 deploy/secrets/keeper.json
sudo chown 1000:1000 deploy/data deploy/secrets/keeper.json
cd deploy
docker compose up -d --build
sleep 20
docker compose ps
docker compose logs --tail 40
cat data/status.json
CMD
```

Updates: build again and run the same command without
`/c/Users/sofia/.flipthememe/keeper.json` in the file list; the key stays where it is. To roll back,
push the previous `dist/keeper.mjs` the same way. The update, spelled out:

```bash
cd /c/Server/memepred_solana/services/keeper
bash /c/Server/twitter_hermes/tools/vps.sh push dist/keeper.mjs deploy/Dockerfile deploy/docker-compose.yml .dockerignore /home/openclaw/ftm-sol-keeper/incoming <<'CMD'
set -e
cd /home/openclaw/ftm-sol-keeper
mkdir -p dist deploy/data deploy/secrets
mv incoming/keeper.mjs dist/keeper.mjs
mv incoming/Dockerfile incoming/docker-compose.yml deploy/
mv incoming/.dockerignore .dockerignore
if [ -f incoming/keeper.json ]; then mv incoming/keeper.json deploy/secrets/keeper.json; fi
rm -rf incoming
test -f deploy/secrets/keeper.json || { echo "deploy/secrets/keeper.json is missing"; exit 3; }
chmod 600 deploy/secrets/keeper.json
sudo chown 1000:1000 deploy/data deploy/secrets/keeper.json
cd deploy
docker compose up -d --build
sleep 20
docker compose ps
docker compose logs --tail 40
cat data/status.json
CMD
```

## 3. Operate (one `vps.sh run` per check)

```bash
bash /c/Server/twitter_hermes/tools/vps.sh run <<'CMD'
cd /home/openclaw/ftm-sol-keeper/deploy
docker compose ps
docker compose logs --tail 60
cat data/status.json
CMD
```

| Task | Command (in `/home/openclaw/ftm-sol-keeper/deploy`) |
|---|---|
| status | `cat data/status.json` |
| logs | `docker compose logs --tail 200` |
| restart | `docker compose restart` |
| stop | `docker compose stop` (waits up to 40 s for transactions in flight) |
| start again | `docker compose up -d` |

`status.json` is rewritten every second: last round id, last successful action, keeper SOL balance,
house vault available, house budget of the UTC day, current pool and its rung, GeckoTerminal
discovery (tracked pools, candidates, last good refresh, failures), age of the newest price
observation per pool, devnet clock offset. The container health check fails when it is older than
30 s.

Log lines are JSON: one per action, `{"t","round","step","sig"}` or `{"t","round","step","error"}`
with step `create`, `fill`, `strike`, `settle`, `claim`, `sweep`, `close` or `expire`; everything
else carries an `event` field (`pool_selected`, `chain_clock`, `mainnet_rpc_error`, ...).

## Token choice

Once a minute (`src/poolgate.ts`, `src/discovery.ts`, `src/selector.ts`):

- Entry gate: pool 10-120 minutes old, 50+ trades in the last 5 minutes, quote wSOL, owner
  PumpSwap, at least 50 SOL in the quote vault on chain (K x min_bank). Score
  `txM5 * (1 + (120 - age_min) / 120)`: activity, with up to twice the weight for the youngest.
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
  first) every minute and tracks its PumpSwap pools for 180 minutes; `pools/multi` refreshes up to
  30 of them plus the current pool; the PumpSwap top list (pages 1-2 every 5 minutes) feeds the
  ladder. A failed request skips the next 1, 2, 4, then 8 minutes (`pool_discovery_failed`), and
  numbers up to 15 minutes old stay in use meanwhile.
- The tracked set lives in memory. After a restart pools qualify again once they are 10 minutes
  old, so for the first 10 minutes or so the ladder (or the restored pool, if it still passes)
  plays.

Read-only check of the choice on live data (2 GeckoTerminal requests, mainnet reads, no key, no
devnet; it does not race the VPS keeper):

```
node services/keeper/scripts/select-dry-run.ts packages/client/test/fixtures/geckoterminal-new-pools-page1.json
```

## Configuration

Optional `deploy/.env` next to `docker-compose.yml`:

| Variable | Default | Meaning |
|---|---|---|
| `DEVNET_RPC` | `https://api.devnet.solana.com` | devnet RPC for reads and transactions |
| `MAINNET_RPCS` | `https://api.mainnet-beta.solana.com,https://solana-rpc.publicnode.com` | price source RPCs, tried in order with backoff |
| `HOUSE_ROUND_CAP_LAMPORTS` | `50000000` (0.05 SOL) | most the house adds to one round |
| `HOUSE_DAILY_BUDGET_LAMPORTS` | `2000000000` (2 SOL) | most the house adds per UTC day |
| `POOL_OVERRIDE` | empty | force one PumpSwap pool address instead of the GeckoTerminal choice |
| `POOL_MIN_AGE_MIN` | `10` | entry gate: youngest pool age, minutes |
| `POOL_MAX_AGE_MIN` | `120` | entry gate: oldest pool age, minutes (also where the youth bonus ends) |
| `POOL_MIN_TX_M5` | `50` | entry gate: trades in the last 5 minutes |
| `POOL_HOLD_MIN` | `10` | minutes the current pool stays at least |
| `POOL_SWITCH_RATIO` | `1.5` | after the hold, a candidate needs this many times the current score |
| `POOL_KEEP_MIN_TX_M5` | `20` | after the hold, fewer trades in 5 minutes replace the current pool |
| `POOL_KEEP_MAX_AGE_MIN` | `180` | after the hold, an older fresh pool is replaced |

`KEEPER_KEYPAIR=/secrets/keeper.json` and `STATE_FILE=/data/state.json` are set by the image.
RPC URLs may carry API keys: the keeper logs only their host names.

## Run on the laptop instead (cmd.exe)

```
cd C:\Server\memepred_solana
node services\keeper\scripts\status.ts
node services\keeper\src\main.ts
```

It reads the key from `C:\Users\sofia\.flipthememe\keeper.json` and keeps `keeper-state.json` and
`status.json` in `services\keeper` (both ignored by git). Ctrl+C stops it after the transactions in
flight. Stop the VPS container first.

## Costs (keeper wallet)

Measured on devnet on 5 October 2026 (rent there is 5080 lamports per byte including overhead):

- Empty round (nobody bets): create, strike (ends NotActivated), close = 3 fees of 5000 lamports;
  the round rent (0.00184 SOL) comes back on close. 0.0009 SOL per hour.
- Played round: 6 fees (create, house fill, strike, settle, claim, sweep) plus rent that stays on
  chain as history: the round (0.00184 SOL) and the house position (0.00116 SOL), about 0.003 SOL
  per round. The treasury (the keeper key) gets the 2% fee back at the sweep; the house stake
  itself is won or lost inside the house Vault.

## RPC limits

The public devnet RPC rejects bursts with HTTP 429. The keeper keeps at most two transactions in
flight (create and house fill first), polls confirmations every 1.2 s and pauses 4 s after a 429.
A 429 while confirming does not mean the transaction failed: such log lines carry the signature
and `"landed":"unknown"`, and the next tick decides from the chain state. If 429s keep appearing,
set `DEVNET_RPC` to a dedicated devnet endpoint.

## Program upgrade (October 2026): position rent, house limits, price attestor

What changes on chain. Existing accounts keep their layout; old error numbers stay, new ones
are appended (6023 `NotClaimed`, 6024 `HouseRoundCapExceeded`, 6025 `HouseDailyCapExceeded`,
6026 `AttestorRequired`, 6027 `InvalidAttestor`).

- `close_position` (anyone): a claimed position of a Final round closes once its exit window ended
  at least an hour ago; the rent (0.00116 SOL) goes to the owner's wallet. The keeper closes them
  a day after the round (`CLOSE_AFTER_SECS`, default 86400): the app keeps a finished round in the
  phone's history only while it still sees the position on chain.
- `HouseLimits` (`init_house_limits`, `update_house_limits`, admin only): per-round and per-UTC-day
  caps of the house. `house_fill` needs the account and refuses anything above the caps.
- `OracleConfig` (`init_oracle`, `set_oracle`, admin only): the independent price attestor. While
  `required` is true, `set_strike` and `settle` of a matched round need its signature.
  `refund_expired` and claims never need it, so an attestor outage only ends rounds in the usual
  refund. `set_strike` and `settle` need the account even while `required` is false. The admin
  alone may only strengthen it: switching a required attestor off or replacing it needs the
  attestor in office to co-sign (`C:\Users\sofia\.flipthememe\attestor.json`), so a stolen keeper
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

Run nothing of this before Sofia agrees. Commands for cmd.exe from `C:\Server\memepred_solana`,
except the two VPS steps (Git Bash, `vps.sh`, as in section 2).

1. Build and test, check the size, the authority and the money:

   ```
   cd C:\Server\memepred_solana
   set PATH=C:\Users\sofia\.local\agave\3.1.14\bin;%PATH%
   cargo build-sbf --manifest-path programs\flip-the-meme\Cargo.toml
   cargo test --manifest-path programs\flip-the-meme\Cargo.toml
   node --test "packages/client/test/*.test.ts"
   node --test "services/keeper/test/*.test.ts"
   dir target\deploy\flip_the_meme.so
   solana program show 5kUCKYAYxZyaSz18xEajhSDNwdXvVLp2AvBp4LDxWuCz --url devnet
   solana balance --keypair C:\Users\sofia\.flipthememe\keeper.json --url devnet
   solana rent 473805 --url devnet
   ```

   `program show` must list the keeper key as `Authority` and `Data Length: 398296`. Keep a copy
   of the running program for a rollback:

   ```
   solana program dump 5kUCKYAYxZyaSz18xEajhSDNwdXvVLp2AvBp4LDxWuCz C:\Users\sofia\.flipthememe\flip_the_meme-2026-10-05.so --url devnet
   ```

2. Stop new bets, then wait until the last rounds are Final and claimed (about 4 minutes):

   ```
   node services\keeper\scripts\set-pause.ts on
   node services\keeper\scripts\status.ts 6
   ```

3. Stop the keeper on the VPS (Git Bash): the old keeper cannot strike, settle or fill against
   the new program, whose account lists changed.

   ```bash
   bash /c/Server/twitter_hermes/tools/vps.sh run <<'CMD'
   cd /home/openclaw/ftm-sol-keeper/deploy
   docker compose stop
   CMD
   ```

4. Extend the program data account and deploy (the keeper key pays and, this one last time, is
   the upgrade authority):

   ```
   solana program extend 5kUCKYAYxZyaSz18xEajhSDNwdXvVLp2AvBp4LDxWuCz 75472 --keypair C:\Users\sofia\.flipthememe\keeper.json --url devnet
   solana program deploy target\deploy\flip_the_meme.so --program-id 5kUCKYAYxZyaSz18xEajhSDNwdXvVLp2AvBp4LDxWuCz --upgrade-authority C:\Users\sofia\.flipthememe\keeper.json --keypair C:\Users\sofia\.flipthememe\keeper.json --url devnet
   solana program show 5kUCKYAYxZyaSz18xEajhSDNwdXvVLp2AvBp4LDxWuCz --url devnet
   ```

   If the buffer writes stall, repeat the deploy with `--use-rpc`. A deploy that stops half way
   prints how to resume it with `--buffer`; a buffer left behind gives its rent back with
   `solana program close --buffers --keypair C:\Users\sofia\.flipthememe\keeper.json --url devnet`.

5. Move the upgrade authority off the keeper key, which sits on the VPS: a stolen keeper key must
   not be able to replace the program. The new key file never goes to the VPS; keep a backup
   (the seed phrase `solana-keygen` prints, or a copy of the file), because without it the
   program can never be upgraded again.

   ```
   solana-keygen new --no-bip39-passphrase -o C:\Users\sofia\.flipthememe\upgrade.json
   solana program set-upgrade-authority 5kUCKYAYxZyaSz18xEajhSDNwdXvVLp2AvBp4LDxWuCz --new-upgrade-authority C:\Users\sofia\.flipthememe\upgrade.json --upgrade-authority C:\Users\sofia\.flipthememe\keeper.json --keypair C:\Users\sofia\.flipthememe\keeper.json --url devnet
   solana program show 5kUCKYAYxZyaSz18xEajhSDNwdXvVLp2AvBp4LDxWuCz --url devnet
   ```

   Given as a key file, the new authority co-signs, which the CLI checks by default (agave
   3.1.14). `program show` must now list the address of upgrade.json as `Authority`. Every later
   deploy, the rollback below included, uses
   `--upgrade-authority C:\Users\sofia\.flipthememe\upgrade.json`; the keeper wallet still pays
   (`--keypair C:\Users\sofia\.flipthememe\keeper.json`).

6. Create the new accounts (dry run first; both scripts are idempotent):

   ```
   node services\keeper\scripts\init-house-limits.ts --dry-run
   node services\keeper\scripts\init-house-limits.ts
   node services\keeper\scripts\init-oracle.ts --required false
   node services\keeper\scripts\status.ts
   ```

   Defaults: `--round-cap 50000000` (0.05 SOL), `--daily-cap 2000000000` (2 SOL), the keeper's own
   defaults, which now act as a softer limit on top of the chain.

7. Optional, separate keys for the price and house roles (still paused). Make the keys and look
   at the plan; the script prints every amount and sends nothing without `--execute`:

   ```
   solana-keygen new --no-bip39-passphrase --outfile C:\Users\sofia\.flipthememe\price.json
   solana-keygen new --no-bip39-passphrase --outfile C:\Users\sofia\.flipthememe\house.json
   set PRICE_KEYPAIR=C:\Users\sofia\.flipthememe\price.json
   set HOUSE_KEYPAIR=C:\Users\sofia\.flipthememe\house.json
   node services\keeper\scripts\split-roles.ts
   node services\keeper\scripts\split-roles.ts --execute
   ```

   One transaction: withdraw the free house money from the keeper's vault, transfer it plus the
   new vault's rent (0.00094 SOL) plus 0.25 SOL for house position rent (`--house-rent-reserve`)
   to the house key, open its vault, deposit, and `update_config` with the new price authority,
   house authority and `TREASURY` (unset: unchanged). The keeper key stays admin and fee payer.
   Once the attestor is required (step 9), the admin alone cannot switch it off or replace it,
   so a stolen keeper key cannot price rounds alone; it can still pause betting, create rounds
   and change Config. Then upload both files with the next step (add them to the `vps.sh push`
   file list, like keeper.json in the first deploy), move them to `deploy/secrets/` (mounted as a
   whole at `/secrets`, read only) and set `PRICE_KEYPAIR=/secrets/price.json` and
   `HOUSE_KEYPAIR=/secrets/house.json` in `deploy/.env`.

8. Deploy the new keeper (build as in section 1, push as in section 2 "Updates"; it starts the
   container), check `cat data/status.json` for `houseLimits`, `oracle` and `positions`, then
   reopen betting:

   ```
   node services\keeper\scripts\set-pause.ts off
   ```

9. Attestor, once the service runs: put `ATTEST_URL=https://...` and `ATTEST_TOKEN=...` (the same
   value as the Worker's `ATTEST_TOKEN` secret) in `deploy/.env` and recreate the container
   (`docker compose up -d`; `restart` does not read `.env` again), set its public key while not
   yet required, watch `attest_ok` / `attest_refused` for a while, then require it:

   ```
   node services\keeper\scripts\init-oracle.ts --attestor <ATTESTOR_PUBKEY> --required false
   node services\keeper\scripts\init-oracle.ts --required true
   ```

   From then on, switching the attestor off or replacing it needs the attestor in office to
   co-sign with its key file; without `--attestor-keypair` the script refuses before sending:

   ```
   node services\keeper\scripts\init-oracle.ts --required false --attestor-keypair C:\Users\sofia\.flipthememe\attestor.json
   node services\keeper\scripts\init-oracle.ts --attestor <NEW_ATTESTOR_PUBKEY> --attestor-keypair C:\Users\sofia\.flipthememe\attestor.json
   ```

   The keeper sends the attestor nothing but the transaction (`POST /v1/attest`, `{"tx": ...}`,
   with `authorization: Bearer <ATTEST_TOKEN>` when that is set). A missing or wrong token shows
   as `attest_refused` with reason `unauthorized`. While not required, a refusal or an outage is
   logged and the price goes out without it; while required, the step is retried with backoff
   until `settle_deadline`, then the round refunds.

Rollback: deploy the dumped file the same way (step 4, with
`--upgrade-authority C:\Users\sofia\.flipthememe\upgrade.json` once step 5 ran) together with the
previous `dist/keeper.mjs`. The old program ignores the new accounts; the extended size stays.

New environment variables (all optional): `ATTEST_URL`; `ATTEST_TOKEN` (the start line shows only
whether it is set, never its value); `PRICE_KEYPAIR` and `HOUSE_KEYPAIR` (unset: the keeper key);
`CLOSE_AFTER_SECS` (default 86400, never below the program's 3600); `TREASURY` (an address, used
by `split-roles.ts` only).

New log events: `positions_scan` (claimed, closable, lamports, waiting, skipped),
`positions_closed` (positions, lamports, house, rounds, queued, sig), `positions_close_failed`,
`close_batch_shrunk`, `fill_skipped_onchain_cap` (with the caps and today's spend),
`house_limits_missing`, `oracle_missing`, `attest_ok`, `attest_refused` (reason, status),
`attest_failed`, `attestor_required_no_url`, `house_wallet_low`. Strike and settle lines carry
`"attested"` when an attestor is set up. Position closing runs only when nothing else is in
flight, in seconds 3 to 33 of the minute, one transaction of up to 8 closes every 10 s at most,
with a scan of claimed positions every 5 minutes.
