FROM node:22-alpine AS builder

WORKDIR /build

# Install dependencies first (layer cache)
COPY ts/package.json ts/package-lock.json ./
RUN npm ci --ignore-scripts

# Compile TypeScript
COPY ts/tsconfig.json ./
COPY ts/src/ src/
RUN npx tsc

# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

WORKDIR /app

# Production dependencies only
COPY ts/package.json ts/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Compiled JS
COPY --from=builder /build/dist ./dist

# Bundled game data baked in at build time (pre-fetched by CI via
# python/scripts/fetch_gamedata.py or ts equivalent).
# Serves as a read-only offline fallback when /data/gamedata has no data yet.
COPY data/ data/

# Tell config.ts we are running inside Docker so it uses /data/gamedata
# (the volume mount-point) as the auto-sync target.
ENV PRTS_MCP_ROOT=/app
ENV PORT=3000

# Create the volume mount-point as an empty directory.
RUN mkdir -p /data/gamedata /data/storyjson

EXPOSE 3000

ENTRYPOINT ["node", "dist/server.js"]
