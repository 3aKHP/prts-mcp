# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Bounded retry loop for startup sync: `offline_fallback` and `no_data`
  results schedule daemon-thread retries at 30s, 120s, and 600s before
  giving up until the next process start. Matches the existing TypeScript
  behavior so both implementations recover from transient network failures
  without manual restart.

## [1.0.0-alpha.1] - 2026-05-03

### Added

- Added a shared local dataset reader layer with directory, zip, and fallback stores.
- Added dataset specs for GameData excel and story JSON Release assets.
- Added bundled package-data verification for Docker and npm release pipelines.

### Changed

- Operator and story parsers now read through the new store abstraction while preserving
  current MCP tool names, parameters, and output formatting.
- Runtime sync setup now consumes dataset specs instead of repeating Release metadata in
  server startup code and prewarm scripts.

## [0.4.2] - 2026-05-03

### Changed

- ArknightsGameData auto-sync now downloads the `zh_CN-excel.zip` Release asset from
  `3aKHP/ArknightsGameData` and extracts it into the existing `gamedata` layout, aligning
  the game-data and story-data sync paths around GitHub Release archives.
- `fetch_gamedata.py` now prewarms bundled game data from the same Release archive instead
  of downloading individual raw JSON files.
- Python operator-data completeness now requires `story_review_table.json`, matching the
  TypeScript implementation and the new full-excel archive.
- Operator data config is re-resolved on each tool call, and table caches are cleared after
  startup auto-sync writes updated game data.
- Added regression coverage for data becoming available later in the same process.

## [0.4.0] - 2026-04-25

### Added

- `GITHUB_MIRRORS` environment variable: comma-separated list of ghproxy-style proxy base URLs
  (e.g. `GITHUB_MIRRORS=https://ghproxy.net`) tried in order after the direct GitHub URL fails,
  enabling auto-sync on servers behind the GFW
- Blind download path in `sync_repo` and `sync_release`: when the GitHub API is unreachable but
  mirrors are configured and no local data exists, files are fetched directly via mirrors without a
  prior SHA check; storyjson uses the `releases/latest/download/` redirect URL which does not
  require an API call

### Changed

- `download_files` replaced shared `httpx.Client` with per-file `_get_cascading` calls to enable
  independent mirror cascade per file

## [0.2.2] - 2026-04-10

### Changed

- Repository restructured as a monorepo: Python implementation moved to `python/` subdirectory, shared game data resides in `data/gamedata/` at the repo root. No functional changes to the package itself.

### Fixed

- `fetch_gamedata.py` and `package_operator_data.py` path resolution updated for the new `python/` subdirectory location
- Docker build context updated to repo root so `COPY data/` correctly bundles game data into the image

## [0.2.1] - 2026-04-14

### Added

- Bundled operator data files (`data/gamedata/zh_CN/gamedata/excel/*.json`) now committed to the repository and baked into the Docker image at build time, serving as a read-only offline fallback when the volume has no data yet

### Changed

- Data path architecture split into two independent roots: `/data/gamedata` (volume, auto-sync write target) and `/app/data/gamedata` (bundled, read-only fallback inside Docker); `config.py` resolves the effective read path by preferring the volume when its files are present, falling back to bundled otherwise
- `_DEFAULT_GAMEDATA_PATH` inside Docker now fixed to `/data/gamedata` (the volume mount-point) instead of being derived from `PRTS_MCP_ROOT`; outside Docker retains the per-user data directory fallback
- Auto-sync skip condition changed from path comparison to `is_custom_gamedata` flag: sync is disabled only when `GAMEDATA_PATH` is explicitly set by the user, regardless of the path value
- `Config` dataclass gains `is_custom_gamedata: bool` and `effective_excel_path: Path | None` fields; `has_operator_data` now reflects both the volume path and the bundled fallback
- Operator tool error message updated to indicate that auto-sync may still be in progress, rather than asking the user to set `GAMEDATA_PATH`
- Dockerfile creates `/data/gamedata` and `/data/storyjson` as empty directories (volume mount-points)
- Recommended Docker invocation updated to include a named volume: `docker run -i --rm -v prts-mcp-data:/data/gamedata prts-mcp`
- `.mcp.example.json`, `docker-compose.override.example.yml`, `README.md`, `CONTRIBUTING.md`, and `docs/deployment.md` updated to reflect the new volume-first workflow
- CI verify assertions updated to match the new error message prefix

### Fixed

- Volume-mounted data directory was silently ignored when `GAMEDATA_PATH` was not set; the server now correctly uses `/data/gamedata` as the sync target inside Docker without requiring the user to set any environment variable
- Raw `[Errno 2] No such file or directory` propagated to MCP clients when operator data files were missing; now caught and returned as a human-readable message

### Removed

- `PRTS_MCP_ROOT`-based data root resolution no longer drives the sync write path (retained only as a Docker/non-Docker environment marker)

## [0.2.0] - 2026-04-08

### Added

- GitHub-backed operator data sync via `src/prts_mcp/data/sync.py`, including upstream SHA checks, TTL-based cache reuse, atomic file replacement, and offline fallback behavior
- `scripts/fetch_gamedata.py` for prewarming the minimal operator dataset in CI, local development, and image-build workflows
- Optional `GITHUB_TOKEN` support for GitHub API requests to reduce anonymous rate-limit risk
- Docker/CI smoke-test coverage for the containerized MCP server, including a protocol-correct MCP initialize handshake
- Contributor-facing repository policy in `CONTRIBUTING.md`

### Changed

- Default data flow now prefers auto-sync of the minimal required operator files instead of relying on `local_repo.jsonc` or manual packaging as the primary workflow
- Installed-path data resolution now falls back more safely across Docker, editable installs, and user data directories
- Server startup no longer blocks the main thread on data sync; startup refresh runs in a background daemon thread
- CI now validates the newer data/bootstrap path and image workflow more explicitly
- `README.md` and `CONTRIBUTING.md` updated to remove `local_repo.jsonc` / `local_repo.example.jsonc` references and reflect the auto-sync-first workflow
- `docs/deployment.md` rewritten to describe auto-sync as the default; now provides parallel Windows (PowerShell) and Linux/macOS examples for volume mounts; environment-variable reference table updated with `GITHUB_TOKEN` and `PRTS_MCP_ROOT`
- `.mcp.example.json` simplified to the default auto-sync invocation; local-path override examples moved to `docs/deployment.md`
- `.env.example` updated to reflect current env var set with blank defaults and `GITHUB_TOKEN` entry
- `docker-compose.override.example.yml` cleaned up: removed unused `STORYJSON_PATH` volume, added `GITHUB_TOKEN` passthrough, added Windows path format comment

### Fixed

- `local_repo.jsonc` re-added to `.gitignore`; the previous refactor had inadvertently removed it, leaving the file exposed to accidental staging

### Removed

- `local_repo.example.jsonc` deleted — the file had no reader code and was no longer referenced by any documentation or tooling

### Deprecated

- `scripts/package_operator_data.py` is retained only as a compatibility path and is no longer the recommended primary workflow

## [0.1.0] - 2026-03-18

### Added

- FastMCP server with 4 tools: `search_prts`, `read_prts_page`, `get_operator_archives`, `get_operator_voicelines`
- PRTS MediaWiki API integration with rate limiting and custom User-Agent
- Local ArknightsGameData JSON reader with LRU caching (character_table, handbook_info_table, charword_table)
- Wikitext sanitizer for stripping templates, file links, and HTML tags
- Config module with env var / local_repo.jsonc fallback
- Dockerfile for stdio-based containerized deployment
- Project metadata via pyproject.toml (PEP 621)
