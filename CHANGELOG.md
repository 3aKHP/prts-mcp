# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - TBD

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
