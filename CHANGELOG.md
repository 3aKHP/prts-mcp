# Changelog

English | [简体中文](CHANGELOG.zh-CN.md)

This file records user-visible changes across PRTS-MCP implementations: Python and TypeScript through 2.x, and native Rust starting in 3.x. Versions are listed in descending order, with LTS maintenance patches retaining their original release dates. In 1.x/2.x sections, entries without an implementation subheading apply to both Python and TypeScript; implementation-specific entries are grouped under `Python` or `TypeScript`.

The original per-implementation changelogs at the 2.8.1 baseline remain available on the [`ts/v2.8.1` tag](https://github.com/3aKHP/prts-mcp/tree/ts/v2.8.1) ([Python](https://github.com/3aKHP/prts-mcp/blob/ts/v2.8.1/python/CHANGELOG.md) · [TypeScript](https://github.com/3aKHP/prts-mcp/blob/ts/v2.8.1/ts/CHANGELOG.md)), and the 1.7.1/1.7.2 maintenance records come from the published [`python/v1.7.2`](https://github.com/3aKHP/prts-mcp/blob/python/v1.7.2/python/CHANGELOG.md) and [`ts/v1.7.2`](https://github.com/3aKHP/prts-mcp/blob/ts/v1.7.2/ts/CHANGELOG.md) tags.

## [Unreleased] — 3.0.0-dev.0

Implementation: Rust.

### Added

- **Unified native Rust runtime (`prts-mcp`)**: migrated the server to a single native Rust implementation at the repository root (MSRV `1.89`) with a statically linked QuickJS regular-expression engine (`vendor/quickjs-regexp/`), preserving the frozen TS/v2.8.1 24-tool contract, both MCP protocol eras (`legacy` and `2026-07-28` stateless `modern`), `stdio` and Streamable HTTP transports, and generation-aware background data/image synchronization.
- **Five-platform prebuilt native archives**: added standalone release archives (`linux-x64`, `linux-arm64` with `glibc >= 2.28`, `windows-x64` with static CRT, `darwin-arm64`, and `darwin-x64` targeting macOS `14.0+`) containing all five entry executables, ABI/build manifests, third-party license notices, and a verified read-only fallback snapshot of game tables, level data, and stories.
- **Nine-package Rust-backed npm distribution**: added the new `prts-mcp` main package alongside the compatible `prts-mcp-ts` package, backed by `@3akhp/prts-mcp-runtime` (Node `>= 22` launch bridge with signal forwarding and Windows parent-process lifecycle monitoring), `@3akhp/prts-mcp-data` (shared read-only fallback data), and five platform-filtered binary packages (`@3akhp/prts-mcp-<platform>`), published with npm OIDC provenance on `@next` (`3.0.0-alpha.3`).
- **Dual-architecture native Docker images**: updated `ghcr.io/3akhp/prts-mcp` (`linux/amd64` and `linux/arm64`) to run the native Rust server under `tini` (PID 1 signal forwarding) with bundled read-only fallback data in `/app/data` and full compatibility with existing 2.x `/data` named volumes and bind mounts.
- **Isolated `lts/2.8` maintenance line**: preserved the Python and TypeScript 2.8.x implementations on `lts/2.8` (alongside `lts/1.7`), both supported through `2027-07-02`.

### Changed

- **Tool response allocation**: transfer owned Markdown, structured results, and image strings into MCP responses, reducing temporary copies while preserving all output channels.

- **Stage enemy queries**: read the six displayed combat attributes through stage overrides without reconstructing whole enemy records, and parse only the consumed wave/reference fields into JSON values, preserving override and level-fallback behavior.

- **Enemy database memory use**: parse combat data directly into a compact cache with shared field names and read attributes without reconstructing whole records, preserving enemy and stage-override results.

- **Story index memory and search**: store chapter text contiguously, share repeated speaker names within each chapter, and iterate record positions without a duplicate array, preserving every indexed line and search order.

- **Operator memory use**: retain only fields consumed by operator panels, talents, and skill lookups in the character cache, reducing memory use without changing tool output.

- **Entry-point transport defaults**: the new `prts-mcp` binary and npm package default to Streamable HTTP (`:3000/mcp`, switchable via `PRTS_TRANSPORT=stdio`); `prts-mcp-ts` / `prts-mcp-ts-bun` (HTTP) and `prts-mcp-ts-stdio` (stdio) retain their fixed 2.x transport modes on top of the Rust binary without requiring Bun; the Docker entrypoint (`prts-mcp-ghcr`) retains default `stdio` (switchable via `PRTS_TRANSPORT=http`).
- **Native diagnostics and regex boundaries (`D-001`–`D-007`)**: `/debug/metrics` reports `process.runtime: "rust"`, OS-native resident memory (`process.rss_bytes`), and the highest sampled RSS (`process.rss_high_water_bytes`) instead of V8/Python heap fields; `/debug/cache` retains its per-domain cache counters (documented in `contracts/baseline.json`).

### Fixed

- **Memory use after mixed queries**: share cached stage, search, and artwork data; avoid copying the enemy database for individual queries; and retain only consumed operator, enemy, stage, base-skill, and skin fields. Enemy appearance indexing parses wave data without allocating unrelated level structures.
- **Concurrent first queries**: serialize each dataset's initial load within a generation so simultaneous requests share the cached result. Failed loads remain retryable.
- **Combat skill loading and search**: keep compact skill data and build search text directly, reducing retained memory and temporary allocations while preserving level numbering, placeholders, and output values.

### Removed

- **Legacy `python/` and `ts/` source trees on `develop` and PyPI 3.x publishing**: removed the dual-language source directories and the outdated 4-table sample under `data/` from the 3.x development tree. Python and TypeScript 2.8.x/1.7.x remain maintained on their respective LTS branches; 3.x is distributed via npm, GitHub Release native archives, and GHCR Docker images (with `crates.io` planned after 3.0.0 stable).

## [2.8.1] - 2026-10-11

### Added

- **Roguelike story supplement catalog support.** When the story pack carries `story_supplement.json` (an additive file within the `prts-mcp-data/v1` contract, produced by arknights-data-pipeline), the six `rogue_N` roguelike events become first-class story content: `list_story_events` lists them (with a new `category="roguelike"` filter), `list_stories` / `read_activity` order their chapters, `search_stories` and the two character tools index them through the shared search index, and `read_story` / `get_story_summary` resolve their keys. Packs without the file behave exactly as before; directory-store caches now track the supplement file so self-hosted directory trees invalidate correctly, and the story-pack validator checks the catalog's chapter references when the file is present. The MCP tool surface stays at 24.

### Fixed

- Directory story-search caches track each catalog file independently, so an equal-size edit with a timestamp older than the other catalog still invalidates the index. Python story-pack validation now skips non-list supplement chapter fields consistently with TypeScript.

## [2.8.0] - 2026-10-10

### Added

- **Operator combat skills: `get_operator_basic_info(action="skills")` and a `skills` search scope.** The skills action returns an operator's combat skills with per-level effects — Lv1-7 plus mastery 1-3 — including SP cost, initial SP, charge count, duration/ammo, and descriptions rendered by substituting blackboard placeholders (`{key}` / `{key:0%}` .NET-style formats; unknown placeholders stay literal). The unified `search` tool gains a `skills` scope for cross-operator keyword lookup over all level descriptions. The `skills` scope returns each matching skill's highest-level effect line, so the matched keyword may appear in a lower level's description rather than the displayed line. `skill_table.json` becomes a validated dataset-contract entry of the AKDP `zh_CN-excel.zip` dataset (the archive has always shipped it, so re-download restores contract compliance on older deployments); user-supplied data roots without the file degrade: the skills action explains the gap, the scope reports no matches. The `skill` domain registers on the dataset-access contract and appears as the eleventh `/debug/cache` module. The MCP tool surface stays at 24; existing calls and user configuration stay compatible.

- **Operator stat panels: `get_operator_basic_info(action="stats")`.** The stats action surfaces `character_table.json` phase keyframes that no previous tool read: without `phase`/`level` it returns every elite phase's Lv1/LvMax panels plus max-trust and potential bonus summaries; with both it returns the exact interpolated panel at that level (linear between keyframes, rounded half away from zero — the community-verified in-game formula, calibrated against PRTS Wiki-published keyframe values for Amiya in the test suite). No new data files — the operator domain's caches apply unchanged.

- **Per-tier talent effects in `get_operator_basic_info`.** Each talent slot now carries its per-tier candidates — unlock elite phase, `unlock_level`, and raw zero-based `potential_rank` per variant — alongside the unchanged top-tier `name`/`description` headline; the markdown adds a compact annotation line (e.g. `精英1解锁；精英1 Lv55强化` or `精英1解锁；精英2强化；潜能5档强化`) while structured consumers get the full candidate list. Unlock levels above Lv1 are shown explicitly, and potential annotations use the player-facing rank (`potential_rank + 1`). Additive payload change only.

- **The NOTICE file now ships in every distribution artifact (#200).** npm packages, PyPI sdists/wheels, and Docker images carry the repository's third-party content and IP notices; packaging-only change with no runtime behavior impact.

### Changed

- **One operator-information entry point, still 24 MCP tools.** `get_operator_basic_info` accepts optional `action="basic"|"skills"|"stats"` (default `basic`). Existing name-only calls retain the basic profile; skills and panels are returned only when selected, with the same output-channel behavior. `phase` and `level` are accepted only for `stats` and must be supplied together or both omitted. The unreleased standalone skill/stat tool registrations are withdrawn.

### Fixed

- **Release identity parsing accepts the hyphen-joined upstream versionId format.** Upstream data versionIds changed from `YY-MM-DD-HH-MM-SS_hash` to a trailing-hyphen shape (`YY-MM-DD-HH-MM-SS-hash`) in October 2026, but the stored-identity parser only recognized the underscore shape. For any new-format source the anti-downgrade guarantee introduced in 2.7.3 silently degraded to plain string comparison: an installed `datarev` repair revision no longer refused a same-source plain release, and the identity checks guarding blind downloads and missing-zip recovery were bypassed. The suffix patterns now accept either separator, restoring tuple comparison for both formats. Release discovery and normal updates were already format-agnostic and are unchanged.

## [2.7.4] - 2026-09-15

### Added

#### Python

- **HTTP session idle eviction now honors `SESSION_IDLE_TIMEOUT_MS` (#193).** The Python HTTP transport previously delegated session lifecycle entirely to the MCP Python SDK without configuring its idle timeout, so idle sessions lived until client disconnect or process restart while the TypeScript side evicted them. The variable is read with the same semantics as TypeScript — unset falls back to 24h, a positive finite value is taken as milliseconds, anything else disables eviction — and passed to the SDK session manager, which now reaps idle sessions one timeout after their last request.

### Fixed

#### TypeScript

- **HTTP sessions were evicted after ~2× the configured idle timeout (#193).** When the idle timer fired with less than `SESSION_IDLE_TIMEOUT_MS` elapsed since the last request — guaranteed whenever any request followed `initialize`, since that request refreshes activity after the timer is armed — the timer was re-armed for a full period instead of the remaining time, so eviction landed at ~48h with the default 24h timeout and `/debug/metrics` could report an `oldest_age_ms` well beyond `idle_timeout_ms`. The timer now re-arms for the remaining idle budget. The variable is now parsed as a strict decimal (in `config.ts`), so non-decimal spellings such as `0x10` are rejected as invalid instead of being interpreted as hex and evicting almost immediately. The `sessionIdleTimeout` regression test now sends a post-initialize request and asserts eviction timing on both sides of the threshold, replacing a 2×-duration wait that passed under both behaviors.

## [2.7.3] - 2026-09-05

### Fixed

- Chapter listings and single-chapter summaries now consistently prefer valid LLM summaries, with official summaries as fallback.

- Data sync discovers immutable `datarev-<versionId>-r<N>` repair releases and orders updates by source version and revision, allowing corrected data to arrive through normal Auto-Sync without client configuration changes.

- Repair releases require matching manifests. Duplicate identities are rejected, and runtime and build selectors exclude drafts and prereleases.

- Recorded release identities continue to prevent downgrades when a cached ZIP is missing or invalid; recovery can download the same or a newer revision without an unverified Latest fallback.

### Changed

- Consolidated environment-variable and HTTP deployment guidance, and clarified the 1.7 LTS lifecycle policy.

## [2.7.2] - 2026-08-22

### Fixed

#### Python

- User-facing echoes of identifiers in not-found and validation messages now render with double quotes via `json.dumps(..., ensure_ascii=False)`, byte-identical to the TypeScript `JSON.stringify` rendering (stage / stage-enemy / item not-found, `threat_level` / search-scope / PRTS `direction` validation, image download guards, and the story `Event not found` / `Story not found` KeyErrors).

#### TypeScript

- User-visible id listings now sort in codepoint order through a shared `compareIds` comparator (new `data/sort.ts`), matching Python's `sorted()`: artwork lists (`artworkLocal` + `artworkMediawiki`), the item listing and item-search tie-breaks, the enemy listing tie-break, and the stage listing sorts. `localeCompare` ICU collation previously inverted punctuation pairs such as `1+.png` vs `1.png` and folded uppercase item ids (`AP_GAMEPLAY`) after lowercase ones, so `list_items` pagination order already diverged from Python on real data.

## [2.7.1] - 2026-08-18

### Fixed

- **Wrong-shape `building_data.json` degrades like corrupt JSON (#178).** A valid-JSON-but-wrong-shape `building_data.json` (list/null/scalar) previously escaped the tolerate-family as an `AttributeError` in `get_operator_basic_info` on Python and produced an empty-payload `building_skills` on TypeScript (a parity fork). A top-level shape guard now converts it to the same degradation family on both implementations: basic_info omits the field, and the `search` `building_skills` scope reports the degradation instead of crashing. On Python the scope's catch tuple also gains `ValueError`, so corrupt-JSON tables now degrade there too (previously they crashed the scope; `JSONDecodeError` is a `ValueError` subclass) — basic_info's corrupt-JSON handling from 2.7.0 is unchanged.

#### Python

- **Images sync applies the full AKDP delta chain (#179).** The syncer previously downloaded the baseline shards plus only the latest `images-delta-<currentVersion>.zip`, never enumerating intermediate delta releases. Once the factory publishes two or more non-empty deltas after a baseline, a fresh `LOCAL_IMAGE=true` install or a version-skipping sync built an incomplete generation and failed at the sha256 gate — after burning the ~1.5 GB baseline download (~5.1 GB with `ORIGINAL_IMAGE=true`). The syncer now enumerates every `images-*` delta release with `baselineVersion < v <= currentVersion` and applies the chain in version order; `index.json` `currentVersion` is authoritative and cross-checked against the latest delta tag (drift fails closed); a broken chain (missing delta asset, duplicate version) fails fast *before* the baseline download starts; release discovery paginates until the chain start is covered so the newest-100 page can no longer silently truncate the chain; and a fast-path generation only absorbs deltas newer than its own `currentVersion` — an index rollback behind the active generation now rebuilds from the baseline instead of reusing newer content. The atomic staging, sha256 verification, offline-fallback, and generation-prune semantics are unchanged. The existing tests were also rebuilt to exercise real zips against truthful indexes (the old mocks passed verification vacuously over empty artwork sets, which is how this bug escaped), and TypeScript gained its first `imagesSync` test coverage.

#### TypeScript

- **Images sync applies the full AKDP delta chain (#179).** The syncer previously downloaded the baseline shards plus only the latest `images-delta-<currentVersion>.zip`, never enumerating intermediate delta releases. Once the factory publishes two or more non-empty deltas after a baseline, a fresh `LOCAL_IMAGE=true` install or a version-skipping sync built an incomplete generation and failed at the sha256 gate — after burning the ~1.5 GB baseline download (~5.1 GB with `ORIGINAL_IMAGE=true`). The syncer now enumerates every `images-*` delta release with `baselineVersion < v <= currentVersion` and applies the chain in version order; `index.json` `currentVersion` is authoritative and cross-checked against the latest delta tag (drift fails closed); a broken chain (missing delta asset, duplicate version) fails fast *before* the baseline download starts; release discovery paginates until the chain start is covered so the newest-100 page can no longer silently truncate the chain; and a fast-path generation only absorbs deltas newer than its own `currentVersion` — an index rollback behind the active generation now rebuilds from the baseline instead of reusing newer content. The atomic staging, sha256 verification, offline-fallback, and generation-prune semantics are unchanged. The TypeScript side also gained its first `imagesSync` test coverage, mirroring the Python chain scenarios.

## [2.7.0] - 2026-08-15

### Added

#### Python

- **Operator base skills (基建技能).** `get_operator_basic_info` gains a `building_skills` payload field and a `## 基建技能` markdown section (skill name, facility, elite-phase unlock, markup-stripped effect description; the highest elite-phase variant per skill slot is kept). The unified `search` tool gains a `building_skills` scope for cross-operator lookup by facility, effect, or skill name (e.g. which operators boost trading-post efficiency). Backed by a new `data/building` module on the dataset-access contract (visible as the tenth `/debug/cache` module); `building_data.json` and `skin_table.json` are now validated entries of the AKDP `zh_CN-excel.zip` dataset contract. When `building_data.json` is absent (older user-supplied data roots), the basic_info payload omits the field and the scope reports no matches — no data error. The MCP tool surface stays at 24 (scope-enum extension only).

- **Bounded skin metadata in local artwork list.** `operator_artwork(action="list")` under `LOCAL_IMAGE=true` now joins each artwork with its `skin_table.json` entry and adds three nullable payload fields: `skin_group` (collection/theme), `acquisition`, and `description`; the markdown line appends `｜{skin_group}` when present. The MediaWiki backend is not enriched (its artwork_id is a wiki filename with no skin_table join key). Tool surface unchanged.

- **PyPI artifact verification in CD (#157).** The Python CD `github-release` job now verifies the published wheel and sdist sha256 against the digests PyPI recorded at upload (via the PyPI JSON API), polling through indexing delay, before creating the GitHub Release. Parity with the TypeScript npm-tarball verification added in #156.

#### TypeScript

- **Operator base skills (基建技能).** `get_operator_basic_info` gains a `building_skills` payload field and a `## 基建技能` markdown section (skill name, facility, elite-phase unlock, markup-stripped effect description; the highest elite-phase variant per skill slot is kept). The unified `search` tool gains a `building_skills` scope for cross-operator lookup by facility, effect, or skill name. Backed by a new `data/building.ts` module on the dataset-access contract (visible as the tenth `/debug/cache` module); `building_data.json` and `skin_table.json` are now validated entries of the AKDP `zh_CN-excel.zip` dataset contract. When `building_data.json` is absent (older user-supplied data roots), the basic_info payload omits the field and the scope reports no matches — no data error. The MCP tool surface stays at 24 (scope-enum extension only).

- **Bounded skin metadata in local artwork list.** `operator_artwork(action="list")` under `LOCAL_IMAGE=true` now joins each artwork with its `skin_table.json` entry and adds three nullable payload fields: `skin_group` (collection/theme), `acquisition`, and `description`; the markdown line appends `｜{skin_group}` when present; `CharSkinLike` widens accordingly. The MediaWiki backend is not enriched (its artwork_id is a wiki filename with no skin_table join key). Tool surface unchanged.

### Changed

#### Python

- **Artwork/images cluster split (P3.B).** `tools_artwork.py` (382 lines) shed its two data-source backends into `data/artwork_local` (local AKDP: char-id form aliases, index loading, realpath-guarded PNG reads), an extended `data/artwork_mediawiki` (absorbs the MediaWiki list/get orchestrations, fetching exclusively through the api client), and `data/artwork_format` (result shapes + shared list renderer); `tools_artwork` is now registration + dispatch + output-channel wrapping. Backends return message strings or outcome tuples, so data modules still import no output module. `data/images_sync` moved into the `sync/` tier as `sync/images_sync` (it is a sync state machine, not a data reader) — an import-path change for anyone importing `prts_mcp.data.images_sync` (consumers: startup_sync, tools_artwork). Its generation-filesystem state moved to `sync/generation_store` and shared atomic-write/prune primitives to `sync/primitives` (dedupes four JSON tmp+replace copies per side and unifies the two prune variants; images prune keeps skipping hidden staging dirs). The streaming shard download (`_download_large`) was lifted into `sync/transport.stream_cascading` with its 30-min deadline semantics unchanged. The eight underscore-"private" symbols images_sync imported across the sync tier are now public: `get_cascading`, `github_headers`, `url_candidates`, `list_releases`, `latest_release_by_prefix`, `asset_url`, `safe_extract_zip`, `with_archive_activation_lock` (the `data/sync` barrel re-exports the new names). **Edge-behavior deltas**: images generation prune now unlinks symlinked entries (a dangling link, whose target cannot be stat'ed, is still skipped — mirroring the release-tree prune variant) and tolerates a failing directory scan. The MCP tool surface is unchanged.

- **Enemy cluster split (P3.A).** `data/enemy` and `data/stage_enemy` shed their pure logic into four new 1:1 module pairs: `enemy_stats` (stat extraction + m_defined override merging), `enemy_render` (the repo's first render module — shared handbook card + stats block), `level_parser` (zh_CN-levels JSON parsing), and an extended `enemy_database` (level0_index projection). `stage_enemy` now consumes enemy/stage's shared cached accessors instead of re-loading the same JSON into parallel cache instances — its dataset shrinks to `enemy_appearance_index` only. **User-visible (debug)**: the `/debug/cache` `stage_enemy` section drops the four duplicated keys (`stage_table`/`enemy_handbook`/`enemy_database`/`enemy_name_to_id` — the data remains visible under the `enemy`/`stage` sections where it now lives). **User-visible (malformed-sync edges)**: when levels are configured but the underlying excel/levels inputs are absent or mis-shaped, stage tools now render `无数据库记录` (enemy_database.json absent) instead of a wrapped read error, and some failure-wrapper inner messages drift to the owning modules' wording — both implementations converge here (TS changed in the same way).

- **DatasetAccess contract (P1.B).** New `prts_mcp.data.dataset_access` (factory + named registry + `excel_store`/`levels_store`), `prts_mcp.data.gamedata_attrs` (`m_value` deduplicated from enemy/stage_enemy), and `prts_mcp.data.messages` (canonical missing-data / bounds / regex message builders). All seven gamedata-family modules (item, operator, enemy, stage, stage_enemy, images, search) migrate onto the contract; cache keys, named clear functions, and the payload-or-string surface are unchanged. `server.py`'s `/debug/cache` handler and `startup_sync`'s post-sync clear list now read the dataset registry instead of hand-enumerated module lists (output shape and key order unchanged — the projection uses an explicit fixed key order on both implementations, since registry insertion order is import-order-dependent). **User-visible**: item/stage missing-data messages now use the canonical family (auto-sync hint + GITHUB_TOKEN advice + path echo), replacing the "请检查 GAMEDATA_PATH 配置…" wording; enemy's divergent `无效的 limit/offset 参数：…，需 ≥ N。` validation strings unify to the canonical `limit 必须 >= 1。` family (and now also enforce limit ≤ 200, matching the tool-layer schema).

- Internal activation and cache-instrumentation symbols moved out of `prts_mcp.config` into dedicated modules — a visible import-path change for anyone importing these internals from `prts_mcp.config`: `activation_aware_cache`/`cache_stat` → `prts_mcp.cache_stats`; `activation_snapshot`/`check_activation_change`/`register_activation_listener` → `prts_mcp.activation`. The MCP tool surface (names/params/output) is unchanged (#162).

- HTTP transport and release-discovery leaves extracted from `prts_mcp.data.sync` into a new `prts_mcp.sync` tier (`sync.transport`, `sync.release_discovery`) — the only layer that issues data-sync HTTP (the PRTS Wiki API client in `api/` is unaffected). `data/sync` re-exports them during the P2.A→P2.B migration, so existing `prts_mcp.data.sync.*` import paths keep working; the release/archive/pair state machine remains in `data/sync` until P2.B. `check_latest_release` log lines now originate from `prts_mcp.sync.release_discovery`. The MCP tool surface is unchanged.

- The release-archive activation subsystem (cross-process lock + generation tree + staging + zip validate/extract + prune) and the release state machine (CacheMeta + asset download + manifest verify + `sync_release`) moved out of `prts_mcp.data.sync` into `prts_mcp.sync.release_activation` / `prts_mcp.sync.release`; shared spec/result types moved to `prts_mcp.sync._types` (back-edge avoidance). `data/sync` re-exports them and retains the GameData-pair state machine (moves to `sync.gamedata_pair` in P2.B.2). Release-path log lines now originate from `prts_mcp.sync.release`. The MCP tool surface is unchanged.

- The GameData-pair state machine (`sync_release_archive` / `sync_release_archive_pair` + pair load/save/init) moved to `prts_mcp.sync.gamedata_pair`, carrying both #152/#155 idempotency guards verbatim. `data/sync` is now a pure re-export barrel — the full sync state machine (transport, discovery, activation, release, pair) lives in `sync/`. The MCP tool surface is unchanged.

#### TypeScript

- **Artwork/images cluster split (P3.B).** `tools/artworkTools.ts` (453 lines) shed its two data-source backends into `data/artworkLocal` (local AKDP: char-id form aliases, index loading, realpath-guarded PNG reads), an extended `data/artworkMediawiki` (absorbs the MediaWiki list/get orchestrations, fetching exclusively through the api client), and `data/artworkFormat` (result shapes + shared list renderer); `tools/artworkTools` is now registration + dispatch + output-channel wrapping. `data/imagesSync` moved into the `sync/` tier as `sync/imagesSync` — an import-path change for anyone importing `./data/imagesSync.js` (consumers: startupSync, artworkTools). Its generation-filesystem state moved to `sync/generationStore` (with new unit tests — this file had zero coverage before) and shared atomic-write/prune primitives to `sync/primitives` (dedupes three JSON tmp+rename copies and unifies the two prune variants). The streaming shard download (`downloadLarge`) was lifted into `sync/transport.streamCascading` verbatim. **Edge-behavior deltas**: images generation prune now uses `lstat` semantics (symlinked entries are removed, aligned with the release-tree prune variant); a documented PY/TS divergence is now pinned by test — Python's generation-root containment resolves symlinks (`Path.resolve()`) while this side's `activeGenerationSync` is purely lexical (the downstream artwork doGet guard from #169 still contains actual file reads; D2 ledger candidate). The MCP tool surface is unchanged.

- **Enemy cluster split (P3.A).** `data/enemy.ts` and `data/stageEnemy.ts` shed their pure logic into new 1:1 module pairs: `enemyStats.ts` (stat extraction + mergeDefined + the deduplicated formatting shims `pythonFloatString`/`formatNumber` — previously four scattered private copies, now with the extract path's unconditional `f"{n:,}"` semantics preserved separately from the int-gated compact-stats variant), `enemyRender.ts` (shared handbook card + stats block with the TS-only `hasEnemyStatsContent` guard preserved), `levelParser.ts` (level JSON parsing; dedupes the two `parseLevel` copies), and `enemyDatabase.ts` gains `level0Index`. `stageEnemy.ts` consumes enemy/stage's exported accessors instead of parallel cache instances; its dataset shrinks to `enemy_appearance_index`. **User-visible (debug)**: the `/debug/cache` `stage_enemy` section drops the four duplicated keys. **User-visible (malformed-sync edges)**: when levels are configured but the underlying excel/levels inputs are absent or mis-shaped, stage tools now render `无数据库记录` (enemy_database.json absent) instead of a thrown read error, and some failure-wrapper inner messages drift to the owning modules' wording (previously TypeScript threw where Python degraded — both now converge).

- **DatasetAccess contract (P1.B).** New `data/datasetAccess.ts` (factory + named registry + `excelStore`/`levelsStore`), `data/gamedataAttrs.ts` (`mValue` deduplicated from enemy/stageEnemy, now with overloads preserving enemy's typed call sites), and `data/messages.ts` (canonical missing-data / bounds / regex message builders). All seven gamedata-family modules migrate onto the contract, retiring the hand-rolled `let` + `checkActivationChange()` + `CacheMetrics` scaffold (~200 lines; the tri-state `TableCache` post-guards were dead code — a throwing load always left the variable null, i.e. retry semantics — and are deleted); cache keys, named clear functions, and the payload-or-string surface are unchanged. `cacheStats.ts` now aggregates via the dataset registry behind an explicit fixed key order (identical to Python's projection; registry insertion order alone is import-order-dependent and does not leak into output). `/debug/cache` corrections that land as side effects, all aligning with Python: `operator`'s `handbook_table`/`charword_table` counts now count the inner dicts (`handbookDict`/`charWords`) instead of the top-level key (always 1); `stage`'s `zone_table` reports `loaded: false` when the zone file is absent (the old `_zoneTableFailed` boolean's behavior, preserved by the contract's loaded-null snapshot rule). **User-visible**: item/stage missing-data messages now use the canonical family; enemy's divergent `无效的 limit/offset 参数：…` validation strings unify to the canonical `limit 必须 >= 1。` family (also enforcing limit ≤ 200).

- Internal activation symbols (`withActivationSnapshot`/`checkActivationChange`/`registerActivationListener`) moved from `config.js` into a dedicated `activation.js` module — import them from `activation.js` instead of `config.js`. The MCP tool surface is unchanged (#162).

- HTTP transport and release-discovery leaves extracted from `data/sync.ts` into a new `sync/` tier (`sync/transport.ts`, `sync/releaseDiscovery.ts`) — the only layer that issues data-sync HTTP (the PRTS Wiki API client in `api/` is unaffected). `data/sync.ts` re-exports them during the P2.A→P2.B migration, so existing `./sync.js` import paths keep working; the release/archive/pair state machine remains in `data/sync.ts` until P2.B. The MCP tool surface is unchanged.

- The release-archive activation subsystem (cross-process lock + generation tree + staging + zip validate/extract + prune) and the release state machine (CacheMeta + asset download + manifest verify + `syncRelease`) moved out of `data/sync.ts` into `sync/releaseActivation.ts` / `sync/release.ts`; shared spec/result types + the `errorMessage` helper moved to `sync/types.ts` (back-edge avoidance — `errorMessage` is consumed by both release and releaseActivation). `data/sync.ts` re-exports them and retains the GameData-pair state machine (moves to `sync/gamedataPair` in P2.B.2). The MCP tool surface is unchanged.

- The GameData-pair state machine (`syncReleaseArchive` / `syncReleaseArchivePair` + pair load/save/init) moved to `sync/gamedataPair.ts`, carrying both #152/#155 idempotency guards verbatim. `data/sync.ts` is now a pure re-export barrel — the full sync state machine lives in `sync/`. The MCP tool surface is unchanged.

### Fixed

#### Python

- **Story tool text parity with the TypeScript implementation** (findings from the 2.7.0 E2E usability pass). `read_activity` now renders like the TS twin: a markdown `#` heading with a `（共 N 章，当前为部分内容）` partial marker, per-chapter `简介：` lines (previously dropped), an actionable `[还有更多章节，请调用 read_activity(event_id="…", page=N)]` footer hint, and the empty-activities message — replacing the old `【】`-bracket header with inline pagination wording. Not-found messages that echo an ID now use double quotes (`未找到活动："…"` / `未找到剧情："…"` / `未找到匹配的活动："…"`, matching the TS strings) instead of Python repr single quotes, and `read_story`'s not-found gains the `请通过 list_stories 确认章节 key。` suffix. `get_operator_memoirs` / `find_character_appearances` / `find_speakers_in` no longer wrap their KeyError messages in repr quotes. TypeScript behavior is unchanged (it is the canonical side); one suspected drift from the E2E pass (archive race text) turned out to be a preview-truncation artifact and needed no fix.

- Local artwork path containment: no Python behavior change — the TypeScript implementation's guard in `operator_artwork(action="get")` local mode was upgraded from a lexical check to realpath resolution, closing a symlink-escape (defense-in-depth: the sync's zip extraction only writes regular files, so no purely upstream-driven planting path existed) that the Python side (`Path.resolve()`-based) never had. Both implementations now enforce identical containment semantics.

- Activation-lock wait timeouts now raise a named `_ActivationLockTimeoutError` (a `TimeoutError` subclass, so existing `except TimeoutError` consumers keep working), re-exported from `prts_mcp.data.sync`; parity with the new TS `ActivationLockTimeoutError`. The error message is unchanged.

- Large-shard image downloads (`_download_large`) now use a **30-min per-mirror-attempt deadline** (default raised from 300 s), enforced by a `time.monotonic()` check in the chunk loop while chunks keep arriving; the same value remains the httpx per-operation timeout for connect/read stalls (unlike the TS twin's `AbortSignal.timeout`, which additionally aborts hard mid-read — so a mirror that stalls mid-read after long progress can hold a Python attempt for up to ~2× the budget). Previously Python had no wall-clock cap at all, so a connect or inter-chunk stall of >300 s failed fast while slow-but-progressing downloads ran unbounded. Tightening: a progressing attempt whose total duration exceeds 30 min now fails and cascades to the next mirror with a fresh budget; worst-case wait per dead mirror rises from 300 s to 1800 s. Only shard/delta downloads are affected — discovery (10 s), release assets (120 s) and lock waits (120 s) are unchanged.

- `GITHUB_MIRRORS` entries are now normalized identically in both implementations: surrounding whitespace is trimmed and all trailing slashes are stripped (previously Python kept whitespace inside an entry and TypeScript stripped only one trailing slash, so `https://ghproxy.net//` produced a broken `...//https://...` candidate that proxies reject). Entries left empty after normalization (e.g. `///`) are dropped by both sides.

- Gamedata listing tools (`list_enemies`/`get_enemy_appearances`/`list_stages`/`list_items`) now enforce `limit` (`1–200`) and `offset` (`≥ 0`) bounds at the framework layer via `Field(ge=, le=)`, matching the TypeScript Zod schema so out-of-range pagination is rejected consistently across implementations (#161).

#### TypeScript

- Story tool text parity: no TypeScript behavior change — the Python implementation's `read_activity` rendering, not-found quoting, and KeyError message surfacing were aligned to this side's strings (which are the canonical ones). One suspected drift from the 2.7.0 E2E pass (archive race text) was a preview-truncation artifact; both sides were already identical.

- **Local artwork path containment now resolves symlinks (realpath).** In `operator_artwork(action="get")` local mode, the guard that contains the index-declared `file` to the synced generation directory was purely lexical, so a symlink inside the generation directory pointing elsewhere on the host passed the check and was followed by the file read — the read would then exfiltrate that host file base64-encoded. Note the sync's zip extraction only ever writes regular files, so a purely upstream-driven escape had no on-disk planting path; this closes the gap as defense-in-depth and aligns the guard with the Python implementation (which already used `Path.resolve()`). Both paths are now `realpathSync`-resolved before the containment check; escapes fall into the existing `图片文件缺失` message.

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

- `read_activity` now validates page inputs consistently and returns a clear content-only message when the requested page is beyond an existing activity's range (#137).

#### Python

- Template rendering now preserves valid fields when another nested value renders empty, validates malformed MediaWiki response shapes and marker boundaries, and keeps unexpected local processing errors observable.

#### TypeScript

- Template rendering now preserves valid fields when another nested value renders empty and normalizes malformed MediaWiki response shapes and marker boundaries to the documented content-only fallback.

## [2.6.0] - 2026-08-09

### Added

#### Python

- **Cache instrumentation (`/debug/cache` endpoint).** Each data module exports `cache_stats()` returning per-cache `{loaded, count}` (and `bytes` for the MediaWiki image LRU). The read-only `/debug/cache` HTTP endpoint aggregates all nine modules for observability (#104).

#### TypeScript

- **Cache instrumentation (`/debug/cache` endpoint).** Each data module exports `getCacheStats()` returning per-cache `{loaded, count}` (and `bytes` for the image LRU). The read-only endpoint aggregates all nine modules (#104).

- **Aggregate runtime metrics for Issue #90.** The TypeScript Streamable HTTP server provides an opt-in `/debug/metrics` endpoint with process memory high-water, request/tool duration and error totals, session age/idle-timeout/lifecycle totals, and nine-domain cache hit/miss/invalidation counters. Metrics are aggregate-only and retain neither MCP arguments/results nor session identifiers.

- **Production cgroup sampler.** Added a systemd timer template that resolves the PRTS service cgroup dynamically and appends validated five-minute memory and runtime-metrics samples to JSONL, with log rotation and no public reverse-proxy route.

- **Six-session memory canary gate (#90).** The isolated loopback benchmark exercises archives, data search, story search, chapter/activity reads, and an actual artwork image retrieval across six concurrent sessions. It requires cache stability plus a quiescent request state and bounded RSS. Version-controlled same-host canary assets add a separate loopback service, authenticated temporary route, and cgroup limits of `MemoryHigh=1G` / `MemoryMax=1536M` without modifying the stable service.

### Fixed

#### Python

- **Artwork form and diagnostics boundaries (#123).** `operator_artwork` resolves the half-width and full-width-parenthesis spellings of `阿米娅(近卫)` and `阿米娅(医疗)` to their distinct artwork char IDs without changing name resolution for other tools. Opaque artwork tokens require an exact form match in both local and MediaWiki modes. `/debug/cache` now requires `PRTS_DEBUG_TOKEN` Bearer authentication and otherwise returns 404.

#### TypeScript

- `Readable.fromWeb` cast is narrowed from bare `any` to the exact parameter type via `Parameters<typeof Readable.fromWeb>[0]` (#100).

- **Artwork form and diagnostics boundaries (#123).** `operator_artwork` resolves the half-width and full-width-parenthesis spellings of `阿米娅(近卫)` and `阿米娅(医疗)` to their distinct artwork char IDs without changing name resolution for other tools. Opaque artwork tokens require an exact form match in both local and MediaWiki modes. `/debug/cache` and `/debug/metrics` now require `PRTS_DEBUG_TOKEN` Bearer authentication and otherwise return 404.

### Changed

#### Python

- Base illust label mapping (`BASE_ILLUST_LABELS`) consolidated to a single owner in `data/images.py`; `data/artwork_mediawiki.py` imports it instead of maintaining a duplicate (#100).

- **MCP SDK v2 and dual-era serving (#84).** Migrated to the exact `mcp[cli]==2.0.0` dependency and `MCPServer` API. Legacy initialize/session clients remain supported; a new stdio connection or HTTP request can instead select the stateless `2026-07-28` envelope, including `server/discover`, `tools/list`, and `tools/call` without initialize. Python result-model construction uses the SDK v2 snake_case API while preserving its camelCase wire fields.

#### TypeScript

- Cache debug projections now include process-lifetime `hits`, `misses`, and `clears` fields while preserving the existing nine-domain shape.

- **MCP SDK v2 and dual-era serving (#84).** Migrated to SDK v2. Legacy initialize/session clients remain supported; HTTP clients can opt into the stateless `2026-07-28` envelope for `server/discover`, `tools/list`, and `tools/call` without initialize or `Mcp-Session-Id`.

- Base illust label mapping (`BASE_ILLUST_LABELS`) is consolidated to a single owner in `data/images.ts`; `data/artworkMediawiki.ts` imports it instead of maintaining a duplicate (#100).

## [2.5.2] - 2026-08-09

### Security

- Updated the locked npm production dependency graph, including `@modelcontextprotocol/sdk` 1.30 and `adm-zip` 0.6, resolving the audited production advisories without a breaking SDK-major upgrade.

### Fixed

- **Current AKDP enemy databases.** `get_stage_enemies` and `get_enemy_info` now read the direct enemy-ID mapping emitted by current `zh_CN-levels.zip` releases, while retaining the legacy wrapper format.

- **Scalar story decisions.** A `Decision.options` string is returned as one complete choice line instead of being dropped or split into characters.

- **Artwork token ownership.** `operator_artwork(action="get")` rejects an artwork token belonging to another operator before reading local image data or making a MediaWiki request.

## [2.5.1] - 2026-08-07

### Fixed

- **Gamedata pair retry no longer fires on commit_sha mismatch.** When both the excel and levels archives are up-to-date but carry divergent `commit_sha` values (stale local metadata, not missing data), the sync no longer schedules dense 30s/120s/600s retries. The next periodic cycle resolves the metadata drift; only `offline_fallback` / `no_data` statuses trigger retries.

#### Python

- **Release manifest 404 handling.** When a mirror confirms a release has no `manifest.json` via HTTP 404, the sync skips that mirror cleanly instead of letting a later mirror's generic network 404 overwrite the explicit absence signal. A new `_AssetNotFoundError` distinguishes "this release genuinely has no manifest" from "we couldn't reach this mirror".

- **Image shard sha256 verification.** After downloading AKDP image shards, the sync verifies each wanted variant's sha256 before activation. A missing PNG for a wanted variant counts as a mismatch and blocks activation (previously silently skipped).

- **MCP `initialize` version handshake fallback.** When package metadata is unavailable (e.g. running from source without install), the handshake reports `0.0.0` instead of crashing on `PackageNotFoundError`.

#### TypeScript

- **Release manifest 404 handling.** When a mirror confirms a release has no `manifest.json` via HTTP 404, the sync skips that mirror cleanly instead of letting a later mirror's generic network 404 overwrite the explicit absence signal. A new `AssetNotFoundError` distinguishes "this release genuinely has no manifest" from "we couldn't reach this mirror".

- **Image shard sha256 verification.** After downloading AKDP image shards, the sync verifies each wanted variant's sha256 (now async) before activation. A missing PNG for a wanted variant counts as a mismatch and blocks activation (previously silently skipped).

### Changed

- CI upgraded to Node 24 (`actions/*` bumped to Node 24-compatible versions).

## [2.5.0] - 2026-08-07

### Added

- New `operator_artwork` tool (enabled by default). `action="list"` returns bounded metadata with semantic labels; `action="get"` returns one image as base64 `ImageContent` (default `large` variant, max 1024px). Default mode (`LOCAL_IMAGE=false`) fetches on-demand from PRTS MediaWiki under the full #85 security boundary (hostname/MIME/magic/1MiB/streaming/redirect) with a 256 MiB LRU cache (`PRTS_IMAGE_CACHE=true`). Set `LOCAL_IMAGE=true` to sync ~1.5 GB of AKDP local PNG assets; `ORIGINAL_IMAGE=true` adds full-resolution shards. MediaWiki labels via CharinfoV2 `时装N名称`; AKDP labels via `skin_table.json`. The `original` variant is rejected in MediaWiki mode (PRTS originals exceed the 1 MiB cap). Tool surface 23 → 24.

### Changed

- **Auto-sync data source switched to self-hosted `arknights-data-pipeline`.** The default sync now consumes `zh_CN-excel.zip`, `zh_CN-levels.zip`, and story `zh_CN.zip` Releases from `3aKHP/arknights-data-pipeline` (the factory repo). The legacy upstream repos are no longer data dependencies on the 2.5.0 line. Release manifest verification tightened so a partial or corrupt archive cannot be treated as healthy data.

#### TypeScript

- `tsx` devDependency updated from 4.21 to 4.23.

### Fixed

- **`operator_artwork` allimages pagination.** MediaWiki `allimages` now paginates with `aifrom` continuation (50 per page) to avoid silent truncation when an operator has more than 50 skin images.

#### Python

- **Data sync uses tag-prefix filtering instead of `/releases/latest`.** The `arknights-data-pipeline` repo now hosts both `data-*` and `images-*` GitHub Releases. `check_latest_release` switched from the `/releases/latest` endpoint to the releases list API with `data-` tag-prefix filtering, preventing silent sync stalls if GitHub auto-promotes an `images-*` release to "Latest". Shared `_list_releases` / `_latest_release_by_prefix` / `_asset_url` helpers were lifted from `images_sync` into `sync` to avoid duplication.

- **Product version reported in MCP `initialize` handshake.** The server now reports its actual package version via `importlib.metadata` instead of an empty placeholder, so MCP clients can display the correct version.

#### TypeScript

- **Data sync uses tag-prefix filtering instead of `/releases/latest`.** The `arknights-data-pipeline` repo now hosts both `data-*` and `images-*` GitHub Releases. `checkLatestRelease` switched from the `/releases/latest` endpoint to the releases list API with `data-` tag-prefix filtering, preventing silent sync stalls if GitHub auto-promotes an `images-*` release to "Latest". Shared `listReleases` / `latestReleaseByPrefix` / `assetUrl` helpers were lifted from `imagesSync` into `sync` to avoid duplication. CI `gh release download` now resolves the latest `data-*` tag before downloading.

- **TS stdio entry no longer starts an HTTP listener.** The stdio entry point (`server-stdio.ts`) previously imported from `server.ts`, whose module-load side effect called `app.listen()` — spawning a rogue HTTP server on the configured `PORT` alongside the stdio transport. Extracted a side-effect-free `server-core.ts` factory shared by both entry points.

- **Docker images volume for `LOCAL_IMAGE=true`.** All three Dockerfiles now create `/data/images` so the `LOCAL_IMAGE=true` sync path has a writable target directory when running with a named volume.

- **TS `{}` empty-object placeholder crash.** Upstream AKDP data sometimes emits `{}` instead of `[]` for array fields (`waves`, `fragments`, `actions`, `unlockCondition`, `talents`, `tagList`, etc.). TS `?? []` only catches `null`/`undefined`, so `{}` slipped through and crashed `.map()` / `for...of`. All 21 JSON-sourced `?? []` sites now use `Array.isArray(x) ? x : []` to match Python's falsy `or []` tolerance.

## [2.4.0] - 2026-07-29

### Fixed

#### Python

- Capped the MCP Python SDK below 2.0 so Docker and other unlocked `pip` installs retain the compatible `mcp.server.fastmcp` API.

### Added

- Added process-lifetime auto-sync: after the startup check, GameData excel, GameData levels, and StoryJson Releases are checked hourly without a service restart. `PRTS_AUTO_SYNC_INTERVAL_SECONDS` configures the interval or keeps startup-only behavior with `0`.

- Added archive activation metadata so an interrupted extraction is retried on the next cycle before the downloaded Release is treated as active.

- GameData excel and levels now become visible as one atomic generation, so tools never observe a mixed old/new pair while a periodic update is running.

- Shared-volume publication locks now renew their lease while held, preventing long downloads or extraction work from being mistaken for abandoned locks.

## [2.3.1] - 2026-07-10

### Changed

#### Python

- Kept the Python package version aligned with the TypeScript 2.3.1 security update.

### Security

#### TypeScript

- Updated transitive production dependencies to resolve known vulnerabilities in HTTP and JSON-schema support packages.

### Fixed

#### TypeScript

- Synchronized the `prts-mcp-ts-stdio` bin metadata in `package-lock.json`.

## [2.3.0] - 2026-07-08

### Added

#### Python

- Added Streamable HTTP transport: `PRTS_TRANSPORT=http` starts a Starlette + uvicorn server with `/mcp` endpoint, `/health` probe, and `HOST`/`PORT` env control (defaults `0.0.0.0:3000`). `stdio` remains the default. Breaks the 2.0 transport split — the Python implementation now supports both stdio and Streamable HTTP.

- Added `test_e2e_http.py` covering HTTP health, initialize + tools/list, and env-only output_channel behavior.

- Declared `starlette>=0.27` and `uvicorn>=0.31` as explicit dependencies (previously transitive via `mcp[cli]`).

#### TypeScript

- Added stdio transport support: new `prts-mcp-ts-stdio` npm bin and `ts/src/server-stdio.ts` entry point. Reuses the existing `createMcpServer` factory and `runStartupSync`; connects an `StdioServerTransport` for single-session local MCP clients (Claude Desktop, Claude Code, Cursor). Breaks the 2.0 transport split — the TypeScript implementation now supports both Streamable HTTP (existing `prts-mcp-ts` / `prts-mcp-ts-bun` bins) and stdio.

- Added `start:stdio` / `start:stdio:bun` npm scripts.

- Added `e2eStdio.test.ts` covering stdio initialize handshake, tools/list, and graceful error handling.

- Extended `smoke-package-bun.mjs` to assert the `prts-mcp-ts-stdio` bin shim is installed and non-empty after `npm pack` + `bun add`.

### Changed

#### Python

- Refactored `OUTPUT_CHANNEL` from a module-level constant to a `contextvars.ContextVar`, paving the way for transport-level overrides. Tool code is unchanged; `render_result` resolves the channel via `get_output_channel()` at call time. **Note**: Python HTTP output_channel is currently process-level (env-only) — FastMCP's session model makes per-request contextvars invisible to tool code. The TypeScript HTTP transport supports per-request resolution.

#### TypeScript

- `server.ts` now exports `createMcpServer`, `SERVER_VERSION`, and `log` (previously module-private) so the stdio entry point can reuse them without duplicating tool registration logic.

## [2.2.0] - 2026-07-08

### Changed

#### Python

- No user-facing Python changes. This release keeps the Python package version aligned with the 2.2.0 repository release (TypeScript default-runtime flip).

#### TypeScript

- Bun is now the default production runtime for the TypeScript implementation: the default `ts/Dockerfile`, the primary CI verification path (`verify-ts`), and the recommended Docker deployment all run under Bun (verified against Bun `1.3.14`). **Node.js remains a supported legacy/optional runtime** via the `prts-mcp-ts` npm bin (so `npx prts-mcp-ts` stays zero-dependency), `npm install -g`, and the new `ts/Dockerfile.node` build path. The npm publishing path is unchanged (`npm publish --provenance`, runtime-agnostic).

- Default npm scripts (`start`, `smoke:http`, `smoke:http:fixture`) now drive the Bun entrypoint; `start:bun` / `smoke:bun` / `smoke:bun:package` retained verbatim for 2.1.0 backward compatibility.

- CI matrix flipped: `verify-ts` is now Bun-based (type-check, build, runtime smoke, packed-package smoke); the `node:test` unit suite moved to a new `test-ts` job; `build-image-ts` builds the default Bun image; a new `build-image-ts-node` job covers the legacy Node image.

### Added

#### TypeScript

- Added `ts/Dockerfile.node` as the supported Node.js legacy Docker build path.

- Added Node legacy npm scripts: `start:node`, `smoke:http:node`, `smoke:http:fixture:node`, and `dev:bun` for Bun-native development.

- Added an explicit `bun.lock`/`package.json` drift check in `verify-ts` so dual-lockfile desync fails fast with an actionable message.

- Extended `build-image-ts` to also run on `release/**` pull requests so the default Bun image is validated before shipping to main.

### Fixed

#### TypeScript

- Fixed the default Docker image shipping without bundled fallback data: `.dockerignore`'s `*.zip` rule stripped the CI-pre-fetched `data/storyjson/zh_CN.zip` (and gamedata archives) from `COPY data/ data/`, leaving the container without offline storyjson fallback. Added negation rules so bundled data zips reach the image.

### Removed

#### TypeScript

- Removed the now-redundant `ts/Dockerfile.bun`; its content is promoted to the default `ts/Dockerfile`.

- Removed the `verify-ts-bun` and `build-image-ts-bun` CI jobs; their coverage is absorbed by the new Bun-default `verify-ts` and `build-image-ts`.

## [2.1.0] - 2026-07-07

### Changed

#### Python

- No user-facing Python changes. This release keeps the Python package version aligned with the 2.1.0 repository release.

#### TypeScript

- Promoted the Bun runtime and `ts/Dockerfile.bun` from candidate coverage to a supported optional TypeScript runtime path, verified against Bun `1.3.14`. Node/npm remains the default runtime, Dockerfile, and Trusted Publishing path.

### Added

#### TypeScript

- Added the `prts-mcp-ts-bun` public bin as the supported optional Bun runtime entry point. The default `prts-mcp-ts` bin remains Node.js-based.

- Added a packed-package Bun smoke test that runs `npm pack`, installs the tarball with Bun in a temporary project, starts `prts-mcp-ts-bun`, and reuses the HTTP MCP smoke harness.

## [2.0.2] - 2026-07-07

### Fixed

- `search_prts` now resolves redirect-like PRTS Wiki search hits to their target page when the search response lacks redirect metadata, while falling back to the original result if the follow-up lookup fails.

#### Python

- `search_prts` filters technical/wiki implementation pages more precisely and keeps `totalhits` stable even when visible results are filtered out.

#### TypeScript

- `search_prts` filters technical/wiki implementation pages more precisely and keeps `totalHits` stable even when visible results are filtered out.

### Added

#### TypeScript

- Added a reusable HTTP MCP smoke harness for the TypeScript server and CI coverage for Node, Bun, and the candidate Bun Docker image.

- Added an optional Bun candidate runtime path with Bun scripts, a committed `bun.lock`, `ts/Dockerfile.bun`, and CI smoke coverage. Node/npm remains the default TypeScript runtime and npm Trusted Publishing path.

## [2.0.1] - 2026-07-03

### Fixed

#### Python

- `list_story_events` no longer emits a spurious `structuredContent` wrapper when story data is not yet available, matching the other eight story tools (which already delivered the missing-data message as content-only text).

### Changed

#### TypeScript

- Content-only tool handlers now consistently route through the shared `textResult(...)` helper, keeping text-result construction centralized without changing the returned MCP payload shape.

## [2.0.0] - 2026-07-03

### Added

#### Python

- **Output channel design replaces the per-call `output_format` parameter (2.0 design decision).** The original roadmap proposed an optional `output_format=markdown|json` parameter with 2.0 flipping the default to `json`. **That shape was rejected during design.** The primary consumer is an LLM agent, and JSON inflates prompt tokens ~15–30% versus markdown — which would negate the context-budget savings the tool-surface consolidation delivers. 2.0 instead keeps markdown as the always-on `content` text and carries structured data on MCP's native `structuredContent` field, selected by a **connection-level** `output_channel` knob (`content` (default) / `structured` / `both`) via the `PRTS_OUTPUT_CHANNEL` env var. The default is **not** flipped to JSON. See [`docs/migration-1.x-to-2.0.md`](https://github.com/3aKHP/prts-mcp/blob/main/docs/migration-1.x-to-2.0.md) for the per-tool channel mapping and client configuration.

- **Output channel (2.0).** Optional structured-content delivery via MCP's native `structuredContent` channel, controlled by a connection-level `PRTS_OUTPUT_CHANNEL` env var (`content` (default) / `structured` / `both`). The default `content` channel preserves the human-readable markdown content for clients that only consume MCP `content`. Migrated tools intentionally change the MCP manifest/wire shape by replacing FastMCP's automatic `outputSchema={result:string}` plus `structuredContent={"result": markdown}` wrapper with explicit `CallToolResult` delivery, so capable clients no longer receive duplicate markdown unless `both` is selected. `list_stages` is the pilot tool; its `structuredContent` carries both raw enums (e.g. `type=ACTIVITY`) and rendered labels (`type_label=活动`), and legitimate empty pages (filter no-match / offset past end) return structured empty payloads while preserving the original markdown text. The remaining structural tools and the TypeScript implementation follow in subsequent commits. Note: `structured` mode is intended for deployments known to use a structuredContent-capable client — an incapable client (e.g. Chatbox) receives only a one-line summary, so leave the default `content` unless the client is confirmed capable.

- **Narrative-tool wire slimming (2.0).** The six narrative/prose tools (`get_operator_archives`, `get_operator_voicelines`, `read_story`, `read_activity`, `get_story_summary`, `prts_page`) migrated from `-> str` to explicit `CallToolResult` delivery via the new `text_result(markdown)` helper. Their content text is unchanged, but they no longer derive FastMCP's automatic `outputSchema` nor emit a duplicate `structuredContent={"result": markdown}` — narrative output has no useful structured form. The remaining structural tools keep their structured payloads behind `output_channel`.

- **Detail-tool structuredContent (2.0, P2b PR1).** The four detail tools (`get_operator_basic_info`, `get_enemy_info`, `get_stage_info`, `get_item_info`) migrated to the build/render split with real `structuredContent` payloads. `render_result` gains an optional `summary` override so detail tools (single-record, no `total`) can provide a meaningful one-liner in `structured` mode instead of the generic fallback. Their `structuredContent` carries both raw enums and rendered labels (e.g. `profession_raw=CASTER` + `profession=术师`), so downstream automation can filter on raw values while Chinese consumers get localized text. The list/fusion tools (`list_enemies`, `search`, …) and the `search` consolidation follow in P2b PR2/PR3.

- **Gamedata list/fusion structuredContent (2.0, P2b PR2a).** The four gamedata list/fusion tools (`list_enemies`, `list_items`, `get_stage_enemies`, `get_enemy_appearances`) migrated to the build/render split with real structuredContent. Listing payloads carry pagination metadata + filters (raw user input + normalized filter) + entries with chainable IDs and raw/label field pairs; the fusion tool (`get_stage_enemies`) carries per-enemy spawn counts, level, overwrite flag, and stats text. **Empty-result contract**: legitimate-but-empty results (filter no-match, offset past end) now return a structured payload `{total:0, entries:[]}` that the structured channel carries, while the content channel still emits the original human message verbatim — so structured consumers can uniformly rely on "empty ⇒ {total:0}". True errors (invalid params, missing data) stay content-only. The story-list/wiki-search tools and the heterogeneous `search` follow in P2b PR2b/PR3.

- **Story navigation and wiki-search structuredContent (2.0, P2b PR2b).** The six story/wiki navigation tools (`list_story_events`, `list_stories`, `get_operator_memoirs`, `find_character_appearances`, `find_speakers_in`, `search_prts`) migrated to explicit `CallToolResult` delivery with build/render payloads. Story payloads carry chainable event/story IDs, raw story entry tags, and boolean speaks/mentioned flags; `search_prts` now exposes `total` as MediaWiki `totalhits`, which can exceed the returned page of results. Legitimate empty results carry `{total:0}` on the structured channel while preserving the existing markdown text; invalid parameters, missing story data, and PRTS network failures remain content-only.

- **Search structuredContent (2.0, P3).** The remaining Python search tools (`search` and `search_stories`) migrated to explicit `CallToolResult` delivery with structured search envelopes. `search` now returns a stable outer envelope (`scope`, `pattern`, `total`, `results`) while keeping scope-specific entries for operators, enemies, stages, and items; each entry carries chainable IDs and the fields needed to re-render the existing markdown cards. `search_stories` now exposes raw filters and structured context lines with `is_match` flags plus `story_key` for follow-up reads. Legitimate no-match searches carry `{total:0, results:[]}` on the structured channel; invalid regexes, invalid filters, and missing data remain content-only. The all-tool outputSchema invariant is left to the dedicated PR4 test-layer follow-up.

#### TypeScript

- **Output channel design replaces the per-call `output_format` parameter (2.0 design decision).** The original roadmap proposed an optional `output_format=markdown|json` parameter with 2.0 flipping the default to `json`. **That shape was rejected during design.** The primary consumer is an LLM agent, and JSON inflates prompt tokens ~15–30% versus markdown — which would negate the context-budget savings the tool-surface consolidation delivers. 2.0 instead keeps markdown as the always-on `content` text and carries structured data on MCP's native `structuredContent` field, selected by a **connection-level** `output_channel` knob (`content` (default) / `structured` / `both`) via query string / `x-prts-output-channel` header / `PRTS_OUTPUT_CHANNEL` env. The default is **not** flipped to JSON. See [`docs/migration-1.x-to-2.0.md`](https://github.com/3aKHP/prts-mcp/blob/main/docs/migration-1.x-to-2.0.md) for the per-tool channel mapping and client configuration. _(The Python implementation additionally documents a "narrative-tool wire slimming" entry for dropping FastMCP's automatic `outputSchema={result:string}` wrapper; the TS transport has no equivalent auto-wrapper, so narrative tools are simply part of the content-only delivery path here.)_

- **Output channel pilot (2.0).** Streamable HTTP sessions can opt into `output_channel=structured` or `output_channel=both` via query string, `x-prts-output-channel` header, or `PRTS_OUTPUT_CHANNEL`. This first TS migration slice enables structuredContent for `list_stages` while preserving the default content-only markdown output, including legitimate empty pages (filter no-match / offset past end) as structured empty payloads.

- **Output channel coverage for structured data tools (2.0).** The remaining game-data and story navigation tools now support structuredContent in TS: operator/item/enemy/stage details and listings, stage-enemy fusion, story event/chapter listings, operator memoirs, character appearances, and event speaker counts.

- **Output channel coverage for search tools (2.0).** The TS `search`, `search_stories`, and `search_prts` tools now emit structuredContent in `structured`/`both` channels, including structured-empty payloads for legal no-match results and parity fixtures shared with the Python implementation.

### Changed

- **Parameter naming normalization (2.0, breaking).** Operator tools (`get_operator_archives`, `get_operator_voicelines`, `get_operator_basic_info`, `get_operator_memoirs`) now take `name` instead of `operator_name`, matching the `name` convention already used by the enemy/stage/item/character tools.

- **Unified search (2.0, breaking).** `search_data`, `search_enemies`, `search_stages`, and `search_items` are consolidated into a single `search(scope, pattern, max_results)` tool with a required `scope` enum (`operators` / `enemies` / `stages` / `items`). Story dialogue search remains a separate `search_stories` (its filters differ). Tool surface drops 32 → 28.

- **Unified PRTS page tool (2.0, breaking).** `read_prts_page`, `list_prts_sections`, `get_prts_categories`, `get_prts_links`, and `get_prts_template` are consolidated into a single `prts_page(page_title, action, ...)` tool with a required `action` enum (`read` / `sections` / `categories` / `links` / `template`). Wiki keyword search remains a separate `search_prts`. Tool surface drops 28 → 24.

- **Tool descriptions standardized (2.0).** All tool descriptions were rewritten to a consistent house style (verb-first purpose, output-shape note, at most one cross-reference, parameter semantics kept in the parameter schema) and trimmed ~20% to reduce context budget on smaller-context models. No change to tool names, parameters, or output format.

#### Python

- **`list_stories` absorbs the event-level summary (2.0, breaking).** `list_stories(event_id, include_summaries=True)` now prepends the event's LLM overview (from `event_summaries.json`) when present, on top of the per-chapter one-liners it already returned — making it a superset of the former `get_event_summary`. Tool surface drops 24 → 23.

#### TypeScript

- **`list_stories` absorbs the event-level summary (2.0, breaking).** `list_stories(event_id, include_summaries=true)` now prepends the event's LLM overview (from `event_summaries.json`) when present, on top of the per-chapter one-liners it already returned — making it a superset of the former `get_event_summary`. Tool surface drops 24 → 23.

- **Story empty-result wording aligned with Python (2.0).** TS story navigation tools now use the Python-compatible empty messages for event/chapter listings, character appearances, and speaker counts (including Python-style quoted filter values). This is an intentional TS-dev text change in otherwise content-compatible output-channel migration paths.

### Removed

- **`search_data`, `search_enemies`, `search_stages`, `search_items`, `list_search_scopes` (2.0, breaking).** Replaced by unified `search(scope, ...)`; the scope catalogue previously returned by `list_search_scopes` is folded into the `search` tool description.

- **`read_prts_page`, `list_prts_sections`, `get_prts_categories`, `get_prts_links`, `get_prts_template` (2.0, breaking).** Replaced by unified `prts_page(page_title, action, ...)`.

#### Python

- **`get_event_summary` (2.0, breaking).** Folded into `list_stories(include_summaries=True)`; `get_story_summary` (single-chapter deep summary) is unchanged.

#### TypeScript

- **`get_event_summary` (2.0, breaking).** Folded into `list_stories(include_summaries=true)`; `get_story_summary` (single-chapter deep summary) is unchanged.

## [1.7.2] - 2026-09-26

Maintenance release on the 1.7 LTS line (Python and TypeScript).

### Fixed

- Cache metadata saves are now atomic (unique tmp file + rename, no corruption from a crash mid-write), and release asset downloads use unique tmp names so concurrent processes no longer race on a shared `.tmp` file.

- `GITHUB_MIRRORS` entries are now normalized identically in both implementations: surrounding whitespace is trimmed and all trailing slashes are stripped (previously TypeScript stripped only one trailing slash, so `https://ghproxy.net//` produced a broken `...//https://...` candidate that proxies reject, and Python kept surrounding whitespace and filtered blank entries before normalizing). Entries left empty after normalization (e.g. `///`) are dropped by both sides.

- `get_enemy_info` / `get_stage_enemies` read the current upstream `enemy_database.json` direct-mapping shape again (enemy combat stats are restored); the legacy `enemies` wrapper shape remains supported.

- `get_stage_enemies` no-stats fallback no longer renders a doubled `战斗属性：战斗属性：` prefix.

#### Python

- `read_activity` now bounds `page` (`>= 1`) and `page_size` (`1-20`) at the framework layer via `Field(ge=, le=)`, matching the TypeScript Zod schema, so invalid pagination (e.g. `page_size=0`, which previously produced endless empty pages with `has_more=True`) is rejected before reaching the data layer.

- Gamedata listing tools (`list_enemies`/`get_enemy_appearances`/`list_stages`/`list_items`) now enforce `limit` (`1-200`) and `offset` (`>= 0`) bounds at the framework layer via `Field(ge=, le=)`, matching the TypeScript Zod schema so out-of-range pagination is rejected consistently across implementations.

- `get_operator_memoirs`, `find_character_appearances`, and `find_speakers_in` no longer return KeyError messages (unknown operator, operator without memoir data, unknown event) wrapped in Python repr quotes; the clean message text is surfaced bare, matching the TypeScript implementation.

- `release_meta.json` sync metadata is now interoperable when the Python and TypeScript runtimes share one data directory: both implementations read either key casing (`commit_sha`/`commitSha`, `fetched_at`/`fetchedAt`) with defensive field validation, and both write snake_case. Previously a TypeScript-written cache was discarded by Python (treated as missing) and a Python-written cache yielded an undefined commit SHA and NaN freshness in TypeScript (forced re-download). Unknown keys in the file are now tolerated instead of invalidating the cache.

- **Scalar story decisions.** A `Decision.options` string is returned as one complete choice line instead of being split into one bogus choice line per character.

- Cap the mcp SDK dependency to the compatible 1.x line (`mcp[cli]>=1.28,<2`) so fresh installs and Docker builds no longer resolve the incompatible 2.x major.

#### TypeScript

- **HTTP sessions were evicted after up to ~2× the configured idle timeout.** When the idle timer fired with less than `SESSION_IDLE_TIMEOUT_MS` elapsed since the last request — guaranteed whenever any request followed `initialize`, since that request refreshes activity after the timer is armed — the timer was re-armed for a full period instead of the remaining time, so eviction could land at ~48h with the default 24h timeout. The timer now re-arms for the remaining idle budget.

- **`SESSION_IDLE_TIMEOUT_MS` is now parsed as a strict decimal.** Non-decimal spellings such as `0x10` were previously accepted by `Number()` and interpreted as a millisecond-scale timeout, evicting sessions almost immediately. Invalid or non-positive values now disable idle eviction as documented.

- `release_meta.json` sync metadata is now interoperable when the Python and TypeScript runtimes share one data directory: both implementations read either key casing (`commit_sha`/`commitSha`, `fetched_at`/`fetchedAt`) with defensive field validation, and both write snake_case. Previously a TypeScript-written cache was discarded by Python (treated as missing) and a Python-written cache yielded an undefined commit SHA and NaN freshness in TypeScript (forced re-download). Python additionally tolerates unknown keys in the file instead of invalidating the cache.

- User-visible id listings (item listing and item search, enemy handbook tie-break, stage listings and stage search) now order ids by Unicode codepoint like the Python backend's `sorted()`, instead of ICU locale collation that folds uppercase ids after lowercase ones on sortId ties (e.g. `AP_GAMEPLAY` vs `ap_item_*`).

- User-supplied search patterns (`search`, `search_stories`, and the enemy/stage/item search scopes) now compile with the RegExp `/u` flag, so astral characters match as single codepoints like Python's Unicode-default `re`. Identity escapes that `/u` rejects (e.g. `\ `) now surface the existing invalid-regex error instead of being silently tolerated.

- **Scalar story decisions.** A `Decision.options` string is returned as one complete choice line instead of being silently dropped.

- Guarded JSON-sourced array reads against upstream `{}` empty-object placeholders: game data that encodes empty arrays as `{}` no longer crashes `get_stage_info` (unlock conditions), `get_stage_enemies` / `get_enemy_appearances` (level waves, fragments, actions, enemyDbRefs), enemy queries (handbook damage types/tags, database enemies/skills/blackboard), operator archives and basic info (story audio, stories, talents, candidates), and `get_item_info` (stage drop list). Affected fields are now treated as empty lists.

### Security

#### TypeScript

- Updated production dependencies to resolve current npm security advisories: `@modelcontextprotocol/sdk` to ^1.30.0 (staying on the v1 SDK line) and `adm-zip` to ^0.6.0 as direct dependencies, with `overrides` pinning the transitive `@hono/node-server`, `hono`, `body-parser`, `type-is`, `fast-uri`, `ip-address`, and `qs` packages to patched versions (`content-type` 2.x is pulled in through the patched `body-parser` / `type-is` chain). The dev-only `tsx` / `esbuild` update clears the dev esbuild advisory. `npm audit` now reports zero vulnerabilities.

## [1.7.1] - 2026-07-10

Maintenance release on the 1.7 LTS line (Python and TypeScript).

### Fixed

- `search_prts` now resolves redirect-like search results and filters technical pages more precisely while preserving the upstream total-hit count.

- Docker builds retain bundled game and story data archives for offline fallback.

### Security

#### TypeScript

- Updated locked production dependencies to resolve current npm security advisories.

## [1.7.0] - 2026-07-02

1.7.0 is the final 1.x feature release and the 1.7 LTS baseline. Future 1.7.x updates are limited to compatibility, security, data-sync, and critical bug fixes.

### Added

- **Story character tracking.** Two new tools reuse the existing story search index (no new data source): `find_character_appearances(name, scope?, max_events?)` returns chapters where a character **speaks** (dialog role exact match) or is **mentioned** (name substring in any line text); `find_speakers_in(event_id)` lists every speaker in an event with dialog line counts. Brings the tool surface to 32.

### Changed

#### Python

- **Module split: story and server god files.** `data/story.py` (916 lines) and `server.py` (914 lines) were split into focused submodules to meet the STYLE.md file-size guideline (~300 lines). `story.py` is now a re-export shim over `story_reader`, `story_search`, `story_memoir`, and `story_summary`. `server.py` is now a ~60-line entry point that delegates tool registration to `tools_prts`, `tools_gamedata`, and `tools_story`, and sync orchestration to `startup_sync`. All public symbols are re-exported — no behaviour change.

- **Dead code removal in sync.** The original GitHub raw file sync path (`sync_repo`, `download_files`, `check_upstream_sha`, `sync_all`) had no external callers and has been removed. `sync.py` shrank from 626 to 479 lines. Shared symbols (`CacheMeta`, `SyncResult`, `RepoSpec`, `GAMEDATA_FILES`) are retained for the Release-based sync path.

#### TypeScript

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

#### Python

- Runtime data sync now handles three datasets: `zh_CN-excel.zip`, `zh_CN-levels.zip`, and story `zh_CN.zip`. Docker images prewarm `data/gamedata-levels` alongside existing bundled fallback data.

#### TypeScript

- Runtime data sync now handles three datasets: `zh_CN-excel.zip`, `zh_CN-levels.zip`, and story `zh_CN.zip`. Docker images and npm packages prewarm `data/gamedata-levels` alongside existing bundled fallback data.

### Changed

- Stage drop formatting now resolves item IDs through `item_table.json` when available, e.g. `招聘许可（7001）`.

#### Python

- `fetch_gamedata.py` now prewarms both the excel and levels Release archives; `check_package_data.py` verifies bundled level data before packaging.

### Fixed

- **Release archive validation.** Archive sync validates required zip entries before extraction and rechecks required files after extraction, so a partial or corrupt `zh_CN-levels.zip` cannot be logged as healthy data.

- **Enemy appearance lookup memory profile.** `get_enemy_appearances` now scans for the requested enemy instead of permanently caching an all-enemy appearance index on first use.

#### Python

- **ZipStore lifecycle hardening.** `ZipStore` now supports explicit `close()` and context-manager use. Zip-path story helpers close their transient stores after each call, avoiding lingering `ZipFile` handles in repeated story reads/searches.

#### TypeScript

- **Release zip cache validation parity.** `syncRelease` now treats a cached zip that fails the dataset validator as unusable during network fallback, matching Python behavior and preventing corrupt story archives from being reported as healthy fallback data.

- **Session timer lifecycle.** Idle-session timers now call `unref()` so they do not keep an otherwise idle Node process alive.

## [1.5.0] - 2026-05-25

### Added

- **Stage data domain.** Three new tools — `list_stages`, `get_stage_info`, `search_stages` — sourced from `stage_table.json` (3319 stages) and `zone_table.json` (434 zones) in ArknightsGameData. `list_stages` supports zone and stage-type filters with pagination; `get_stage_info` returns detailed per-stage data (drops, unlocks, related variants); `search_stages` performs regex search across names, codes, descriptions, and types.

- Tool surface expanded from 21 to 24. `list_search_scopes` updated with stages and enemies entries.

- `stage_table.json` and `zone_table.json` added to sync manifests for integrity validation.

## [1.4.2] - 2026-05-25

### Changed

#### Python

- **Version sync with TS 1.4.2.** No Python-side changes — the session pool fix in this release applies only to the TypeScript Streamable HTTP transport. Python's stdio transport is not affected by the stale-session issue.

#### TypeScript

- **Session idle timeout default extended** from 30 minutes to 24 hours, reducing the chance of session eviction during normal interactive use. Configurable via `SESSION_IDLE_TIMEOUT_MS` env var.

- **Session idle timeout test** tightened to assert exact 404 status and error code, plus a new sub-test for init auto-recovery path.

### Fixed

#### TypeScript

- **Session pool 400 on stale session ID.** When a client reuses a session ID that was evicted by idle timeout or lost across server restart, the server now returns a spec-compliant 404 (error code `-32002`) with an LLM-actionable message instead of the previous 400 "Server not initialized". Initialize requests with a stale session ID auto-recover (strip old ID, treat as fresh handshake) — an intentional relaxation of MCP Streamable HTTP §3.2 for clients that don't retry with a fresh handshake on error.

## [1.4.1] - 2026-05-19

### Fixed

#### Python

- **ZipStore zip instance caching.** `ZipFile` is now cached instead of re-opened on every `exists()`/`read_text()` call. `exists()` switches from O(n) `namelist()` to O(1) `getinfo()`. In `search_stories` without an `event_id` filter this was ~3000 redundant zip opens, exceeding the 120 s MCP client timeout.

- **HTTP client reuse.** Module-level shared `httpx.AsyncClient` replaces per-call instantiation (7 call sites), recovering connection pooling and avoiding repeated TLS handshakes.

- **Rate limiter race condition.** Slot-based reservation scheme (matching the TS implementation) replaces the check-then-act pattern that could allow concurrent coroutines to exceed the configured rate.

- **Parsetree `.tail` preservation.** Text after nested `<comment>` and `<template>` elements in title/value extraction is now preserved instead of silently dropped.

- **Story search robustness.** `read_activity` gains `page >= 1` validation. Exception handling in `search_stories` and `read_activity` narrowed from bare `except Exception` to expected error types. Convenience wrappers (`search_stories`, `get_event_summary`, `get_story_summary`) now use `_story_store()` for consistency.

- **API error semantics.** `ValueError` replaced with `RuntimeError` for MediaWiki API errors, matching the Python exception hierarchy convention.

#### TypeScript

- **ZipStore zip instance caching.** `AdmZip` is now cached instead of re-instantiated on every `exists()`/`readText()` call. In `search_stories` without an `event_id` filter this was ~3000 redundant zip parses, exceeding the 120 s MCP client timeout.

- **Session memory leak.** `SESSION_IDLE_TIMEOUT_MS` (default 30 min) evicts MCP transports left behind by clients that disconnect without cleanly closing their session, preventing unbounded memory growth.

- **Enemy blackboard parity.** Filter/slice order corrected to match Python: slice first 6 entries, then filter null values.

- **HTML entity decoding.** `String.fromCodePoint` replaces `String.fromCharCode` for correct non-BMP Unicode handling. Named entity table extended from 6 hardcoded replacements to a lookup table with regex-based fallback for unrecognized entities.

- **Story search robustness.** `read_activity` gains `page >= 1` validation. Exception handling in `search_stories` and `read_activity` narrowed from bare `catch {}` to expected error types. Convenience wrappers (`searchStories`, `getEventSummary`, `getStorySummary`) now use `storyStore()` for consistency.

### Added

#### Python

- **E2E test suite.** MCP protocol-level test (`test_e2e.py`) covering handshake, tool surface (all 21 tools), operator data, and graceful degradation when optional data is unavailable.

#### TypeScript

- **E2E test suite.** MCP protocol-level test (`e2e.test.ts`) covering handshake, tool surface (all 21 tools), operator data, and graceful degradation when optional data is unavailable.

## [1.4.0] - 2026-05-19

### Added

#### Python

- **PRTS template data extraction.** `get_prts_template(page_title)` returns structured key-value data from MediaWiki template calls on a page. Supports `CharinfoV2` (operator), `敌人信息/common2` (enemy), `道具信息` (item), and other name=value pattern templates via `action=parse&prop=parsetree`. Only top-level templates are returned; nested templates inside a value are stripped from the value text.

- **Enemy handbook tools.** Three new tools backed by `enemy_handbook_table.json` with optional combat-stats merge from `levels/enemydata/enemy_database.json`:
  - `list_enemies(threat_level, limit, offset, full)` — paginated listing with optional filter by `boss` / `elite` / `normal`. Defaults to first 50 entries; `full=true` returns all 1500+ entries (discouraged for normal use).
  - `get_enemy_info(name)` — handbook entry merged with full combat stats: HP / ATK / DEF / RES, attack interval, mass level, status immunities, and skill list with cooldowns and blackboard parameters.
  - `search_enemies(pattern, max_results)` — regex search across enemy names, descriptions, and ability text.

#### TypeScript

- **PRTS template data extraction.** `get_prts_template(page_title)` returns structured key-value data from MediaWiki template calls on a page via `action=parse&prop=parsetree`. Only top-level templates are returned; nested templates inside values are stripped.

- **Enemy handbook tools.** Three new tools backed by `enemy_handbook_table.json` with optional combat-stats merge from `levels/enemydata/enemy_database.json`:
  - `list_enemies(threat_level?, limit, offset, full)` — paginated listing with `boss` / `elite` / `normal` filter. Defaults to first 50 entries.
  - `get_enemy_info(name)` — handbook entry merged with HP / ATK / DEF / RES, immunities, and skill list with blackboard params.
  - `search_enemies(pattern, max_results)` — regex search across enemy names, descriptions, and abilities.

## [1.3.1] - 2026-05-19

### Fixed

#### Python

- **Operator name-to-ID collision.** `_build_name_to_id()` in `operator.py` now filters to `char_*` entries only, preventing `trap_*` and `token_*` entries from silently overwriting real operator IDs when they share the same Chinese name. Fixes `get_operator_basic_info`, `get_operator_archives`, `get_operator_voicelines`, and `search_data` for affected operators (阿米娅, 森蚺, 狮蝎, 佩佩, 断罪者, etc.).

#### TypeScript

- **Operator name-to-ID collision.** `resolveCharId()` and `searchOperatorData()` now filter to `char_*` entries only, preventing `trap_*` and `token_*` entries from silently overwriting real operator IDs when they share the same Chinese name. Fixes `get_operator_basic_info`, `get_operator_archives`, `get_operator_voicelines`, and `search_data` for affected operators (阿米娅, 森蚺, 狮蝎, 佩佩, 断罪者, etc.).

## [1.3.0] - 2026-05-18

### Added

#### Python

- **PRTS page table of contents.** `list_prts_sections(page_title)` returns the section index for a wiki page. Each section is labeled with its index (e.g. `[1]`, `[T-1]` for template-transcluded), heading level, and title.

- **PRTS page categories.** `get_prts_categories(page_title)` returns the category tags for a wiki page (e.g. "干员", "术师干员").

- **PRTS page links.** `get_prts_links(page_title, direction, limit)` returns outbound links from a page or inbound backlinks to a page, with pagination.

#### TypeScript

- **PRTS page table of contents.** `list_prts_sections(page_title)` returns the section index for a wiki page.

- **PRTS page categories.** `get_prts_categories(page_title)` returns category tags for a wiki page.

- **PRTS page links.** `get_prts_links(page_title, direction, limit)` returns outbound links or inbound backlinks with pagination.

### Changed

#### Python

- **`read_prts_page` gains `section_index` parameter.** When set, only the specified section's plain-text content is returned instead of the full page. Backwards-compatible: the parameter defaults to `None` (whole page).

- **`search_prts` enhanced.** New `search_mode` parameter (`text` / `title`), `filter_technical` toggle (default `true`, filters `/spine`, `/data`, etc. technical pages), and `totalhits` count in search results. Backwards-compatible: new parameters have safe defaults.

#### TypeScript

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

#### Python

- **Search snippets are cleaned of HTML entities and JSON fragments.** Added `html.unescape` decoding and residual-wikitext cleanup after `strip_wikitext`.

#### TypeScript

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

#### Python

- `include_narration=false` in `read_story` now also filters unnamed speaker lines (stage directions displayed as `（旁白）：text`) instead of only filtering `type="narration"` sticker/subtitle/animation lines.

#### TypeScript

- `include_narration=false` in `readStory` now also excludes unnamed speaker lines (stage directions displayed as `（旁白）：text`) instead of only excluding `type="narration"` sticker/subtitle/animation lines.

## [1.0.0-beta.1] - 2026-05-12

## [1.0.0-alpha.2] - 2026-05-04

### Added

#### Python

- Bounded retry loop for startup sync: `offline_fallback` and `no_data` results schedule daemon-thread retries at 30s, 120s, and 600s before giving up until the next process start. Matches the existing TypeScript behavior so both implementations recover from transient network failures without manual restart.

- The first sync attempt is wrapped in `_run_initial_sync`, so an unexpected exception in `sync_release` / `sync_release_archive` no longer kills the daemon sync thread; it is logged and treated as retry-needed, matching the TypeScript `.catch(() => true)` baseline.

#### TypeScript

- Post-download zip integrity validation for the storyjson Release asset: every chapter referenced by `story_review_table.json` must exist in the downloaded zip before it replaces the cached copy. A missing or unreadable archive is rejected and falls through the normal `offline_fallback` / retry path instead of silently corrupting the local cache. Matches the pre-existing Python behavior.

## [1.0.0-alpha.1] - 2026-05-03

### Added

- Added a shared local dataset reader layer with directory, zip, and fallback stores.

- Added dataset specs for GameData excel and story JSON Release assets.

- Added bundled package-data verification for Docker and npm release pipelines.

### Changed

- Operator and story parsers now read through the new store abstraction while preserving current MCP tool names, parameters, and output formatting.

#### Python

- Runtime sync setup now consumes dataset specs instead of repeating Release metadata in server startup code and prewarm scripts.

#### TypeScript

- Runtime sync setup now consumes dataset specs instead of repeating Release metadata in server startup code.

## [0.4.2] - 2026-05-03

Implementation: Python.

### Changed

- ArknightsGameData auto-sync now downloads the `zh_CN-excel.zip` Release asset from `3aKHP/ArknightsGameData` and extracts it into the existing `gamedata` layout, aligning the game-data and story-data sync paths around GitHub Release archives.

- `fetch_gamedata.py` now prewarms bundled game data from the same Release archive instead of downloading individual raw JSON files.

- Python operator-data completeness now requires `story_review_table.json`, matching the TypeScript implementation and the new full-excel archive.

- Operator data config is re-resolved on each tool call, and table caches are cleared after startup auto-sync writes updated game data.

- Added regression coverage for data becoming available later in the same process.

## [0.4.0] - 2026-04-25

Implementation: Python.

### Added

- `GITHUB_MIRRORS` environment variable: comma-separated list of ghproxy-style proxy base URLs (e.g. `GITHUB_MIRRORS=https://ghproxy.net`) tried in order after the direct GitHub URL fails, enabling auto-sync on servers behind the GFW

- Blind download path in `sync_repo` and `sync_release`: when the GitHub API is unreachable but mirrors are configured and no local data exists, files are fetched directly via mirrors without a prior SHA check; storyjson uses the `releases/latest/download/` redirect URL which does not require an API call

### Changed

- `download_files` replaced shared `httpx.Client` with per-file `_get_cascading` calls to enable independent mirror cascade per file

## [0.3.3] - 2026-05-03

Implementation: TypeScript.

### Fixed

- The HTTP server now starts listening before GameData and story auto-sync run in the background, so slow GitHub Release downloads no longer leave systemd active while the port is unavailable.

## [0.3.2] - 2026-05-03

Implementation: TypeScript.

### Changed

- ArknightsGameData auto-sync now downloads the `zh_CN-excel.zip` Release asset from `3aKHP/ArknightsGameData` and extracts it into the existing `gamedata` layout, aligning the game-data and story-data sync paths around GitHub Release archives.

- npm bundled game data is now prewarmed through `python/scripts/fetch_gamedata.py`, using the same Release archive as runtime sync instead of downloading raw JSON files directly.

- Package metadata now targets `0.3.2` for this transition release.

- Operator table caches are cleared after startup auto-sync writes updated game data, and core operator behavior is covered by Node test-runner smoke tests.

## [0.3.0] - 2026-04-10

Implementation: TypeScript.

### Added

- `GITHUB_MIRRORS` environment variable: comma-separated list of ghproxy-style proxy base URLs (e.g. `GITHUB_MIRRORS=https://ghproxy.net`) tried in order after the direct GitHub URL fails, enabling auto-sync on servers behind the GFW

- Blind download path in `sync_release`: when the GitHub API is unreachable but mirrors are configured and no local data exists, the storyjson zip is fetched via the `releases/latest/download/` redirect URL which does not require an API call

- `list_story_events`, `list_stories`, `read_story`, `read_activity` tools for querying Arknights story scripts and event metadata from ArknightsStoryJson

- Bundled game data (`data/gamedata/`, `data/storyjson/`) included in the npm package so the server starts with offline fallback data without requiring a prior sync

- `config.ts` now resolves data paths relative to `import.meta.url` (package root) so bundled paths work correctly for both npm installs and Docker

### Fixed

- `story_review_table.json` added to bundled data and `cache_meta.json`; was missing after the story feature added it to `REQUIRED_OPERATOR_FILES`, causing `filesComplete()` to always return false for the bundled path

- Dead code (`STORYINFO` constant) removed; unused import dropped; null role format aligned with Python implementation

## [0.2.2] - 2026-04-10

Implementation: Python.

### Changed

- Repository restructured as a monorepo: Python implementation moved to `python/` subdirectory, shared game data resides in `data/gamedata/` at the repo root. No functional changes to the package itself.

### Fixed

- `fetch_gamedata.py` and `package_operator_data.py` path resolution updated for the new `python/` subdirectory location

- Docker build context updated to repo root so `COPY data/` correctly bundles game data into the image

## [0.2.1] - 2026-04-14

Implementation: Python.

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

#### Python

- GitHub-backed operator data sync via `src/prts_mcp/data/sync.py`, including upstream SHA checks, TTL-based cache reuse, atomic file replacement, and offline fallback behavior

- `scripts/fetch_gamedata.py` for prewarming the minimal operator dataset in CI, local development, and image-build workflows

- Optional `GITHUB_TOKEN` support for GitHub API requests to reduce anonymous rate-limit risk

- Docker/CI smoke-test coverage for the containerized MCP server, including a protocol-correct MCP initialize handshake

- Contributor-facing repository policy in `CONTRIBUTING.md`

#### TypeScript

- `get_operator_basic_info` tool exposing operator rarity, class, faction, and description from `character_table.json`

- Streamable HTTP transport (MCP 2025-03-26 spec) replacing the earlier SSE-based approach; endpoint at `/mcp`, health check at `/health`

- Docker image for self-hosted HTTP server deployment

- npm package (`prts-mcp-ts`) for `npx` / global install usage

- GitHub Actions CD workflow (`cd-ts.yml`) publishing to npm with Trusted Publishing and pushing Docker image to GHCR

### Changed

#### Python

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

#### Python

- `local_repo.jsonc` re-added to `.gitignore`; the previous refactor had inadvertently removed it, leaving the file exposed to accidental staging

### Removed

#### Python

- `local_repo.example.jsonc` deleted — the file had no reader code and was no longer referenced by any documentation or tooling

### Deprecated

#### Python

- `scripts/package_operator_data.py` is retained only as a compatibility path and is no longer the recommended primary workflow

## [0.1.0] - 2026-03-18

### Added

- PRTS MediaWiki API integration with rate limiting and custom User-Agent

- Wikitext sanitizer for stripping templates, file links, and HTML tags

#### Python

- FastMCP server with 4 tools: `search_prts`, `read_prts_page`, `get_operator_archives`, `get_operator_voicelines`

- Local ArknightsGameData JSON reader with LRU caching (character_table, handbook_info_table, charword_table)

- Config module with env var / local_repo.jsonc fallback

- Dockerfile for stdio-based containerized deployment

- Project metadata via pyproject.toml (PEP 621)

#### TypeScript

- FastMCP TypeScript server with 4 tools: `search_prts`, `read_prts_page`, `get_operator_archives`, `get_operator_voicelines`

- Local ArknightsGameData JSON reader with LRU caching
