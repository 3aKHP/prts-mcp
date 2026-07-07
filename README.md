# PRTS MCP Server

[![PyPI](https://img.shields.io/pypi/v/prts-mcp)](https://pypi.org/project/prts-mcp/)
[![npm](https://img.shields.io/npm/v/prts-mcp-ts)](https://www.npmjs.com/package/prts-mcp-ts)
[![License: MIT](https://img.shields.io/github/license/3aKHP/prts-mcp)](LICENSE)

**Language / 语言：** [English](#english) | [中文](#中文)

---

<a id="english"></a>

## English

An MCP Server for [Arknights](https://www.arknights.global/) fan creation (同人創作) AI agents. Powered by the [PRTS Wiki](https://prts.wiki) MediaWiki API and auto-synced operator game data, it gives any MCP-compatible client — Claude Desktop, Claude Code, Chatbox, and more — live access to lore, operator archives, and voice lines from the world of Terra.

### Implementations

This repository contains two independent implementations for different deployment scenarios:

| Directory | Language | Transport | Use case |
|-----------|----------|-----------|----------|
| [`python/`](python/) | Python 3.10+ | stdio + Streamable HTTP | Local Claude Desktop / Claude Code (stdio), self-hosted HTTP server |
| [`ts/`](ts/) | TypeScript / Node.js + Bun | Streamable HTTP + stdio | Self-hosted HTTP server, local stdio for Claude Desktop / Code |

### Release Lines

Two release lines ship in parallel:

| Line | Version | Tools | Status |
|------|---------|-------|--------|
| **2.3** (`main`) | `2.3.0` | 23 | Cross-transport parity: both implementations support both stdio and Streamable HTTP (Python gains HTTP, TypeScript gains stdio). Bun remains the default TS runtime. |
| **1.7 LTS** (`lts/1.7`) | `1.7.0` | 32 | Stable maintenance line. 1.7.x accepts only compatibility, security, data-sync, and critical bug fixes. |

| Area | Python | TypeScript |
|------|--------|------------|
| MCP tools | Same 23 public tool names and required parameters (2.0) / 32 on 1.7 LTS | Same 23 (2.0) / 32 on 1.7 LTS |
| GameData | `GAMEDATA_PATH` or auto-synced `zh_CN-excel.zip` | `GAMEDATA_PATH` or auto-synced `zh_CN-excel.zip` |
| Level data | Auto-synced `zh_CN-levels.zip` beside GameData | Auto-synced `zh_CN-levels.zip` beside GameData |
| Story data | `STORYJSON_PATH` or auto-synced `zh_CN.zip` | `STORYJSON_PATH` or auto-synced `zh_CN.zip` |
| Bundled fallback data | Docker image only | Docker image and published npm package (PyPI stays data-light) |

See [`docs/migration-1.x-to-2.0.md`](docs/migration-1.x-to-2.0.md) for the 1.x → 2.0
breaking changes (tool consolidation, `operator_name` → `name`, output channel),
and [`docs/migration-0.x-to-1.0.md`](docs/migration-0.x-to-1.0.md) for the 0.x → 1.0
transition.

### Tools

Both implementations expose the same tool set:

| Tool | Description |
|------|-------------|
| `search_prts(query, limit)` | Search PRTS Wiki by keyword, returns matching article titles |
| `prts_page(page_title, action, ...)` | Read a wiki page or its metadata; `action` ∈ read / sections / categories / links / template |
| `get_operator_archives(name)` | Retrieve operator archive records (Chinese name) |
| `get_operator_voicelines(name)` | Retrieve operator voice lines (Chinese name) |
| `get_operator_basic_info(name)` | Retrieve basic operator profile: class, rarity, faction, recruit tags, talents (Chinese name) |
| `list_story_events(category?)` | List story events; optional filter: `main` (main story) or `activities` |
| `list_stories(event_id, include_summaries?)` | List chapters of an event in official order; `include_summaries` adds the event-level overview + per-chapter summaries |
| `get_story_summary(story_key)` | Single-chapter summary (LLM long summary or official one-liner) |
| `read_story(story_key, include_narration)` | Read full dialogue for a single chapter |
| `read_activity(event_id, include_narration, page, page_size)` | Read a complete activity's transcript, with pagination |
| `search(scope, pattern, max_results)` | Full-text regex search within a data domain: `scope` ∈ operators / enemies / stages / items |
| `search_stories(pattern, character?, line_type?, context_lines?, max_results?, event_id?)` | Full-text regex search across story dialogue, narration, and choice lines with filtering |
| `list_enemies()` | List all enemies in the handbook with threat level and description |
| `get_enemy_info(name, stage_id?)` | Retrieve full enemy handbook entry by name, or stage-specific stats when `stage_id` is provided |
| `get_stage_enemies(stage_id)` | List enemies actually spawned in a stage, with stage-specific levels and combat stats |
| `get_enemy_appearances(name, limit?, offset?)` | Reverse lookup stages where an enemy actually spawns |
| `list_stages(chapter?, type?, limit?, offset?)` | List stages with optional zone and stage-type filters |
| `get_stage_info(stage_id)` | Retrieve detailed stage information by stage ID |
| `list_items(category?, limit?, offset?)` | List items/materials from `item_table.json` with optional category filtering |
| `get_item_info(name)` | Retrieve item/material details, usage, obtain methods, drops, production, and shop links |
| `get_operator_memoirs(name)` | Resolve an operator's memoir (干员密录) story keys for follow-up `read_story` calls |
| `find_character_appearances(name, scope?, max_events?)` | Find chapters/events where a character speaks (dialog) or is mentioned (name substring) |
| `find_speakers_in(event_id)` | List every speaker in an event with dialog line counts |

### Output Channel

Both implementations keep markdown as the default, human-readable output on
MCP's `content` field. Deployments whose client consumes MCP-native
`structuredContent` can opt in via a **connection-level** `output_channel` knob
(`content` (default) / `structured` / `both`):

- **Python** — `PRTS_OUTPUT_CHANNEL` environment variable.
- **TypeScript** — `?output_channel=` query string, `x-prts-output-channel` header, or `PRTS_OUTPUT_CHANNEL` env.

The default `content` requires no configuration and is unchanged from 1.x. See
the [2.0 migration guide](docs/migration-1.x-to-2.0.md) for the per-tool
mapping and the rationale for choosing a channel over a per-call format
parameter.

### Quick Start

Since 2.3.0 both implementations support both transports — pick by use case,
not by language:

- **Local stdio** (Claude Desktop / Claude Code) → Python `prts-mcp` (stdio, default) or TypeScript `npx prts-mcp-ts-stdio`
- **HTTP server** (self-hosted, remote access) → Python `PRTS_TRANSPORT=http prts-mcp` or TypeScript `npx prts-mcp-ts`
- See [`python/`](python/) and [`ts/`](ts/) for per-implementation details

The TypeScript implementation supports Bun and Node.js. Since 2.2.0 **Bun is
the default production runtime**: the default `ts/Dockerfile`, the primary CI
verification path, and the recommended Docker deployment all run under Bun
(verified against Bun `1.3.14`). Node.js remains a supported legacy/optional
runtime via the `prts-mcp-ts` npm bin (so `npx prts-mcp-ts` stays
zero-dependency), `npm install -g`, and the `ts/Dockerfile.node` build path.
The npm publishing path still uses npm CLI (`npm publish --provenance`,
runtime-agnostic).

### Data Sources

- **PRTS Wiki API** (`https://prts.wiki/api.php`) — lore articles, faction info, world-building entries
- **ArknightsGameData** ([`3aKHP/ArknightsGameData`](https://github.com/3aKHP/ArknightsGameData)) — Release archive mirror of [`Kengxxiao/ArknightsGameData`](https://github.com/Kengxxiao/ArknightsGameData), used for operator archives, voice lines, base stats, enemies, stages, items, and level combat data (`zh_CN-excel.zip` + `zh_CN-levels.zip`)
- **ArknightsStoryJson** ([`3aKHP/ArknightsStoryJson`](https://github.com/3aKHP/ArknightsStoryJson)) — parsed story dialogue, auto-synced from GitHub Releases (`zh_CN.zip`)

Game data lives in the `gamedata` volume. Level combat data lives in the `gamedata-levels` volume. Story data lives in the `storyjson` volume. All three are auto-synced in the background after the server starts listening.

Published Docker images and the npm package include bundled fallback game/level/story data prepared by CI. The PyPI package stays lightweight and does not embed these data files; it relies on startup auto-sync or user-provided data paths.

---

<a id="中文"></a>

## 中文

明日方舟同人创作辅助 MCP Server。通过 [PRTS Wiki](https://prts.wiki) API 和自动同步的干员数据，为 MCP 客户端（Claude Desktop、Claude Code、Chatbox 等）提供泰拉世界观检索与干员资料查询能力。

### 实现版本

本仓库包含两个独立实现，适用于不同的部署场景：

| 目录 | 语言 | 传输方式 | 适用场景 |
|------|------|----------|----------|
| [`python/`](python/) | Python 3.10+ | stdio + Streamable HTTP | Claude Desktop / Claude Code 本地接入（stdio）、自建 HTTP 服务 |
| [`ts/`](ts/) | TypeScript / Node.js + Bun | Streamable HTTP + stdio | 自建 HTTP 服务、Claude Desktop / Claude Code 本地接入（stdio） |

### 版本线

两个版本线并行维护：

| 版本线 | 版本 | 工具数 | 状态 |
|--------|------|--------|------|
| **2.3**（`main`） | `2.3.0` | 23 | Cross-transport parity：双端均支持 stdio + Streamable HTTP（Python 新增 HTTP，TypeScript 新增 stdio）。Bun 仍是 TS 默认运行时。 |
| **1.7 LTS**（`lts/1.7`） | `1.7.0` | 32 | 稳定维护线。1.7.x 仅接受兼容性、安全性、数据同步和关键缺陷修复。 |

| 范围 | Python | TypeScript |
|------|--------|------------|
| MCP 工具 | 相同的 23 个工具名和必填参数（2.0）/ 1.7 LTS 为 32 个 | 相同的 23 个（2.0）/ 1.7 LTS 为 32 个 |
| 干员数据 | `GAMEDATA_PATH` 或自动同步 `zh_CN-excel.zip` | `GAMEDATA_PATH` 或自动同步 `zh_CN-excel.zip` |
| 关卡战斗数据 | 自动同步与 GameData 并列的 `zh_CN-levels.zip` | 自动同步与 GameData 并列的 `zh_CN-levels.zip` |
| 剧情数据 | `STORYJSON_PATH` 或自动同步 `zh_CN.zip` | `STORYJSON_PATH` 或自动同步 `zh_CN.zip` |
| bundled 兜底数据 | Docker 镜像 | Docker 镜像和正式 npm 包（PyPI 保持轻量） |

1.x → 2.0 的破坏性变更（工具面合并、`operator_name` → `name`、output channel）见
[`docs/migration-1.x-to-2.0.md`](docs/migration-1.x-to-2.0.md)；0.x → 1.0 迁移见
[`docs/migration-0.x-to-1.0.md`](docs/migration-0.x-to-1.0.md)。

### 工具集

两个实现提供相同的工具集：

| 工具 | 说明 |
|------|------|
| `search_prts(query, limit)` | 关键词搜索 PRTS 维基词条，返回匹配标题列表 |
| `prts_page(page_title, action, ...)` | 读取词条正文或元数据；`action` ∈ read / sections / categories / links / template |
| `get_operator_archives(name)` | 获取干员档案资料（中文名） |
| `get_operator_voicelines(name)` | 获取干员语音记录（中文名） |
| `get_operator_basic_info(name)` | 获取干员基本信息：职业、稀有度、所属、招募标签、天赋（中文名） |
| `list_story_events(category?)` | 列出剧情活动，可选过滤：`main`（主线）或 `activities`（活动） |
| `list_stories(event_id, include_summaries?)` | 列出指定活动的章节（按官方顺序）；`include_summaries` 附活动级概览 + 每章梗概 |
| `get_story_summary(story_key)` | 获取单章梗概（LLM 长摘要或官方一句话简介） |
| `read_story(story_key, include_narration)` | 读取单章完整台词 |
| `read_activity(event_id, include_narration, page, page_size)` | 读取整个活动的完整剧情，支持分页 |
| `search(scope, pattern, max_results)` | 在指定数据域执行全文正则搜索：`scope` ∈ operators / enemies / stages / items |
| `search_stories(pattern, character?, line_type?, context_lines?, max_results?, event_id?)` | 在剧情台词中执行全文正则搜索，支持按角色和台词类型过滤 |
| `list_enemies()` | 列出敌方图鉴中所有敌人及其威胁等级和描述 |
| `get_enemy_info(name, stage_id?)` | 获取指定敌人的详细图鉴资料；传入 `stage_id` 时返回关卡级数值 |
| `get_stage_enemies(stage_id)` | 获取指定关卡实际出场敌人及关卡级等级/战斗属性 |
| `get_enemy_appearances(name, limit?, offset?)` | 反查指定敌人实际出现在哪些关卡 |
| `list_stages(chapter?, type?, limit?, offset?)` | 列出关卡，支持按章节/区域和关卡类型过滤 |
| `get_stage_info(stage_id)` | 根据关卡 ID 获取关卡详细信息 |
| `list_items(category?, limit?, offset?)` | 列出物品/材料，支持按类别过滤和分页 |
| `get_item_info(name)` | 获取物品/材料详情、用途、获取方式、掉落、基建产出和商店关联 |
| `get_operator_memoirs(name)` | 解析干员密录的 story_key，便于后续 `read_story` 调用 |
| `find_character_appearances(name, scope?, max_events?)` | 查找角色在哪些章节/活动中开口（对话）或被提及（名字子串） |
| `find_speakers_in(event_id)` | 列出指定活动中所有发言角色及其对话行数 |

### 输出通道

两个实现默认在 MCP 的 `content` 字段输出人类可读的 markdown。若部署环境使用的客户端能消费 MCP 原生的 `structuredContent`，可通过**连接级**的 `output_channel` 开关（`content`（默认）/ `structured` / `both`）启用：

- **Python** — `PRTS_OUTPUT_CHANNEL` 环境变量。
- **TypeScript** — `?output_channel=` 查询字符串、`x-prts-output-channel` 请求头，或 `PRTS_OUTPUT_CHANNEL` 环境变量。

默认 `content` 无需任何配置，与 1.x 一致。各工具的通道映射，以及「为何选连接级通道而非 per-call 格式参数」的设计理由，见 [2.0 迁移指南](docs/migration-1.x-to-2.0.md)。

### 快速开始

自 2.3.0 起两个实现都支持双传输——按场景选择，而非按语言：

- **本地 stdio 接入**（Claude Desktop / Claude Code）→ Python `prts-mcp`（stdio，默认）或 TypeScript `npx prts-mcp-ts-stdio`
- **HTTP 服务部署**（自建服务器，供他人调用）→ Python `PRTS_TRANSPORT=http prts-mcp` 或 TypeScript `npx prts-mcp-ts`
- 详见 [`python/`](python/) 和 [`ts/`](ts/)

TypeScript 实现支持 Bun 与 Node.js。自 2.2.0 起 **Bun 是默认生产运行时**：默认
`ts/Dockerfile`、CI 主验证链与推荐 Docker 部署均在 Bun 下运行（最低验证版本 Bun
`1.3.14`）。Node.js 保留为受支持的 legacy/可选运行时，通过 `prts-mcp-ts` npm bin（因此
`npx prts-mcp-ts` 仍零额外运行时依赖）、`npm install -g` 与 `ts/Dockerfile.node` 构建
路径提供。npm 发布路径仍走 npm CLI（`npm publish --provenance`，与运行时无关）。

### 数据源

- **PRTS Wiki API** (`https://prts.wiki/api.php`) — 世界观词条、阵营设定
- **ArknightsGameData** ([`3aKHP/ArknightsGameData`](https://github.com/3aKHP/ArknightsGameData)) — [`Kengxxiao/ArknightsGameData`](https://github.com/Kengxxiao/ArknightsGameData) 的 Release 压缩包镜像，用于干员档案、语音记录、基础信息、敌人、关卡、物品和关卡战斗数据（`zh_CN-excel.zip` + `zh_CN-levels.zip`）
- **ArknightsStoryJson** ([`3aKHP/ArknightsStoryJson`](https://github.com/3aKHP/ArknightsStoryJson)) — 剧情台词解析数据，从 GitHub Releases 自动同步（`zh_CN.zip`）

干员/表格数据存放在 `gamedata` volume，关卡战斗数据存放在 `gamedata-levels` volume，剧情数据存放在 `storyjson` volume，均在服务器开始监听后于后台自动同步。

正式发布的 Docker 镜像和 npm 包会由 CI 预置 bundled 兜底数据；PyPI 包保持轻量，不内置这些数据文件，依赖启动时 auto-sync 或用户自行提供数据路径。

---

## License

MIT
