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
| [`python/`](python/) | Python 3.10+ | stdio | Local Claude Desktop / Claude Code, Docker |
| [`ts/`](ts/) | TypeScript / Node.js | Streamable HTTP | Self-hosted server, remote HTTP access |

### 1.x Compatibility Matrix

1.7.0 is the last 1.x feature release and the LTS baseline. Future 1.7.x updates are limited to compatibility, security, data-sync, and critical bug fixes while 2.0 development focuses on tool-surface consolidation, structured output defaults, and Python/TypeScript transport parity.

| Area | Python | TypeScript | 1.x policy |
|------|--------|------------|------------|
| Current line | `1.7.0` LTS | `1.7.0` LTS | 1.7.x is the final 1.x maintenance line |
| MCP tools | Same 32 public tool names and required parameters | Same 32 public tool names and required parameters | Tool names, required parameters, and default markdown output stay stable through 1.7.x |
| GameData | `GAMEDATA_PATH` or auto-synced `zh_CN-excel.zip` | `GAMEDATA_PATH` or auto-synced `zh_CN-excel.zip` | Custom paths disable auto-sync |
| Level data | Auto-synced `zh_CN-levels.zip` beside GameData | Auto-synced `zh_CN-levels.zip` beside GameData | Custom GameData roots may provide their own `zh_CN/gamedata/levels` |
| Story data | `STORYJSON_PATH` or auto-synced `zh_CN.zip` | `STORYJSON_PATH` or auto-synced `zh_CN.zip` | Custom zip paths disable auto-sync |
| Bundled fallback data | Docker image only | Docker image and published npm package | PyPI remains data-light |

See [`docs/migration-0.x-to-1.0.md`](docs/migration-0.x-to-1.0.md) for the 0.x to 1.0 migration notes.

### Tools

Both implementations expose the same tool set:

| Tool | Description |
|------|-------------|
| `search_prts(query, limit)` | Search PRTS Wiki by keyword, returns matching article titles |
| `read_prts_page(page_title)` | Fetch the plain-text content of a PRTS Wiki article |
| `get_operator_archives(name)` | Retrieve operator archive records (Chinese name) |
| `get_operator_voicelines(name)` | Retrieve operator voice lines (Chinese name) |
| `get_operator_basic_info(name)` | Retrieve basic operator profile: class, rarity, faction, recruit tags, talents (Chinese name) |
| `list_story_events(category?)` | List story events; optional filter: `main` (main story) or `activities` |
| `list_stories(event_id, include_summaries?)` | List chapters of an event in official order, with optional summaries |
| `get_event_summary(event_id)` | Narrative overview of all chapters in an event with summaries |
| `get_story_summary(story_key)` | Single-chapter summary (LLM long summary or official one-liner) |
| `read_story(story_key, include_narration)` | Read full dialogue for a single chapter |
| `read_activity(event_id, include_narration, page, page_size)` | Read a complete activity's transcript, with pagination |
| `list_search_scopes` | List available search domains (operators, stories, enemies, stages, items) with descriptions |
| `search_data(pattern, scope, max_results)` | Full-text regex search across operator names, descriptions, archives, and voice lines |
| `search_stories(pattern, character?, line_type?, context_lines?, max_results?, event_id?)` | Full-text regex search across story dialogue, narration, and choice lines with filtering |
| `list_prts_sections(page_title)` | Section table of contents for a wiki page |
| `get_prts_categories(page_title)` | Category tags for a wiki page |
| `get_prts_links(page_title, direction, limit)` | Outbound links or inbound backlinks with pagination |
| `get_prts_template(page_title)` | Extract structured template data (key-value pairs) from a wiki page |
| `list_enemies()` | List all enemies in the handbook with threat level and description |
| `get_enemy_info(name, stage_id?)` | Retrieve full enemy handbook entry by name, or stage-specific stats when `stage_id` is provided |
| `search_enemies(pattern, max_results?)` | Full-text regex search across enemy names, descriptions, and abilities |
| `get_stage_enemies(stage_id)` | List enemies actually spawned in a stage, with stage-specific levels and combat stats |
| `get_enemy_appearances(name, limit?, offset?)` | Reverse lookup stages where an enemy actually spawns |
| `list_stages(chapter?, type?, limit?, offset?)` | List stages with optional zone and stage-type filters |
| `get_stage_info(stage_id)` | Retrieve detailed stage information by stage ID |
| `search_stages(pattern, max_results?)` | Full-text regex search across stage names, codes, descriptions, and types |
| `list_items(category?, limit?, offset?)` | List items/materials from `item_table.json` with optional category filtering |
| `get_item_info(name)` | Retrieve item/material details, usage, obtain methods, drops, production, and shop links |
| `search_items(pattern, max_results?)` | Full-text regex search across item names, descriptions, usage, obtain methods, and types |

