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

### Tools

Both implementations expose the same tool set:

| Tool | Description |
|------|-------------|
| `search_prts(query, limit)` | Search PRTS Wiki by keyword, returns matching article titles |
| `read_prts_page(page_title)` | Fetch the plain-text content of a PRTS Wiki article |
| `get_operator_archives(operator_name)` | Retrieve operator archive records (Chinese name) |
| `get_operator_voicelines(operator_name)` | Retrieve operator voice lines (Chinese name) |

### Quick Start

- **Local stdio (Python / Docker)** → see [`python/`](python/)
- **HTTP server (TypeScript / Docker)** → see [`ts/`](ts/)

### Data Sources

- **PRTS Wiki API** (`https://prts.wiki/api.php`) — lore articles, faction info, world-building entries
- **ArknightsGameData** ([`Kengxxiao/ArknightsGameData`](https://github.com/Kengxxiao/ArknightsGameData)) — operator archives, voice lines, base stats

Shared game data lives in [`data/gamedata/`](data/gamedata/). The Python implementation maintains it via an auto-sync mechanism; the TypeScript implementation reads from the same directory.

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

### 快速开始

- **本地 stdio 接入（Python / Docker）** → 见 [`python/`](python/)
- **HTTP 服务部署（TypeScript / Docker）** → 见 [`ts/`](ts/)

### 数据源

- **PRTS Wiki API** (`https://prts.wiki/api.php`) — 世界观词条、阵营设定
- **ArknightsGameData** ([`Kengxxiao/ArknightsGameData`](https://github.com/Kengxxiao/ArknightsGameData)) — 干员档案、语音记录、基础信息

共享游戏数据位于 [`data/gamedata/`](data/gamedata/)，由 Python 版 auto-sync 机制维护，TS 版同样读取此目录。

---

## License

MIT
