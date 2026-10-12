# Rust TS-profile image: the shape of ts/Dockerfile (default HTTP on :3000,
# PRTS_MCP_ROOT=/app, bundle at /app/data, 4 volumes) with the native
# binary replacing bun dist. Local tag only — never pushed (docs/09).
FROM ubuntu:24.04

WORKDIR /app

# Native binaries + bundled read-only fallback data + legal notices.
COPY bin/ /app/bin/
COPY data/ /app/data/
COPY NOTICE /app/NOTICE
COPY LICENSE /app/LICENSE

ENV PRTS_MCP_ROOT=/app
ENV PORT=3000

RUN mkdir -p /data/gamedata /data/gamedata-levels /data/storyjson /data/images

EXPOSE 3000

ENTRYPOINT ["/app/bin/prts-mcp-ts-bun"]
