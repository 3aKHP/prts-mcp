FROM python:3.11-slim

WORKDIR /app

COPY python/pyproject.toml .
COPY README.md .
COPY python/src/ src/
# Bundled game data baked in at build time (pre-fetched by CI via
# python/scripts/fetch_gamedata.py).  Serves as a read-only offline fallback
# when /data/gamedata (the volume mount-point) has no data yet.
COPY data/ data/

RUN pip install --no-cache-dir .

# Tell config.py we are running inside Docker so it uses /data/gamedata
# (the volume mount-point) as the auto-sync target instead of the
# per-user data directory.
ENV PRTS_MCP_ROOT=/app

# Create the volume mount-point as an empty directory.  Docker will
# populate it with the named-volume or bind-mount contents at runtime;
# if no volume is attached it remains writable by the container so
# auto-sync can still write data here (data lost on container removal).
RUN mkdir -p /data/gamedata /data/storyjson

ENTRYPOINT ["prts-mcp"]
