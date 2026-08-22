# PRTS-MCP 项目状态

_Last updated: 2026-08-18_

## 当前版本

| 实现 | 版本 | 状态 |
|------|------|------|
| Python | 2.7.1 | Stable release |
| TypeScript | 2.7.1 | Stable release |

- 当前稳定发布：2.7.1（24 个 MCP 工具）
- 当前 LTS 发布：1.7.0（32 个 MCP 工具，剧情角色追踪）
- 下一开发目标：2.8.0
- 当前稳定补丁线：2.7.x
- 2.7.1 发布内容：图片同步应用完整 AKDP delta chain（全新安装/跳版本同步不再漏中间 delta；断链在 baseline 下载前 fail fast；index currentVersion 权威化；release 发现分页覆盖链起点）（#179）；wrong-shape `building_data.json` 双实现一致降级（#178）。
- 2.7.0 发布内容：干员基建技能（`get_operator_basic_info` 新段 + `search` `building_skills` scope 跨干员反查）、本地立绘列表的皮肤系列/获取方式/描述元数据、`building_data.json`/`skin_table.json` 提升 AKDP 数据集契约、2.7 上帝文件重构程序（#161–#171）、story 文案 parity 修复（#172）与全量 E2E 手册制度化（#173）。工具面保持 24。
- 2.6.2 发布内容：GameData pair 幂等性修复——未变化的 Excel/Levels Auto-Sync 周期不再替换 `.gamedata_pair.json`，避免虚假激活变更与周期性缓存失效（#152）。
- 2.6.1 发布内容：`prts_page(action="template")` 的嵌套字段安全渲染与 malformed-response 边界；`read_activity` 页码输入和越界提示一致性。
- 2.6.0 发布内容：MCP SDK v2 与 legacy/`2026-07-28` 双时代协议服务；`operator_artwork` 阿米娅近卫/医疗形态解析与精确 opaque token 归属；TS 聚合指标、六会话隔离内存基准及同机 canary 资产。
- 2.5.0 发布内容：干员立绘工具 `operator_artwork`（list/get，默认 MediaWiki 在线获取 + 256 MiB LRU 缓存，`LOCAL_IMAGE=true` 时使用 AKDP 本地 PNG 资产）；数据源切换到自建 `arknights-data-pipeline` Release；TS stdio 不再泄漏 HTTP 监听器；TS JSON 空对象占位守卫。
- 2.4.0 发布内容：常驻服务默认每小时同步 GameData excel、GameData levels 与 StoryJson；GameData 两类归档以同一代原子切换，并支持共享卷跨进程发布锁续租。
- 2.3.1 发布内容：TypeScript 生产依赖安全更新，并同步 `prts-mcp-ts-stdio` 的 npm 锁文件 bin 元数据；不改变 MCP 工具面或传输行为。
- 2.3.0 发布内容：Cross-transport parity——Python 新增 Streamable HTTP （`PRTS_TRANSPORT=http`），TypeScript 新增 stdio（`prts-mcp-ts-stdio` bin），双端双 transport。Python HTTP 的 output_channel 为 process-level（env-only， FastMCP session 模型限制），TS HTTP 支持 per-request。
- 2.2.0 发布内容：TypeScript 默认生产运行时由 Node.js 翻转为 Bun（默认 `ts/Dockerfile`、CI 主链 `verify-ts`、npm scripts 切 Bun，验证版本 Bun `1.3.14`）。Node.js 降级为受支持 legacy/可选路径（`prts-mcp-ts` npm bin、 `npx prts-mcp-ts`、`ts/Dockerfile.node`）。npm bin 命名与发布路径（`npm publish --provenance`）不变，零 npm 破坏。
- 2.1.0 发布内容：将 TS Bun 从候选路径提升为受支持可选运行时，新增 `prts-mcp-ts-bun` npm bin，并保留 Node/npm 作为默认入口、默认 Dockerfile 和 npm Trusted Publishing 路径。Bun 最低验证版本为 1.3.14。
- 2.0.2 补丁集：TS HTTP MCP smoke harness、TS Bun 候选运行路径、 `search_prts` redirect/技术页面过滤修复。Bun 在 2.0.2 仍是可选候选路径。
- 2.0 交付内容：工具面合并（32 → 23）+ output channel（structuredContent）；**双端协议同步（Python 上 HTTP / TS 上 stdio）已后置到 2.0 之后**。
- 兼容性合约：1.7.x LTS 线既有 32 个工具名、必填参数、默认输出格式不变；仅接受兼容性、安全性、数据同步和关键缺陷修复