### Quick Start

- **Local stdio (Python / Docker)** → see [`python/`](python/)
- **HTTP server (TypeScript / Docker)** → see [`ts/`](ts/)

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
| [`python/`](python/) | Python 3.10+ | stdio | Claude Desktop / Claude Code 本地接入、Docker |
| [`ts/`](ts/) | TypeScript / Node.js | Streamable HTTP | 个人服务器部署，供他人通过 HTTP 调用 |

### 1.x 兼容矩阵

1.7.0 是最后一个 1.x 功能版本和 LTS 基线。后续 1.7.x 仅接受兼容性、安全性、数据同步和关键缺陷修复；2.0 开发线将集中处理工具面合并、结构化输出默认值和 Python/TypeScript 传输对齐。

| 范围 | Python | TypeScript | 1.x 策略 |
|------|--------|------------|----------|
| 当前版本线 | `1.7.0` LTS | `1.7.0` LTS | 1.7.x 是最后的 1.x 维护线 |
| MCP 工具 | 相同的 32 个工具名和必填参数 | 相同的 32 个工具名和必填参数 | 1.7.x 期间保持工具名、必填参数和默认 markdown 输出稳定 |
| 干员数据 | `GAMEDATA_PATH` 或自动同步 `zh_CN-excel.zip` | `GAMEDATA_PATH` 或自动同步 `zh_CN-excel.zip` | 自定义路径会禁用自动同步 |
| 关卡战斗数据 | 自动同步与 GameData 并列的 `zh_CN-levels.zip` | 自动同步与 GameData 并列的 `zh_CN-levels.zip` | 自定义 GameData 根目录可直接提供 `zh_CN/gamedata/levels` |
| 剧情数据 | `STORYJSON_PATH` 或自动同步 `zh_CN.zip` | `STORYJSON_PATH` 或自动同步 `zh_CN.zip` | 自定义 zip 会禁用自动同步 |
| bundled 兜底数据 | Docker 镜像 | Docker 镜像和正式 npm 包 | PyPI 继续保持轻量 |

0.x 到 1.0 的迁移说明见 [`docs/migration-0.x-to-1.0.md`](docs/migration-0.x-to-1.0.md)。

### 工具集

两个实现提供相同的工具集：

