FROM python:3.11-slim

WORKDIR /app

COPY pyproject.toml .
COPY src/ src/

RUN pip install --no-cache-dir .

# Default mount points for local game data (override via -v)
ENV GAMEDATA_PATH=/data/gamedata
ENV STORYJSON_PATH=/data/storyjson

ENTRYPOINT ["prts-mcp"]
