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
| **2.7** (`main`) | `2.7.1` | 24 | Operator base skills (basic_info section + `search` building_skills scope), local artwork skin metadata, and the 2.7 internal refactor program. |
| **1.7 LTS** (`lts/1.7`) | `1.7.0` | 32 | Stable maintenance line. 1.7.x accepts only compatibility, security, data-sync, and critical bug fixes. |

The `main` and `develop` lines use the self-built `arknights-data-pipeline` Release exclusively for default Auto-Sync. The 1.7 LTS line retains its legacy upstream compatibility until a separate, backwards-compatible migration; changes to the new factory path must not be backported to LTS as an implicit source switch.

| Area | Python | TypeScript |
|------|--------|------------|
| MCP tools | Same 24 public tool names and required parameters (2.x) / 32 on 1.7 LTS | Same 24 (2.x) / 32 on 1.7 LTS |
| GameData | `GAMEDATA_PATH` or auto-synced `zh_CN-excel.zip` | `GAMEDATA_PATH` or auto-synced `zh_CN-excel.zip` |
| Level data | Auto-synced `zh_CN-levels.zip` beside GameData | Auto-synced `zh_CN-levels.zip` beside GameData |
| Story data | `STORYJSON_PATH` or auto-synced `zh_CN.zip` | `STORYJSON_PATH` or auto-synced `zh_CN.zip` |
| Image artwork (2.5) | Enabled by default; MediaWiki on-demand or AKDP local assets (`LOCAL_IMAGE=true`) | Enabled by default; MediaWiki on-demand or AKDP local assets (`LOCAL_IMAGE=true`) |
| Bundled fallback data | Docker image only | Docker image and published npm package (PyPI stays data-light) |

### Auto-Sync data contract

