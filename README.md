# PRTS MCP Server

明日方舟同人创作辅助 MCP Server。通过 [PRTS Wiki](https://prts.wiki) API 和自动同步的干员数据，为 AI Agent 提供泰拉世界观检索与干员资料查询能力。

## 实现版本

本仓库包含两个独立实现，适用于不同的部署场景：

| 目录 | 语言 | 传输方式 | 适用场景 |
|------|------|----------|----------|
| [`python/`](python/) | Python 3.10+ | stdio | Claude Desktop / Claude Code 本地接入、Docker |
| [`ts/`](ts/) | TypeScript / Node.js | Streamable HTTP | 个人网站部署，供他人通过 HTTP 调用 |

## Tools

两个实现提供相同的工具集：

| Tool | 说明 |
|------|------|
| `search_prts(query, limit)` | 关键词搜索 PRTS 维基词条 |
| `read_prts_page(page_title)` | 读取指定词条的纯文本内容 |
| `get_operator_archives(operator_name)` | 获取干员档案资料（中文名） |
| `get_operator_voicelines(operator_name)` | 获取干员语音记录（中文名） |

## 快速开始

- **本地 stdio 接入（Python）** → 见 [`python/`](python/)
- **网站 HTTP 部署（TypeScript）** → 见 [`ts/`](ts/)

## 数据源

- **PRTS Wiki API** (`https://prts.wiki/api.php`) — 世界观词条、阵营设定
- **ArknightsGameData** (`Kengxxiao/ArknightsGameData`) — 干员档案、语音记录、基础信息

共享游戏数据位于 [`data/gamedata/`](data/gamedata/)，由 Python 版 auto-sync 机制维护，TS 版同样读取此目录。

## License

MIT
