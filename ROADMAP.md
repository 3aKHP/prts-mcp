# PRTS-MCP Roadmap

_Last updated: 2026-07-02_ · [中文版](ROADMAP.zh-CN.md)

PRTS-MCP is past 1.0. Version 1.7.0 is the final 1.x feature release and the 1.7 LTS baseline. This document tracks **what comes next** — not what has shipped. For shipped features, see the Python and TypeScript CHANGELOGs.

## Current Release

- Python: `1.7.0` LTS
- TypeScript: `1.7.0` LTS
- `dev` branch current target after the LTS release: `2.0.0-dev`
- 32 public MCP tools, frozen in the 1.7 LTS line (CI-enforced).
- See [migration guide](docs/migration-0.x-to-1.0.md) for the
  0.x → 1.0 transition.

## 1.x Compatibility Contract

What stays stable through 1.7.x:

- Tool names and required parameters.
- Response **format** (markdown shape), though wording/details may evolve for
  fixes.
- `GAMEDATA_PATH` and `STORYJSON_PATH` semantics.
- Auto-sync from GitHub Releases as the default data source.

What may change in 1.7.x maintenance releases:

- Compatibility and security fixes.
- Data-sync resilience and upstream data compatibility fixes.
- Critical bug fixes that preserve existing tool names, required parameters,
  and default output format.

## 1.x Patch Policy

Patch releases on the 1.7 LTS line are limited to bug fixes, documentation, compatibility, security, and data-sync maintenance. **No new tools, no new required parameters, and no default output-format changes.**

## 1.x Non-Goals

- Shipping every Arknights data table — pick what's useful for fan creation.
- Embedding large fallback data in PyPI wheels.
- Replacing GitHub-Release-based sync with a different hosting model.
- Adding LLM-generated content as a required runtime dependency.

---

## Minor Release Plan

Each minor version carries one main data domain. Cross-source fusion tools ship with or after the version that introduces their dependency.

### 1.6.0 — Stage Cross-Source Fusion + Item/Material Domain

Shipped 2026-05-28. See the Python and TypeScript CHANGELOGs for release details.

**Stage cross-source fusion**
- `get_stage_enemies(stage_id)` — enemies in that stage with **stage-specific**
  stats (not the level-0 default exposed by `get_enemy_info`).
- `get_enemy_appearances(name)` — reverse lookup: which stages feature this enemy.
- `get_enemy_info(name)` gains an optional `stage_id` parameter that returns
  stats for that stage's level variant.

**Main: item data domain**
- `list_items(category?)` — items grouped by category (materials, devices,
  chips, etc.).
- `get_item_info(name)` — item details: usage, obtain methods.
- `search_items(pattern)` — regex search.

### 1.7.0 — Story Character Tracking (LTS)

**Story character tracking (no new data source — indexes existing story JSON)**
- `find_character_appearances(name, scope?, max_events?)` — chapters / events
  where the character speaks (dialog role exact match) or is mentioned (name
  substring in any line text). Implemented on `dev` for 1.7.0.
- `find_speakers_in(event_id)` — every speaker who appears in an event, with
  dialog line counts. Implemented on `dev` for 1.7.0.

1.7.0 is the final 1.x feature release. The previously planned operator-depth items are deferred to the 2.0 tool-surface redesign instead of being added as more 1.x tools.

### Deferred Beyond 1.7 LTS

The following feature ideas remain useful but are no longer scheduled as 1.x minor releases. They should be reconsidered under the 2.0 tool model:

**Operator depth**
- Base skills and cross-operator building-skill search.
- Skin list and skin descriptions.

**Wiki enhancements + recruitment**

**Main: PRTS Wiki enhancements (group B in one release)**
- `get_prts_images(page_title)` — image list via `prop=images`.
- `resolve_prts_redirect(title)` — redirect resolution; addresses the
  long-standing 1.1.1 "Known remaining issues" item.

**Recruitment**
- `query_recruit_tags(tags)` — reverse lookup: which operators a given
  tag combination can produce.

---

## 1.7 LTS Maintenance Line

1.7.x releases maintain the LTS baseline without expanding the public tool surface.

| Allowed in 1.7.x | Examples |
|------------------|----------|
| Compatibility fixes | Upstream schema drift, client handshake compatibility, packaging metadata |
| Security fixes | Dependency CVEs, unsafe parsing behavior, transport hardening |
| Data-sync fixes | GitHub Release lookup, zip validation, retry/fallback behavior |
| Critical bug fixes | Incorrect results, crashes, resource leaks, parity regressions |
| Documentation fixes | LTS support notes, deployment corrections, migration clarifications |

No new capabilities are planned for 1.7.x. Former patch-line ideas such as search unification, PRTS page unification, JSON output defaults, and golden test infrastructure now belong to 2.0 planning unless they are required to fix a 1.7 LTS regression.

---

## 2.0 Boundary Changes

Three structural shifts that warrant a major bump.

