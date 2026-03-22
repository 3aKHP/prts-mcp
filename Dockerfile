FROM python:3.11-slim

WORKDIR /app

COPY pyproject.toml .
COPY README.md .
COPY src/ src/
COPY data/ data/

RUN pip install --no-cache-dir .

# If data/ has been pre-bundled into the repository, the image can run without host mounts.
ENV GAMEDATA_PATH=/app/data/gamedata
ENV STORYJSON_PATH=/app/data/storyjson

ENTRYPOINT ["prts-mcp"]
