# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [2.0.0] - 2026-07-03

### Added

- **Output channel design replaces the per-call `output_format` parameter
  (2.0 design decision).** The original roadmap proposed an optional
  `output_format=markdown|json` parameter with 2.0 flipping the default to
  `json`. **That shape was rejected during design.** The primary consumer is an
  LLM agent, and JSON inflates prompt tokens ~15–30% versus markdown — which
  would negate the context-budget savings the tool-surface consolidation
  delivers. 2.0 instead keeps markdown as the always-on `content` text and
  carries structured data on MCP's native `structuredContent` field, selected
  by a **connection-level** `output_channel` knob (`content` (default) /
  `structured` / `both`) via the `PRTS_OUTPUT_CHANNEL` env var. The default is
  **not** flipped to JSON. See [`docs/migration-1.x-to-2.0.md`](../docs/migration-1.x-to-2.0.md)
  for the per-tool channel mapping and client configuration.
- **Output channel (2.0).** Optional structured-content delivery via MCP's
  native `structuredContent` channel, controlled by a connection-level
  `PRTS_OUTPUT_CHANNEL` env var (`content` (default) / `structured` / `both`).
  The default `content` channel preserves the human-readable markdown content
  for clients that only consume MCP `content`. Migrated tools intentionally
  change the MCP manifest/wire shape by replacing FastMCP's automatic
  `outputSchema={result:string}` plus `structuredContent={"result": markdown}`
  wrapper with explicit `CallToolResult` delivery, so capable clients no
  longer receive duplicate markdown unless `both` is selected. `list_stages`
  is the pilot tool; its `structuredContent` carries both raw enums (e.g.
  `type=ACTIVITY`) and rendered labels (`type_label=活动`), and legitimate empty
  pages (filter no-match / offset past end) return structured empty payloads
  while preserving the original markdown text. The remaining structural tools
  and the TypeScript implementation follow in subsequent commits. Note:
  `structured` mode is intended for deployments known to use a
  structuredContent-capable client — an incapable client (e.g. Chatbox)
  receives only a one-line summary, so leave the default `content` unless the
  client is confirmed capable.
- **Narrative-tool wire slimming (2.0).** The six narrative/prose tools
  (`get_operator_archives`, `get_operator_voicelines`, `read_story`,
  `read_activity`, `get_story_summary`, `prts_page`) migrated from `-> str`
  to explicit `CallToolResult` delivery via the new `text_result(markdown)`
  helper. Their content text is unchanged, but they no longer derive
  FastMCP's automatic `outputSchema` nor emit a duplicate
  `structuredContent={"result": markdown}` — narrative output has no useful
  structured form. The remaining structural tools keep their structured
  payloads behind `output_channel`.
- **Detail-tool structuredContent (2.0, P2b PR1).** The four detail tools
  (`get_operator_basic_info`, `get_enemy_info`, `get_stage_info`,
  `get_item_info`) migrated to the build/render split with real
  `structuredContent` payloads. `render_result` gains an optional `summary`
  override so detail tools (single-record, no `total`) can provide a
  meaningful one-liner in `structured` mode instead of the generic fallback.
  Their `structuredContent` carries both raw enums and rendered labels
  (e.g. `profession_raw=CASTER` + `profession=术师`), so downstream
  automation can filter on raw values while Chinese consumers get
  localized text.
  The list/fusion tools (`list_enemies`, `search`, …) and the `search`
  consolidation follow in P2b PR2/PR3.
- **Gamedata list/fusion structuredContent (2.0, P2b PR2a).** The four
  gamedata list/fusion tools (`list_enemies`, `list_items`,
  `get_stage_enemies`, `get_enemy_appearances`) migrated to the build/render
  split with real structuredContent. Listing payloads carry pagination
  metadata + filters (raw user input + normalized filter) + entries with
  chainable IDs and raw/label field pairs; the fusion tool
  (`get_stage_enemies`) carries per-enemy spawn counts, level, overwrite
  flag, and stats text. **Empty-result contract**: legitimate-but-empty
  results (filter no-match, offset past end) now return a structured
  payload `{total:0, entries:[]}` that the structured channel carries,
  while the content channel still emits the original human message
  verbatim — so structured consumers can uniformly rely on
  "empty ⇒ {total:0}". True errors (invalid params, missing data) stay
  content-only. The story-list/wiki-search tools and the heterogeneous
  `search` follow in P2b PR2b/PR3.
- **Story navigation and wiki-search structuredContent (2.0, P2b PR2b).**
  The six story/wiki navigation tools (`list_story_events`, `list_stories`,
  `get_operator_memoirs`, `find_character_appearances`, `find_speakers_in`,
  `search_prts`) migrated to explicit `CallToolResult` delivery with
  build/render payloads. Story payloads carry chainable event/story IDs,
  raw story entry tags, and boolean speaks/mentioned flags; `search_prts`
  now exposes `total` as MediaWiki `totalhits`, which can exceed the returned
  page of results. Legitimate empty results carry `{total:0}` on the
  structured channel while preserving the existing markdown text; invalid
  parameters, missing story data, and PRTS network failures remain content-only.
