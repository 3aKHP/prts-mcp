# PRTS-MCP Roadmap

_Last updated: 2026-07-10_ · [中文版](ROADMAP.zh-CN.md)

PRTS-MCP is past 1.0. Version 1.7.0 is the final 1.x feature release and the 1.7 LTS baseline. This document tracks **what comes next** — not what has shipped. For shipped features, see the Python and TypeScript CHANGELOGs.

## Current Release

- Python: `2.3.1` _(latest stable)_
- TypeScript: `2.3.1` _(latest stable)_
- `1.7.1` LTS remains the maintenance line — compatibility, security,
  data-sync, and critical fixes only.
- 23 public MCP tools on the 2.x line (CI-enforced); 32 public MCP tools
  frozen on the 1.7 LTS line.
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

No new capabilities are planned for 1.7.x. Former patch-line ideas such as search unification, PRTS page unification, JSON output defaults, and golden test infrastructure are part of the delivered 2.x history unless they are required to fix a 1.7 LTS regression.

---

## 2.0 Boundary Changes (Delivered)

2.0 delivered the planned major migration while keeping the 1.7 LTS line
unchanged:

- **Tool surface:** schema-oriented consolidation reduced the public 2.x
  surface from 32 to 23 tools. The 1.7 LTS line retains all 32 names.
- **Structured output:** 2.x uses MCP `structuredContent` through an
  `output_channel` control while preserving human-readable content by default.
- **Transport parity:** both implementations support stdio and Streamable HTTP
  on 2.x; 1.7 LTS keeps its established deployment roles.

The migration did not add a custom deferred-tool-loading protocol or change
data-sync semantics.

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

---

## Detailed Plans

- [1.0 architecture plan](docs/dev/plans/1.0-architecture-plan.md)
- [1.0 development roadmap](docs/dev/plans/1.0-development-roadmap.md)
