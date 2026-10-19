# PRTS-MCP Roadmap

The current public stable release is `3.1.1`, a single native Rust implementation that preserves the frozen TS/v2.8.1 tool contract. Active development continues on `develop` (`3.1.2-dev.0`). [简体中文](ROADMAP.zh-CN.md).

## 3.1 — Optional SQLite Data Backend

JSON/ZIP remains the default, preserving existing paths, volumes and sync switches. Version 3.1 provides opt-in SQLite with complete source retention, bounded story scans and independent atomic sync. Observe production use before the planned 3.2 default switch; JSON remains supported throughout 3.x.

## 3.0 Rust Migration

| Milestone | Scope | Status |
| --- | --- | --- |
| **M0** | Freeze 3.0 scope, entry defaults, repository root layout, LTS policy, and distribution architecture. | Complete |
| **M1A** | Establish `lts/2.8` and isolate legacy maintenance publishing from stable `latest`. | Complete |
| **M1B** | Import the Rust implementation to the repository root, remove legacy source trees from `develop`, and set up Rust CI and source packaging. | Complete (PR #228) |
| **M2A** | Build, audit ABI baselines, and run standalone native archives across all 5 target platforms ([NATIVE-PLATFORMS.md](docs/dev/NATIVE-PLATFORMS.md)). | Complete (PR #229) |
| **M2B** | Package `prts-mcp`, `prts-mcp-ts`, shared runtime/fallback data, and 5 platform packages for npm ([NPM-DISTRIBUTION.md](docs/dev/NPM-DISTRIBUTION.md)). | Complete |
| **M2C** | Build and verify Linux `x64`/`arm64` Docker images and legacy volume compatibility ([DOCKER-DISTRIBUTION.md](docs/dev/DOCKER-DISTRIBUTION.md)). | Complete |
| **M3** | Release candidate packaging, single-version enforcement, and isolated CD workflows ([RELEASE-CANDIDATES.md](docs/dev/RELEASE-CANDIDATES.md)). | Complete ([`3.0.0-alpha.3`](https://github.com/3aKHP/prts-mcp/releases/tag/v3.0.0-alpha.3)) |
| **M4** | Real-client E2E validation, data/image sync verification, and upgrade/rollback checks against 2.8.1 volumes ([E2E.md](docs/dev/E2E.md)). | Complete |
| **M5** | RC production lifecycle observation and targeted stress testing, stable `3.0.0` release, promotion of `latest` channel tags, and back-merge to `develop`. | Complete ([`3.0.0`](https://github.com/3aKHP/prts-mcp/releases/tag/v3.0.0)) |

## Post-3.0 Backlog

Version 3.0 focuses strictly on the Rust runtime migration and distribution parity. New features and architectural additions are deferred until after 3.0.0 stable and will be prioritized one theme at a time:

- **crates.io publication**: Cargo source packaging is already verified in CI; publishing `prts-mcp` to crates.io will be executed as a standalone channel task after M5.
- **Management CLI**: Dedicated CLI flags and administrative subcommands (`--version`, `--help`, cache/sync inspection).
- **New tools and data domains**: Recruitment tag reverse-lookup, operator module (模组) data, skill upgrade material costs, and attack-range visualizations.
- **Data resilience & AKDP integration**: Backup object-storage mirrors and further pipeline/image optimizations.

## Maintenance Policy

Both `lts/2.8` (24 tools) and `lts/1.7` (32 tools) are maintained through **2027-07-02**. They accept only compatibility, security, data-sync, and critical bug fixes, and never advance stable `latest` tags. Applicable fixes from LTS branches are ported individually to Rust on `develop` rather than merged across branch trees. Full versioning and LTS rules are documented in [VERSIONING.md](docs/dev/VERSIONING.md) and [LTS.md](docs/dev/LTS.md).

---

## Delivered Milestones and Historical Design Records

The sections below preserve the design records of major 1.x and 2.x milestones at the time they shipped. For the complete version-by-version changelog, see [CHANGELOG.md](CHANGELOG.md) and [STATUS.md](STATUS.md).

### 1.6.0 — Stage Cross-Source Fusion + Item/Material Domain

Shipped 2026-05-28. See the [project CHANGELOG](CHANGELOG.md) for release details.

**Stage cross-source fusion**
- `get_stage_enemies(stage_id)` — enemies in that stage with **stage-specific** stats (not the level-0 default exposed by `get_enemy_info`).
- `get_enemy_appearances(name)` — reverse lookup: which stages feature this enemy.
- `get_enemy_info(name)` gains an optional `stage_id` parameter that returns stats for that stage's level variant.

**Main theme: item data domain**
- `list_items(category?)` — items grouped by category (materials, devices, chips, etc.).
- `get_item_info(name)` — item details: usage, obtain methods.
- `search_items(pattern)` — regex search.

### 1.7.0 — Story Character Tracking (LTS)

**Story character tracking (no new data source — indexes existing story JSON)**
- `find_character_appearances(name, scope?, max_events?)` — chapters / events where the character speaks (dialog role exact match) or is mentioned (name substring in any line text). Shipped in 1.7.0.
- `find_speakers_in(event_id)` — every speaker who appears in an event, with dialog line counts. Shipped in 1.7.0.

1.7.0 is the final 1.x feature release. The previously planned operator-depth items are deferred to the 2.0 tool-surface redesign instead of being added as more 1.x tools.

### 2.0 Boundary Changes

Three structural shifts that warrant a major bump.

#### Tool surface consolidation (context budget)

The 1.x tool surface reached 32 tools by the 1.7.0 LTS release. For long-context flagship models this is fine; for 128K-class models, every additional tool schema eats into the prompt budget and hurts tool-selection accuracy. 2.0 consolidates server-side by *schema shape* — merging tools that share parameter structure and output shape, keeping tools whose semantics genuinely differ — and drops the 32 → **23 tools** without losing capability.

**Background**: MCP currently has no protocol-level support for deferred tool loading. Closed proposals: lazy hydration (#1978), lazyRegistration (#2376). Open drafts: tool-search query (#1821), token-bloat mitigations (#1576). Claude Code's ToolSearch is an Anthropic-API-level feature (`tool_reference` blocks), not portable to Cursor/Cline/Chatbox.

**Delivered in 2.0**:

- `search(scope, pattern, max_results)` consolidates `search_data`, `search_enemies`, `search_stages`, `search_items`, and `list_search_scopes` into one tool keyed on a `scope` enum (`operators` / `enemies` / `stages` / `items`). Story dialogue search remains the separate `search_stories` tool, because its filters (character, line type, context lines) differ in shape.
- `prts_page(page_title, action, ...)` consolidates `read_prts_page`, `list_prts_sections`, `get_prts_categories`, `get_prts_links`, and `get_prts_template` into one tool keyed on an `action` enum.
- `list_stories(event_id, include_summaries=true)` now prepends the event-level LLM overview, absorbing the former `get_event_summary`. The single-chapter deep summary tool `get_story_summary` is unchanged.
- The deprecated legacy aliases behind these three consolidations are dropped from the 2.0 tool surface. The 1.7 LTS line keeps the existing 32-tool surface.

**What was explicitly NOT consolidated**:

- Operator triplet (`get_operator_archives` / `voicelines` / `basic_info`): outputs differ in shape and length; merging hurts LLM selection accuracy more than it saves context.
- Enemy pair (`list_enemies` / `get_enemy_info`): same reason. (The enemy search tool `search_enemies` was folded into the cross-domain `search(scope="enemies")` as described above.)
- Story tools (`read_story` / `read_activity` / `get_story_summary`): genuinely distinct actions on related-but-different data.

The bar for consolidation: same parameter shape, similar output length and structure, an LLM choosing between them today is choosing between near-synonyms.

#### Output channel (structuredContent)

2.0 adds structured output via MCP's native `structuredContent` field. The control plane is a single **connection-level** `output_channel` knob (`content` (default) / `structured` / `both`), set via the `PRTS_OUTPUT_CHANNEL` env var on Python and via query string / header / env on TypeScript. Structural tools (17) carry real structured payloads with chainable IDs and raw/label field pairs; narrative tools (6) stay content-only. The default `content` channel preserves the 1.x human-readable markdown output, so incapable clients (e.g. Chatbox) are unaffected without configuration.

**Design choice — channel, not a per-call format parameter.** The original roadmap proposed a per-call `output_format=markdown|json` parameter with 2.0 flipping the default to `json`. **That shape was rejected during design.** The primary consumer is an LLM agent, and JSON inflates prompt tokens ~15–30% versus markdown — which would negate the context-budget savings the tool-surface consolidation was built to deliver. Instead, markdown stays the always-on `content` text and structured data rides a separate channel; the two axes are orthogonal. The default is **not** flipped to JSON.

See [the 2.0 migration guide](docs/migration-1.x-to-2.0.md) for the per-tool channel mapping and client configuration.

#### Implementation parity (Python ↔ TypeScript)

2.0 narrows, but does not remove, the de-facto role split between the two implementations. Delivered in 2.0:

- npm and PyPI packages have an equivalent **capability surface** — the same 23 tool names, parameters, structuredContent payloads, and parity fixtures shared across both implementations.
- Environment variable names and defaults are unified (`PRTS_OUTPUT_CHANNEL`, `GAMEDATA_PATH`, `STORYJSON_PATH`, `GITHUB_TOKEN`, `GITHUB_MIRRORS`).

**Cross-transport parity — delivered in 2.3.0.** The original goal that both implementations support stdio **and** Streamable HTTP (Python gaining HTTP, TypeScript gaining stdio) was deferred beyond 2.0 and shipped in 2.3.0. Python selects transport via `PRTS_TRANSPORT` (stdio default | http); TypeScript selects via bin (`prts-mcp-ts`[-bun] = HTTP, `prts-mcp-ts-stdio` = stdio). Since 2.3.0 the deployment guidance is "choose by use case, not by language."

#### Cleanup

- Drop any 0.x-compat shims that survive into late 1.x.
- Drop the deprecated tool aliases introduced by the 2.0 migration plan (see consolidation section above).

#### 2.0 Non-Goals

- Not rewriting the MCP protocol layer.
- Not introducing new transports beyond stdio + HTTP.
- Not breaking data-sync semantics.
- **Not implementing a custom deferred-tool-loading scheme.** If MCP spec standardizes one (e.g. SEP-1821 merges), we adopt it; otherwise consolidation + description optimization is our answer.

---

### 2.7.0 — Shipped 2026-08-15

The former draft items for operator base skills (`get_operator_basic_info` carrying a bounded `building_skills` section, plus a `building_skills` scope on `search`) and skin/artwork metadata shipped in 2.7.0 — see the [project CHANGELOG](CHANGELOG.md) for details. The `operator_artwork(action="list")` skin-metadata enrichment under `LOCAL_IMAGE=true` was pulled forward from the former 2.8.0 candidate; that 2.8.0 placeholder was a target version only and never carried a theme.

### 2.8.0 — Shipped 2026-10-10

Theme: closed the three gaps in operator numeric queries — level-specific panels, per-level skill effects, and per-tier talent effects. See the [project CHANGELOG](CHANGELOG.md) for the shipped details.

- `get_operator_basic_info(name, action="skills")`: per-level effects of an operator's combat skills (Lv1-7 plus each mastery rank). `skill_table.json` is promoted to a validated dataset-contract entry.
- `get_operator_basic_info(name, action="stats", phase?, level?)`: an operator's panel at a specific elite phase and level, linearly interpolated between keyframes and calibrated against published PRTS Wiki panel values. Omitting phase/level returns every elite phase's Lv1/max panels plus trust/potential bonus summaries.
- `get_operator_basic_info` talent section additive extension: each talent slot gains per-tier candidates (unlock phase/level, potential rank); the existing top-tier `name`/`description` fields keep their semantics.
- `search` gains a `skills` scope: cross-operator keyword lookup over skill effects.
- The tool surface stays at 24. Skills and panels use an optional action on `get_operator_basic_info`; default `basic` retains the existing short profile, and each call returns only the selected content.
- This release excluded skill upgrade material costs, modules, and attack-range shapes; the 1.7 LTS tool surface did not change. Implementation-level details (data paths, placeholder syntax, interpolation and calibration specifics) live in the feature PRs' CHANGELOG entries.

### 2.8.1 — Shipped 2026-10-11

Roguelike story supplement catalogs now expose six events through existing story tools, including discovery, chapter reading, search, and character tracking. Older packs without the optional catalog remain supported; the tool count stays at 24.
