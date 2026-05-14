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

### 1.0 Compatibility Matrix

| Area | Python | TypeScript | 1.0 policy |
|------|--------|------------|------------|
| Current line | `1.1.0` | `1.1.0` | Stable releases are cut from the same commit when possible |
| MCP tools | Same 12 public tool names and required parameters | Same 12 public tool names and required parameters | Tool names and required parameters stay stable through 1.x |
| GameData | `GAMEDATA_PATH` or auto-synced `zh_CN-excel.zip` | `GAMEDATA_PATH` or auto-synced `zh_CN-excel.zip` | Custom paths disable auto-sync |
| Story data | `STORYJSON_PATH` or auto-synced `zh_CN.zip` | `STORYJSON_PATH` or auto-synced `zh_CN.zip` | Custom zip paths disable auto-sync |
| Bundled fallback data | Docker image only | Docker image and published npm package | PyPI remains data-light |

See [`docs/migration-0.x-to-1.0.md`](docs/migration-0.x-to-1.0.md) for the
0.x to 1.0 migration notes.

### Tools

Both implementations expose the same tool set:

| Tool | Description |
|------|-------------|
| `search_prts(query, limit)` | Search PRTS Wiki by keyword, returns matching article titles |
| `read_prts_page(page_title)` | Fetch the plain-text content of a PRTS Wiki article |
| `get_operator_archives(operator_name)` | Retrieve operator archive records (Chinese name) |
| `get_operator_voicelines(operator_name)` | Retrieve operator voice lines (Chinese name) |
| `get_operator_basic_info(operator_name)` | Retrieve basic operator profile: class, rarity, faction, recruit tags, talents (Chinese name) |
| `list_story_events(category?)` | List story events; optional filter: `main` (main story) or `activities` |
| `list_stories(event_id)` | List chapters of an event in official order |
| `read_story(story_key, include_narration)` | Read full dialogue for a single chapter |
| `read_activity(event_id, include_narration, page, page_size)` | Read a complete activity's transcript, with pagination |
| `list_search_scopes` | List available search domains (operators, stories) with descriptions |
| `search_data(pattern, scope, max_results)` | Full-text regex search across operator names, descriptions, archives, and voice lines |
| `search_stories(pattern, character?, line_type?, context_lines?, max_results?, event_id?)` | Full-text regex search across story dialogue, narration, and choice lines with filtering |

### Quick Start

- **Local stdio (Python / Docker)** → see [`python/`](python/)
- **HTTP server (TypeScript / Docker)** → see [`ts/`](ts/)

### Data Sources

- **PRTS Wiki API** (`https://prts.wiki/api.php`) — lore articles, faction info, world-building entries
- **ArknightsGameData** ([`3aKHP/ArknightsGameData`](https://github.com/3aKHP/ArknightsGameData)) — Release archive mirror of [`Kengxxiao/ArknightsGameData`](https://github.com/Kengxxiao/ArknightsGameData), used for operator archives, voice lines, base stats, and other game tables
- **ArknightsStoryJson** ([`3aKHP/ArknightsStoryJson`](https://github.com/3aKHP/ArknightsStoryJson)) — parsed story dialogue, auto-synced from GitHub Releases (`zh_CN.zip`)

Game data lives in the `gamedata` volume. Story data lives in the `storyjson` volume. Both are auto-synced in the background after the server starts listening.

Published Docker images and the npm package include bundled fallback game/story data prepared by CI. The PyPI package stays lightweight and does not embed these data files; it relies on startup auto-sync or user-provided data paths.

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

### 1.0 兼容矩阵

| 范围 | Python | TypeScript | 1.0 策略 |
|------|--------|------------|----------|
| 当前版本线 | `1.1.0` | `1.1.0` | 稳定发布尽量从同一 commit 发布 |
| MCP 工具 | 相同的 12 个工具名和必填参数 | 相同的 12 个工具名和必填参数 | 1.x 期间保持工具名和必填参数稳定 |
| 干员数据 | `GAMEDATA_PATH` 或自动同步 `zh_CN-excel.zip` | `GAMEDATA_PATH` 或自动同步 `zh_CN-excel.zip` | 自定义路径会禁用自动同步 |
| 剧情数据 | `STORYJSON_PATH` 或自动同步 `zh_CN.zip` | `STORYJSON_PATH` 或自动同步 `zh_CN.zip` | 自定义 zip 会禁用自动同步 |
| bundled 兜底数据 | Docker 镜像 | Docker 镜像和正式 npm 包 | PyPI 继续保持轻量 |

0.x 到 1.0 的迁移说明见 [`docs/migration-0.x-to-1.0.md`](docs/migration-0.x-to-1.0.md)。

### 工具集

两个实现提供相同的工具集：

| 工具 | 说明 |
|------|------|
| `search_prts(query, limit)` | 关键词搜索 PRTS 维基词条，返回匹配标题列表 |
| `read_prts_page(page_title)` | 读取指定词条的纯文本内容 |
| `get_operator_archives(operator_name)` | 获取干员档案资料（中文名） |
| `get_operator_voicelines(operator_name)` | 获取干员语音记录（中文名） |
| `get_operator_basic_info(operator_name)` | 获取干员基本信息：职业、稀有度、所属、招募标签、天赋（中文名） |
| `list_story_events(category?)` | 列出剧情活动，可选过滤：`main`（主线）或 `activities`（活动） |
| `list_stories(event_id)` | 列出指定活动的章节（按官方顺序） |
| `read_story(story_key, include_narration)` | 读取单章完整台词 |
| `read_activity(event_id, include_narration, page, page_size)` | 读取整个活动的完整剧情，支持分页 |
| `list_search_scopes` | 列出可搜索的数据域（干员、剧情）及其内容类型 |
| `search_data(pattern, scope, max_results)` | 在干员名称、描述、档案、语音中执行全文正则搜索 |
| `search_stories(pattern, character?, line_type?, context_lines?, max_results?, event_id?)` | 在剧情台词中执行全文正则搜索，支持按角色和台词类型过滤 |

### 快速开始

- **本地 stdio 接入（Python / Docker）** → 见 [`python/`](python/)
- **HTTP 服务部署（TypeScript / Docker）** → 见 [`ts/`](ts/)

### 数据源

- **PRTS Wiki API** (`https://prts.wiki/api.php`) — 世界观词条、阵营设定
- **ArknightsGameData** ([`3aKHP/ArknightsGameData`](https://github.com/3aKHP/ArknightsGameData)) — [`Kengxxiao/ArknightsGameData`](https://github.com/Kengxxiao/ArknightsGameData) 的 Release 压缩包镜像，用于干员档案、语音记录、基础信息及其他游戏表
- **ArknightsStoryJson** ([`3aKHP/ArknightsStoryJson`](https://github.com/3aKHP/ArknightsStoryJson)) — 剧情台词解析数据，从 GitHub Releases 自动同步（`zh_CN.zip`）

干员数据存放在 `gamedata` volume，剧情数据存放在 `storyjson` volume，均在服务器开始监听后于后台自动同步。

正式发布的 Docker 镜像和 npm 包会由 CI 预置 bundled 兜底数据；PyPI 包保持轻量，不内置这些数据文件，依赖启动时 auto-sync 或用户自行提供数据路径。

---

## License

MIT
