# PRTS-MCP Roadmap

_Last updated: 2026-05-28_ · [中文版](ROADMAP.zh-CN.md)

PRTS-MCP is past 1.0. The public tool surface and data architecture are under a 1.x compatibility contract. This document tracks **what comes next** — not what has shipped. For shipped features, see the Python and TypeScript CHANGELOGs.

## Current Release

- Python: `1.6.1`
- TypeScript: `1.6.1`
- `dev` branch current target: `1.7.0-dev`
- 30 public MCP tools, frozen in the 1.x line (CI-enforced).
- See [migration guide](docs/migration-0.x-to-1.0.md) for the
  0.x → 1.0 transition.

## 1.x Compatibility Contract

What stays stable through 1.x:

- Tool names and required parameters.
- Response **format** (markdown shape), though wording/details may evolve.
- `GAMEDATA_PATH` and `STORYJSON_PATH` semantics.
- Auto-sync from GitHub Releases as the default data source.

What may change in minor releases:

- New tools (additive).
- New optional parameters with safe defaults.
- New optional data sources / fallbacks.
- Enhanced output content within the same format.

## 1.x Patch Policy

Patch releases (1.x.y) are limited to bug fixes, documentation, and non-breaking experience improvements (see "Patch line" below). **No new tools, no new required parameters.**

## 1.x Non-Goals

- Shipping every Arknights data table — pick what's useful for fan creation.
- Embedding large fallback data in PyPI wheels.
- Replacing GitHub-Release-based sync with a different hosting model.
- Adding LLM-generated content as a required runtime dependency.

---

## Minor Release Plan

Each minor version carries one main data domain. Cross-source fusion tools ship with or after the version that introduces their dependency.

### 1.6.0 — Stage Cross-Source Fusion + Item/Material Domain

Shipped 2026-05-28. See the Python and TypeScript CHANGELOGs for release
details.

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

### 1.7.0 — Story Character Tracking + Operator Depth

**Story character tracking (no new data source — indexes existing story JSON)**
- `find_character_appearances(name, scope?, max_events?)` — chapters / events
  where the character speaks (dialog role exact match) or is mentioned (name
  substring in any line text). Implemented on `dev` for 1.7.0.
- `find_speakers_in(event_id)` — every speaker who appears in an event, with
  dialog line counts. Implemented on `dev` for 1.7.0.

**Main: building (base) skill data domain**
- `get_operator_building_skills(name)` — base skills, efficiency, slotting.
- `search_building_skills(building_type, pattern)` — cross-operator skill search.

**Skins**
- `get_operator_skins(name)` — skin list with descriptions.

### 1.8.0 — Wiki Enhancements + Recruitment

**Main: PRTS Wiki enhancements (group B in one release)**
- `get_prts_images(page_title)` — image list via `prop=images`.
- `resolve_prts_redirect(title)` — redirect resolution; addresses the
  long-standing 1.1.1 "Known remaining issues" item.

**Recruitment**
- `query_recruit_tags(tags)` — reverse lookup: which operators a given
  tag combination can produce.

---

## Patch Line (1.x.y)

Patch releases roll out experience and infra improvements without introducing new tools. Each patch carries one or two changes; the binding to a specific minor version is illustrative — work flows through whichever patch window is open.

| Tentative | Theme | Scope |
|-----------|-------|-------|
| 1.5.1 | Search unification (Phase 1) | New `search(scope, pattern, ...)` consolidating `search_data`/`search_stories`/`search_enemies`/`list_search_scopes`. Legacy names preserved as deprecated aliases. |
| 1.5.2 | Pagination format | Standard `{total, offset, limit, items}` shape across list tools. |
| 1.6.1 | Structured errors | `{error_code, message}` alongside the legacy string fallback. |
| 1.6.2 | PRTS page unification (Phase 1) | New `prts_page(page_title, action="read\|sections\|categories\|links\|template", ...)` consolidating five `*_prts_*`/`*_prts_page` tools. Legacy names kept and deprecated. |
| 1.6.3 | Tool description optimization | Add keyword-rich descriptions and typical-use examples to all tools. Improves recall for client-side tool search / RAG (Claude Code, Cursor). Server-side, zero protocol risk. |
| 1.7.1 | Shared fixtures | Cross-implementation fixture/golden-test infra. |
| 1.7.2 | Golden tests | Python/TS byte-equal output tests over shared inputs. |
| 1.7.3 | Developer docs | Data architecture diagram + new-domain onboarding guide. |

