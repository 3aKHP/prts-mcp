# PRTS-MCP 路线图

当前公开稳定版为 `3.2.1`，服务端已统一为单一的原生 Rust 实现，并完整保留 TS/v2.8.1 的产品与工具契约；主开发分支 `develop` 继续推进（`3.2.1-dev.0`）。[English](ROADMAP.md)。

## 3.2 — 默认 SQLite 与 v2 图片

已交付默认 SQLite 后端。DB 就绪前自动使用 JSON 备用，就绪后自动切换。图片同步支持 v1/v2 多分片、增量更新和跨基线校验复用。AKDP 生产仍为 v1；计划中的 2027 春节切换以签名、受支持客户端发布及激活验收为前提。LTS/2.8 兼容补丁独立准备。

## 3.1.3 — 自定义 GitHub 数据源

已交付 `PRTS_DATA_SOURCE_REPO`，以独立目录消费兼容的 GitHub 数据与图片 Release。对象存储源和发布签名继续作为独立工作推进，见 [ADR-0017](docs/dev/adr/ADR-0017-custom-github-data-source.md)。

## 3.1 — 可选 SQLite 数据后端

默认继续使用 JSON/ZIP，保留已有路径、数据卷和同步开关；3.1 提供完整保留源数据、限制剧情扫描资源并独立原子同步的可选 SQLite 后端。3.2 起普通默认值为 SQLite，3.x 持续支持 JSON。

## 3.0 Rust 迁移阶段

