# PRTS-MCP 项目状态

_Last updated: 2026-07-10_

## 当前版本

| 实现 | 版本 | 状态 |
|------|------|------|
| Python | 2.4.0.dev0 | Development |
| TypeScript | 2.4.0-dev.0 | Development |

- 当前稳定发布：2.3.1（23 个 MCP 工具）
- 当前 LTS 发布：1.7.0（32 个 MCP 工具，剧情角色追踪）
- 当前开发目标：2.4.0（待规划）
- 当前稳定补丁线：2.3.x
- 当前开发线：2.4.x
- 2.3.1 发布内容：TypeScript 生产依赖安全更新，并同步
  `prts-mcp-ts-stdio` 的 npm 锁文件 bin 元数据；不改变 MCP 工具面或传输行为。
- 2.3.0 发布内容：Cross-transport parity——Python 新增 Streamable HTTP
  （`PRTS_TRANSPORT=http`），TypeScript 新增 stdio（`prts-mcp-ts-stdio` bin），
  双端双 transport。Python HTTP 的 output_channel 为 process-level（env-only，
  FastMCP session 模型限制），TS HTTP 支持 per-request。
- 2.2.0 发布内容：TypeScript 默认生产运行时由 Node.js 翻转为 Bun（默认
  `ts/Dockerfile`、CI 主链 `verify-ts`、npm scripts 切 Bun，验证版本 Bun
  `1.3.14`）。Node.js 降级为受支持 legacy/可选路径（`prts-mcp-ts` npm bin、
  `npx prts-mcp-ts`、`ts/Dockerfile.node`）。npm bin 命名与发布路径
  （`npm publish --provenance`）不变，零 npm 破坏。
- 2.1.0 发布内容：将 TS Bun 从候选路径提升为受支持可选运行时，新增
  `prts-mcp-ts-bun` npm bin，并保留 Node/npm 作为默认入口、默认 Dockerfile 和
  npm Trusted Publishing 路径。Bun 最低验证版本为 1.3.14。
- 2.0.2 补丁集：TS HTTP MCP smoke harness、TS Bun 候选运行路径、
  `search_prts` redirect/技术页面过滤修复。Bun 在 2.0.2 仍是可选候选路径。
- 2.0 交付内容：工具面合并（32 → 23）+ output channel（structuredContent）；**双端协议同步（Python 上 HTTP / TS 上 stdio）已后置到 2.0 之后**。
- 兼容性合约：1.7.x LTS 线既有 32 个工具名、必填参数、默认输出格式不变；仅接受兼容性、安全性、数据同步和关键缺陷修复

## 当前分支

- `main`：2.3.1（最新稳定发布线）
- `lts/1.7`：1.7.x LTS 维护线（从 1.7.0 发布提交创建）
- `develop`：2.4 的开发集成线

1.7.0 是最后一个 1.x 功能版本和 LTS 基线。它将 server.py/server.ts 和 story.py/story.ts 单体文件拆分为聚焦子模块，保留向后兼容垫片（shim），并新增剧情角色追踪工具：`find_character_appearances`、`find_speakers_in`。后续功能开发转向 2.0；1.7.x 仅做兼容性、安全性、数据同步和关键缺陷修复。

## 仓库结构