These improvements are additive and back-compat. None of them are gating for the corresponding minor release; they just track natural delivery windows.

---

## 2.0 Boundary Changes

Three structural shifts that warrant a major bump.

### Tool surface consolidation (context budget)

The 1.x tool surface keeps growing (29 tools at 1.6.0, projected 30+ by 1.8.0). For long-context flagship models this is fine; for 128K-class models, every additional tool schema eats into the prompt budget and hurts tool-selection accuracy.

**Background**: MCP currently has no protocol-level support for deferred tool loading. Closed proposals: lazy hydration (#1978), lazyRegistration (#2376). Open drafts: tool-search query (#1821), token-bloat mitigations (#1576). Claude Code's ToolSearch is an Anthropic-API-level feature (`tool_reference` blocks), not portable to Cursor/Cline/Chatbox.

**Approach**: server-side consolidation by *schema shape*, not by data domain. Merge tools that share parameter structure and output shape; keep tools whose semantics genuinely differ. Estimated reduction: 24 → ~16 tools (about a third) without losing capability.

**Phase 1 (within 1.x, deprecated aliases)**:

- `search(scope, pattern, ...)` consolidates `search_data`,
  `search_stories`, `search_enemies`, `list_search_scopes`. Same
  parameter shape across all four; differs only in `scope`. (1.5.1)
- `prts_page(page_title, action, ...)` consolidates `read_prts_page`,
  `list_prts_sections`, `get_prts_categories`, `get_prts_links`,
  `get_prts_template`. Single primary key; action selects the
  sub-operation. (1.6.2)

**Phase 2 (2.0)**: drop the deprecated aliases. The legacy names remain available throughout 1.x for migration headroom.

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

This staged migration lets users opt into JSON during 1.x and gives ample lead time before the default flips.

### Implementation parity (Python ↔ TypeScript)

Today the implementations have de-facto roles: Python is recommended for Docker / stdio, TypeScript for `npm install -g` / HTTP. 2.0 removes this asymmetry:

- Both implementations support stdio **and** Streamable HTTP.
- npm and PyPI packages have equivalent capability surface.
- Environment variable names and defaults are unified.
- Recommended deployment scenarios collapse into "use whichever runtime
  fits your stack".

### Cleanup

- Drop any 0.x-compat shims that survive into late 1.x.
- Drop the deprecated tool aliases introduced in 1.5.1 / 1.6.2 (see
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

1. **One data domain per minor release** — easier to communicate, easier
   to migrate, easier to roll back.
2. **Patches don't add new capability surface** — they fix bugs, improve
   experience, and may introduce *consolidation aliases* whose semantics
   are already covered by existing tools. They never add a genuinely new
   capability.
3. **Lead the breaking change by a year** — 2.0's `output_format` flip
   and tool-alias removal are prepared throughout 1.x, not announced at
   the last minute.
4. **Bind cross-source fusion to its data dependency** — `get_stage_enemies`
   ships after the stage data domain, not before it.
5. **Consolidate by schema shape, not by domain** — merging tools that
   share parameter structure preserves selection accuracy; merging by
   "everything operator-related" doesn't.

---

## Detailed Plans

- [1.0 architecture plan](docs/dev/plans/1.0-architecture-plan.md)
- [1.0 development roadmap](docs/dev/plans/1.0-development-roadmap.md)