| 工具 | 说明 |
|------|------|
| `search_prts(query, limit)` | 关键词搜索 PRTS 维基词条，返回匹配标题列表 |
| `read_prts_page(page_title)` | 读取指定词条的纯文本内容 |
| `get_operator_archives(name)` | 获取干员档案资料（中文名） |
| `get_operator_voicelines(name)` | 获取干员语音记录（中文名） |
| `get_operator_basic_info(name)` | 获取干员基本信息：职业、稀有度、所属、招募标签、天赋（中文名） |
| `list_story_events(category?)` | 列出剧情活动，可选过滤：`main`（主线）或 `activities`（活动） |
| `list_stories(event_id, include_summaries?)` | 列出指定活动的章节（按官方顺序），可选附带梗概 |
| `get_event_summary(event_id)` | 获取活动的章节梗概概览，含 LLM 长摘要 |
| `get_story_summary(story_key)` | 获取单章梗概（LLM 长摘要或官方一句话简介） |
| `read_story(story_key, include_narration)` | 读取单章完整台词 |
| `read_activity(event_id, include_narration, page, page_size)` | 读取整个活动的完整剧情，支持分页 |
| `list_search_scopes` | 列出可搜索的数据域（干员、剧情、敌人、关卡、物品）及其内容类型 |
| `search_data(pattern, scope, max_results)` | 在干员名称、描述、档案、语音中执行全文正则搜索 |
| `search_stories(pattern, character?, line_type?, context_lines?, max_results?, event_id?)` | 在剧情台词中执行全文正则搜索，支持按角色和台词类型过滤 |
| `list_prts_sections(page_title)` | 获取词条的章节目录 |
| `get_prts_categories(page_title)` | 获取词条的分类标签 |
| `get_prts_links(page_title, direction, limit)` | 获取词条的出链或入链，支持分页 |
| `get_prts_template(page_title)` | 提取词条中的结构化模板键值对数据 |
| `list_enemies()` | 列出敌方图鉴中所有敌人及其威胁等级和描述 |
| `get_enemy_info(name, stage_id?)` | 获取指定敌人的详细图鉴资料；传入 `stage_id` 时返回关卡级数值 |
| `search_enemies(pattern, max_results?)` | 在敌人名称、描述和能力中执行全文正则搜索 |
| `get_stage_enemies(stage_id)` | 获取指定关卡实际出场敌人及关卡级等级/战斗属性 |
| `get_enemy_appearances(name, limit?, offset?)` | 反查指定敌人实际出现在哪些关卡 |
| `list_stages(chapter?, type?, limit?, offset?)` | 列出关卡，支持按章节/区域和关卡类型过滤 |
| `get_stage_info(stage_id)` | 根据关卡 ID 获取关卡详细信息 |
| `search_stages(pattern, max_results?)` | 在关卡名称、编号、描述和类型中执行全文正则搜索 |
| `list_items(category?, limit?, offset?)` | 列出物品/材料，支持按类别过滤和分页 |
| `get_item_info(name)` | 获取物品/材料详情、用途、获取方式、掉落、基建产出和商店关联 |
| `search_items(pattern, max_results?)` | 在物品名称、描述、用途、获取方式和类型中执行全文正则搜索 |

### 快速开始

- **本地 stdio 接入（Python / Docker）** → 见 [`python/`](python/)
- **HTTP 服务部署（TypeScript / Docker）** → 见 [`ts/`](ts/)

### 数据源

- **PRTS Wiki API** (`https://prts.wiki/api.php`) — 世界观词条、阵营设定
- **ArknightsGameData** ([`3aKHP/ArknightsGameData`](https://github.com/3aKHP/ArknightsGameData)) — [`Kengxxiao/ArknightsGameData`](https://github.com/Kengxxiao/ArknightsGameData) 的 Release 压缩包镜像，用于干员档案、语音记录、基础信息、敌人、关卡、物品和关卡战斗数据（`zh_CN-excel.zip` + `zh_CN-levels.zip`）
- **ArknightsStoryJson** ([`3aKHP/ArknightsStoryJson`](https://github.com/3aKHP/ArknightsStoryJson)) — 剧情台词解析数据，从 GitHub Releases 自动同步（`zh_CN.zip`）

干员/表格数据存放在 `gamedata` volume，关卡战斗数据存放在 `gamedata-levels` volume，剧情数据存放在 `storyjson` volume，均在服务器开始监听后于后台自动同步。

正式发布的 Docker 镜像和 npm 包会由 CI 预置 bundled 兜底数据；PyPI 包保持轻量，不内置这些数据文件，依赖启动时 auto-sync 或用户自行提供数据路径。

---

## License

MIT