## 2.7.0 发布内容

- [x] 干员基建技能：`get_operator_basic_info` 增 `building_skills` 段（技能名/设施/精英阶段解锁/效果描述）；`search` 增 `building_skills` scope 支持按设施/效果/技能名跨干员反查。工具面保持 24（#174）。
- [x] `LOCAL_IMAGE=true` 下 `operator_artwork(action="list")` 附带皮肤元数据（`skin_group`/`acquisition`/`description`）；MediaWiki 路径不变（#174）。
- [x] `building_data.json` 与 `skin_table.json` 提升 AKDP 数据集契约；/debug/cache 增 `building` 模块（10 个）。
- [x] 2.7 上帝文件重构程序全部合入（#161–#171）：DatasetAccess 契约、sync 层迁出、enemy/artwork-images 簇拆分、parity 修复与 STYLE 归档。
- [x] Story 工具文案 parity 修复（#172，源自 2.7.0 全量 E2E 实测）；E2E 真机测试流程制度化（#173，docs/dev/E2E.md）。

## 2.6.0 发布内容

- [x] Python 迁移到精确锁定的 `mcp[cli]==2.0.0` 和 `MCPServer` API；SDK v2 内部 snake_case 字段保持正确的 camelCase wire 结果。
- [x] Python 与 TypeScript 同时保留 legacy initialize/session 流程，并支持 opt-in 的 `2026-07-28` 现代协议：HTTP 现代请求无状态且无需 `Mcp-Session-Id`；stdio 由连接上的第一条请求选择协议时代。
- [x] `operator_artwork` 仅为 `阿米娅(近卫)` / `阿米娅(医疗)` 的全角或半角括号拼写解析各自 char ID，不改变其他工具的通用干员解析；本地与 MediaWiki opaque artwork token 都必须与请求的精确形态匹配。
- [x] `/debug/cache` 与 TS 的 `/debug/metrics` 仅在配置 `PRTS_DEBUG_TOKEN` 且 Bearer token 匹配时可用；metrics 还需显式启用，不保留 MCP 参数、结果或会话标识，生产反向代理不得公开这两个路径。
- [x] 隔离 loopback 的六会话基准覆盖档案、数据/剧情搜索、单章/活动读取及真实立绘 get，要求缓存稳定、请求静止和 RSS 上限；同机 canary 使用独立服务、临时认证路由及 `MemoryHigh=1G` / `MemoryMax=1536M`，不触碰稳定服务。

## 2.5.2 发布内容

- [x] npm 生产依赖锁定图升级：`@modelcontextprotocol/sdk` 1.30、`adm-zip`
  0.6 及其安全传递依赖；保持 MCP SDK v1。
- [x] 当前 AKDP `enemy_database.json` 直接 ID 映射兼容：关卡敌人与敌人图鉴均能
  读取战斗属性，并保留旧 wrapper 格式。
- [x] 剧情 `Decision.options` 标量字符串按一整行 choice 返回。
- [x] `operator_artwork(action=get)` 严格校验 artwork token 的干员归属，拒绝跨干员
  token，且在本地读图或 MediaWiki 网络请求之前返回 text-only 错误。

## 2.5.1 发布内容

- [x] gamedata pair retry 逻辑修复：excel/levels 归档均 up-to-date 但 `commit_sha` 不一致时不再触发密集重试（30s/120s/600s），留给下一周期。
- [x] Release manifest 404 fail-open 修复：镜像直接 404 确认缺失时跳过，不再让后续镜像的通用 404 覆盖显式缺失信号（`_AssetNotFoundError` / `AssetNotFoundError`）。
- [x] Image shard sha256 验证：下载后验证变体哈希，缺失 PNG 阻止激活。
- [x] MCP `initialize` 版本握手兜底（Python）：`PackageNotFoundError` 时回退 `0.0.0`。
- [x] CI 升级到 Node 24。

## 2.5.0 发布内容