- **Search structuredContent (2.0, P3).** The remaining Python search tools
  (`search` and `search_stories`) migrated to explicit `CallToolResult`
  delivery with structured search envelopes. `search` now returns a stable
  outer envelope (`scope`, `pattern`, `total`, `results`) while keeping
  scope-specific entries for operators, enemies, stages, and items; each entry
  carries chainable IDs and the fields needed to re-render the existing
  markdown cards. `search_stories` now exposes raw filters and structured
  context lines with `is_match` flags plus `story_key` for follow-up reads.
  Legitimate no-match searches carry `{total:0, results:[]}` on the structured
  channel; invalid regexes, invalid filters, and missing data remain
  content-only. The all-tool outputSchema invariant is left to the dedicated
  PR4 test-layer follow-up.

### Changed

- **Parameter naming normalization (2.0, breaking).** Operator tools
  (`get_operator_archives`, `get_operator_voicelines`, `get_operator_basic_info`,
  `get_operator_memoirs`) now take `name` instead of `operator_name`, matching
  the `name` convention already used by the enemy/stage/item/character tools.
- **Unified search (2.0, breaking).** `search_data`, `search_enemies`,
  `search_stages`, and `search_items` are consolidated into a single
  `search(scope, pattern, max_results)` tool with a required `scope` enum
  (`operators` / `enemies` / `stages` / `items`). Story dialogue search remains a
  separate `search_stories` (its filters differ). Tool surface drops 32 → 28.
- **Unified PRTS page tool (2.0, breaking).** `read_prts_page`,
  `list_prts_sections`, `get_prts_categories`, `get_prts_links`, and
  `get_prts_template` are consolidated into a single `prts_page(page_title,
  action, ...)` tool with a required `action` enum (`read` / `sections` /
  `categories` / `links` / `template`). Wiki keyword search remains a separate
  `search_prts`. Tool surface drops 28 → 24.
- **`list_stories` absorbs the event-level summary (2.0, breaking).**
  `list_stories(event_id, include_summaries=True)` now prepends the event's LLM
  overview (from `event_summaries.json`) when present, on top of the per-chapter
  one-liners it already returned — making it a superset of the former
  `get_event_summary`. Tool surface drops 24 → 23.
- **Tool descriptions standardized (2.0).** All tool descriptions were rewritten
  to a consistent house style (verb-first purpose, output-shape note, at most one
  cross-reference, parameter semantics kept in the parameter schema) and trimmed
  ~20% to reduce context budget on smaller-context models. No change to tool
  names, parameters, or output format.

### Removed

- **`search_data`, `search_enemies`, `search_stages`, `search_items`,
  `list_search_scopes` (2.0, breaking).** Replaced by unified `search(scope, ...)`;
  the scope catalogue previously returned by `list_search_scopes` is folded into
  the `search` tool description.
- **`read_prts_page`, `list_prts_sections`, `get_prts_categories`,
  `get_prts_links`, `get_prts_template` (2.0, breaking).** Replaced by unified
  `prts_page(page_title, action, ...)`.
- **`get_event_summary` (2.0, breaking).** Folded into
  `list_stories(include_summaries=True)`; `get_story_summary` (single-chapter
  deep summary) is unchanged.

## [1.7.0] - 2026-07-02

1.7.0 is the final 1.x feature release and the 1.7 LTS baseline. Future 1.7.x updates are limited to compatibility, security, data-sync, and critical bug fixes.

### Added

- **Story character tracking.** Two new tools reuse the existing story search
  index (no new data source): `find_character_appearances(name, scope?,
  max_events?)` returns chapters where a character **speaks** (dialog role
  exact match) or is **mentioned** (name substring in any line text);
  `find_speakers_in(event_id)` lists every speaker in an event with dialog
  line counts. Brings the tool surface to 32.

### Changed

- **Module split: story and server god files.** `data/story.py` (916 lines) and
  `server.py` (914 lines) were split into focused submodules to meet the
  STYLE.md file-size guideline (~300 lines). `story.py` is now a re-export shim
  over `story_reader`, `story_search`, `story_memoir`, and `story_summary`.
  `server.py` is now a ~60-line entry point that delegates tool registration to
  `tools_prts`, `tools_gamedata`, and `tools_story`, and sync orchestration to
  `startup_sync`. All public symbols are re-exported — no behaviour change.
