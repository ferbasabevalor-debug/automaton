# Conway Automaton — container image for hosted deploys (Railway, Docker).
#
# The agent's state (wallet private key, database, config) lives in
# $HOME/.automaton. HOME is set to /data so that a persistent volume mounted
# at /data keeps the wallet across redeploys. See RAILWAY.md.

FROM node:22-bookworm-slim

# Build tools for better-sqlite3 (native module); git for state versioning.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN corepack enable

# Install dependencies first (better layer caching).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/cli/package.json packages/cli/package.json
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

ENV NODE_ENV=production \
    HOME=/data \
    AUTOMATON_NONINTERACTIVE=true
RUN mkdir -p /data

CMD ["node", "dist/index.js", "--run"]