- [x] 干员立绘工具 `operator_artwork`（`action="list"` 返回有界元数据 + 语义标签；`action="get"` 返回单张 base64 `ImageContent`，默认 `large` 变体 max 1024px）。默认 MediaWiki 在线获取模式（`LOCAL_IMAGE=false`），覆盖 #85 安全边界（hostname/MIME/magic/1MiB/streaming/redirect）+ 256 MiB LRU 缓存。`LOCAL_IMAGE=true` 时同步 ~1.5 GB AKDP 本地 PNG 资产。工具面 23 → 24。
- [x] 数据源切换到自建 `arknights-data-pipeline` Release（`zh_CN-excel.zip`、 `zh_CN-levels.zip`、`zh_CN.zip`），Release 清单验证收紧。
- [x] TS stdio 入口不再因 `server.ts` 模块加载副作用启动 HTTP 监听器（提取无副作用的 `server-core.ts` 工厂）。
- [x] TS JSON 源 `?? []` 全部替换为 `Array.isArray(x) ? x : []`，防止上游 AKDP `{}` 空对象占位导致 `.map()` / `for...of` 崩溃（21 处）。
- [x] Docker 三个 Dockerfile 创建 `/data/images` 目录，`LOCAL_IMAGE=true` 命名卷有可写目标。
- [x] Python `initialize` 握手报告实际产品版本（`importlib.metadata`）。

## 2.4.0 发布内容

- [x] Python / TypeScript 常驻进程在启动同步后默认每小时检查 GameData excel、 GameData levels 与 StoryJson Release，无需通过 crontab 重启服务追赶上游。
- [x] `PRTS_AUTO_SYNC_INTERVAL_SECONDS` 支持 `60..604800` 秒，`0` 保留启动同步但关闭周期检查；非法值回落到 1 小时。
- [x] 周期轮次绕过 1 小时 fresh-cache 快捷路径，更新成功后清除对应内存缓存。
- [x] GameData 归档使用独立解压激活标记；下载后解压中断不会永久卡在旧数据，后续轮次会继续重试同一 Release。
- [x] GameData excel 与 levels 以同一代原子切换，周期更新期间工具不会读到新旧混合的数据组合；共享卷发布锁在长任务期间持续续租，避免被误判为陈旧锁。

## 当前分支

- `main`：2.7.1（最新稳定发布线）
- `lts/1.7`：1.7.x LTS 维护线（从 1.7.0 发布提交创建）
- `develop`：2.8.0 开发线（`.dev0`）

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
│   │   ├── tools_artwork.py # 立绘工具注册（1 工具）
│   │   ├── config.py       # 路径解析、环境变量
│   │   ├── startup_sync.py # 后台数据同步编排
│   │   ├── activation.py / cache_stats.py / output.py  # 代际激活、缓存统计、输出通道
│   │   ├── api/            # PRTS Wiki MediaWiki API 客户端
│   │   ├── data/           # 数据抽象层
│   │   │   ├── story.py    # 兼容性垫片 → 子模块重导出
│   │   │   ├── story_reader.py / story_search.py / story_memoir.py / story_summary.py / story_character.py
│   │   │   ├── operator.py / enemy.py / stage.py / item.py  # 干员/敌人/关卡/物品数据
│   │   │   ├── enemy_database.py / enemy_render.py / enemy_stats.py / stage_enemy.py / level_parser.py
│   │   │   ├── building.py # 基建技能（2.7.0）
│   │   │   ├── artwork_format.py / artwork_local.py / artwork_mediawiki.py  # 立绘后端（2.5.0）
│   │   │   ├── images.py / search.py / datasets.py / dataset_access.py / gamedata_attrs.py / messages.py
│   │   │   ├── stores.py   # 存储抽象 (Directory/Zip/Fallback)
│   │   │   └── sync.py     # re-export 垫片（同步状态机在 sync/ 层）
│   │   ├── sync/            # GitHub Release 传输+发现+激活（数据同步 HTTP 归此层）
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
│   │   │   ├── storyTools.ts
│   │   │   └── artworkTools.ts
│   │   ├── data/           # 数据抽象层（对齐 python/src/prts_mcp/data/）
│   │       ├── story.ts        # 兼容性垫片
│   │       ├── storyReader.ts / storySearch.ts / storyMemoir.ts / storySummary.ts / storyCharacter.ts
│   │       ├── operator.ts / enemy.ts / stage.ts / item.ts
│   │       ├── building.ts / artworkFormat.ts / artworkLocal.ts / artworkMediawiki.ts / images.ts
│   │       ├── stores.ts / sync.ts
│   │       └── ...
│   │   └── sync/           # GitHub Release 传输+发现+激活（数据同步 HTTP 归此层）
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

