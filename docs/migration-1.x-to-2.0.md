# Migration Guide: 1.x to 2.0

_Status: 2.0.0 (development)_

PRTS-MCP 2.0 consolidates the 1.x tool surface (32 tools in 1.7.0 LTS) down to
**23 tools**, normalizes a parameter name, and adds an optional structured-output
channel. These are breaking changes for clients that hard-coded the old tool
names or the `operator_name` parameter.

## TL;DR

- Tool surface: **32 → 23** (net reduction of 9). Eleven legacy tool names are
  removed/folded into three unified entry points; nothing is lost.
- One required parameter is renamed: `operator_name` → `name` on four operator
  tools.
- Output stays markdown by default. A new **connection-level** output channel
  can additionally emit MCP-native `structuredContent`; it is **not** a per-call
  `output_format` parameter and does **not** flip the default to JSON.
- Transport roles are unchanged in 2.0: Python = stdio, TypeScript = Streamable
  HTTP. Cross-transport parity (Python HTTP / TS stdio) is deferred beyond 2.0.

## Breaking Changes

### 1. Unified search tool — `search(scope, pattern, max_results)`

The four 1.x search tools and the scope catalogue are replaced by one tool:

| 1.x tool | 2.0 replacement |
|----------|-----------------|
| `search_data(pattern, scope, max_results)` | `search(scope="operators", pattern, max_results)` |
| `search_enemies(pattern, max_results)` | `search(scope="enemies", pattern, max_results)` |
| `search_stages(pattern, max_results)` | `search(scope="stages", pattern, max_results)` |
| `search_items(pattern, max_results)` | `search(scope="items", pattern, max_results)` |
| `list_search_scopes()` | _(removed)_ — the scope catalogue is now the `search` tool description |

`scope` is a required enum (`operators` / `enemies` / `stages` / `items`).
Story dialogue search remains the separate `search_stories` tool, because its
filters (character, line type, context lines) differ in shape.

### 2. Unified PRTS page tool — `prts_page(page_title, action, ...)`

The five 1.x PRTS page tools are replaced by one tool keyed on `action`:

| 1.x tool | 2.0 replacement |
|----------|-----------------|
| `read_prts_page(page_title, section_index?)` | `prts_page(page_title, action="read", section_index?)` |
| `list_prts_sections(page_title)` | `prts_page(page_title, action="sections")` |
| `get_prts_categories(page_title)` | `prts_page(page_title, action="categories")` |
| `get_prts_links(page_title, direction?, limit?)` | `prts_page(page_title, action="links", direction?, limit?)` |
| `get_prts_template(page_title)` | `prts_page(page_title, action="template")` |

`action` is a required enum (`read` / `sections` / `categories` / `links` /
`template`). Wiki keyword search remains the separate `search_prts` tool.

### 3. Event summary folded into `list_stories`

`get_event_summary(event_id)` is removed. Its content — the event-level LLM
overview from `event_summaries.json` — is now prepended by:

```python
list_stories(event_id, include_summaries=True)
```

which returns the event overview **plus** the per-chapter one-liners it already
returned in 1.x. The single-chapter deep summary tool `get_story_summary` is
unchanged.

### 4. Parameter rename — `operator_name` → `name`

The four operator tools now take `name`, matching the convention already used
by the enemy/stage/item/character tools:

| Tool | 1.x parameter | 2.0 parameter |
|------|---------------|---------------|
| `get_operator_archives` | `operator_name` | `name` |
| `get_operator_voicelines` | `operator_name` | `name` |
| `get_operator_basic_info` | `operator_name` | `name` |
| `get_operator_memoirs` | `operator_name` | `name` |

### Removed tool aliases (summary)

The following tool names no longer exist on the 2.0 tool surface:

```
search_data, search_enemies, search_stages, search_items, list_search_scopes,
read_prts_page, list_prts_sections, get_prts_categories, get_prts_links,
get_prts_template, get_event_summary
```

All eleven are reachable via the unified `search`, `prts_page`, and
`list_stories` tools described above.

## New Capability — Output Channel

2.0 adds an optional, **connection-level** output channel that carries
structured data on MCP's native `structuredContent` field, alongside the
human-readable markdown `content`.

### Design choice: channel, not a per-call format parameter

The original roadmap proposed a per-call `output_format=markdown|json`
parameter with 2.0 flipping the default to JSON. **This shape was rejected
during design.** The primary consumer of these tools is an LLM agent, and
JSON inflates prompt tokens ~15–30% versus markdown — which would negate the
context-budget savings the tool-surface consolidation was designed to deliver.