Both implementations consume the self-built [`arknights-data-pipeline`](https://github.com/3aKHP/arknights-data-pipeline) Release. New releases carry a `manifest.json` with the `prts-mcp-data/v1` contract, source `versionId`, and SHA-256/size for each archive; a mismatch is rejected before activation, while pre-manifest releases remain readable during the transition. The last activated generation stays in place on download, schema, or manifest failure.

`GITHUB_MIRRORS` is an explicit fallback for GitHub URL access. Mirror entries have surrounding whitespace and trailing slashes normalized automatically in both implementations. In Node deployments, standard `HTTP_PROXY`/`HTTPS_PROXY` (including lowercase spellings) are honored via Undici; Bun keeps its native `fetch` path. Proxy support does not weaken manifest or ZIP validation.

See [`docs/migration-1.x-to-2.0.md`](docs/migration-1.x-to-2.0.md) for the 1.x → 2.0 breaking changes (tool consolidation, `operator_name` → `name`, output channel), and [`docs/migration-0.x-to-1.0.md`](docs/migration-0.x-to-1.0.md) for the 0.x → 1.0 transition.

### MCP protocol compatibility

2.6.0 retains the established initialize/session flow for legacy MCP clients and adds opt-in support for the `2026-07-28` protocol era. Modern HTTP requests use the modern envelope and are stateless; they do not send `Mcp-Session-Id`. For stdio, the first request on a connection selects the era, so open a separate connection when changing protocol modes. See [the 2.5 → 2.6 migration guide](docs/migration-2.5-to-2.6.md) before switching a client to modern mode.

### Tools

Both implementations expose the same tool set:

| Tool | Description |
|------|-------------|
| `search_prts(query, limit)` | Search PRTS Wiki by keyword, returns matching article titles |
| `prts_page(page_title, action, ...)` | Read a wiki page or metadata; `template` returns rendered fields from top-level templates |
| `get_operator_archives(name)` | Retrieve operator archive records (Chinese name) |
| `get_operator_voicelines(name)` | Retrieve operator voice lines (Chinese name) |
| `get_operator_basic_info(name)` | Retrieve basic operator profile: class, rarity, faction, recruit tags, talents, base skills (Chinese name) |
| `list_story_events(category?)` | List story events; optional filter: `main` (main story) or `activities` |
| `list_stories(event_id, include_summaries?)` | List chapters of an event in official order; `include_summaries` adds the event-level overview + per-chapter summaries |
| `get_story_summary(story_key)` | Single-chapter summary (LLM long summary or official one-liner) |
| `read_story(story_key, include_narration)` | Read full dialogue for a single chapter |
| `read_activity(event_id, include_narration, page, page_size)` | Read a complete activity's transcript, with pagination |
| `search(scope, pattern, max_results)` | Full-text regex search within a data domain: `scope` ∈ operators / enemies / stages / items / building_skills |
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
| `operator_artwork(operator_name, action, artwork_id?, variant?)` | List operator illustrations/skins (local list carries skin collection/acquisition metadata) and retrieve image variants (base64); MediaWiki by default, AKDP local assets when `LOCAL_IMAGE=true` |

### Output Channel

Both implementations keep markdown as the default, human-readable output on MCP's `content` field. Deployments whose client consumes MCP-native `structuredContent` can opt in via a **connection-level** `output_channel` knob (`content` (default) / `structured` / `both`):

- **Python** — `PRTS_OUTPUT_CHANNEL` environment variable.
- **TypeScript** — `?output_channel=` query string, `x-prts-output-channel` header, or `PRTS_OUTPUT_CHANNEL` env.

The default `content` requires no configuration and is unchanged from 1.x. See the [2.0 migration guide](docs/migration-1.x-to-2.0.md) for the per-tool mapping and the rationale for choosing a channel over a per-call format parameter.

### Image Artwork

The `operator_artwork` tool (2.5.0+) is **enabled by default**. Two data source modes are selected by `LOCAL_IMAGE`:

| Variable | Default | Description |
|----------|---------|-------------|
| `IMAGES_ENABLED` | `true` | Master switch; `false` hides `operator_artwork`. |
| `LOCAL_IMAGE` | `false` | `true` = sync AKDP local PNG assets (~1.5 GB); `false` = fetch on-demand from PRTS MediaWiki (zero download). |
| `PRTS_IMAGE_CACHE` | `true` | In-memory LRU cache (256 MiB) for MediaWiki images; only effective when `LOCAL_IMAGE=false`. |
| `ORIGINAL_IMAGE` | `false` | Also sync original-resolution shards; only effective when `LOCAL_IMAGE=true`. |
| `PRTS_IMAGE_DIR` | `~/.local/share/prts-mcp/images/` | AKDP asset sync target; only effective when `LOCAL_IMAGE=true`. Docker: `/data/images`. |

Zero-config: the tool works immediately via MediaWiki with caching. For the full offline AKDP experience, set `LOCAL_IMAGE=true` (triggers ~1.5 GB background sync).

### Quick Start

Since 2.3.0 both implementations support both transports — pick by use case, not by language:

- **Local stdio** (Claude Desktop / Claude Code) → Python `prts-mcp` (stdio, default) or TypeScript `npx prts-mcp-ts-stdio`
- **HTTP server** (self-hosted, remote access) → Python `PRTS_TRANSPORT=http prts-mcp` or TypeScript `npx prts-mcp-ts`
- See [`python/`](python/) and [`ts/`](ts/) for per-implementation details

The TypeScript implementation supports Bun and Node.js. Since 2.2.0 **Bun is the default production runtime**: the default `ts/Dockerfile`, the primary CI verification path, and the recommended Docker deployment all run under Bun (verified against Bun `1.3.14`). Node.js remains a supported legacy/optional runtime via the `prts-mcp-ts` npm bin (so `npx prts-mcp-ts` stays zero-dependency), `npm install -g`, and the `ts/Dockerfile.node` build path. The npm publishing path still uses npm CLI (`npm publish --provenance`, runtime-agnostic).

### Data Sources

- **PRTS Wiki API** (`https://prts.wiki/api.php`) — lore articles, faction info, world-building entries
- **arknights-data-pipeline** ([`3aKHP/arknights-data-pipeline`](https://github.com/3aKHP/arknights-data-pipeline)) — self-hosted data factory producing game data tables (`zh_CN-excel.zip`), level combat data (`zh_CN-levels.zip`), and parsed story dialogue with LLM summaries (`zh_CN.zip`) from a single GitHub Release

Game data lives in the `gamedata` volume. Level combat data lives in the `gamedata-levels` volume. Story data lives in the `storyjson` volume. After the server starts listening, all three are checked in the background immediately and then every hour without restarting the process. Set `PRTS_AUTO_SYNC_INTERVAL_SECONDS` to `60..604800` to change the interval, or `0` to keep startup sync only.

Published Docker images and the npm package include bundled fallback game/level/story data prepared by CI. The PyPI package stays lightweight and does not embed these data files; it relies on startup auto-sync or user-provided data paths.

### Development

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the contribution workflow and [`docs/dev/ENVIRONMENT.md`](docs/dev/ENVIRONMENT.md) for Linux/WSL, Windows, and macOS development setup.

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
| **2.7**（`main`） | `2.7.1` | 24 | 干员基建技能（basic_info 新段 + `search` 新 scope）、本地立绘皮肤元数据、2.7 内部重构程序。 |
| **1.7 LTS**（`lts/1.7`） | `1.7.0` | 32 | 稳定维护线。1.7.x 仅接受兼容性、安全性、数据同步和关键缺陷修复。 |

| 范围 | Python | TypeScript |
|------|--------|------------|
| MCP 工具 | 相同的 24 个工具名和必填参数（2.x）/ 1.7 LTS 为 32 个 | 相同的 24 个（2.x）/ 1.7 LTS 为 32 个 |
| 干员数据 | `GAMEDATA_PATH` 或自动同步 `zh_CN-excel.zip` | `GAMEDATA_PATH` 或自动同步 `zh_CN-excel.zip` |
| 关卡战斗数据 | 自动同步与 GameData 并列的 `zh_CN-levels.zip` | 自动同步与 GameData 并列的 `zh_CN-levels.zip` |
| 剧情数据 | `STORYJSON_PATH` 或自动同步 `zh_CN.zip` | `STORYJSON_PATH` 或自动同步 `zh_CN.zip` |
| 立绘图片（2.5） | 默认开启；MediaWiki 按需获取或 AKDP 本地资产（`LOCAL_IMAGE=true`） | 默认开启；MediaWiki 按需获取或 AKDP 本地资产（`LOCAL_IMAGE=true`） |
| bundled 兜底数据 | Docker 镜像 | Docker 镜像和正式 npm 包（PyPI 保持轻量） |

### Auto-Sync 数据契约

两套实现都消费自建 [`arknights-data-pipeline`](https://github.com/3aKHP/arknights-data-pipeline) Release。新 Release 附带 `manifest.json`，声明 `prts-mcp-data/v1` 契约、源 `versionId` 以及每个压缩包的大小/SHA-256；不匹配会在激活前拒绝，迁移期间仍兼容没有 manifest 的旧 Release。下载、结构或 manifest 校验失败时，服务继续使用上一代已激活数据。

`GITHUB_MIRRORS` 是显式的 GitHub 访问备用路径；条目的首尾空白与尾部斜杠在两种实现中都会自动归一化。Node 部署会通过 Undici 使用标准 `HTTP_PROXY`/`HTTPS_PROXY`（也识别小写变量），Bun 保持原生 `fetch` 路径。代理不会绕过 manifest 或 ZIP 校验。

1.x → 2.0 的破坏性变更（工具面合并、`operator_name` → `name`、output channel）见 [`docs/migration-1.x-to-2.0.md`](docs/migration-1.x-to-2.0.md)；0.x → 1.0 迁移见 [`docs/migration-0.x-to-1.0.md`](docs/migration-0.x-to-1.0.md)。

### MCP 协议兼容性

2.6.0 保留既有 initialize/session 的 legacy MCP 客户端流程，并新增 opt-in 的 `2026-07-28` 协议时代支持。现代 HTTP 请求使用现代 envelope 且无状态，不发送 `Mcp-Session-Id`；stdio 由连接上的第一条请求选择协议时代，切换协议模式时请新建连接。把客户端切换到 modern 前，请先阅读 [2.5 → 2.6 迁移指南](docs/migration-2.5-to-2.6.md)。

### 工具集

两个实现提供相同的工具集：

| 工具 | 说明 |
|------|------|
| `search_prts(query, limit)` | 关键词搜索 PRTS 维基词条，返回匹配标题列表 |
| `prts_page(page_title, action, ...)` | 读取词条正文或元数据；`template` 返回顶层模板的结构化、已渲染字段数据 |
| `get_operator_archives(name)` | 获取干员档案资料（中文名） |
| `get_operator_voicelines(name)` | 获取干员语音记录（中文名） |
| `get_operator_basic_info(name)` | 获取干员基本信息：职业、稀有度、所属、招募标签、天赋、基建技能（中文名） |
| `list_story_events(category?)` | 列出剧情活动，可选过滤：`main`（主线）或 `activities`（活动） |
| `list_stories(event_id, include_summaries?)` | 列出指定活动的章节（按官方顺序）；`include_summaries` 附活动级概览 + 每章梗概 |
| `get_story_summary(story_key)` | 获取单章梗概（LLM 长摘要或官方一句话简介） |
| `read_story(story_key, include_narration)` | 读取单章完整台词 |
| `read_activity(event_id, include_narration, page, page_size)` | 读取整个活动的完整剧情，支持分页 |
| `search(scope, pattern, max_results)` | 在指定数据域执行全文正则搜索：`scope` ∈ operators / enemies / stages / items / building_skills（基建技能跨干员反查） |
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
| `operator_artwork(operator_name, action, artwork_id?, variant?)` | 列出干员立绘/时装（本地模式附带皮肤系列/获取方式等元数据）并获取图片变体（base64）；默认走 MediaWiki，`LOCAL_IMAGE=true` 时使用 AKDP 本地资产 |

### 输出通道

两个实现默认在 MCP 的 `content` 字段输出人类可读的 markdown。若部署环境使用的客户端能消费 MCP 原生的 `structuredContent`，可通过**连接级**的 `output_channel` 开关（`content`（默认）/ `structured` / `both`）启用：

- **Python** — `PRTS_OUTPUT_CHANNEL` 环境变量。
- **TypeScript** — `?output_channel=` 查询字符串、`x-prts-output-channel` 请求头，或 `PRTS_OUTPUT_CHANNEL` 环境变量。

默认 `content` 无需任何配置，与 1.x 一致。各工具的通道映射，以及「为何选连接级通道而非 per-call 格式参数」的设计理由，见 [2.0 迁移指南](docs/migration-1.x-to-2.0.md)。

### 立绘工具

`operator_artwork` 工具（2.5.0+）**默认开启**。通过 `LOCAL_IMAGE` 选择数据源：

| 变量 | 缺省值 | 说明 |
|----------|---------|-------------|
| `IMAGES_ENABLED` | `true` | 主开关；`false` 隐藏 `operator_artwork`。 |
| `LOCAL_IMAGE` | `false` | `true` = 同步 AKDP 本地 PNG 资产（~1.5 GB）；`false` = 从 PRTS MediaWiki 按需获取（零下载）。 |
| `PRTS_IMAGE_CACHE` | `true` | MediaWiki 图片的内存 LRU 缓存（256 MiB）；仅在 `LOCAL_IMAGE=false` 时生效。 |
| `ORIGINAL_IMAGE` | `false` | 额外同步原图分辨率分片；仅在 `LOCAL_IMAGE=true` 时生效。 |
| `PRTS_IMAGE_DIR` | `~/.local/share/prts-mcp/images/` | AKDP 资产同步目标；仅在 `LOCAL_IMAGE=true` 时生效。Docker：`/data/images`。 |

零配置即可使用：默认走 MediaWiki + 缓存。若需离线全量体验，设置 `LOCAL_IMAGE=true`（触发 ~1.5 GB 后台同步）。

### 快速开始

自 2.3.0 起两个实现都支持双传输——按场景选择，而非按语言：

- **本地 stdio 接入**（Claude Desktop / Claude Code）→ Python `prts-mcp`（stdio，默认）或 TypeScript `npx prts-mcp-ts-stdio`
- **HTTP 服务部署**（自建服务器，供他人调用）→ Python `PRTS_TRANSPORT=http prts-mcp` 或 TypeScript `npx prts-mcp-ts`
- 详见 [`python/`](python/) 和 [`ts/`](ts/)

TypeScript 实现支持 Bun 与 Node.js。自 2.2.0 起 **Bun 是默认生产运行时**：默认 `ts/Dockerfile`、CI 主验证链与推荐 Docker 部署均在 Bun 下运行（最低验证版本 Bun `1.3.14`）。Node.js 保留为受支持的 legacy/可选运行时，通过 `prts-mcp-ts` npm bin（因此 `npx prts-mcp-ts` 仍零额外运行时依赖）、`npm install -g` 与 `ts/Dockerfile.node` 构建路径提供。npm 发布路径仍走 npm CLI（`npm publish --provenance`，与运行时无关）。

### 数据源

- **PRTS Wiki API** (`https://prts.wiki/api.php`) — 世界观词条、阵营设定
- **arknights-data-pipeline** ([`3aKHP/arknights-data-pipeline`](https://github.com/3aKHP/arknights-data-pipeline)) — 自建数据工厂，从单一 GitHub Release 产出游戏数据表（`zh_CN-excel.zip`）、关卡战斗数据（`zh_CN-levels.zip`）和剧情台词解析+LLM 摘要（`zh_CN.zip`）

干员/表格数据存放在 `gamedata` volume，关卡战斗数据存放在 `gamedata-levels` volume，剧情数据存放在 `storyjson` volume。服务器开始监听后会立即在后台检查，此后默认每小时检查一次，无需重启进程。可用 `PRTS_AUTO_SYNC_INTERVAL_SECONDS=60..604800` 调整周期，或设为 `0` 仅保留启动同步。

正式发布的 Docker 镜像和 npm 包会由 CI 预置 bundled 兜底数据；PyPI 包保持轻量，不内置这些数据文件，依赖启动时 auto-sync 或用户自行提供数据路径。

### 开发与贡献

贡献流程见 [`CONTRIBUTING.md`](CONTRIBUTING.md)，Linux/WSL、Windows 和 macOS 的开发环境入口见 [`docs/dev/ENVIRONMENT.md`](docs/dev/ENVIRONMENT.md)。

---

## License

MIT