`main`（2.7.x）与 `develop`（2.8.0 开发线）的默认 Auto-Sync 只消费自建 `3aKHP/arknights-data-pipeline` Release；旧版两个上游仓库不再是 2.x 线的数据依赖。仅 `lts/1.7` 保留旧上游兼容路径，供 LTS 维护使用。

| 数据源 | 用途 | 同步方式 |
|--------|------|----------|
| [arknights-data-pipeline](https://github.com/3aKHP/arknights-data-pipeline) | 干员/敌人/关卡/物品表格 | GitHub Release `zh_CN-excel.zip`（→ `gamedata` volume） |
| [arknights-data-pipeline](https://github.com/3aKHP/arknights-data-pipeline) | 关卡实际出怪与关卡级敌人数值 | GitHub Release `zh_CN-levels.zip`（→ `gamedata-levels` volume） |
| [arknights-data-pipeline](https://github.com/3aKHP/arknights-data-pipeline) | 剧情台词 + LLM 摘要 | GitHub Release `zh_CN.zip`（→ `storyjson` volume） |
| [PRTS Wiki API](https://prts.wiki/api.php) | 世界观词条/阵营设定 | 实时 HTTP 请求 |

## 工具清单 (24, 2.x 发布线)

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
| 24 | `operator_artwork` | PRTS Wiki / AKDP | 2.5.0 |

> `search(scope, pattern, max_results)` 统一了 1.x 的 `search_data` / `search_enemies` / `search_stages` / `search_items` 与 `list_search_scopes` （scope ∈ operators/enemies/stages/items；2.7.0 起新增 `building_skills`）。剧情台词搜索仍为独立的 `search_stories`（参数不同）。
>
> `prts_page(page_title, action, …)` 统一了 1.x 的 `read_prts_page` / `list_prts_sections` / `get_prts_categories` / `get_prts_links` / `get_prts_template`（action ∈ read/sections/categories/links/template）。维基关键词搜索仍为独立的 `search_prts`。
>
> `list_stories(event_id, include_summaries=True)` 现附带活动级长摘要（吸收了 1.x 的 `get_event_summary`）；单章深摘要仍为独立的 `get_story_summary`。

## Output Channel（2.0 新增）

2.0 在 MCP 原生 `structuredContent` 字段上新增结构化输出能力，由**连接级**的 `output_channel` 开关控制（`content`（默认）/ `structured` / `both`）。Python 经 `PRTS_OUTPUT_CHANNEL` 环境变量设置，TypeScript 经查询字符串 / 请求头 / 环境变量设置。默认 `content` 与 1.x 行为一致，无需配置。

- **结构化工具（17 个）** 走 `structuredContent`，载荷含可链式调用的 ID 与 raw/label 字段对：`search_prts`、`get_operator_basic_info`、`list_enemies`、 `get_enemy_info`、`get_stage_enemies`、`get_enemy_appearances`、`list_stages`、 `get_stage_info`、`list_items`、`get_item_info`、`search`、`list_story_events`、 `list_stories`、`search_stories`、`get_operator_memoirs`、`find_character_appearances`、 `find_speakers_in`。
- **叙事工具（6 个）** 仅 `content`（markdown），无结构化形态：`prts_page`（所有 action）、`get_operator_archives`、`get_operator_voicelines`、`get_story_summary`、 `read_story`、`read_activity`。

> 设计选择：采用连接级通道而非 per-call 的 `output_format=markdown|json` 参数，且 **不**翻转默认到 JSON——主要消费者是 LLM agent，JSON 会令 prompt token 膨胀 15–30%，抵消工具面合并带来的上下文预算收益。详见 [`docs/migration-1.x-to-2.0.md`](docs/migration-1.x-to-2.0.md)。

## 2.3.0 发布内容

- [x] Python 新增 Streamable HTTP transport（`PRTS_TRANSPORT=http`，Starlette + uvicorn，`/mcp` 端点 + `/health` 探针）。stdio 保持默认（向后兼容）。
- [x] Python `OUTPUT_CHANNEL` 从进程级常量重构为 `contextvars.ContextVar`，为后续 transport 扩展铺路。**注意**：因 FastMCP Streamable HTTP 的 session 模型，Python HTTP 的 output_channel 当前是 process-level（env-only），不支持 per-request query/header 解析（TS HTTP 支持 per-request）。
- [x] TypeScript 新增 stdio transport（`prts-mcp-ts-stdio` bin， `server-stdio.ts` 入口复用 `createMcpServer` + `runStartupSync`）。
- [x] 跨 transport e2e 测试：Python HTTP（`test_e2e_http.py`）+ TS stdio （`e2eStdio.test.ts`）。
- [x] 文档同步：README transport 表/快速开始、`.mcp.example.json`、`.env.example`。

## 2.2.0 发布内容

- [x] Bun 升为默认生产运行时：默认 `ts/Dockerfile`（原 `Dockerfile.bun` 内容提升）、CI 主验证链（`verify-ts` 切 Bun）、推荐 Docker 部署均走 Bun。
- [x] Node 降级为 legacy/可选路径：新增 `ts/Dockerfile.node`（原 Node `Dockerfile` 搬迁）、`start:node` / `smoke:http:node` 等 npm scripts。
- [x] CI 矩阵翻转：`test-ts`（Node 单测，node:test）+ `verify-ts`（Bun 全链）+ `build-image-ts`（默认 Bun 镜像）+ `build-image-ts-node`（legacy Node 镜像）。
- [x] `bun.lock` / `package.json` 双 lockfile drift 检查加入 `verify-ts`。
- [x] npm bin 命名不变：`prts-mcp-ts`=Node（`npx` 开箱即用）， `prts-mcp-ts-bun`=Bun。npm 发布仍走 `npm publish --provenance`。
- [x] 文档口径翻转：`ts/README.md`、根 `README.md` 中英文运行时段反转。

## 2.1.0 发布内容

- [x] TS Bun 从候选路径提升为受支持可选运行时；`prts-mcp-ts` 继续走 Node.js，新增 `prts-mcp-ts-bun` 作为显式 Bun 入口。
- [x] Bun package smoke 覆盖 `npm pack`、临时项目 `bun add`、安装后 `prts-mcp-ts-bun` 启动和 HTTP MCP 黑盒 smoke。
- [x] `ts/Dockerfile.bun` 作为受支持的 Bun 替代构建路径保留；默认 `ts/Dockerfile` 不切换。

## 2.0.2 发布内容

- [x] TS HTTP MCP smoke harness 已加入 Node/Bun/Docker 验证路径。
- [x] TS Bun 候选运行路径已加入；不改变 Node/npm 默认运行与发布合同。
- [x] PRTS 搜索结果中 redirect 页面自动解析已实现，follow-up lookup 失败时保留原始搜索结果。
- [x] PRTS 搜索结果中 `/spine`、`/data`、`/module` 等技术页面过滤已改进， `filter_technical=false` 仍保留为 escape hatch。

## 最近发布

| 版本 | 日期 | 亮点 |
|------|------|------|
| 2.7.1 | 2026-08-18 | 图片同步应用完整 AKDP delta chain（#179）；wrong-shape building_data 双实现一致降级（#178） |
| 2.7.0 | 2026-08-15 | 干员基建技能（basic_info 新段 + search 新 scope）；本地立绘皮肤元数据；2.7 重构程序收口 |
| 2.6.2 | 2026-08-12 | GameData pair 幂等性修复：未变化同步周期不再替换激活 metadata 或清空缓存（#152） |
| 2.6.1 | 2026-08-10 | 模板嵌套字段安全渲染与 malformed-response 边界；活动剧情页码校验与越界提示 |
| 2.6.0 | 2026-08-09 | MCP SDK v2 双时代协议；阿米娅形态立绘；聚合指标、六会话内存基准与同机 canary |
| 2.5.2 | 2026-08-09 | npm 生产依赖安全更新；AKDP 直接敌人数据库；剧情标量 Decision；立绘 token 归属校验 |
| 2.5.1 | 2026-08-07 | gamedata pair retry 修复；manifest 404 fail-open；image sha256 验证；CI Node 24 |
| 2.5.0 | 2026-08-07 | 干员立绘工具 `operator_artwork`；数据源切换到自建 arknights-data-pipeline；TS stdio HTTP 泄漏修复 |
| 2.4.0 | 2026-07-29 | 常驻服务 Auto-Sync；GameData excel/levels 原子成对发布；共享卷跨进程协调与锁续租 |
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