Instead, 2.0 keeps markdown as the always-on `content` text and carries
structured data on a separate channel. The two axes are orthogonal:

- **`content`** — always the human-readable markdown rendering (unchanged from 1.x).
- **`structuredContent`** — a structured dict for downstream automation, on the
  MCP-native field of the same name.

### Control

A single connection-level knob selects the channel:

| Implementation | How to set |
|----------------|------------|
| **Python** (stdio) | `PRTS_OUTPUT_CHANNEL` environment variable |
| **TypeScript** (HTTP) | query string `?output_channel=`, `x-prts-output-channel` header, or `PRTS_OUTPUT_CHANNEL` env |

Accepted values:

| Value | Behavior |
|-------|----------|
| `content` _(default)_ | markdown `content` only — identical to 1.x output |
| `structured` | `structuredContent` only; `content` carries a one-line summary |
| `both` | both `content` (markdown) and `structuredContent` |

The channel is connection-level rather than per-call because its correct value
depends on which client owns the connection — something the calling LLM cannot
know. An unrecognized value logs a warning and falls back to `content`; a
misconfigured channel never breaks tool calls.

### Which tools emit structuredContent

- **Structural tools (17)** carry real structured payloads: `search_prts`,
  `get_operator_basic_info`, `list_enemies`, `get_enemy_info`,
  `get_stage_enemies`, `get_enemy_appearances`, `list_stages`, `get_stage_info`,
  `list_items`, `get_item_info`, `search`, `list_story_events`, `list_stories`,
  `search_stories`, `get_operator_memoirs`, `find_character_appearances`,
  `find_speakers_in`. Structured payloads carry chainable IDs plus raw enums
  and rendered labels (e.g. `type="ACTIVITY"` + `type_label="活动"`).
- **Narrative tools (6)** are content-only: `prts_page` (all actions),
  `get_operator_archives`, `get_operator_voicelines`, `get_story_summary`,
  `read_story`, `read_activity`. Their prose output has no useful structured
  form.

### Note for incapable clients

`structured` mode is intended for deployments known to use a
`structuredContent`-capable client. A client that does not consume
`structuredContent` (for example Chatbox) receives only a one-line summary when
`structured` is selected — so **leave the default `content`** unless the client
is confirmed capable. No configuration is needed for the common case.

## What Stays Compatible

These are unchanged from 1.x and require no migration:

- **Markdown content text.** The default `content` output stays markdown, and
  most tools preserve their 1.7.x rendering. The notable exception is
  `list_stories(include_summaries=true)`, which now prepends the event-level
  overview (see breaking change #3 above); tools reached via the new unified
  entry points (`search`, `prts_page`) render the same cards as their 1.x
  counterparts. The TS story empty-result wording was aligned to Python.
- **Environment variable semantics.** `GAMEDATA_PATH`, `STORYJSON_PATH`,
  `GITHUB_TOKEN`, `GITHUB_MIRRORS`, and the auto-sync behavior are unchanged.
- **Data sources and sync.** The three Release archives (`zh_CN-excel.zip`,
  `zh_CN-levels.zip`, story `zh_CN.zip`) and the PRTS Wiki API are unchanged.
- **Transport roles.** Python remains stdio (FastMCP); TypeScript remains
  Streamable HTTP (Express). Docker and `npm install -g` deployment paths are
  unchanged.

## Upgrade Notes

1. Upgrade the Python package (`pip install -U prts-mcp`) or TypeScript
   package (`npm install -g prts-mcp-ts`) as usual.
2. If your client or prompt hard-codes any of the removed tool names, switch to
   the unified `search` / `prts_page` / `list_stories` calls above.
3. If you call operator tools with `operator_name`, rename the argument to
   `name`.
4. No environment variable changes are required. To opt into structured output,
   set `PRTS_OUTPUT_CHANNEL=structured` (or `both`) only if your client is
   confirmed to consume `structuredContent`.
5. For Docker deployments, no volume or compose changes are needed.

## Deferred Beyond 2.0

- **Cross-transport parity.** Both implementations supporting both stdio and
  Streamable HTTP (Python gaining HTTP, TypeScript gaining stdio) was an
  original 2.0 boundary goal but is deferred to a later release. 2.0 ships with
  the same de-facto transport split as 1.x.

For the 0.x → 1.0 transition, see
[`migration-0.x-to-1.0.md`](migration-0.x-to-1.0.md).
