# PRTS-MCP Roadmap

_Last updated: 2026-07-29_ · [中文版](ROADMAP.zh-CN.md)

PRTS-MCP is past 1.0. Version 1.7.0 is the final 1.x feature release and the 1.7 LTS baseline. This document tracks **what comes next** — not what has shipped. For shipped features, see the Python and TypeScript CHANGELOGs.

## Current Release

- Python: `2.4.0` _(latest stable)_
- TypeScript: `2.4.0` _(latest stable)_
- `1.7.0` LTS remains the maintenance line — compatibility, security, data-sync, and critical fixes only.
- 23 public MCP tools on the 2.x line (CI-enforced); 32 public MCP tools frozen on the 1.7 LTS line.
- See [migration guide 0.x → 1.0](docs/migration-0.x-to-1.0.md) and
  [migration guide 1.x → 2.0](docs/migration-1.x-to-2.0.md).

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
  substring in any line text). Implemented on `develop` for 1.7.0.
- `find_speakers_in(event_id)` — every speaker who appears in an event, with
  dialog line counts. Implemented on `develop` for 1.7.0.

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

The 1.x tool surface reached 32 tools by the 1.7.0 LTS release. For long-context flagship models this is fine; for 128K-class models, every additional tool schema eats into the prompt budget and hurts tool-selection accuracy. 2.0 consolidates server-side by *schema shape* — merging tools that share parameter structure and output shape, keeping tools whose semantics genuinely differ — and drops the 32 → **23 tools** without losing capability.

**Background**: MCP currently has no protocol-level support for deferred tool loading. Closed proposals: lazy hydration (#1978), lazyRegistration (#2376). Open drafts: tool-search query (#1821), token-bloat mitigations (#1576). Claude Code's ToolSearch is an Anthropic-API-level feature (`tool_reference` blocks), not portable to Cursor/Cline/Chatbox.

**Delivered in 2.0**:

- `search(scope, pattern, max_results)` consolidates `search_data`,
  `search_enemies`, `search_stages`, `search_items`, and `list_search_scopes`
  into one tool keyed on a `scope` enum (`operators` / `enemies` / `stages` /
  `items`). Story dialogue search remains the separate `search_stories` tool,
  because its filters (character, line type, context lines) differ in shape.
- `prts_page(page_title, action, ...)` consolidates `read_prts_page`,
  `list_prts_sections`, `get_prts_categories`, `get_prts_links`, and
  `get_prts_template` into one tool keyed on an `action` enum.
- `list_stories(event_id, include_summaries=true)` now prepends the event-level
  LLM overview, absorbing the former `get_event_summary`. The single-chapter
  deep summary tool `get_story_summary` is unchanged.
- The deprecated legacy aliases behind these three consolidations are dropped
  from the 2.0 tool surface. The 1.7 LTS line keeps the existing 32-tool surface.

**What was explicitly NOT consolidated**:

- Operator triplet (`get_operator_archives` / `voicelines` /
  `basic_info`): outputs differ in shape and length; merging hurts
  LLM selection accuracy more than it saves context.
- Enemy pair (`list_enemies` / `get_enemy_info`): same reason. (The enemy
  search tool `search_enemies` was folded into the cross-domain
  `search(scope="enemies")` as described above.)
- Story tools (`read_story` / `read_activity` / `get_story_summary`):
  genuinely distinct actions on related-but-different data.

The bar for consolidation: same parameter shape, similar output length and structure, an LLM choosing between them today is choosing between near-synonyms.

### Output channel (structuredContent)

2.0 adds structured output via MCP's native `structuredContent` field. The
control plane is a single **connection-level** `output_channel` knob
(`content` (default) / `structured` / `both`), set via the
`PRTS_OUTPUT_CHANNEL` env var on Python and via query string / header / env on
TypeScript. Structural tools (17) carry real structured payloads with chainable
IDs and raw/label field pairs; narrative tools (6) stay content-only. The
default `content` channel preserves the 1.x human-readable markdown output, so
incapable clients (e.g. Chatbox) are unaffected without configuration.

**Design choice — channel, not a per-call format parameter.** The original
roadmap proposed a per-call `output_format=markdown|json` parameter with 2.0
flipping the default to `json`. **That shape was rejected during design.** The
primary consumer is an LLM agent, and JSON inflates prompt tokens ~15–30%
versus markdown — which would negate the context-budget savings the
tool-surface consolidation was built to deliver. Instead, markdown stays the
always-on `content` text and structured data rides a separate channel; the two
axes are orthogonal. The default is **not** flipped to JSON.

See [the 2.0 migration guide](docs/migration-1.x-to-2.0.md) for the per-tool
channel mapping and client configuration.

### Implementation parity (Python ↔ TypeScript)

2.0 narrows, but does not remove, the de-facto role split between the two
implementations. Delivered in 2.0:

- npm and PyPI packages have an equivalent **capability surface** — the same
  23 tool names, parameters, structuredContent payloads, and parity fixtures
  shared across both implementations.
- Environment variable names and defaults are unified (`PRTS_OUTPUT_CHANNEL`,
  `GAMEDATA_PATH`, `STORYJSON_PATH`, `GITHUB_TOKEN`, `GITHUB_MIRRORS`).

**Cross-transport parity — delivered in 2.3.0.** The original goal that
both implementations support stdio **and** Streamable HTTP (Python gaining
HTTP, TypeScript gaining stdio) was deferred beyond 2.0 and shipped in
2.3.0. Python selects transport via `PRTS_TRANSPORT`
(stdio default | http); TypeScript selects via bin (`prts-mcp-ts`[-bun] = HTTP,
`prts-mcp-ts-stdio` = stdio). Since 2.3.0 the deployment guidance is
"choose by use case, not by language."

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
