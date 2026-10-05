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
  Below 50 SOL it is replaced at once. Only rounds created after a switch use the new pool.
- Nothing fresh: the ladder widens the age to 6 h, then 24 h, then takes the most active pool of any
  age. Log events `pool_selected` (rung `fresh`) and `pool_selected_fallback` (rung `within-6h`,
  `within-24h` or `any-age`), plus `pool_kept_on_rung`, `pool_none_qualifies`, `pool_check_failed`.
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
