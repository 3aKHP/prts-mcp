# Rust GHCR-profile image: the shape of python/Dockerfile (default stdio;
# PRTS_TRANSPORT=trim/lower selects HTTP; PORT parsed with python int()
# semantics, exit 1 on non-numeric). Local tag only (docs/09).
FROM ubuntu:24.04

WORKDIR /app

COPY bin/ /app/bin/
COPY data/ /app/data/
COPY NOTICE /app/NOTICE
COPY LICENSE /app/LICENSE
COPY THIRD-PARTY-NOTICES.txt /app/THIRD-PARTY-NOTICES.txt

ENV PRTS_MCP_ROOT=/app

RUN mkdir -p /data/gamedata /data/gamedata-levels /data/storyjson /data/images

# stdio by default — MCP client spawns; PRTS_TRANSPORT=http for HTTP.
ENTRYPOINT ["/app/bin/prts-mcp"]