- **Dead code removal in sync.** The original GitHub raw file sync path
  (`sync_repo`, `download_files`, `check_upstream_sha`, `sync_all`) had no
  external callers and has been removed. `sync.py` shrank from 626 to 479 lines.
  Shared symbols (`CacheMeta`, `SyncResult`, `RepoSpec`, `GAMEDATA_FILES`)
  are retained for the Release-based sync path.

## [1.6.1] - 2026-06-03

### Added

- **Operator memoir discovery.** New `get_operator_memoirs(operator_name)` tool
  resolves operator Chinese name to memoir story keys via `chardict.json`,
  enabling LLM agents to find and read operator memoir (干员密录) dialogue.
- This new tool is treated as a one-off patch-line exception because it exposes
  story data that already existed in the synced StoryJson archive but was not
  discoverable through the public tool surface.
- `list_story_events(category="memoirs")` now exposes 372 previously hidden
  operator memoir events.
- Operator memoir dialogue is now indexed by `search_stories`.

### Changed

- Search tools backed by local game/story data now reuse cached search records
  instead of rebuilding parsed text on every call, substantially improving
  repeated full-story and full-table regex searches.
- Enemy search records now include `enemyTags` in searchable text.

### Fixed

- Story search now caps `max_results` and `context_lines` consistently to
  prevent oversized MCP responses from long-running full-dataset searches.
- `search_stages` and `search_items` now enforce `max_results` bounds (1–100)
  for parity with other search tools.
- `list_story_events` and `search_stories` no longer ignore entries with
  `entryType: "NONE"` when those entries have valid story data (was the
  root cause of memoirs being undiscoverable).

## [1.6.0] - 2026-05-28

### Added

- **Item/material data domain.** Three new tools — `list_items`,
  `get_item_info`, and `search_items` — read `item_table.json` to expose
  material/item lists, details, obtain methods, stage drops, production, and
  shop/voucher links.
- **Stage/enemy cross-source fusion.** Added `get_stage_enemies(stage_id)` and
  `get_enemy_appearances(name, limit, offset)` backed by `zh_CN-levels.zip`.
  `get_enemy_info(name)` now accepts optional `stage_id` for stage-specific
  enemy levels and overwritten combat stats while preserving the default
  handbook behavior.
- Tool surface expanded from 24 to 29. `list_search_scopes` now includes the
  items domain.
- Runtime data sync now handles three datasets: `zh_CN-excel.zip`,
  `zh_CN-levels.zip`, and story `zh_CN.zip`. Docker images prewarm
  `data/gamedata-levels` alongside existing bundled fallback data.

### Changed

- Stage drop formatting now resolves item IDs through `item_table.json` when
  available, e.g. `招聘许可（7001）`.
- `fetch_gamedata.py` now prewarms both the excel and levels Release archives;
  `check_package_data.py` verifies bundled level data before packaging.

### Fixed

- **Release archive validation.** Archive sync validates required zip entries
  before extraction and rechecks required files after extraction, so a partial
  or corrupt `zh_CN-levels.zip` cannot be logged as healthy data.
- **Enemy appearance lookup memory profile.** `get_enemy_appearances` now scans
  for the requested enemy instead of permanently caching an all-enemy
  appearance index on first use.
- **ZipStore lifecycle hardening.** `ZipStore` now supports explicit
  `close()` and context-manager use. Zip-path story helpers close their
  transient stores after each call, avoiding lingering `ZipFile` handles in
  repeated story reads/searches.

## [1.5.0] - 2026-05-25

### Added

- **Stage data domain.** Three new tools — `list_stages`, `get_stage_info`,
  `search_stages` — sourced from `stage_table.json` (3319 stages) and
  `zone_table.json` (434 zones) in ArknightsGameData. `list_stages` supports
  zone and stage-type filters with pagination; `get_stage_info` returns
  detailed per-stage data (drops, unlocks, related variants); `search_stages`
  performs regex search across names, codes, descriptions, and types.
- Tool surface expanded from 21 to 24. `list_search_scopes` updated with
  stages and enemies entries.
- `stage_table.json` and `zone_table.json` added to sync manifests for
  integrity validation.

## [1.4.2] - 2026-05-25

### Changed

- **Version sync with TS 1.4.2.** No Python-side changes — the session pool
  fix in this release applies only to the TypeScript Streamable HTTP transport.
  Python's stdio transport is not affected by the stale-session issue.

## [1.4.1] - 2026-05-19

### Fixed

- **ZipStore zip instance caching.** `ZipFile` is now cached instead of
  re-opened on every `exists()`/`read_text()` call. `exists()` switches
  from O(n) `namelist()` to O(1) `getinfo()`. In `search_stories` without
  an `event_id` filter this was ~3000 redundant zip opens, exceeding the
  120 s MCP client timeout.
