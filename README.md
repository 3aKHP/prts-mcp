# PRTS MCP Server

[![PyPI 2.x](https://img.shields.io/pypi/v/prts-mcp?label=PyPI%202.x)](https://pypi.org/project/prts-mcp/)
[![npm stable](https://img.shields.io/npm/v/prts-mcp?label=npm%20stable)](https://www.npmjs.com/package/prts-mcp)
[![npm prts-mcp-ts](https://img.shields.io/npm/v/prts-mcp-ts?label=npm%20prts-mcp-ts)](https://www.npmjs.com/package/prts-mcp-ts)
[![License: MIT](https://img.shields.io/github/license/3aKHP/prts-mcp)](LICENSE)

**Language / 语言：** [English](#english) | [中文](#中文)

---

<a id="english"></a>

## English

An MCP Server for [Arknights](https://www.arknights.global/) fan creation (同人創作) AI agents. Powered by the [PRTS Wiki](https://prts.wiki) MediaWiki API and auto-synced operator game data, it gives any MCP-compatible client — Claude Desktop, Claude Code, Chatbox, and more — live access to lore, operator archives, and voice lines from the world of Terra.

### Implementation and Release Lines

Starting with 3.x, PRTS-MCP is unified into a single native Rust implementation at the repository root, with its C regular-expression engine statically linked into prebuilt binaries. All game-data queries, Wiki requests, and MCP protocol handling run in Rust:

- **Prebuilt native archives and Docker images** run directly with no language runtime or compiler required.
- **npm packages** provide a thin Node.js launch bridge (`Node >=22`, `npm >=10`) that invokes the platform-matched Rust binary; Bun is not required.
- **Building from source** requires a Rust toolchain and a C compiler.

| Line | Version | Tools | Status |
|------|---------|-------|--------|
| Public stable (`main`) | 3.1.3 | 24 | Native Rust stable release on npm (`latest`), GitHub Releases, and GHCR (`:latest`, `:3`). |
| Rust (`develop`) | 3.1.3-dev.0 | 24 | Active 3.x development line. |
| `lts/2.8` | 2.8.x | 24 | Python/TypeScript long-term maintenance; EOL 2027-07-02. |
| `lts/1.7` | 1.7.x | 32 | Python/TypeScript long-term maintenance; EOL 2027-07-02. |

On npm, install `prts-mcp` (or pin `3.1.3`). If you want to keep existing 2.x command names (`prts-mcp-ts`, `prts-mcp-ts-bun`, `prts-mcp-ts-stdio`), install `prts-mcp-ts`; from 3.0.0 it is also backed by the Rust binary. To stay on 2.8.x, pin `prts-mcp-ts@lts-2.8` or `ghcr.io/3akhp/prts-mcp:2`. See the [roadmap](ROADMAP.md), [2.x → 3.0 migration guide](docs/migration-2.x-to-3.0.md), and [2.8.1 documentation](https://github.com/3aKHP/prts-mcp/tree/ts/v2.8.1).

Prebuilt binaries are provided for **Linux x64/ARM64** (`glibc >= 2.28`), **Windows x64**, and **macOS ARM64/x64** (macOS 14.0+). Linux musl/Alpine and other CPU architectures are not supported by the prebuilt native archives. Docker images are published for Linux x64 and ARM64. See [NATIVE-PLATFORMS.md](docs/dev/NATIVE-PLATFORMS.md) for platform ABI baselines and verification details.

### Quick Start

#### 1. npm (Node >=22, npm >=10)

```bash
# Install globally and start Streamable HTTP (default on port 3000):
npm install -g prts-mcp@3.1.3
prts-mcp

# Or run in stdio mode for local MCP clients:
PRTS_TRANSPORT=stdio prts-mcp

# Or keep legacy 2.x command names via the compatibility package:
npm install -g prts-mcp-ts@3.1.3
prts-mcp-ts-stdio
```

For a one-off trial without global installation:

- **HTTP mode**: `npx -y prts-mcp@3.1.3`
- **stdio mode**: `npx -y --package=prts-mcp-ts@3.1.3 prts-mcp-ts-stdio`

Default transport behavior by entry point:

- **`prts-mcp` (native binary and npm main package)**: defaults to Streamable HTTP at `http://localhost:3000/mcp` (health check at `/health`). Set `PRTS_TRANSPORT=stdio` when a local MCP client spawns the server as a subprocess.
- **Docker image (`ghcr.io/3akhp/prts-mcp`)**: defaults to `stdio`. Pass `-e PRTS_TRANSPORT=http` to run it as an HTTP server.
- **`prts-mcp-ts` compatibility commands**: run the Rust binary under the hood (no Bun needed) while keeping fixed 2.x transport modes — `prts-mcp-ts` and `prts-mcp-ts-bun` always use HTTP, and `prts-mcp-ts-stdio` always uses stdio.

#### 2. Docker

```bash
# Run as an HTTP service with persistent data:
docker run -d --name prts-mcp -p 127.0.0.1:3000:3000 -e PRTS_TRANSPORT=http -v prts-data:/data ghcr.io/3akhp/prts-mcp:3.1.3
```

#### 3. Prebuilt Native Archives & Source Builds

Download the archive for your OS and CPU from the [3.1.3 GitHub Release](https://github.com/3aKHP/prts-mcp/releases/tag/v3.1.3), verify its SHA-256 checksum, extract it while keeping the `bin/` and `data/` directory structure intact, and run `bin/prts-mcp` (`bin\prts-mcp.exe` on Windows). To build from source, run `cargo build --locked --release --bins`.

For MCP client configuration snippets (`Claude Desktop`, `Claude Code`, `Roo Code`, `Codex`), see the [Agent & MCP Beginner Guide](docs/user/mcp-and-agent-basics.md), [Client Quick Start Guide](docs/user/quick-start.md), and [Tools & Workflow Guide](docs/user/tools-guide.md). For server deployment, Docker volume mounting, and troubleshooting, see the [Server Deployment Guide](docs/admin/deployment.md).

### Tools

The server exposes 24 MCP tools (`IMAGES_ENABLED=false` disables `operator_artwork`, leaving 23 tools):

| Tool | Description |
|------|-------------|
| `search_prts(query, limit?)` | Search PRTS Wiki by keyword, returns matching article titles |
| `prts_page(page_title, action, ...)` | Read a wiki page or metadata; `template` returns structured, rendered fields from top-level templates |
| `get_operator_archives(name)` | Retrieve operator archive records (Chinese name) |
| `get_operator_voicelines(name)` | Retrieve operator voice lines (Chinese name) |
| `get_operator_basic_info(name, action="basic", phase?, level?)` | Query an operator's profile/talents/base skills (`basic`, default), per-level combat skills (`skills`), or stat panels (`stats`); `phase`/`level` apply only to `stats` (Chinese name) |
| `list_story_events(category?)` | List story events; optional filter: `main` (main story), `activities`, or `roguelike` |
| `list_stories(event_id, include_summaries?)` | List chapters of an event in official order; `include_summaries` adds the event-level overview + per-chapter summaries |
| `get_story_summary(story_key)` | Single-chapter summary (LLM long summary or official one-liner) |
| `read_story(story_key, include_narration?)` | Read full dialogue for a single chapter |
| `read_activity(event_id, include_narration?, page?, page_size?)` | Read a complete activity's transcript, with pagination |
| `search(scope, pattern, max_results?)` | Full-text regex search within a data domain: `scope` ∈ operators / enemies / stages / items / building_skills / skills; the skill scopes support cross-operator lookup |
| `search_stories(pattern, character?, line_type?, context_lines?, max_results?, event_id?)` | Full-text regex search across story dialogue, narration, and choice lines, with character and line-type filters |
| `list_enemies(threat_level?, limit?, offset?, full?)` | List all enemies in the handbook with threat level and description |
| `get_enemy_info(name, stage_id?)` | Retrieve full enemy handbook entry by name, or stage-specific stats when `stage_id` is provided |
| `get_stage_enemies(stage_id)` | List enemies actually spawned in a stage, with stage-specific levels and combat stats |
| `get_enemy_appearances(name, limit?, offset?)` | Reverse lookup stages where an enemy actually spawns |
| `list_stages(chapter?, type?, limit?, offset?)` | List stages with optional chapter/zone and stage-type filters |
| `get_stage_info(stage_id)` | Retrieve detailed stage information by stage ID |
| `list_items(category?, limit?, offset?)` | List items/materials from `item_table.json` with optional category filtering and pagination |
| `get_item_info(name)` | Retrieve item/material details, usage, obtain methods, drops, production, and shop links |
| `get_operator_memoirs(name)` | Resolve an operator's memoir (干员密录) story keys for follow-up `read_story` calls |
| `find_character_appearances(name, scope?, max_events?)` | Find chapters/events where a character speaks (dialog) or is mentioned (name substring) |
| `find_speakers_in(event_id)` | List every speaker in an event with dialog line counts |
| `operator_artwork(operator_name, action, artwork_id?, variant?)` | List operator illustrations/skins (local list carries skin collection/acquisition metadata) and retrieve image variants (base64); MediaWiki by default, AKDP local assets when `LOCAL_IMAGE=true` |

`get_operator_basic_info(name)` returns the basic profile by default. Pass `action="skills"` for Lv1–7 and mastery effects, or `action="stats"` for elite-phase Lv1/max stat panels with trust and potential bonuses. To query a specific level's panel, supply both `phase` (0–2) and `level` — for example, `get_operator_basic_info("阿米娅", action="stats", phase=2, level=40)`. `phase` and `level` are valid only when `action="stats"`, and each call returns only the selected action's content.

### Output Channel

By default, tools return human-readable Markdown in the MCP `content` field. Clients that consume MCP `structuredContent` can set a connection-level output channel (`content`, `structured`, or `both`) via `PRTS_OUTPUT_CHANNEL`. In HTTP mode, individual requests or sessions can also override this via the `?output_channel=` query parameter or the `x-prts-output-channel` header. See the [environment variable reference](docs/admin/environment-variables.md) and the [2.0 migration guide](docs/migration-1.x-to-2.0.md).

### Image Artwork (`operator_artwork`)

The `operator_artwork` tool (2.5.0+) is **enabled by default** and supports two data-source modes controlled by `LOCAL_IMAGE`:

| Variable | Default | Description |
|----------|---------|-------------|
| `IMAGES_ENABLED` | `true` | Master switch; `false` hides `operator_artwork` (24 → 23 tools). |
| `LOCAL_IMAGE` | `false` | `false` = fetch images on demand from PRTS MediaWiki (no upfront asset sync, though fetching an image still uses network traffic); `true` = sync full AKDP PNG packages to local disk (multi-GB). |
| `PRTS_IMAGE_CACHE` | `true` | In-memory LRU cache (256 MiB) for MediaWiki images; only effective when `LOCAL_IMAGE=false`. |
| `ORIGINAL_IMAGE` | `false` | Also sync original-resolution image shards; only effective when `LOCAL_IMAGE=true`. |
| `PRTS_IMAGE_DIR` | `~/.local/share/prts-mcp/images/` | Local directory for synced AKDP images (`LOCAL_IMAGE=true` only; `/data/images` in Docker). |

Zero configuration is required out of the box: the server fetches requested illustrations from MediaWiki and caches them in memory. Set `LOCAL_IMAGE=true` only if you want a full local mirror of AKDP artwork assets. For storage planning and the full list of runtime variables, see [Data & Artwork Storage Management](docs/admin/data-and-sync.md) and [docs/admin/environment-variables.md](docs/admin/environment-variables.md).

### Data Sources and Auto-Sync

- **PRTS Wiki API** (`https://prts.wiki/api.php`) — lore articles, faction info, and world-building entries.
- **arknights-data-pipeline** ([`3aKHP/arknights-data-pipeline`](https://github.com/3aKHP/arknights-data-pipeline)) — self-hosted data pipeline publishing game data tables (`zh_CN-excel.zip`), level combat data (`zh_CN-levels.zip`), and parsed story dialogue with LLM summaries (`zh_CN.zip`) via GitHub Releases.

Game tables, level combat data, and story archives are stored under `gamedata`, `gamedata-levels`, and `storyjson` respectively. Once the server starts listening, it checks for updates in the background immediately and re-checks every hour by default (`PRTS_AUTO_SYNC_INTERVAL_SECONDS=3600`; configurable across `60..604800`, or `0` to run only the startup check).

New pipeline releases include a `manifest.json` (`prts-mcp-data/v1` contract) with the source `versionId` and each archive's SHA-256 and byte size. Archives that fail manifest or structure checks are rejected before activation, while pre-manifest releases remain supported. If a download or validation fails, the previously activated data generation stays online without interruption.

`GITHUB_MIRRORS` accepts comma-separated fallback URL prefixes for GitHub release downloads (surrounding whitespace and trailing slashes are normalized automatically). Standard proxy environment variables (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`) are also respected; using a proxy or mirror never bypasses manifest or ZIP verification.

Public Rust native archives, Docker images, and npm packages ship with a verified read-only fallback snapshot of game, level, and story data so offline queries work immediately even before the first sync completes. Once complete user data is present in the writable data directory or volume, user data takes precedence. Source builds rely on runtime auto-sync or explicit data paths (`GAMEDATA_PATH`, `STORYJSON_PATH`); crates.io publication is planned after 3.0.0 stable, and there is no Rust package on PyPI.

### Protocol Compatibility & Migration Guides

- **Dual-Era MCP Protocol (Zero-Config Adaptive)**: PRTS-MCP supports both the stateful legacy session flow (`initialize` + `Mcp-Session-Id`) and the stateless `2026-07-28` modern envelope (`_meta` per request) with **zero server-side configuration**. In Streamable HTTP mode, a single `/mcp` endpoint can serve multiple legacy and modern clients concurrently, isolating each session's state and output channel; if a legacy session expires after the 24-hour idle timeout (`SESSION_IDLE_TIMEOUT_MS`) or a server restart (`-32002: MCP session lost`), clients can simply re-send `initialize` or toggle the MCP connection in client settings. In `stdio` mode, the first message on a pipe locks the protocol era for that subprocess. See the [Client Quick Start Guide](docs/user/quick-start.md), [Server Deployment Guide](docs/admin/deployment.md), and [2.5 → 2.6 Migration Guide](docs/migration-2.5-to-2.6.md).
- **Version Upgrades**:
  - [2.x → 3.0 Migration Guide](docs/migration-2.x-to-3.0.md) (Rust transition, entry points, data volumes)
  - [1.x → 2.0 Migration Guide](docs/migration-1.x-to-2.0.md) (tool consolidation, `operator_name` → `name`, output channel)
  - [0.x → 1.0 Migration Guide](docs/migration-0.x-to-1.0.md)

### Development

- [Documentation Index](docs/README.md) — overview of user, administrator, developer, and migration guides.
- [Project Status](STATUS.md) · [Changelog](CHANGELOG.md) · [Roadmap](ROADMAP.md) · [Security Policy](SECURITY.md#english)
- [Contributing Guide](CONTRIBUTING.md) and [Development Environment Setup](docs/dev/ENVIRONMENT.md) — instructions for building and testing on Linux/WSL, Windows, and macOS.

---

<a id="中文"></a>

## 中文

面向[明日方舟](https://www.arknights.global/)同人创作 AI 助手的 MCP Server。通过 [PRTS Wiki](https://prts.wiki) MediaWiki API 与自动同步的游戏数据，为 Claude Desktop、Claude Code、Chatbox 等 MCP 客户端提供泰拉世界观、干员档案、技能数值、关卡敌情与剧情文本的实时查询。

### 实现与版本线

从 3.x 起，PRTS-MCP 统一为仓库根目录下的原生 Rust 实现，并将 C 正则组件静态链接进预编译二进制中。游戏数据查询、Wiki 解析与 MCP 协议处理全部由 Rust 执行：

- **预编译原生归档包与 Docker 镜像**：开箱即用，无需安装任何语言运行时或编译器。
- **npm 包**：提供轻量的 Node.js 启动桥（要求 `Node >=22`、`npm >=10`），自动拉起对应平台的预编译 Rust 二进制，无需安装 Bun。
- **从源码构建**：需要安装 Rust 工具链与 C 编译器。

| 版本线 | 版本 | 工具数 | 状态 |
|--------|------|--------|------|
| 公开稳定版（`main`） | 3.1.3 | 24 | 原生 Rust 正式版，已发布至 npm（`latest`）、GitHub Releases 与 GHCR（`:latest`、`:3`）。 |
| Rust 开发线（`develop`） | 3.1.3-dev.0 | 24 | 3.x 主开发线。 |
| `lts/2.8` | 2.8.x | 24 | Python/TypeScript 长期维护线，维护至 2027-07-02（EOL）。 |
| `lts/1.7` | 1.7.x | 32 | Python/TypeScript 长期维护线，维护至 2027-07-02（EOL）。 |

通过 npm 安装时，请安装 `prts-mcp`（或指定精确版本 `3.1.3`）。若希望保留 2.x 的旧命令名（`prts-mcp-ts`、`prts-mcp-ts-bun`、`prts-mcp-ts-stdio`），可安装兼容包 `prts-mcp-ts`，它自 3.0.0 起同样运行 Rust 二进制。如需继续使用 2.8.x，请固定 `prts-mcp-ts@lts-2.8` 或 `ghcr.io/3akhp/prts-mcp:2`。详见[路线图](ROADMAP.zh-CN.md)、[2.x → 3.0 迁移指南](docs/migration-2.x-to-3.0.md)与 [2.8.1 旧版文档](https://github.com/3aKHP/prts-mcp/tree/ts/v2.8.1)。

预编译二进制支持 **Linux x64/ARM64**（`glibc >= 2.28`）、**Windows x64** 与 **macOS ARM64/x64**（macOS 14.0+）；暂不支持 Linux musl/Alpine 及其他 CPU 架构。Docker 镜像支持 Linux x64 与 ARM64。各平台的 ABI 基线与验证详情见[原生平台说明](docs/dev/NATIVE-PLATFORMS.md)。

### 快速开始

#### 1. npm 安装（需 Node >=22、npm >=10）

```bash
# 全局安装并启动 Streamable HTTP 服务（默认监听 3000 端口）：
npm install -g prts-mcp@3.1.3
prts-mcp

# 本地客户端以 stdio 子进程方式接入：
PRTS_TRANSPORT=stdio prts-mcp

# 若需保留 2.x 旧命令配置，可安装兼容入口包：
npm install -g prts-mcp-ts@3.1.3
prts-mcp-ts-stdio
```

免安装临时试用可直接通过 `npx` 启动：

- **HTTP 模式**：`npx -y prts-mcp@3.1.3`
- **stdio 模式**：`npx -y --package=prts-mcp-ts@3.1.3 prts-mcp-ts-stdio`

各入口的默认传输方式如下：

- **`prts-mcp`（原生二进制与 npm 主包）**：默认启动 Streamable HTTP，端点为 `http://localhost:3000/mcp`，健康检查为 `/health`。本地客户端拉起子进程时，设置 `PRTS_TRANSPORT=stdio` 切换为 stdio。
- **Docker 镜像（`ghcr.io/3akhp/prts-mcp`）**：默认使用 `stdio`；作为独立 HTTP 服务运行时，需显式传入 `-e PRTS_TRANSPORT=http`。
- **`prts-mcp-ts` 兼容命令**：底层同样运行 Rust 二进制（无需安装 Bun），并保持 2.x 的固定传输行为——`prts-mcp-ts` 与 `prts-mcp-ts-bun` 固定为 HTTP，`prts-mcp-ts-stdio` 固定为 stdio。

#### 2. Docker 运行

```bash
# 以 HTTP 模式后台运行镜像，并挂载数据卷：
docker run -d --name prts-mcp -p 127.0.0.1:3000:3000 -e PRTS_TRANSPORT=http -v prts-data:/data ghcr.io/3akhp/prts-mcp:3.1.3
```

#### 3. 预编译原生归档包与源码构建

从 [3.1.3 Release](https://github.com/3aKHP/prts-mcp/releases/tag/v3.1.3) 下载对应系统与架构的归档包，校验 SHA-256 后解压（请完整保留解压目录内的 `bin/` 与 `data/` 相对结构），直接运行 `bin/prts-mcp`（Windows 为 `bin\prts-mcp.exe`）。从源码编译请执行 `cargo build --locked --release --bins`。

各大 MCP 客户端的零基础入门、配置片段与工具串联工作流请参阅[Agent 与 MCP 零基础入门指南](docs/user/mcp-and-agent-basics.md)、[客户端接入与快速上手指南](docs/user/quick-start.md)和[工具使用与同人创作工作流指南](docs/user/tools-guide.md)；服务器常驻部署、Docker 卷挂载与故障排查请参阅[服务端部署与容器运维指南](docs/admin/deployment.md)。

### 工具集

服务端共提供 24 个 MCP 工具（设置 `IMAGES_ENABLED=false` 会隐藏 `operator_artwork`，剩余 23 个）：

| 工具 | 说明 |
|------|------|
| `search_prts(query, limit?)` | 关键词搜索 PRTS 维基词条，返回匹配标题列表 |
| `prts_page(page_title, action, ...)` | 读取词条正文或元数据；`template` 返回顶层模板的结构化、已渲染字段数据 |
| `get_operator_archives(name)` | 获取干员档案资料（中文名） |
| `get_operator_voicelines(name)` | 获取干员语音记录（中文名） |
| `get_operator_basic_info(name, action="basic", phase?, level?)` | 查询干员档案/天赋/基建技能（`basic`，默认）、战斗技能各等级效果（`skills`）或面板数值（`stats`）；`phase`/`level` 仅用于 `stats`（中文名） |
| `list_story_events(category?)` | 列出剧情活动，可选过滤：`main`（主线）、`activities`（活动）或 `roguelike`（集成战略） |
| `list_stories(event_id, include_summaries?)` | 列出指定活动的章节（按官方顺序）；`include_summaries` 附活动级概览 + 每章梗概 |
| `get_story_summary(story_key)` | 获取单章梗概（LLM 长摘要或官方一句话简介） |
| `read_story(story_key, include_narration?)` | 读取单章完整台词 |
| `read_activity(event_id, include_narration?, page?, page_size?)` | 读取整个活动的完整剧情，支持分页 |
| `search(scope, pattern, max_results?)` | 在指定数据域执行全文正则搜索：`scope` ∈ operators / enemies / stages / items / building_skills / skills（基建/战斗技能跨干员反查） |
| `search_stories(pattern, character?, line_type?, context_lines?, max_results?, event_id?)` | 在剧情对话、旁白和选项中执行全文正则搜索，支持按角色和台词类型过滤 |
| `list_enemies(threat_level?, limit?, offset?, full?)` | 列出敌方图鉴中所有敌人及其威胁等级和描述 |
| `get_enemy_info(name, stage_id?)` | 获取指定敌人的详细图鉴资料；传入 `stage_id` 时返回关卡级数值 |
| `get_stage_enemies(stage_id)` | 获取指定关卡实际出场敌人及关卡级等级/战斗属性 |
| `get_enemy_appearances(name, limit?, offset?)` | 反查指定敌人实际出现在哪些关卡 |
| `list_stages(chapter?, type?, limit?, offset?)` | 列出关卡，支持按章节/区域和关卡类型过滤 |
| `get_stage_info(stage_id)` | 根据关卡 ID 获取关卡详细信息 |
| `list_items(category?, limit?, offset?)` | 列出 `item_table.json` 中的物品/材料，支持按类别过滤和分页 |
| `get_item_info(name)` | 获取物品/材料详情、用途、获取方式、掉落、基建产出和商店关联 |
| `get_operator_memoirs(name)` | 解析干员密录的 story_key，便于后续 `read_story` 调用 |
| `find_character_appearances(name, scope?, max_events?)` | 查找角色在哪些章节/活动中开口（对话）或被提及（名字子串） |
| `find_speakers_in(event_id)` | 列出指定活动中所有发言角色及其对话行数 |
| `operator_artwork(operator_name, action, artwork_id?, variant?)` | 列出干员立绘/时装（本地模式附带皮肤系列/获取方式等元数据）并获取图片变体（base64）；默认走 MediaWiki，`LOCAL_IMAGE=true` 时使用 AKDP 本地资产 |

`get_operator_basic_info(name)` 默认返回干员基础档案（`action="basic"`）。传入 `action="skills"` 可查询技能 Lv1–7 与专精效果；传入 `action="stats"` 可查询各精英阶段 Lv1/满级面板及信赖、潜能加成。如需查询特定等级面板，请同时传入 `phase`（0–2）与 `level`，例如 `get_operator_basic_info("阿米娅", action="stats", phase=2, level=40)`。`phase` 与 `level` 仅在 `action="stats"` 下有效，每次调用只返回对应 `action` 的内容。

### 输出通道

工具默认在 MCP `content` 字段中输出人类可读的 Markdown。支持消费 MCP 原生 `structuredContent` 的客户端，可通过环境变量 `PRTS_OUTPUT_CHANNEL` 将连接级输出通道设为 `content`（默认）、`structured` 或 `both`；HTTP 模式还支持通过 `?output_channel=` 查询参数或 `x-prts-output-channel` 请求头按连接/请求覆盖。设计背景见 [2.0 迁移指南](docs/migration-1.x-to-2.0.md)，详细配置见[环境变量参考](docs/admin/environment-variables.md)。

### 立绘工具（`operator_artwork`）

`operator_artwork` 工具（2.5.0+）**默认开启**，通过 `LOCAL_IMAGE` 切换数据源模式：

| 变量 | 默认值 | 说明 |
|----------|---------|-------------|
| `IMAGES_ENABLED` | `true` | 主开关；设为 `false` 时不注册 `operator_artwork`（工具数 24 → 23）。 |
| `LOCAL_IMAGE` | `false` | `false` = 从 PRTS MediaWiki 按需拉取（无需预先同步全量资产，但请求图片时仍会产生网络下载）；`true` = 后台同步 AKDP 本地 PNG 资产包（GB 量级）。 |
| `PRTS_IMAGE_CACHE` | `true` | MediaWiki 图片的内存 LRU 缓存（上限 256 MiB）；仅在 `LOCAL_IMAGE=false` 时生效。 |
| `ORIGINAL_IMAGE` | `false` | 额外同步原图分辨率分片；仅在 `LOCAL_IMAGE=true` 时生效。 |
| `PRTS_IMAGE_DIR` | `~/.local/share/prts-mcp/images/` | AKDP 立绘资产的本地存储目录（仅 `LOCAL_IMAGE=true` 时生效；Docker 下默认为 `/data/images`）。 |

默认配置无需额外准备，直接通过 MediaWiki 按需获取并缓存立绘。仅当需要本地全量离线立绘时，再开启 `LOCAL_IMAGE=true`。存储规划与完整环境变量说明见[数据同步与立绘存储管理](docs/admin/data-and-sync.md)和[环境变量参考](docs/admin/environment-variables.md)。

### 数据源与自动同步

- **PRTS Wiki API** (`https://prts.wiki/api.php`) — 泰拉世界观词条、阵营设定与剧情资料。
- **arknights-data-pipeline** ([`3aKHP/arknights-data-pipeline`](https://github.com/3aKHP/arknights-data-pipeline)) — 自建数据流水线，通过 GitHub Release 统一发布游戏数据表（`zh_CN-excel.zip`）、关卡战斗数据（`zh_CN-levels.zip`）以及带 LLM 摘要的剧情台词数据（`zh_CN.zip`）。

干员与表格数据存放在 `gamedata` 目录，关卡战斗数据存放在 `gamedata-levels` 目录，剧情数据存放在 `storyjson` 目录。服务启动监听后会立即在后台检查一次更新，之后默认每小时检查一次（`PRTS_AUTO_SYNC_INTERVAL_SECONDS=3600`，可在 `60..604800` 秒范围内调整，或设为 `0` 仅保留启动时检查）。

新版数据 Release 附带 `manifest.json`（遵循 `prts-mcp-data/v1` 契约），记录源端 `versionId` 以及各压缩包的大小与 SHA-256。校验不通过的归档会在激活前被拒绝；同时仍兼容不含 manifest 的旧版 Release。若下载、解压或校验失败，服务会继续使用上一代已激活的数据，不会中断现有查询。

`GITHUB_MIRRORS` 支持配置逗号分隔的 GitHub 下载备用前缀（自动去除首尾空白与末尾斜杠）。HTTP 客户端同时支持标准代理环境变量（`HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY`）；使用镜像或代理不会跳过 manifest 与 ZIP 完整性校验。

公开发布的 Rust 原生归档包、Docker 镜像与 npm 包均内置经过校验的只读备用数据（含游戏表、关卡与剧情），首次同步完成前或离线环境下可直接查询。一旦可写用户数据目录或数据卷中存在完整的用户数据，服务优先读取用户数据，且后台同步只写入用户目录，不会修改安装包内的备用数据。从源码构建或使用 Cargo 源码包时依赖启动同步或显式配置的数据路径；crates.io 计划在 3.0 正式版发布后上架，Rust 版不再通过 PyPI 发布。

### 协议兼容性与版本迁移

- **两代 MCP 协议（零配置无感自适应与并发混连）**：服务端无需配置任何协议切换开关，即可同时支持传统的有状态会话（`initialize` + `Mcp-Session-Id`）与 `2026-07-28` 无状态现代信封（请求内携带 `_meta`）。Streamable HTTP 模式下，同一个 `/mcp` 端点支持多个不同协议世代、不同输出通道的客户端同时连接；当 Legacy 会话因服务端重启或连续空闲满 24 小时（`SESSION_IDLE_TIMEOUT_MS`）被自动驱逐（返回 `-32002: MCP session lost`）时，客户端可直接重发 `initialize` 或在设置中关闭重开连接恢复。`stdio` 模式下，子进程连接上的首条消息决定该连接的协议世代。详见[客户端接入指南](docs/user/quick-start.md)、[服务端部署指南](docs/admin/deployment.md)与 [2.5 → 2.6 迁移指南](docs/migration-2.5-to-2.6.md)。
- **版本迁移指南**：
  - [2.x → 3.0 迁移指南](docs/migration-2.x-to-3.0.md)（Rust 切换、启动命令、数据卷兼容）
  - [1.x → 2.0 迁移指南](docs/migration-1.x-to-2.0.md)（工具面收敛、`operator_name` → `name`、输出通道）
  - [0.x → 1.0 迁移指南](docs/migration-0.x-to-1.0.md)

### 开发与贡献

- [文档总目录](docs/README.md) — 汇总用户指南、运维手册、开发规范与迁移文档。
- [项目状态](STATUS.zh-CN.md) · [更新日志](CHANGELOG.zh-CN.md) · [路线图](ROADMAP.zh-CN.md) · [安全政策](SECURITY.md#中文)
- [贡献指南](CONTRIBUTING.zh-CN.md) 与 [开发环境指南](docs/dev/ENVIRONMENT.md) — 介绍 Linux/WSL、Windows 与 macOS 下的构建与验证流程。

---

## Rust Compatibility / Rust 兼容性说明

Tool names, parameters, output channels, and data semantics match the frozen TS/v2.8.1 baseline, with seven approved implementation differences (`D-001` through `D-007`, covering runtime identity, native diagnostics schema, and specific Unicode regex case-folding edges) documented in [`contracts/baseline.json`](contracts/baseline.json). Full JSON Schemas for all tool inputs are recorded in [`contracts/tool-declarations.json`](contracts/tool-declarations.json).

3.x 的工具名、参数、输出通道与数据语义严格对齐 TS/v2.8.1 基线；7 项经批准的实现差异（`D-001` 至 `D-007`，涉及运行时标识、原生诊断结构及部分 Unicode 正则大小写折叠边界）完整记录于 [`contracts/baseline.json`](contracts/baseline.json)，所有工具的参数 Schema 见 [`contracts/tool-declarations.json`](contracts/tool-declarations.json)。

## License / 许可说明

Project source code is licensed under MIT; vendored native code retains its upstream license notices. Game data and PRTS Wiki content remain under their respective terms — see [LICENSE](LICENSE), [NOTICE](NOTICE), and [native component notices](vendor/quickjs-regexp/NOTICES.txt).

项目源代码采用 MIT 许可证授权；随仓打包的原生组件保留各自的上游许可声明。明日方舟游戏数据与 PRTS Wiki 内容仍适用各自版权与授权条款，详见 [LICENSE](LICENSE)、[NOTICE](NOTICE) 与[原生组件许可说明](vendor/quickjs-regexp/NOTICES.txt)。
