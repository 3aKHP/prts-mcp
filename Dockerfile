# Distribution context is prepared and verified by tools/docker/build.mjs.
# The source-build development recipe is packaging/docker/Dockerfile.source.
FROM ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY native-payload/ /app/
COPY bundle/ /app/data/
RUN chmod -R a+rX /app && mkdir -p /data/gamedata /data/gamedata-levels /data/storyjson /data/images
ENV PRTS_MCP_ROOT=/app
USER 0:0
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/app/bin/prts-mcp-ghcr"]
