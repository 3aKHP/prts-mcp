# PRTS MCP Server

[![PyPI](https://img.shields.io/pypi/v/prts-mcp)](https://pypi.org/project/prts-mcp/)
[![npm](https://img.shields.io/npm/v/prts-mcp-ts)](https://www.npmjs.com/package/prts-mcp-ts)
[![License: MIT](https://img.shields.io/github/license/3aKHP/prts-mcp)](LICENSE)
[![SafeSkill 50/100](https://img.shields.io/badge/SafeSkill-50%2F100_Use%20with%20Caution-orange)](https://safeskill.dev/scan/3akhp-prts-mcp)

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

### Quick Start

- **Local stdio (Python / Docker)** → see [`python/`](python/)
- **HTTP server (TypeScript / Docker)** → see [`ts/`](ts/)

### Data Sources

- **PRTS Wiki API** (`https://prts.wiki/api.php`) — lore articles, faction info, world-building entries
- **ArknightsGameData** ([`Kengxxiao/ArknightsGameData`](https://github.com/Kengxxiao/ArknightsGameData)) — operator archives, voice lines, base stats
- **ArknightsStoryJson** ([`3aKHP/ArknightsStoryJson`](https://github.com/3aKHP/ArknightsStoryJson)) — parsed story dialogue, auto-synced from GitHub Releases (`zh_CN.zip`)

Game data lives in the `gamedata` volume. Story data lives in the `storyjson` volume. Both are auto-synced on server startup.

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

### 快速开始

- **本地 stdio 接入（Python / Docker）** → 见 [`python/`](python/)
- **HTTP 服务部署（TypeScript / Docker）** → 见 [`ts/`](ts/)

### 数据源

- **PRTS Wiki API** (`https://prts.wiki/api.php`) — 世界观词条、阵营设定
- **ArknightsGameData** ([`Kengxxiao/ArknightsGameData`](https://github.com/Kengxxiao/ArknightsGameData)) — 干员档案、语音记录、基础信息
- **ArknightsStoryJson** ([`3aKHP/ArknightsStoryJson`](https://github.com/3aKHP/ArknightsStoryJson)) — 剧情台词解析数据，从 GitHub Releases 自动同步（`zh_CN.zip`）

干员数据存放在 `gamedata` volume，剧情数据存放在 `storyjson` volume，均在服务器启动时自动同步。

---

## License

MIT