```
PRTS-MCP/
├── python/                 # Python 实现 (stdio, FastMCP)
│   ├── src/prts_mcp/       # 源码
│   │   ├── server.py       # 入口点 → tools_* 模块
│   │   ├── tools_prts.py   # PRTS Wiki 工具注册（2 工具）
│   │   ├── tools_gamedata.py # GameData 工具注册（12 工具）
│   │   ├── tools_story.py  # 剧情工具注册（9 工具）
│   │   ├── config.py       # 路径解析、环境变量
│   │   ├── startup_sync.py # 后台数据同步编排
│   │   ├── api/            # PRTS Wiki MediaWiki API 客户端
│   │   ├── data/           # 数据抽象层
│   │   │   ├── story.py    # 兼容性垫片 → 子模块重导出
│   │   │   ├── story_reader.py  # 剧情类型、常量、章节解析
│   │   │   ├── story_search.py  # 全文搜索索引
│   │   │   ├── story_memoir.py  # 干员密录发现
│   │   │   ├── story_summary.py # 活动/章节摘要
│   │   │   ├── operators.py     # 干员数据
│   │   │   ├── enemies.py       # 敌人数据
│   │   │   ├── stages.py        # 关卡数据
│   │   │   ├── items.py         # 物品/材料数据
│   │   │   ├── stores.py        # 存储抽象 (Directory/Zip/Fallback)
│   │   │   └── sync.py          # GitHub Release 同步
│   │   └── utils/          # wikitext 清洗等工具
│   ├── tests/              # pytest 测试
│   ├── pyproject.toml      # 包元数据、依赖
│   ├── uv.lock             # Python 开发环境锁文件
│   └── CHANGELOG.md
├── ts/                     # TypeScript 实现 (Streamable HTTP, Express)
│   ├── src/                # 源码，结构对齐 python/
│   │   ├── server.ts       # 入口点 → tools/* 模块
│   │   ├── startupSync.ts  # 后台数据同步编排
│   │   ├── tools/          # 工具注册模块
│   │   │   ├── prtsTools.ts
│   │   │   ├── gamedataTools.ts
│   │   │   └── storyTools.ts
│   │   └── data/           # 数据抽象层（对齐 python/src/prts_mcp/data/）
│   │       ├── story.ts        # 兼容性垫片
│   │       ├── storyReader.ts / storySearch.ts / storyMemoir.ts / storySummary.ts
│   │       ├── operators.ts / enemies.ts / stages.ts / items.ts
│   │       ├── stores.ts / sync.ts
│   │       └── ...
│   ├── tests/              # node --test 测试
│   ├── package.json
│   └── CHANGELOG.md
├── data/                   # 共享数据（gamedata zip 等）
├── docs/                   # 文档
│   ├── dev/                # 开发者文档
│   ├── admin/              # 管理员文档
│   └── user/               # 用户文档
├── dev/                    # 本地开发草稿（.gitignore 排除）
├── .github/workflows/      # CI/CD
│   ├── ci.yml              # 双实现测试
│   ├── cd.yml              # Python PyPI 发布
│   └── cd-ts.yml           # TS npm + Docker 发布
├── CLAUDE.md               # AI 协作说明（本会话必读）
├── CONTRIBUTING.md         # 公开贡献指南与环境准备入口
├── ROADMAP.md              # 路线图
├── STATUS.md               # 本文件
└── README.md               # 面向用户的说明
```

## 数据源

