# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.2.0] - 2026-05-14

### Added

- **Story chapter summaries.** Two new tools and one enhancement built on the
  previously-unused `zh_CN/storyinfo.json` index (1,945 entries), plus an
  LLM summarization pipeline in the data-source fork:
  - `get_event_summary(event_id)` — narrative overview of every chapter in an
    event, with chapter codes, tags, names, and summary text. When LLM event
    summaries are available (`zh_CN/event_summaries.json`), a full-dialogue
    V2 synopsis is prepended above the chapter listing.
  - `get_story_summary(story_key)` — single-chapter summary with a three-tier
    fallback chain: LLM long summary (`zh_CN/summaries.json`, 5~7:1 compression),
    official one-liner (`zh_CN/storyinfo.json`), and chapter `storyInfo` field.
  - `list_stories` now accepts `include_summaries` (bool). When `true`, each
    chapter line includes an indented summary below it.
- **LLM summarization pipeline** (`3aKHP/ArknightsStoryJson` fork):
  `scripts/summarize.py` generates per-chapter (5~7:1) and per-event (10:1)
  summaries via DeepSeek V4 Flash API during CI release, injecting them into
  `zh_CN.zip` for transparent consumption by the MCP server.

## [1.1.1] - 2026-05-14

### Fixed

- **`read_prts_page` now returns full page content.** Switched from
  `action=query&prop=extracts` (which strips all template-rendered content)
  to `action=parse&prop=text`. Character pages now return 22K+ chars of
  readable text instead of ~400 chars of empty section headers.
- **`search_prts` restricts to main namespace.** Added `srnamespace=0`
  so search results are no longer polluted by technical data pages from
  other MediaWiki namespaces.
- **Search snippets are cleaned of HTML entities and JSON fragments.**
  Added HTML entity decoding and residual-wikitext cleanup after
  `stripWikitext`.

## [1.1.0] - 2026-05-14

### Added

- **Search tools.** Three new MCP tools provide full-text regex search across
  operator data and story dialogue, enabling exploratory queries without
  knowing exact operator names or story keys upfront:
  - `list_search_scopes` — list searchable data domains and their content types.
  - `search_data(pattern, scope, max_results)` — search operator names,
    descriptions, archive texts, and voice lines.
  - `search_stories(pattern, character, line_type, context_lines, max_results, event_id)`
    — search story dialogue, narration, and choice lines with filtering by
    speaker and line type, plus configurable context lines around each match.

## [1.0.0] - 2026-05-13

### Changed

- **Public tool surface frozen.** The 9 MCP tool names, required parameters,
  and response formats are locked. Automated tests enforce this in CI for
  both Python and TypeScript.
- CI now downloads the storyjson `zh_CN.zip` fixture before running Python
  tests so story integration tests are no longer silently skipped.
- Migration guide expanded with behavioral changes from 0.x: Release archive
  sync, `archives/` cache metadata, `local_repo.jsonc` removal, and
  `story_review_table.json` as a required gamedata file.

### Fixed

- `include_narration=false` in `readStory` now also excludes unnamed speaker
  lines (stage directions displayed as `（旁白）：text`) instead of only
  excluding `type="narration"` sticker/subtitle/animation lines.

## [1.0.0-beta.1] - 2026-05-12

## [1.0.0-alpha.2] - 2026-05-04

### Added

- Post-download zip integrity validation for the storyjson Release asset:
  every chapter referenced by `story_review_table.json` must exist in the
  downloaded zip before it replaces the cached copy. A missing or unreadable
  archive is rejected and falls through the normal `offline_fallback` /
  retry path instead of silently corrupting the local cache. Matches the
  pre-existing Python behavior.

## [1.0.0-alpha.1] - 2026-05-03

### Added

- Added a shared local dataset reader layer with directory, zip, and fallback stores.
- Added dataset specs for GameData excel and story JSON Release assets.
- Added bundled package-data verification for Docker and npm release pipelines.

### Changed

- Operator and story parsers now read through the new store abstraction while preserving
  current MCP tool names, parameters, and output formatting.
- Runtime sync setup now consumes dataset specs instead of repeating Release metadata in
  server startup code.

## [0.3.3] - 2026-05-03

### Fixed

- The HTTP server now starts listening before GameData and story auto-sync run
  in the background, so slow GitHub Release downloads no longer leave systemd
  active while the port is unavailable.

## [0.3.2] - 2026-05-03

### Changed

- ArknightsGameData auto-sync now downloads the `zh_CN-excel.zip` Release asset from
  `3aKHP/ArknightsGameData` and extracts it into the existing `gamedata` layout, aligning
  the game-data and story-data sync paths around GitHub Release archives.
- npm bundled game data is now prewarmed through `python/scripts/fetch_gamedata.py`, using
  the same Release archive as runtime sync instead of downloading raw JSON files directly.
- Package metadata now targets `0.3.2` for this transition release.
- Operator table caches are cleared after startup auto-sync writes updated game data, and
  core operator behavior is covered by Node test-runner smoke tests.

## [0.3.0] - 2026-04-10

### Added

- `GITHUB_MIRRORS` environment variable: comma-separated list of ghproxy-style proxy base URLs
  (e.g. `GITHUB_MIRRORS=https://ghproxy.net`) tried in order after the direct GitHub URL fails,
  enabling auto-sync on servers behind the GFW
- Blind download path in `sync_release`: when the GitHub API is unreachable but mirrors are
  configured and no local data exists, the storyjson zip is fetched via the
  `releases/latest/download/` redirect URL which does not require an API call
- `list_story_events`, `list_stories`, `read_story`, `read_activity` tools for querying
  Arknights story scripts and event metadata from ArknightsStoryJson
- Bundled game data (`data/gamedata/`, `data/storyjson/`) included in the npm package so the
  server starts with offline fallback data without requiring a prior sync
- `config.ts` now resolves data paths relative to `import.meta.url` (package root) so bundled
  paths work correctly for both npm installs and Docker

### Fixed

- `story_review_table.json` added to bundled data and `cache_meta.json`; was missing after the
  story feature added it to `REQUIRED_OPERATOR_FILES`, causing `filesComplete()` to always return
  false for the bundled path
- Dead code (`STORYINFO` constant) removed; unused import dropped; null role format aligned with
  Python implementation

## [0.2.0] - 2026-04-08

### Added

- `get_operator_basic_info` tool exposing operator rarity, class, faction, and description from
  `character_table.json`
- Streamable HTTP transport (MCP 2025-03-26 spec) replacing the earlier SSE-based approach;
  endpoint at `/mcp`, health check at `/health`
- Docker image for self-hosted HTTP server deployment
- npm package (`prts-mcp-ts`) for `npx` / global install usage
- GitHub Actions CD workflow (`cd-ts.yml`) publishing to npm with Trusted Publishing and pushing
  Docker image to GHCR

## [0.1.0] - 2026-03-18

### Added

- FastMCP TypeScript server with 4 tools: `search_prts`, `read_prts_page`,
  `get_operator_archives`, `get_operator_voicelines`
- PRTS MediaWiki API integration with rate limiting and custom User-Agent
- Local ArknightsGameData JSON reader with LRU caching
- Wikitext sanitizer for stripping templates, file links, and HTML tags