| 阶段 | 工作内容 | 状态 |
| --- | --- | --- |
| **M0** | 冻结 3.0 范围、入口默认行为、根目录布局、LTS 维护策略与分发架构。 | 已完成 |
| **M1A** | 建立 `lts/2.8` 分支，将旧线维护发布与稳定版 `latest` 标签隔离。 | 已完成 |
| **M1B** | 将原生 Rust 工程导入仓库根目录，从 `develop` 移除旧语言目录，建立 Rust CI 与源码包验证。 | 已完成（PR #228） |
| **M2A** | 完成五大目标平台的原生构建、ABI 基线审计与独立归档运行验证（见 [NATIVE-PLATFORMS.md](docs/dev/NATIVE-PLATFORMS.md)）。 | 已完成（PR #229） |
| **M2B** | 完成 `prts-mcp`、`prts-mcp-ts`、共享启动桥/内置备用数据及 5 个平台包的 npm 分发验证（见 [NPM-DISTRIBUTION.md](docs/dev/NPM-DISTRIBUTION.md)）。 | 已完成 |
| **M2C** | 完成 Linux `x64`/`arm64` 双架构 Docker 镜像与旧版数据卷兼容验证（见 [DOCKER-DISTRIBUTION.md](docs/dev/DOCKER-DISTRIBUTION.md)）。 | 已完成 |
| **M3** | 建立候选发行物汇总、单一版本校验与隔离的公开发布自动化（见 [RELEASE-CANDIDATES.md](docs/dev/RELEASE-CANDIDATES.md)）。 | 已完成（[`3.0.0-alpha.3`](https://github.com/3aKHP/prts-mcp/releases/tag/v3.0.0-alpha.3)） |
| **M4** | 基于公开候选发行物完成真实客户端 E2E、数据与立绘同步、以及 2.8.1 旧卷升级与回滚验证（见 [E2E.md](docs/dev/E2E.md)）。 | 已完成 |
| **M5** | 完成 RC 在生产服务器上的全生命周期观测和专项压测，发布 `3.0.0` 正式版，切换 `latest` 稳定标签并回灌 `develop`。 | 已完成（[`3.0.0`](https://github.com/3aKHP/prts-mcp/releases/tag/v3.0.0)） |

## 3.0 之后的规划（Post-3.0 Backlog）

3.0 阶段专注于 Rust 技术栈统一与分发渠道平滑切换。新功能与工具扩展均安排在 3.0.0 正式发布之后，按每次一个主题逐步推进：

- **上架 crates.io（3.2.1）**：已实现源码安装与带条件校验的发布流程。首次注册使用维护者 Token，后续 OIDC 需配置 Trusted Publisher，见[候选发行流程](docs/dev/RELEASE-CANDIDATES.md#5-cargo-源码发行)。
- **管理 CLI**：提供显式的命令行管理与诊断子命令（如 `--version`、`--help`、缓存与同步状态检查）。
- **新工具与数据域扩展**：公开招募标签反查、干员模组数据、技能专精/升级材料消耗、攻击范围形状等。
- **数据容灾与 AKDP 协同**：多源对象存储备份镜像及图片分片进一步优化。

## 维护与兼容政策

`lts/2.8`（24 个工具）与 `lts/1.7`（32 个工具）均维护至 **2027-07-02**，期间仅接收兼容性、安全性、数据同步与关键缺陷修复，且不更新稳定版 `latest` 标签。旧线修复若同样适用于 Rust，将在 `develop` 上单独移植实现，绝不跨语言目录整分支合并。详细规则请参阅 [VERSIONING.md](docs/dev/VERSIONING.md) 与 [LTS.md](docs/dev/LTS.md)。

---

## 已交付里程碑与历史设计记录

以下章节保留 1.x 与 2.x 各关键版本发布时的功能主题与设计背景。完整的逐版本变更记录见 [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md) 与 [STATUS.zh-CN.md](STATUS.zh-CN.md)。

### 1.6.0 — 关卡跨源融合 + 道具/材料数据域

已于 2026-05-28 发布。发布详情见 [项目 CHANGELOG](CHANGELOG.zh-CN.md)。

**关卡跨源融合**
- `get_stage_enemies(stage_id)` — 该关卡出现的敌人 + **关卡级数值** （而非 `get_enemy_info` 返回的 level-0 默认值）。
- `get_enemy_appearances(name)` — 反向查询：该敌人出现在哪些关卡。
- `get_enemy_info(name)` 增加可选 `stage_id` 参数，返回该关卡下的具体数值变体。

**主要主题：道具数据域**
- `list_items(category?)` — 按类别列出物品（材料、装置、芯片等）。
- `get_item_info(name)` — 物品详情：用途、获取方式。
- `search_items(pattern)` — 正则搜索。

### 1.7.0 — 剧情角色追踪（LTS）

**剧情角色追踪（无新数据源——基于现有剧情 JSON 索引化）**
- `find_character_appearances(name, scope?, max_events?)` — 该角色出现的章节 / 活动（说话：对话角色名精确匹配；被提及：名字作为子串出现在台词/旁白中）。已随 1.7.0 发布。
- `find_speakers_in(event_id)` — 该活动中所有发言角色及其台词数。已随 1.7.0 发布。

1.7.0 是最后一个 1.x 功能版本。原计划中的干员深度能力不再继续作为 1.x 新工具加入，而是推迟到 2.0 工具面重设计中重新评估。

### 2.0 边界变化

三个值得 major 升级的结构性变更。

#### 工具面合并（上下文预算）

1.x 工具面在 1.7.0 LTS 时已达到 32 个。旗舰长上下文模型不在乎；但对 128K 级别模型，每个工具 schema 都吃 prompt 预算并降低工具选择准确率。2.0 按 *schema 形态* 在服务端合并——合并参数结构和输出形态相似的工具，保留语义真正不同的工具——把工具面降到 **23 个**，不损失能力。

**背景**：MCP 协议层目前无原生 deferred tool loading 支持。已关闭提案：lazy hydration（#1978）、lazyRegistration（#2376）。开放草案：tool-search query（#1821）、token-bloat 缓解（#1576）。Claude Code 的 ToolSearch 是 Anthropic API 层特性（`tool_reference` blocks），不能移植到 Cursor / Cline / Chatbox。

**已在 2.0 交付**：

- `search(scope, pattern, max_results)` 把 `search_data` / `search_enemies` / `search_stages` / `search_items` / `list_search_scopes` 合并为一个以 `scope` enum（`operators` / `enemies` / `stages` / `items`）为键的工具。剧情台词搜索仍为独立的 `search_stories`，因其过滤器（角色、台词类型、上下文行）形态不同。
- `prts_page(page_title, action, ...)` 把 `read_prts_page` / `list_prts_sections` / `get_prts_categories` / `get_prts_links` / `get_prts_template` 合并为一个以 `action` enum 为键的工具。
- `list_stories(event_id, include_summaries=true)` 现前置活动级 LLM 概览，吸收了原 `get_event_summary`。单章深摘要工具 `get_story_summary` 不变。
- 这三次合并背后的 deprecated 旧别名从 2.0 工具面移除。1.7 LTS 线保留现有 32 工具面。

**明确不合并的部分**：

- 干员三件套（`get_operator_archives` / `voicelines` / `basic_info`）：输出形态和长度差异大，合并反而降低 LLM 选择准确率，得不偿失。
- 敌人成对工具（`list_enemies` / `get_enemy_info`）：同上。（敌人搜索工具 `search_enemies` 已并入跨域 `search(scope="enemies")`，见上方说明。）
- 剧情工具（`read_story` / `read_activity` / `get_story_summary`）：在相关但不同的数据上做真正不同的动作。

合并的门槛：参数形态相同、输出长度和结构相似、LLM 在它们之间做选择本质上是在选近义词。

#### 输出通道（structuredContent）

2.0 经 MCP 原生 `structuredContent` 字段新增结构化输出。控制面是单个**连接级** `output_channel` 开关（`content`（默认）/ `structured` / `both`），Python 经 `PRTS_OUTPUT_CHANNEL` 环境变量设置，TypeScript 经查询字符串 / 请求头 / 环境变量设置。结构化工具（17 个）携带真实结构化载荷，含可链式调用的 ID 与 raw/label 字段对；叙事工具（6 个）仅 content。默认 `content` 通道保留 1.x 人类可读的 markdown 输出，故不支持的客户端（如 Chatbox）无需配置即不受影响。

**设计选择——用通道，而非 per-call 格式参数。** 原路线图提出 per-call 的 `output_format=markdown|json` 参数，并在 2.0 把默认翻转为 `json`。**该形态在设计阶段被否决。** 主要消费者是 LLM agent，JSON 会令 prompt token 膨胀 ~15–30%——这将抵消工具面合并带来的上下文预算收益。因此 markdown 始终作为 `content` 文本，结构化数据走独立通道，两轴正交。**默认不**翻转为 JSON。

各工具的通道映射与客户端配置见 [2.0 迁移指南](docs/migration-1.x-to-2.0.md)。

#### 双实现等价化（Python ↔ TypeScript）

2.0 收窄但未取消两套实现之间事实上的角色分工。**已在 2.0 交付**：

- npm 包和 PyPI 包的**能力面对等**——相同的 23 个工具名、参数、structuredContent 载荷，以及跨实现共享的 parity fixture。
- 环境变量名称和默认值统一（`PRTS_OUTPUT_CHANNEL`、`GAMEDATA_PATH`、`STORYJSON_PATH`、 `GITHUB_TOKEN`、`GITHUB_MIRRORS`）。

**跨传输协议同步——已于 2.3.0 交付。** 原目标“两套实现都同时支持 stdio **和** Streamable HTTP”（Python 上 HTTP、TypeScript 上 stdio）曾后置到 2.0 之后，已在 2.3.0 交付。Python 经 `PRTS_TRANSPORT` 选择传输（stdio 默认 | http）；TypeScript 经 bin 选择（`prts-mcp-ts`[-bun] = HTTP，`prts-mcp-ts-stdio` = stdio）。自 2.3.0 起部署推荐为“按场景选择，而非按语言”。

#### 清理

- 移除晚期 1.x 仍残留的 0.x 兼容 shim（如果有）。
- 移除 2.0 迁移方案引入的 deprecated 工具别名（见上方“工具面合并”部分）。

#### 2.0 不包含的工作

- 不重写 MCP 协议层。
- 不引入 stdio + HTTP 之外的传输方式。
- 不破坏数据同步语义。
- **不实现自定义的 deferred tool loading 方案**。若 MCP spec 标准化（如 SEP-1821 合入），则采纳；否则合并 + 描述优化就是我们的回答。

---

### 2.7.0 — 已于 2026-08-15 发布

原草案中的干员基建技能（`get_operator_basic_info` 携带有界 `building_skills` 区，以及 `search` 新增 `building_skills` scope）与时装/立绘元数据条目已随 2.7.0 发布——详见 [项目 CHANGELOG](CHANGELOG.zh-CN.md)。`LOCAL_IMAGE=true` 下 `operator_artwork(action="list")` 的皮肤元数据富化是从原 2.8.0 候选提前的条目；该次 2.8.0 占位仅为目标版本号，未承载主题。

### 2.8.0 — 已于 2026-10-10 发布

主题：补齐干员数值查询的三个缺口——特定等级面板、技能各等级效果、天赋逐档效果。发布内容详见 [项目 CHANGELOG](CHANGELOG.zh-CN.md)。

- `get_operator_basic_info(name, action="skills")`：干员战斗技能的逐等级效果（Lv1-7 与专精各级）。`skill_table.json` 提升为经过验证的数据集契约条目。
- `get_operator_basic_info(name, action="stats", phase?, level?)`：干员特定精英阶段与等级的面板数据，按关键帧线性插值并以 PRTS Wiki 公开面板值校准；省略 phase/level 时返回各精英阶段 Lv1/满级面板 + 信赖/潜能加成摘要。
- `get_operator_basic_info` 天赋段增量扩展：每个天赋槽输出逐档候选（解锁精英阶段/等级、潜能档），既有最高档 `name`/`description` 字段语义不变。
- `search` 新增 `skills` scope：按技能效果关键词跨干员反查。
- 工具面保持 24。技能与面板通过 `get_operator_basic_info` 的可选 action 查询；默认 `basic` 保留既有短档案，每次只返回所选内容，避免默认输出膨胀。
- 该版本未包含技能升级材料费用、模组和攻击范围形状；1.7 LTS 工具面不动。实现层细节（数据路径、占位符语法、插值与校准口径）由各 feature PR 的 CHANGELOG 承载。

### 2.8.1 — 已于 2026-10-11 发布

肉鸽剧情补充目录接入既有剧情工具，支持六个事件的发现、章节读取、搜索与角色追踪；兼容不携带可选目录的旧数据包，工具面保持 24。
