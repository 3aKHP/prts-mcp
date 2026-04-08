FROM python:3.11-slim

WORKDIR /app

COPY pyproject.toml .
COPY README.md .
COPY src/ src/
# data/ is pre-populated by scripts/fetch_gamedata.py in CI before docker build.
# The bundled files serve as the offline fallback baseline; at runtime the server
# checks GitHub for updates and refreshes them if a newer commit is available.
COPY data/ data/

RUN pip install --no-cache-dir .

# Tell config.py where the project root is (needed when the package is installed
# via pip and __file__ resolves inside site-packages rather than /app/src/).
ENV PRTS_MCP_ROOT=/app

ENTRYPOINT ["prts-mcp"]
