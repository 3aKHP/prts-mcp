# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- **Enemy cluster split (P3.A).** `data/enemy.ts` and `data/stageEnemy.ts` shed their pure logic into new 1:1 module pairs: `enemyStats.ts` (stat extraction + mergeDefined + the deduplicated formatting shims `pythonFloatString`/`formatNumber` — previously four scattered private copies, now with the extract path's unconditional `f"{n:,}"` semantics preserved separately from the int-gated compact-stats variant), `enemyRender.ts` (shared handbook card + stats block with the TS-only `hasEnemyStatsContent` guard preserved), `levelParser.ts` (level JSON parsing; dedupes the two `parseLevel` copies), and `enemyDatabase.ts` gains `level0Index`. `stageEnemy.ts` consumes enemy/stage's exported accessors instead of parallel cache instances; its dataset shrinks to `enemy_appearance_index`. **User-visible (debug)**: the `/debug/cache` `stage_enemy` section drops the four duplicated keys. **User-visible (malformed-sync edges)**: when levels are configured but the underlying excel/levels inputs are absent or mis-shaped, stage tools now render `无数据库记录` (enemy_database.json absent) instead of a thrown read error, and some failure-wrapper inner messages drift to the owning modules' wording (previously TypeScript threw where Python degraded — both now converge).
- **DatasetAccess contract (P1.B).** New `data/datasetAccess.ts` (factory + named registry + `excelStore`/`levelsStore`), `data/gamedataAttrs.ts` (`mValue` deduplicated from enemy/stageEnemy, now with overloads preserving enemy's typed call sites), and `data/messages.ts` (canonical missing-data / bounds / regex message builders). All seven gamedata-family modules migrate onto the contract, retiring the hand-rolled `let` + `checkActivationChange()` + `CacheMetrics` scaffold (~200 lines; the tri-state `TableCache` post-guards were dead code — a throwing load always left the variable null, i.e. retry semantics — and are deleted); cache keys, named clear functions, and the payload-or-string surface are unchanged. `cacheStats.ts` now aggregates via the dataset registry behind an explicit fixed key order (identical to Python's projection; registry insertion order alone is import-order-dependent and does not leak into output). `/debug/cache` corrections that land as side effects, all aligning with Python: `operator`'s `handbook_table`/`charword_table` counts now count the inner dicts (`handbookDict`/`charWords`) instead of the top-level key (always 1); `stage`'s `zone_table` reports `loaded: false` when the zone file is absent (the old `_zoneTableFailed` boolean's behavior, preserved by the contract's loaded-null snapshot rule). **User-visible**: item/stage missing-data messages now use the canonical family; enemy's divergent `无效的 limit/offset 参数：…` validation strings unify to the canonical `limit 必须 >= 1。` family (also enforcing limit ≤ 200).
- Internal activation symbols (`withActivationSnapshot`/`checkActivationChange`/`registerActivationListener`) moved from `config.js` into a dedicated `activation.js` module — import them from `activation.js` instead of `config.js`. The MCP tool surface is unchanged (#162).
- HTTP transport and release-discovery leaves extracted from `data/sync.ts` into a new `sync/` tier (`sync/transport.ts`, `sync/releaseDiscovery.ts`) — the only layer that issues data-sync HTTP (the PRTS Wiki API client in `api/` is unaffected). `data/sync.ts` re-exports them during the P2.A→P2.B migration, so existing `./sync.js` import paths keep working; the release/archive/pair state machine remains in `data/sync.ts` until P2.B. The MCP tool surface is unchanged.
- The release-archive activation subsystem (cross-process lock + generation tree + staging + zip validate/extract + prune) and the release state machine (CacheMeta + asset download + manifest verify + `syncRelease`) moved out of `data/sync.ts` into `sync/releaseActivation.ts` / `sync/release.ts`; shared spec/result types + the `errorMessage` helper moved to `sync/types.ts` (back-edge avoidance — `errorMessage` is consumed by both release and releaseActivation). `data/sync.ts` re-exports them and retains the GameData-pair state machine (moves to `sync/gamedataPair` in P2.B.2). The MCP tool surface is unchanged.
- The GameData-pair state machine (`syncReleaseArchive` / `syncReleaseArchivePair` + pair load/save/init) moved to `sync/gamedataPair.ts`, carrying both #152/#155 idempotency guards verbatim. `data/sync.ts` is now a pure re-export barrel — the full sync state machine lives in `sync/`. The MCP tool surface is unchanged.

### Fixed

- **Local artwork path containment now resolves symlinks (realpath).** In `operator_artwork(action="get")` local mode, the guard that contains the index-declared `file` to the synced generation directory was purely lexical, so a symlink inside the generation directory pointing elsewhere on the host passed the check and was followed by the file read — a malformed or compromised images index could exfiltrate an arbitrary host file base64-encoded. Both paths are now `realpathSync`-resolved before the containment check, matching the Python implementation (which already used `Path.resolve()`); escapes fall into the existing `图片文件缺失` message.
- Activation-lock wait timeouts now throw a named `ActivationLockTimeoutError` (exported from `./data/sync.js`) instead of a plain `Error`, parity with the Python `_ActivationLockTimeout`. The error message is unchanged.
- Large-shard image downloads: the Python implementation's default timeout was aligned to this one's 30-min total deadline per mirror attempt (no TypeScript behavior change; comment updated to document the now-matched semantics).
- `GITHUB_MIRRORS` entries are now normalized identically in both implementations: surrounding whitespace is trimmed and all trailing slashes are stripped (previously TypeScript stripped only one trailing slash, so `https://ghproxy.net//` produced a broken `...//https://...` candidate that proxies reject). Entries left empty after normalization (e.g. `///`) are dropped by both sides.
- **npm tarball verification tolerates propagation delay (#156).** The TypeScript CD `Verify npm published bytes` step now cache-busts the registry/CDN URL, retries for ~10 min, distinguishes a propagation timeout from a real byte mismatch, and fails fast on a permanent mismatch. The step moved from `publish-npm` into `github-release` so a propagation timeout no longer skips release creation (recover with `gh run rerun <run-id> --failed`); `npm publish` is skipped if the version already exists, making job re-runs safe.
- User-pattern search regexes (`search`, `search_stories`, and the enemy/stage/item scopes) now compile with the Unicode (`/u`) flag, aligning astral-codepoint handling (e.g. emoji, extended characters) with Python's Unicode-default `re` (#161). Note: JS `\w` remains ASCII-only even with `/u` (Python `\w` matches CJK) — that residual gap is fundamental and not flag-fixable.

## [2.6.2] - 2026-08-12

### Fixed

- Unchanged GameData Excel/Levels Auto-Sync cycles no longer replace `.gamedata_pair.json`, preventing false activation changes and periodic cache invalidation (#152).
- Real generation changes and missing or invalid pair metadata still rebuild the pair atomically and invalidate GameData caches.

## [2.6.1] - 2026-08-10

### Fixed

- `prts_page(action="template")` now renders nested template fields to complete readable text instead of silently dropping text or returning parsetree XML fragments (#125).
- Template rendering now preserves valid fields when another nested value renders empty and normalizes malformed MediaWiki response shapes and marker boundaries to the documented content-only fallback.
- `read_activity` now validates page inputs consistently and returns a clear content-only message when the requested page is beyond an existing activity's range (#137).

## [2.6.0] - 2026-08-09

### Added

- **Cache instrumentation (`/debug/cache` endpoint).** Each data module exports `getCacheStats()` returning per-cache `{loaded, count}` (and `bytes` for the image LRU). The read-only endpoint aggregates all nine modules (#104).
- **Aggregate runtime metrics for Issue #90.** The TypeScript Streamable HTTP server provides an opt-in `/debug/metrics` endpoint with process memory high-water, request/tool duration and error totals, session age/idle-timeout/lifecycle totals, and nine-domain cache hit/miss/invalidation counters. Metrics are aggregate-only and retain neither MCP arguments/results nor session identifiers.
- **Production cgroup sampler.** Added a systemd timer template that resolves the PRTS service cgroup dynamically and appends validated five-minute memory and runtime-metrics samples to JSONL, with log rotation and no public reverse-proxy route.
- **Six-session memory canary gate (#90).** The isolated loopback benchmark exercises archives, data search, story search, chapter/activity reads, and an actual artwork image retrieval across six concurrent sessions. It requires cache stability plus a quiescent request state and bounded RSS. Version-controlled same-host canary assets add a separate loopback service, authenticated temporary route, and cgroup limits of `MemoryHigh=1G` / `MemoryMax=1536M` without modifying the stable service.

### Changed

- Cache debug projections now include process-lifetime `hits`, `misses`, and `clears` fields while preserving the existing nine-domain shape.
- **MCP SDK v2 and dual-era serving (#84).** Migrated to SDK v2. Legacy initialize/session clients remain supported; HTTP clients can opt into the stateless `2026-07-28` envelope for `server/discover`, `tools/list`, and `tools/call` without initialize or `Mcp-Session-Id`.
- Base illust label mapping (`BASE_ILLUST_LABELS`) is consolidated to a single owner in `data/images.ts`; `data/artworkMediawiki.ts` imports it instead of maintaining a duplicate (#100).

### Fixed

- `Readable.fromWeb` cast is narrowed from bare `any` to the exact parameter type via `Parameters<typeof Readable.fromWeb>[0]` (#100).
- **Artwork form and diagnostics boundaries (#123).** `operator_artwork` resolves the half-width and full-width-parenthesis spellings of `阿米娅(近卫)` and `阿米娅(医疗)` to their distinct artwork char IDs without changing name resolution for other tools. Opaque artwork tokens require an exact form match in both local and MediaWiki modes. `/debug/cache` and `/debug/metrics` now require `PRTS_DEBUG_TOKEN` Bearer authentication and otherwise return 404.

## [2.5.2] - 2026-08-09

### Security

- Updated the locked npm production dependency graph, including
  `@modelcontextprotocol/sdk` 1.30 and `adm-zip` 0.6, resolving the audited
  production advisories without a breaking SDK-major upgrade.

### Fixed

- **Current AKDP enemy databases.** `get_stage_enemies` and
  `get_enemy_info` now read the direct enemy-ID mapping emitted by current
  `zh_CN-levels.zip` releases, while retaining the legacy wrapper format.
- **Scalar story decisions.** A `Decision.options` string is returned as one
  complete choice line instead of being dropped or split into characters.
- **Artwork token ownership.** `operator_artwork(action="get")` rejects an
  artwork token belonging to another operator before reading local image data
  or making a MediaWiki request.

## [2.5.1] - 2026-08-07

### Fixed

- **Gamedata pair retry no longer fires on commit_sha mismatch.** When both the excel and levels archives are up-to-date but carry divergent `commit_sha` values (stale local metadata, not missing data), the sync no longer schedules dense 30s/120s/600s retries. The next periodic cycle resolves the metadata drift; only `offline_fallback` / `no_data` statuses trigger retries.
- **Release manifest 404 handling.** When a mirror confirms a release has no `manifest.json` via HTTP 404, the sync skips that mirror cleanly instead of letting a later mirror's generic network 404 overwrite the explicit absence signal. A new `AssetNotFoundError` distinguishes "this release genuinely has no manifest" from "we couldn't reach this mirror".
- **Image shard sha256 verification.** After downloading AKDP image shards, the sync verifies each wanted variant's sha256 (now async) before activation. A missing PNG for a wanted variant counts as a mismatch and blocks activation (previously silently skipped).

### Changed

- CI upgraded to Node 24 (`actions/*` bumped to Node 24-compatible versions).

## [2.5.0] - 2026-08-07

### Added

- New `operator_artwork` tool (enabled by default). `action="list"` returns bounded metadata with semantic labels; `action="get"` returns one image as base64 `ImageContent` (default `large` variant, max 1024px). Default mode (`LOCAL_IMAGE=false`) fetches on-demand from PRTS MediaWiki under the full #85 security boundary (hostname/MIME/magic/1MiB/streaming/redirect) with a 256 MiB LRU cache (`PRTS_IMAGE_CACHE=true`). Set `LOCAL_IMAGE=true` to sync ~1.5 GB of AKDP local PNG assets; `ORIGINAL_IMAGE=true` adds full-resolution shards. MediaWiki labels via CharinfoV2 `时装N名称`; AKDP labels via `skin_table.json`. The `original` variant is rejected in MediaWiki mode (PRTS originals exceed the 1 MiB cap). Tool surface 23 → 24.

### Changed

- **Auto-sync data source switched to self-hosted `arknights-data-pipeline`.** The default sync now consumes `zh_CN-excel.zip`, `zh_CN-levels.zip`, and story `zh_CN.zip` Releases from `3aKHP/arknights-data-pipeline` (the factory repo). The legacy upstream repos are no longer data dependencies on the 2.5.0 line. Release manifest verification tightened so a partial or corrupt archive cannot be treated as healthy data.
- `tsx` devDependency updated from 4.21 to 4.23.

### Fixed

- **Data sync uses tag-prefix filtering instead of `/releases/latest`.** The `arknights-data-pipeline` repo now hosts both `data-*` and `images-*` GitHub Releases. `checkLatestRelease` switched from the `/releases/latest` endpoint to the releases list API with `data-` tag-prefix filtering, preventing silent sync stalls if GitHub auto-promotes an `images-*` release to "Latest". Shared `listReleases` / `latestReleaseByPrefix` / `assetUrl` helpers were lifted from `imagesSync` into `sync` to avoid duplication. CI `gh release download` now resolves the latest `data-*` tag before downloading.
- **TS stdio entry no longer starts an HTTP listener.** The stdio entry point (`server-stdio.ts`) previously imported from `server.ts`, whose module-load side effect called `app.listen()` — spawning a rogue HTTP server on the configured `PORT` alongside the stdio transport. Extracted a side-effect-free `server-core.ts` factory shared by both entry points.
- **`operator_artwork` allimages pagination.** MediaWiki `allimages` now paginates with `aifrom` continuation (50 per page) to avoid silent truncation when an operator has more than 50 skin images.
- **Docker images volume for `LOCAL_IMAGE=true`.** All three Dockerfiles now create `/data/images` so the `LOCAL_IMAGE=true` sync path has a writable target directory when running with a named volume.
- **TS `{}` empty-object placeholder crash.** Upstream AKDP data sometimes emits `{}` instead of `[]` for array fields (`waves`, `fragments`, `actions`, `unlockCondition`, `talents`, `tagList`, etc.). TS `?? []` only catches `null`/`undefined`, so `{}` slipped through and crashed `.map()` / `for...of`. All 21 JSON-sourced `?? []` sites now use `Array.isArray(x) ? x : []` to match Python's falsy `or []` tolerance.

## [2.4.0] - 2026-07-29

### Added

- Added process-lifetime auto-sync: after the startup check, GameData excel, GameData levels, and StoryJson Releases are checked hourly without a service restart. `PRTS_AUTO_SYNC_INTERVAL_SECONDS` configures the interval or keeps startup-only behavior with `0`.
- Added archive activation metadata so an interrupted extraction is retried on the next cycle before the downloaded Release is treated as active.
- GameData excel and levels now become visible as one atomic generation, so tools never observe a mixed old/new pair while a periodic update is running.
- Shared-volume publication locks now renew their lease while held, preventing long downloads or extraction work from being mistaken for abandoned locks.

## [2.3.1] - 2026-07-10

### Security

- Updated transitive production dependencies to resolve known vulnerabilities in HTTP and JSON-schema support packages.

### Fixed

- Synchronized the `prts-mcp-ts-stdio` bin metadata in `package-lock.json`.

## [2.3.0] - 2026-07-08

### Added

- Added stdio transport support: new `prts-mcp-ts-stdio` npm bin and `ts/src/server-stdio.ts` entry point. Reuses the existing `createMcpServer` factory and `runStartupSync`; connects an `StdioServerTransport` for single-session local MCP clients (Claude Desktop, Claude Code, Cursor). Breaks the 2.0 transport split — the TypeScript implementation now supports both Streamable HTTP (existing `prts-mcp-ts` / `prts-mcp-ts-bun` bins) and stdio.
- Added `start:stdio` / `start:stdio:bun` npm scripts.
- Added `e2eStdio.test.ts` covering stdio initialize handshake, tools/list, and graceful error handling.
- Extended `smoke-package-bun.mjs` to assert the `prts-mcp-ts-stdio` bin shim is installed and non-empty after `npm pack` + `bun add`.

### Changed

- `server.ts` now exports `createMcpServer`, `SERVER_VERSION`, and `log` (previously module-private) so the stdio entry point can reuse them without duplicating tool registration logic.

## [2.2.0] - 2026-07-08

### Added

- Added `ts/Dockerfile.node` as the supported Node.js legacy Docker build path.
- Added Node legacy npm scripts: `start:node`, `smoke:http:node`, `smoke:http:fixture:node`, and `dev:bun` for Bun-native development.
- Added an explicit `bun.lock`/`package.json` drift check in `verify-ts` so dual-lockfile desync fails fast with an actionable message.
- Extended `build-image-ts` to also run on `release/**` pull requests so the default Bun image is validated before shipping to main.

### Fixed

- Fixed the default Docker image shipping without bundled fallback data: `.dockerignore`'s `*.zip` rule stripped the CI-pre-fetched `data/storyjson/zh_CN.zip` (and gamedata archives) from `COPY data/ data/`, leaving the container without offline storyjson fallback. Added negation rules so bundled data zips reach the image.

### Changed

- Bun is now the default production runtime for the TypeScript implementation: the default `ts/Dockerfile`, the primary CI verification path (`verify-ts`), and the recommended Docker deployment all run under Bun (verified against Bun `1.3.14`). **Node.js remains a supported legacy/optional runtime** via the `prts-mcp-ts` npm bin (so `npx prts-mcp-ts` stays zero-dependency), `npm install -g`, and the new `ts/Dockerfile.node` build path. The npm publishing path is unchanged (`npm publish --provenance`, runtime-agnostic).
- Default npm scripts (`start`, `smoke:http`, `smoke:http:fixture`) now drive the Bun entrypoint; `start:bun` / `smoke:bun` / `smoke:bun:package` retained verbatim for 2.1.0 backward compatibility.
- CI matrix flipped: `verify-ts` is now Bun-based (type-check, build, runtime smoke, packed-package smoke); the `node:test` unit suite moved to a new `test-ts` job; `build-image-ts` builds the default Bun image; a new `build-image-ts-node` job covers the legacy Node image.

### Removed

- Removed the now-redundant `ts/Dockerfile.bun`; its content is promoted to the default `ts/Dockerfile`.
- Removed the `verify-ts-bun` and `build-image-ts-bun` CI jobs; their coverage is absorbed by the new Bun-default `verify-ts` and `build-image-ts`.

## [2.1.0] - 2026-07-07

### Added

- Added the `prts-mcp-ts-bun` public bin as the supported optional Bun runtime entry point. The default `prts-mcp-ts` bin remains Node.js-based.
- Added a packed-package Bun smoke test that runs `npm pack`, installs the tarball with Bun in a temporary project, starts `prts-mcp-ts-bun`, and reuses the HTTP MCP smoke harness.

### Changed

- Promoted the Bun runtime and `ts/Dockerfile.bun` from candidate coverage to a supported optional TypeScript runtime path, verified against Bun `1.3.14`. Node/npm remains the default runtime, Dockerfile, and Trusted Publishing path.

## [2.0.2] - 2026-07-07

### Added

- Added a reusable HTTP MCP smoke harness for the TypeScript server and CI coverage for Node, Bun, and the candidate Bun Docker image.
- Added an optional Bun candidate runtime path with Bun scripts, a committed `bun.lock`, `ts/Dockerfile.bun`, and CI smoke coverage. Node/npm remains the default TypeScript runtime and npm Trusted Publishing path.

### Fixed

- `search_prts` now resolves redirect-like PRTS Wiki search hits to their target page when the search response lacks redirect metadata, while falling back to the original result if the follow-up lookup fails.
- `search_prts` filters technical/wiki implementation pages more precisely and keeps `totalHits` stable even when visible results are filtered out.

## [2.0.1] - 2026-07-03

### Changed

- Content-only tool handlers now consistently route through the shared `textResult(...)` helper, keeping text-result construction centralized without changing the returned MCP payload shape.

## [2.0.0] - 2026-07-03

### Added

- **Output channel design replaces the per-call `output_format` parameter (2.0 design decision).** The original roadmap proposed an optional `output_format=markdown|json` parameter with 2.0 flipping the default to `json`. **That shape was rejected during design.** The primary consumer is an LLM agent, and JSON inflates prompt tokens ~15–30% versus markdown — which would negate the context-budget savings the tool-surface consolidation delivers. 2.0 instead keeps markdown as the always-on `content` text and carries structured data on MCP's native `structuredContent` field, selected by a **connection-level** `output_channel` knob (`content` (default) / `structured` / `both`) via query string / `x-prts-output-channel` header / `PRTS_OUTPUT_CHANNEL` env. The default is **not** flipped to JSON. See [`docs/migration-1.x-to-2.0.md`](../docs/migration-1.x-to-2.0.md) for the per-tool channel mapping and client configuration. _(The Python implementation additionally documents a "narrative-tool wire slimming" entry for dropping FastMCP's automatic `outputSchema={result:string}` wrapper; the TS transport has no equivalent auto-wrapper, so narrative tools are simply part of the content-only delivery path here.)_
- **Output channel pilot (2.0).** Streamable HTTP sessions can opt into `output_channel=structured` or `output_channel=both` via query string, `x-prts-output-channel` header, or `PRTS_OUTPUT_CHANNEL`. This first TS migration slice enables structuredContent for `list_stages` while preserving the default content-only markdown output, including legitimate empty pages (filter no-match / offset past end) as structured empty payloads.
- **Output channel coverage for structured data tools (2.0).** The remaining game-data and story navigation tools now support structuredContent in TS: operator/item/enemy/stage details and listings, stage-enemy fusion, story event/chapter listings, operator memoirs, character appearances, and event speaker counts.
- **Output channel coverage for search tools (2.0).** The TS `search`, `search_stories`, and `search_prts` tools now emit structuredContent in `structured`/`both` channels, including structured-empty payloads for legal no-match results and parity fixtures shared with the Python implementation.

### Changed

- **Parameter naming normalization (2.0, breaking).** Operator tools (`get_operator_archives`, `get_operator_voicelines`, `get_operator_basic_info`, `get_operator_memoirs`) now take `name` instead of `operator_name`, matching the `name` convention already used by the enemy/stage/item/character tools.
- **Unified search (2.0, breaking).** `search_data`, `search_enemies`, `search_stages`, and `search_items` are consolidated into a single `search(scope, pattern, max_results)` tool with a required `scope` enum (`operators` / `enemies` / `stages` / `items`). Story dialogue search remains a separate `search_stories` (its filters differ). Tool surface drops 32 → 28.
- **Unified PRTS page tool (2.0, breaking).** `read_prts_page`, `list_prts_sections`, `get_prts_categories`, `get_prts_links`, and `get_prts_template` are consolidated into a single `prts_page(page_title, action, ...)` tool with a required `action` enum (`read` / `sections` / `categories` / `links` / `template`). Wiki keyword search remains a separate `search_prts`. Tool surface drops 28 → 24.
- **`list_stories` absorbs the event-level summary (2.0, breaking).** `list_stories(event_id, include_summaries=true)` now prepends the event's LLM overview (from `event_summaries.json`) when present, on top of the per-chapter one-liners it already returned — making it a superset of the former `get_event_summary`. Tool surface drops 24 → 23.
- **Tool descriptions standardized (2.0).** All tool descriptions were rewritten to a consistent house style (verb-first purpose, output-shape note, at most one cross-reference, parameter semantics kept in the parameter schema) and trimmed ~20% to reduce context budget on smaller-context models. No change to tool names, parameters, or output format.
- **Story empty-result wording aligned with Python (2.0).** TS story navigation tools now use the Python-compatible empty messages for event/chapter listings, character appearances, and speaker counts (including Python-style quoted filter values). This is an intentional TS-dev text change in otherwise content-compatible output-channel migration paths.

### Removed

- **`search_data`, `search_enemies`, `search_stages`, `search_items`, `list_search_scopes` (2.0, breaking).** Replaced by unified `search(scope, ...)`; the scope catalogue previously returned by `list_search_scopes` is folded into the `search` tool description.
- **`read_prts_page`, `list_prts_sections`, `get_prts_categories`, `get_prts_links`, `get_prts_template` (2.0, breaking).** Replaced by unified `prts_page(page_title, action, ...)`.
- **`get_event_summary` (2.0, breaking).** Folded into `list_stories(include_summaries=true)`; `get_story_summary` (single-chapter deep summary) is unchanged.

## [1.7.0] - 2026-07-02

1.7.0 is the final 1.x feature release and the 1.7 LTS baseline. Future 1.7.x updates are limited to compatibility, security, data-sync, and critical bug fixes.

### Added

- **Story character tracking.** Two new tools reuse the existing story search index (no new data source): `find_character_appearances(name, scope?, max_events?)` returns chapters where a character **speaks** (dialog role exact match) or is **mentioned** (name substring in any line text); `find_speakers_in(event_id)` lists every speaker in an event with dialog line counts. Brings the tool surface to 32.

### Changed

- **Module split: story and server god files.** `data/story.ts` (907 lines) and `server.ts` (1173 lines) were split into focused submodules to meet the STYLE.md file-size guideline (~300 lines). `story.ts` is now a re-export shim over `storyReader`, `storySearch`, `storyMemoir`, and `storySummary`. `server.ts` is now a ~200-line entry point (Express + session management) that delegates tool registration to `tools/prtsTools`, `tools/gamedataTools`, and `tools/storyTools`, and sync orchestration to `startupSync`. All public symbols are re-exported — no behaviour change.
- **Dead code removal in sync.** The original GitHub raw file sync path (`syncRepo`, `downloadFiles`, `checkUpstreamSha`, `syncAll`, `cacheMetaPath`, `loadCacheMeta`, `saveCacheMeta`, `filesPresent`) had no external callers and has been removed. `sync.ts` shrank from 700 to 504 lines. The remaining exported sync symbols (`SyncResult`, `RepoSpec`, `GAMEDATA_FILES`) are retained for the Release-based sync path.

## [1.6.1] - 2026-06-03

### Added

- **Operator memoir discovery.** New `get_operator_memoirs(operator_name)` tool resolves operator Chinese name to memoir story keys via `chardict.json`, enabling LLM agents to find and read operator memoir (干员密录) dialogue.
- This new tool is treated as a one-off patch-line exception because it exposes story data that already existed in the synced StoryJson archive but was not discoverable through the public tool surface.
- `list_story_events(category="memoirs")` now exposes 372 previously hidden operator memoir events.
- Operator memoir dialogue is now indexed by `search_stories`.

### Changed

- Search tools backed by local game/story data now reuse cached search records instead of rebuilding parsed text on every call, substantially improving repeated full-story and full-table regex searches.
- Enemy search records now include `enemyTags` in searchable text.

### Fixed

- Story search now caps `max_results` and `context_lines` consistently to prevent oversized MCP responses from long-running full-dataset searches.
- `search_stages` and `search_items` now enforce `max_results` bounds (1–100) for parity with other search tools.
- `list_story_events` and `search_stories` no longer ignore entries with `entryType: "NONE"` when those entries have valid story data (was the root cause of memoirs being undiscoverable).

## [1.6.0] - 2026-05-28

### Added

- **Item/material data domain.** Three new tools — `list_items`, `get_item_info`, and `search_items` — read `item_table.json` to expose material/item lists, details, obtain methods, stage drops, production, and shop/voucher links.
- **Stage/enemy cross-source fusion.** Added `get_stage_enemies(stage_id)` and `get_enemy_appearances(name, limit, offset)` backed by `zh_CN-levels.zip`. `get_enemy_info(name)` now accepts optional `stage_id` for stage-specific enemy levels and overwritten combat stats while preserving the default handbook behavior.
- Tool surface expanded from 24 to 29. `list_search_scopes` now includes the items domain.
- Runtime data sync now handles three datasets: `zh_CN-excel.zip`, `zh_CN-levels.zip`, and story `zh_CN.zip`. Docker images and npm packages prewarm `data/gamedata-levels` alongside existing bundled fallback data.

### Changed

- Stage drop formatting now resolves item IDs through `item_table.json` when available, e.g. `招聘许可（7001）`.

### Fixed

- **Release archive validation.** Archive sync validates required zip entries before extraction and rechecks required files after extraction, so a partial or corrupt `zh_CN-levels.zip` cannot be logged as healthy data.
- **Enemy appearance lookup memory profile.** `get_enemy_appearances` now scans for the requested enemy instead of permanently caching an all-enemy appearance index on first use.
- **Release zip cache validation parity.** `syncRelease` now treats a cached zip that fails the dataset validator as unusable during network fallback, matching Python behavior and preventing corrupt story archives from being reported as healthy fallback data.
- **Session timer lifecycle.** Idle-session timers now call `unref()` so they do not keep an otherwise idle Node process alive.

## [1.5.0] - 2026-05-25

### Added

- **Stage data domain.** Three new tools — `list_stages`, `get_stage_info`, `search_stages` — sourced from `stage_table.json` (3319 stages) and `zone_table.json` (434 zones) in ArknightsGameData. `list_stages` supports zone and stage-type filters with pagination; `get_stage_info` returns detailed per-stage data (drops, unlocks, related variants); `search_stages` performs regex search across names, codes, descriptions, and types.
- Tool surface expanded from 21 to 24. `list_search_scopes` updated with stages and enemies entries.
- `stage_table.json` and `zone_table.json` added to sync manifests for integrity validation.

## [1.4.2] - 2026-05-25

### Fixed

- **Session pool 400 on stale session ID.** When a client reuses a session ID that was evicted by idle timeout or lost across server restart, the server now returns a spec-compliant 404 (error code `-32002`) with an LLM-actionable message instead of the previous 400 "Server not initialized". Initialize requests with a stale session ID auto-recover (strip old ID, treat as fresh handshake) — an intentional relaxation of MCP Streamable HTTP §3.2 for clients that don't retry with a fresh handshake on error.

### Changed

- **Session idle timeout default extended** from 30 minutes to 24 hours, reducing the chance of session eviction during normal interactive use. Configurable via `SESSION_IDLE_TIMEOUT_MS` env var.
- **Session idle timeout test** tightened to assert exact 404 status and error code, plus a new sub-test for init auto-recovery path.

## [1.4.1] - 2026-05-19

### Fixed

- **ZipStore zip instance caching.** `AdmZip` is now cached instead of re-instantiated on every `exists()`/`readText()` call. In `search_stories` without an `event_id` filter this was ~3000 redundant zip parses, exceeding the 120 s MCP client timeout.
- **Session memory leak.** `SESSION_IDLE_TIMEOUT_MS` (default 30 min) evicts MCP transports left behind by clients that disconnect without cleanly closing their session, preventing unbounded memory growth.
- **Enemy blackboard parity.** Filter/slice order corrected to match Python: slice first 6 entries, then filter null values.
- **HTML entity decoding.** `String.fromCodePoint` replaces `String.fromCharCode` for correct non-BMP Unicode handling. Named entity table extended from 6 hardcoded replacements to a lookup table with regex-based fallback for unrecognized entities.
- **Story search robustness.** `read_activity` gains `page >= 1` validation. Exception handling in `search_stories` and `read_activity` narrowed from bare `catch {}` to expected error types. Convenience wrappers (`searchStories`, `getEventSummary`, `getStorySummary`) now use `storyStore()` for consistency.

### Added

- **E2E test suite.** MCP protocol-level test (`e2e.test.ts`) covering handshake, tool surface (all 21 tools), operator data, and graceful degradation when optional data is unavailable.

## [1.4.0] - 2026-05-19

### Added

- **PRTS template data extraction.** `get_prts_template(page_title)` returns structured key-value data from MediaWiki template calls on a page via `action=parse&prop=parsetree`. Only top-level templates are returned; nested templates inside values are stripped.
- **Enemy handbook tools.** Three new tools backed by `enemy_handbook_table.json` with optional combat-stats merge from `levels/enemydata/enemy_database.json`:
  - `list_enemies(threat_level?, limit, offset, full)` — paginated listing with `boss` / `elite` / `normal` filter. Defaults to first 50 entries.
  - `get_enemy_info(name)` — handbook entry merged with HP / ATK / DEF / RES, immunities, and skill list with blackboard params.
  - `search_enemies(pattern, max_results)` — regex search across enemy names, descriptions, and abilities.

## [1.3.1] - 2026-05-19

### Fixed

- **Operator name-to-ID collision.** `resolveCharId()` and `searchOperatorData()` now filter to `char_*` entries only, preventing `trap_*` and `token_*` entries from silently overwriting real operator IDs when they share the same Chinese name. Fixes `get_operator_basic_info`, `get_operator_archives`, `get_operator_voicelines`, and `search_data` for affected operators (阿米娅, 森蚺, 狮蝎, 佩佩, 断罪者, etc.).

## [1.3.0] - 2026-05-18

### Added

- **PRTS page table of contents.** `list_prts_sections(page_title)` returns the section index for a wiki page.
- **PRTS page categories.** `get_prts_categories(page_title)` returns category tags for a wiki page.
- **PRTS page links.** `get_prts_links(page_title, direction, limit)` returns outbound links or inbound backlinks with pagination.

### Changed

- **`read_prts_page` gains `section_index` parameter.** Backwards-compatible.
- **`search_prts` enhanced.** New `search_mode` (`text` / `title`), `filter_technical` toggle, and `totalHits` in results. Backwards-compatible.

## [1.2.0] - 2026-05-14

### Added

- **Story chapter summaries.** Two new tools and one enhancement built on the previously-unused `zh_CN/storyinfo.json` index (1,945 entries), plus an LLM summarization pipeline in the data-source fork:
  - `get_event_summary(event_id)` — narrative overview of every chapter in an event, with chapter codes, tags, names, and summary text. When LLM event summaries are available (`zh_CN/event_summaries.json`), a full-dialogue V2 synopsis is prepended above the chapter listing.
  - `get_story_summary(story_key)` — single-chapter summary with a three-tier fallback chain: LLM long summary (`zh_CN/summaries.json`, 5~7:1 compression), official one-liner (`zh_CN/storyinfo.json`), and chapter `storyInfo` field.
  - `list_stories` now accepts `include_summaries` (bool). When `true`, each chapter line includes an indented summary below it.
- **LLM summarization pipeline** (`3aKHP/ArknightsStoryJson` fork): `scripts/summarize.py` generates per-chapter (5~7:1) and per-event (10:1) summaries via DeepSeek V4 Flash API during CI release, injecting them into `zh_CN.zip` for transparent consumption by the MCP server.

## [1.1.1] - 2026-05-14

### Fixed

- **`read_prts_page` now returns full page content.** Switched from `action=query&prop=extracts` (which strips all template-rendered content) to `action=parse&prop=text`. Character pages now return 22K+ chars of readable text instead of ~400 chars of empty section headers.
- **`search_prts` restricts to main namespace.** Added `srnamespace=0` so search results are no longer polluted by technical data pages from other MediaWiki namespaces.
- **Search snippets are cleaned of HTML entities and JSON fragments.** Added HTML entity decoding and residual-wikitext cleanup after `stripWikitext`.

## [1.1.0] - 2026-05-14

### Added

- **Search tools.** Three new MCP tools provide full-text regex search across operator data and story dialogue, enabling exploratory queries without knowing exact operator names or story keys upfront:
  - `list_search_scopes` — list searchable data domains and their content types.
  - `search_data(pattern, scope, max_results)` — search operator names, descriptions, archive texts, and voice lines.
  - `search_stories(pattern, character, line_type, context_lines, max_results, event_id)` — search story dialogue, narration, and choice lines with filtering by speaker and line type, plus configurable context lines around each match.

## [1.0.0] - 2026-05-13

### Changed

- **Public tool surface frozen.** The 9 MCP tool names, required parameters, and response formats are locked. Automated tests enforce this in CI for both Python and TypeScript.
- CI now downloads the storyjson `zh_CN.zip` fixture before running Python tests so story integration tests are no longer silently skipped.
- Migration guide expanded with behavioral changes from 0.x: Release archive sync, `archives/` cache metadata, `local_repo.jsonc` removal, and `story_review_table.json` as a required gamedata file.

### Fixed

- `include_narration=false` in `readStory` now also excludes unnamed speaker lines (stage directions displayed as `（旁白）：text`) instead of only excluding `type="narration"` sticker/subtitle/animation lines.

## [1.0.0-beta.1] - 2026-05-12

## [1.0.0-alpha.2] - 2026-05-04

### Added

- Post-download zip integrity validation for the storyjson Release asset: every chapter referenced by `story_review_table.json` must exist in the downloaded zip before it replaces the cached copy. A missing or unreadable archive is rejected and falls through the normal `offline_fallback` / retry path instead of silently corrupting the local cache. Matches the pre-existing Python behavior.

## [1.0.0-alpha.1] - 2026-05-03

### Added

- Added a shared local dataset reader layer with directory, zip, and fallback stores.
- Added dataset specs for GameData excel and story JSON Release assets.
- Added bundled package-data verification for Docker and npm release pipelines.

### Changed

- Operator and story parsers now read through the new store abstraction while preserving current MCP tool names, parameters, and output formatting.
- Runtime sync setup now consumes dataset specs instead of repeating Release metadata in server startup code.

## [0.3.3] - 2026-05-03

### Fixed

- The HTTP server now starts listening before GameData and story auto-sync run in the background, so slow GitHub Release downloads no longer leave systemd active while the port is unavailable.

## [0.3.2] - 2026-05-03

### Changed

- ArknightsGameData auto-sync now downloads the `zh_CN-excel.zip` Release asset from `3aKHP/ArknightsGameData` and extracts it into the existing `gamedata` layout, aligning the game-data and story-data sync paths around GitHub Release archives.
- npm bundled game data is now prewarmed through `python/scripts/fetch_gamedata.py`, using the same Release archive as runtime sync instead of downloading raw JSON files directly.
- Package metadata now targets `0.3.2` for this transition release.
- Operator table caches are cleared after startup auto-sync writes updated game data, and core operator behavior is covered by Node test-runner smoke tests.

## [0.3.0] - 2026-04-10

### Added

- `GITHUB_MIRRORS` environment variable: comma-separated list of ghproxy-style proxy base URLs (e.g. `GITHUB_MIRRORS=https://ghproxy.net`) tried in order after the direct GitHub URL fails, enabling auto-sync on servers behind the GFW
- Blind download path in `sync_release`: when the GitHub API is unreachable but mirrors are configured and no local data exists, the storyjson zip is fetched via the `releases/latest/download/` redirect URL which does not require an API call
- `list_story_events`, `list_stories`, `read_story`, `read_activity` tools for querying Arknights story scripts and event metadata from ArknightsStoryJson
- Bundled game data (`data/gamedata/`, `data/storyjson/`) included in the npm package so the server starts with offline fallback data without requiring a prior sync
- `config.ts` now resolves data paths relative to `import.meta.url` (package root) so bundled paths work correctly for both npm installs and Docker

### Fixed

- `story_review_table.json` added to bundled data and `cache_meta.json`; was missing after the story feature added it to `REQUIRED_OPERATOR_FILES`, causing `filesComplete()` to always return false for the bundled path
- Dead code (`STORYINFO` constant) removed; unused import dropped; null role format aligned with Python implementation

## [0.2.0] - 2026-04-08

### Added

- `get_operator_basic_info` tool exposing operator rarity, class, faction, and description from `character_table.json`
- Streamable HTTP transport (MCP 2025-03-26 spec) replacing the earlier SSE-based approach; endpoint at `/mcp`, health check at `/health`
- Docker image for self-hosted HTTP server deployment
- npm package (`prts-mcp-ts`) for `npx` / global install usage
- GitHub Actions CD workflow (`cd-ts.yml`) publishing to npm with Trusted Publishing and pushing Docker image to GHCR

## [0.1.0] - 2026-03-18

### Added

- FastMCP TypeScript server with 4 tools: `search_prts`, `read_prts_page`, `get_operator_archives`, `get_operator_voicelines`
- PRTS MediaWiki API integration with rate limiting and custom User-Agent
- Local ArknightsGameData JSON reader with LRU caching
- Wikitext sanitizer for stripping templates, file links, and HTML tags
