# Safelight web (Next.js) — multi-stage build.
#
# Build:  docker build -t safelight-web ./web
# Run:    docker run -p 3001:3001 -v safelight-data:/data safelight-web
#
# The image contains only the Next.js standalone output plus the traced
# node_modules (better-sqlite3, sharp, pino stay real packages because of
# `serverExternalPackages`). It runs as the non-root `node` user and keeps
# all mutable state under /data (SAFELIGHT_DATA_DIR).

# ---------- Stage 1: install dependencies ----------
FROM node:22-slim AS deps
# better-sqlite3 falls back to a source build when no prebuilt binary matches;
# sharp may do the same. Both build-script allowances are pinned in
# pnpm-workspace.yaml (onlyBuiltDependencies).
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# The repo's pnpm-workspace.yaml ships a literal placeholder
# (`better-sqlite3: set this to true or false` under allowBuilds), which pnpm
# treats as "not allowed" and fails the install with ERR_PNPM_IGNORED_BUILDS.
# Fix the copy inside the image only; the repo file should be fixed upstream.
RUN sed -i 's/better-sqlite3: set this to true or false/better-sqlite3: true/' pnpm-workspace.yaml \
 && pnpm install --frozen-lockfile

# ---------- Stage 2: build ----------
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Same placeholder fix as the deps stage: `pnpm build` re-runs a deps-status
# install against the freshly copied workspace file and would fail otherwise.
RUN sed -i 's/better-sqlite3: set this to true or false/better-sqlite3: true/' pnpm-workspace.yaml
# NEXT_PUBLIC_* values are inlined into the client bundle at BUILD time.
# The browser opens this WebSocket itself, so for LAN use it must point at
# the ComfyUI port as reachable FROM THE BROWSER (e.g. ws://192.168.1.10:8188),
# not at the compose-internal hostname.
ARG NEXT_PUBLIC_COMFY_WS=ws://127.0.0.1:8188
ENV NEXT_PUBLIC_COMFY_WS=$NEXT_PUBLIC_COMFY_WS
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# ---------- Stage 3: runtime ----------
FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3001 \
    HOSTNAME=0.0.0.0 \
    SAFELIGHT_DATA_DIR=/data \
    COMFY_OUTPUT_DIR=/outputs \
    COMFY_INPUT_DIR=/inputs
WORKDIR /app
# Standalone server + traced node_modules, static assets, and public files.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
# Mutable state lives outside the image. /data holds the SQLite DB and the
# encrypted key vault; /outputs and /inputs are shared with ComfyUI.
RUN mkdir -p /data /outputs /inputs && chown node:node /data /outputs /inputs
VOLUME /data
USER node
EXPOSE 3001
# node:22-slim has no curl; use Node's own fetch for the healthcheck.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
