# FlipTheMeme keeper (devnet). Build context: services/keeper, which .dockerignore narrows to
# dist/keeper.mjs (build it first: corepack pnpm --filter @flipthememe/keeper run build).
FROM node:22-alpine

ENV KEEPER_KEYPAIR=/secrets/keeper.json \
    STATE_FILE=/data/state.json \
    NODE_OPTIONS=--max-old-space-size=160

WORKDIR /app
COPY dist/keeper.mjs /app/keeper.mjs
RUN mkdir -p /data && chown node:node /data

# Unprivileged user of the official image (uid 1000): it must own ./data and be able to read
# ./secrets/keeper.json on the host.
USER node

# status.json is rewritten every second; older than 30 s means the scheduler loop is stuck.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "const s=JSON.parse(require('fs').readFileSync('/data/status.json','utf8'));process.exit(Date.now()-Date.parse(s.updatedAt)<30000?0:1)"

CMD ["node", "/app/keeper.mjs"]
