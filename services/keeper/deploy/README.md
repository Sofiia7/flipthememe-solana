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
push the previous `dist/keeper.mjs` the same way.

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
house vault available, house budget of the UTC day, current pool, age of the newest price
observation per pool, devnet clock offset. The container health check fails when it is older than
30 s.

Log lines are JSON: one per action, `{"t","round","step","sig"}` or `{"t","round","step","error"}`
with step `create`, `fill`, `strike`, `settle`, `claim`, `sweep`, `close` or `expire`; everything
else carries an `event` field (`pool_selected`, `chain_clock`, `mainnet_rpc_error`, ...).

## Configuration

Optional `deploy/.env` next to `docker-compose.yml`:

| Variable | Default | Meaning |
|---|---|---|
| `DEVNET_RPC` | `https://api.devnet.solana.com` | devnet RPC for reads and transactions |
| `MAINNET_RPCS` | `https://api.mainnet-beta.solana.com,https://solana-rpc.publicnode.com` | price source RPCs, tried in order with backoff |
| `HOUSE_ROUND_CAP_LAMPORTS` | `50000000` (0.05 SOL) | most the house adds to one round |
| `HOUSE_DAILY_BUDGET_LAMPORTS` | `2000000000` (2 SOL) | most the house adds per UTC day |
| `POOL_OVERRIDE` | empty | force one PumpSwap pool address instead of the GeckoTerminal choice |

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