### Tool surface consolidation (context budget)

The 1.x tool surface reached 32 tools by the 1.7.0 LTS release. For long-context flagship models this is fine; for 128K-class models, every additional tool schema eats into the prompt budget and hurts tool-selection accuracy.

**Background**: MCP currently has no protocol-level support for deferred tool loading. Closed proposals: lazy hydration (#1978), lazyRegistration (#2376). Open drafts: tool-search query (#1821), token-bloat mitigations (#1576). Claude Code's ToolSearch is an Anthropic-API-level feature (`tool_reference` blocks), not portable to Cursor/Cline/Chatbox.

**Approach**: server-side consolidation by *schema shape*, not by data domain. Merge tools that share parameter structure and output shape; keep tools whose semantics genuinely differ. Estimated reduction: 24 → ~16 tools (about a third) without losing capability.

**Phase 1 (2.0 migration design)**:

- `search(scope, pattern, ...)` consolidates `search_data`,
  `search_stories`, `search_enemies`, `list_search_scopes`. Same
  parameter shape across all four; differs only in `scope`.
- `prts_page(page_title, action, ...)` consolidates `read_prts_page`,
  `list_prts_sections`, `get_prts_categories`, `get_prts_links`,
  `get_prts_template`. Single primary key; action selects the
  sub-operation.

**Phase 2 (2.0)**: drop or hide the deprecated legacy aliases according to the final 2.0 migration plan. The 1.7 LTS line keeps the existing 32-tool surface.

**What we explicitly will NOT consolidate**:

- Operator triplet (`get_operator_archives` / `voicelines` /
  `basic_info`): outputs differ in shape and length; merging hurts
  LLM selection accuracy more than it saves context.
- Enemy triplet (`list_enemies` / `get_enemy_info` / `search_enemies`):
  same reason.
- Story tools (`read_story` / `read_activity` / `get_event_summary`):
  genuinely distinct actions on related-but-different data.

The bar for consolidation: same parameter shape, similar output length and structure, an LLM choosing between them today is choosing between near-synonyms.

### Output format becomes selectable

- Add an optional `output_format=markdown|json` parameter (default
  `markdown` in 1.x — additive, no break).
- JSON mode returns structured objects suitable for downstream
  automation.
- 2.0 flips the **default** to `json`, making this the breaking change.
- Markdown remains supported under explicit opt-in.

The original staged plan expected 1.x opt-in. With 1.7 now serving as the LTS line, the exact migration path belongs to the 2.0 design phase and must be documented before the first 2.0 prerelease.

### Implementation parity (Python ↔ TypeScript)

Today the implementations have de-facto roles: Python is recommended for Docker / stdio, TypeScript for `npm install -g` / HTTP. 2.0 removes this asymmetry:

- Both implementations support stdio **and** Streamable HTTP.
- npm and PyPI packages have equivalent capability surface.
- Environment variable names and defaults are unified.
- Recommended deployment scenarios collapse into "use whichever runtime
  fits your stack".

### Cleanup

- Drop any 0.x-compat shims that survive into late 1.x.
- Drop the deprecated tool aliases introduced by the 2.0 migration plan (see
  consolidation section above).

### 2.0 Non-Goals

- Not rewriting the MCP protocol layer.
- Not introducing new transports beyond stdio + HTTP.
- Not breaking data-sync semantics.
- **Not implementing a custom deferred-tool-loading scheme.** If MCP
  spec standardizes one (e.g. SEP-1821 merges), we adopt it; otherwise
  consolidation + description optimization is our answer.

---

## Decision Principles

1. **1.7 LTS is closed to new capabilities** — keep the stable line small,
   predictable, and supportable.
2. **One data domain per feature release** — easier to communicate, easier
   to migrate, easier to roll back.
3. **Patches don't add new capability surface** — they fix bugs, improve
   compatibility, and preserve the 1.7 contract.
4. **Lead breaking changes with explicit migration docs** — 2.0's tool-surface
   and output-format changes must be documented before prerelease.
5. **Bind cross-source fusion to its data dependency** — `get_stage_enemies`
   ships after the stage data domain, not before it.
6. **Consolidate by schema shape, not by domain** — merging tools that
   share parameter structure preserves selection accuracy; merging by
   "everything operator-related" doesn't.
7. **Prefer extending a `scope` enum over adding a list/get/search triplet
   per new data domain** — when onboarding a new data domain (e.g. base
   skills, skins, furniture), first check whether it fits an existing unified
   entry point's enum (e.g. `search(scope)`); only add a new tool when the
   output shape is genuinely heterogeneous and cannot be carried by an
   existing tool. This targets the "+3 tools per data domain" growth that
   drove the surface from 24 to 32 across 1.x.

---

## Detailed Plans

- [1.0 architecture plan](docs/dev/plans/1.0-architecture-plan.md)
- [1.0 development roadmap](docs/dev/plans/1.0-development-roadmap.md)
