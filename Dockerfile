# Distribution context is prepared and verified by tools/docker/build.mjs.
# The source-build development recipe is packaging/docker/Dockerfile.source.
FROM ubuntu:25.10@sha256:7cc5e35f6567ee8c66d2abb4aab0fd866669e6207c237c3a8f0947a5c7f17092
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY native-payload/ /app/
COPY bundle/ /app/data/
RUN chmod -R a+rX /app && mkdir -p /data/gamedata /data/gamedata-levels /data/storyjson /data/images /data/database
ENV PRTS_MCP_ROOT=/app
USER 0:0
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/app/bin/prts-mcp-ghcr"]