| 数据源 | 用途 | 同步方式 |
|--------|------|----------|
| [ArknightsGameData](https://github.com/3aKHP/ArknightsGameData) | 干员/敌人/关卡/物品表格 | GitHub Release `zh_CN-excel.zip` |
| [ArknightsGameData](https://github.com/3aKHP/ArknightsGameData) | 关卡实际出怪与关卡级敌人数值 | GitHub Release `zh_CN-levels.zip` |
| [ArknightsStoryJson](https://github.com/3aKHP/ArknightsStoryJson) | 剧情台词 | GitHub Release `zh_CN.zip` |
| [PRTS Wiki API](https://prts.wiki/api.php) | 世界观词条/阵营设定 | 实时 HTTP 请求 |

## 工具清单 (23, 2.0 发布线)

| # | 工具 | 数据源 | 版本 |
|---|------|--------|------|
| 1 | `search_prts` | PRTS Wiki | 0.1.0 |
| 2 | `prts_page` | PRTS Wiki | 2.0.0 |
| 3 | `get_operator_archives` | GameData | 0.1.0 |
| 4 | `get_operator_voicelines` | GameData | 0.1.0 |
| 5 | `get_operator_basic_info` | GameData | 0.1.0 |
| 6 | `list_story_events` | StoryJson | 0.3.0 |
| 7 | `list_stories` | StoryJson | 0.3.0 |
| 8 | `read_story` | StoryJson | 0.3.0 |
| 9 | `read_activity` | StoryJson | 0.3.0 |
| 10 | `search` | GameData | 2.0.0 |
| 11 | `search_stories` | StoryJson | 1.1.0 |
| 12 | `get_story_summary` | StoryJson | 1.2.0 |
| 13 | `list_enemies` | GameData | 1.4.0 |
| 14 | `get_enemy_info` | GameData | 1.4.0 |
| 15 | `get_stage_enemies` | GameData levels | 1.6.0 |
| 16 | `get_enemy_appearances` | GameData levels | 1.6.0 |
| 17 | `list_stages` | GameData | 1.5.0 |
| 18 | `get_stage_info` | GameData | 1.5.0 |
| 19 | `list_items` | GameData | 1.6.0 |
| 20 | `get_item_info` | GameData | 1.6.0 |
| 21 | `get_operator_memoirs` | StoryJson | 1.6.1 |
| 22 | `find_character_appearances` | StoryJson | 1.7.0 |
| 23 | `find_speakers_in` | StoryJson | 1.7.0 |

> `search(scope, pattern, max_results)` 统一了 1.x 的 `search_data` /
> `search_enemies` / `search_stages` / `search_items` 与 `list_search_scopes`
> （scope ∈ operators/enemies/stages/items）。剧情台词搜索仍为独立的
> `search_stories`（参数不同）。
>
> `prts_page(page_title, action, …)` 统一了 1.x 的 `read_prts_page` /
> `list_prts_sections` / `get_prts_categories` / `get_prts_links` /
> `get_prts_template`（action ∈ read/sections/categories/links/template）。
> 维基关键词搜索仍为独立的 `search_prts`。
>
> `list_stories(event_id, include_summaries=True)` 现附带活动级长摘要（吸收了
> 1.x 的 `get_event_summary`）；单章深摘要仍为独立的 `get_story_summary`。

## Output Channel（2.0 新增）

2.0 在 MCP 原生 `structuredContent` 字段上新增结构化输出能力，由**连接级**的
`output_channel` 开关控制（`content`（默认）/ `structured` / `both`）。Python 经
`PRTS_OUTPUT_CHANNEL` 环境变量设置，TypeScript 经查询字符串 / 请求头 / 环境变量设置。
默认 `content` 与 1.x 行为一致，无需配置。

- **结构化工具（17 个）** 走 `structuredContent`，载荷含可链式调用的 ID 与
  raw/label 字段对：`search_prts`、`get_operator_basic_info`、`list_enemies`、
  `get_enemy_info`、`get_stage_enemies`、`get_enemy_appearances`、`list_stages`、
  `get_stage_info`、`list_items`、`get_item_info`、`search`、`list_story_events`、
  `list_stories`、`search_stories`、`get_operator_memoirs`、`find_character_appearances`、
  `find_speakers_in`。
- **叙事工具（6 个）** 仅 `content`（markdown），无结构化形态：`prts_page`（所有
  action）、`get_operator_archives`、`get_operator_voicelines`、`get_story_summary`、
  `read_story`、`read_activity`。

> 设计选择：采用连接级通道而非 per-call 的 `output_format=markdown|json` 参数，且
> **不**翻转默认到 JSON——主要消费者是 LLM agent，JSON 会令 prompt token 膨胀
> 15–30%，抵消工具面合并带来的上下文预算收益。详见
> [`docs/migration-1.x-to-2.0.md`](docs/migration-1.x-to-2.0.md)。

## 2.3.0 发布内容

- [x] Python 新增 Streamable HTTP transport（`PRTS_TRANSPORT=http`，Starlette +
  uvicorn，`/mcp` 端点 + `/health` 探针）。stdio 保持默认（向后兼容）。
- [x] Python `OUTPUT_CHANNEL` 从进程级常量重构为 `contextvars.ContextVar`，
  为后续 transport 扩展铺路。**注意**：因 FastMCP Streamable HTTP 的 session
  模型，Python HTTP 的 output_channel 当前是 process-level（env-only），不支持
  per-request query/header 解析（TS HTTP 支持 per-request）。
- [x] TypeScript 新增 stdio transport（`prts-mcp-ts-stdio` bin，
  `server-stdio.ts` 入口复用 `createMcpServer` + `runStartupSync`）。
- [x] 跨 transport e2e 测试：Python HTTP（`test_e2e_http.py`）+ TS stdio
  （`e2eStdio.test.ts`）。
- [x] 文档同步：README transport 表/快速开始、`.mcp.example.json`、`.env.example`。

## 2.2.0 发布内容

- [x] Bun 升为默认生产运行时：默认 `ts/Dockerfile`（原 `Dockerfile.bun` 内容
  提升）、CI 主验证链（`verify-ts` 切 Bun）、推荐 Docker 部署均走 Bun。
- [x] Node 降级为 legacy/可选路径：新增 `ts/Dockerfile.node`（原 Node
  `Dockerfile` 搬迁）、`start:node` / `smoke:http:node` 等 npm scripts。
- [x] CI 矩阵翻转：`test-ts`（Node 单测，node:test）+ `verify-ts`（Bun 全链）+
  `build-image-ts`（默认 Bun 镜像）+ `build-image-ts-node`（legacy Node 镜像）。
- [x] `bun.lock` / `package.json` 双 lockfile drift 检查加入 `verify-ts`。
- [x] npm bin 命名不变：`prts-mcp-ts`=Node（`npx` 开箱即用），
  `prts-mcp-ts-bun`=Bun。npm 发布仍走 `npm publish --provenance`。
- [x] 文档口径翻转：`ts/README.md`、根 `README.md` 中英文运行时段反转。

## 2.1.0 发布内容

- [x] TS Bun 从候选路径提升为受支持可选运行时；`prts-mcp-ts` 继续走
  Node.js，新增 `prts-mcp-ts-bun` 作为显式 Bun 入口。
- [x] Bun package smoke 覆盖 `npm pack`、临时项目 `bun add`、安装后
  `prts-mcp-ts-bun` 启动和 HTTP MCP 黑盒 smoke。
- [x] `ts/Dockerfile.bun` 作为受支持的 Bun 替代构建路径保留；默认
  `ts/Dockerfile` 不切换。

## 2.0.2 发布内容

- [x] TS HTTP MCP smoke harness 已加入 Node/Bun/Docker 验证路径。
- [x] TS Bun 候选运行路径已加入；不改变 Node/npm 默认运行与发布合同。
- [x] PRTS 搜索结果中 redirect 页面自动解析已实现，follow-up lookup 失败时
  保留原始搜索结果。
- [x] PRTS 搜索结果中 `/spine`、`/data`、`/module` 等技术页面过滤已改进，
  `filter_technical=false` 仍保留为 escape hatch。

## 最近发布

| 版本 | 日期 | 亮点 |
|------|------|------|
| 2.3.1 | 2026-07-10 | TypeScript 生产依赖安全更新；同步 `prts-mcp-ts-stdio` npm 锁文件 bin 元数据 |
| 2.3.0 | 2026-07-08 | Cross-transport parity：Python 新增 Streamable HTTP，TypeScript 新增 stdio，双端双 transport；部署改为按场景选择 |
| 2.2.0 | 2026-07-08 | TypeScript 默认生产运行时翻转为 Bun（默认 Dockerfile/CI/scripts）；Node 降级为 legacy 可选路径；npm bin 与发布路径不变 |
| 2.1.0 | 2026-07-07 | TypeScript 正式支持 Bun 可选运行时；新增 `prts-mcp-ts-bun`；Bun Dockerfile 提升为受支持替代构建路径 |
| 2.0.2 | 2026-07-07 | TS HTTP MCP smoke harness；Bun 候选运行路径；`search_prts` redirect 解析与技术页面过滤修复 |
| 2.0.1 | 2026-07-03 | 修复 `list_story_events` 缺失剧情数据时的 output-channel 包装；统一 TS 文本结果 helper；补充 MCP 示例配置 |
| 2.0.0 | 2026-07-03 | 工具面合并 32 → 23 + output channel（structuredContent）；双端协议同步后置 |
| 1.7.0 | 2026-07-02 | 1.7 LTS：剧情角色追踪 + 模块拆分（32 工具） |
| 1.6.1 | 2026-06-03 | 干员密录发现 + 搜索缓存优化（30 工具） |
| 1.6.0 | 2026-05-28 | 关卡敌人融合 + 物品/材料域（29 工具） |
| 1.5.0 | 2026-05-25 | 关卡数据域：list_stages、get_stage_info、search_stages（24 工具） |
| 1.4.2 | 2026-05-25 | 修复 Streamable HTTP session pool 400 错误 |
| 1.4.1 | 2026-05-19 | 生产修复：ZipStore 缓存、session 泄漏、httpx 复用、审计 parity |
| 1.4.0 | 2026-05-19 | 模板提取工具 + 敌人图鉴（含战斗属性） |
| 1.3.1 | 2026-05-19 | 修复 trap/token 同名干员 ID 碰撞 |
| 1.3.0 | 2026-05-18 | PRTS 深度集成：章节列表、分类标签、链接遍历 |
| 1.2.0 | 2026-05-14 | 剧情摘要工具 + LLM 管线 |
| 1.1.1 | 2026-05-14 | PRTS API 修复（parse 替代 extracts） |
| 1.1.0 | 2026-05-14 | 全文搜索工具 |
| 1.0.0 | 2026-05-13 | 稳定版，工具面冻结 |
