# weclone-server — minimal-RAM Railway deploy (Node 18 alpine, zero native deps)
#
# Multi-stage:
#   stage 1 (build):     install devDeps (typescript) and compile server → dist/
#   stage 2 (web-build): build the React SPA (web/) → public/ (replaces the
#                        dev-time placeholder index.html with the real bundle)
#   stage 3 (runtime):   production deps + dist + built public only

# ---- stage 1: server build ----
FROM node:18-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install --no-audit --no-fund --loglevel=warn
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- stage 2: web SPA build ----
# vite 8 requires Node >= 20 (web/package.json engines: ">=20") — do NOT reuse
# the node:18 base here; the server runtime below stays on 18.
FROM node:22-alpine AS web-build
WORKDIR /app/web
COPY web/package*.json ./
# Lockfile may be absent/stale in web/ — try ci first, fall back to resolve.
RUN (npm ci --no-audit --no-fund --loglevel=warn \
     || npm install --no-audit --no-fund --loglevel=warn) \
 && rm -rf /root/.npm
COPY web/ ./
# vite.config.ts: outDir ../public + emptyOutDir → wipes /app/public placeholder
# and writes index.html + assets there.
RUN npm run build

# ---- stage 3: runtime ----
FROM node:18-alpine
WORKDIR /app
ENV NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=256 \
    UV_THREADPOOL_SIZE=4 \
    WECLONE_DATA_DIR=/data

COPY package*.json ./
# Lockfile may be absent/stale in this directory — try ci first, fall back to resolve.
RUN (npm ci --only=production --no-audit --no-fund --loglevel=warn \
     || npm install --omit=dev --no-audit --no-fund --loglevel=warn) \
 && npm cache clean --force \
 && rm -rf /root/.npm /tmp/*

COPY --from=build /app/dist ./dist
# Built SPA (index.html + assets) served by @fastify/static; NOT the host
# public/ placeholder — that stays dev-only.
COPY --from=web-build /app/public ./public

RUN mkdir -p /data

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT:-8080}/health" || exit 1

CMD ["node", "dist/server.js"]