- **HTTP client reuse.** Module-level shared `httpx.AsyncClient` replaces
  per-call instantiation (7 call sites), recovering connection pooling and
  avoiding repeated TLS handshakes.
- **Rate limiter race condition.** Slot-based reservation scheme (matching
  the TS implementation) replaces the check-then-act pattern that could
  allow concurrent coroutines to exceed the configured rate.
- **Parsetree `.tail` preservation.** Text after nested `<comment>` and
  `<template>` elements in title/value extraction is now preserved instead
  of silently dropped.
- **Story search robustness.** `read_activity` gains `page >= 1` validation.
  Exception handling in `search_stories` and `read_activity` narrowed from
  bare `except Exception` to expected error types. Convenience wrappers
  (`search_stories`, `get_event_summary`, `get_story_summary`) now use
  `_story_store()` for consistency.
- **API error semantics.** `ValueError` replaced with `RuntimeError` for
  MediaWiki API errors, matching the Python exception hierarchy convention.

### Added

- **E2E test suite.** MCP protocol-level test (`test_e2e.py`) covering
  handshake, tool surface (all 21 tools), operator data, and graceful
  degradation when optional data is unavailable.

## [1.4.0] - 2026-05-19

### Added

- **PRTS template data extraction.** `get_prts_template(page_title)` returns
  structured key-value data from MediaWiki template calls on a page. Supports
  `CharinfoV2` (operator), `敌人信息/common2` (enemy), `道具信息` (item), and
  other name=value pattern templates via `action=parse&prop=parsetree`. Only
  top-level templates are returned; nested templates inside a value are
  stripped from the value text.
- **Enemy handbook tools.** Three new tools backed by `enemy_handbook_table.json`
  with optional combat-stats merge from `levels/enemydata/enemy_database.json`:
  - `list_enemies(threat_level, limit, offset, full)` — paginated listing
    with optional filter by `boss` / `elite` / `normal`. Defaults to first 50
    entries; `full=true` returns all 1500+ entries (discouraged for normal use).
  - `get_enemy_info(name)` — handbook entry merged with full combat stats:
    HP / ATK / DEF / RES, attack interval, mass level, status immunities, and
    skill list with cooldowns and blackboard parameters.
  - `search_enemies(pattern, max_results)` — regex search across enemy
    names, descriptions, and ability text.

## [1.3.1] - 2026-05-19

### Fixed

- **Operator name-to-ID collision.** `_build_name_to_id()` in `operator.py` now
  filters to `char_*` entries only, preventing `trap_*` and `token_*` entries from
  silently overwriting real operator IDs when they share the same Chinese name.
  Fixes `get_operator_basic_info`, `get_operator_archives`,
  `get_operator_voicelines`, and `search_data` for affected operators (阿米娅,
  森蚺, 狮蝎, 佩佩, 断罪者, etc.).

## [1.3.0] - 2026-05-18

### Added

- **PRTS page table of contents.** `list_prts_sections(page_title)` returns the
  section index for a wiki page. Each section is labeled with its index (e.g.
  `[1]`, `[T-1]` for template-transcluded), heading level, and title.
- **PRTS page categories.** `get_prts_categories(page_title)` returns the
  category tags for a wiki page (e.g. "干员", "术师干员").
- **PRTS page links.** `get_prts_links(page_title, direction, limit)` returns
  outbound links from a page or inbound backlinks to a page, with pagination.

### Changed

- **`read_prts_page` gains `section_index` parameter.** When set, only the
  specified section's plain-text content is returned instead of the full page.
  Backwards-compatible: the parameter defaults to `None` (whole page).
- **`search_prts` enhanced.** New `search_mode` parameter (`text` / `title`),
  `filter_technical` toggle (default `true`, filters `/spine`, `/data`, etc.
  technical pages), and `totalhits` count in search results. Backwards-compatible:
  new parameters have safe defaults.

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
  Added `html.unescape` decoding and residual-wikitext cleanup after
  `strip_wikitext`.

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

- `include_narration=false` in `read_story` now also filters unnamed speaker
  lines (stage directions displayed as `（旁白）：text`) instead of only
  filtering `type="narration"` sticker/subtitle/animation lines.

## [1.0.0-beta.1] - 2026-05-12

## [1.0.0-alpha.2] - 2026-05-04

### Added

- Bounded retry loop for startup sync: `offline_fallback` and `no_data`
  results schedule daemon-thread retries at 30s, 120s, and 600s before
  giving up until the next process start. Matches the existing TypeScript
  behavior so both implementations recover from transient network failures
  without manual restart.
- The first sync attempt is wrapped in `_run_initial_sync`, so an
  unexpected exception in `sync_release` / `sync_release_archive` no longer
  kills the daemon sync thread; it is logged and treated as retry-needed,
  matching the TypeScript `.catch(() => true)` baseline.

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
