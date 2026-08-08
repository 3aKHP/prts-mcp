# PRTS-MCP 路线图

_最近更新：2026-08-09_ · [English](ROADMAP.md)

PRTS-MCP 已进入 1.x 稳定期。1.7.0 是最后一个 1.x 功能版本和 1.7 LTS 基线。本文档记录**接下来要做什么**——已发布的内容请查看 Python 和 TypeScript 各自的 CHANGELOG。

## 当前发布

- Python：`2.6.0` _（最新稳定版）_
- TypeScript：`2.6.0` _（最新稳定版）_
- `1.7.0` LTS 仍为维护线——仅兼容性、安全性、数据同步和关键缺陷修复。
- 2.x 线为 24 个公共 MCP 工具（CI 强制检查）；1.7 LTS 线冻结 32 个公共 MCP 工具。
- 迁移说明：[0.x → 1.0](docs/migration-0.x-to-1.0.md)、[1.x → 2.0](docs/migration-1.x-to-2.0.md)。
- 2.6.0 在保留 legacy MCP 客户端的同时新增 opt-in `2026-07-28` 支持；变更客户端协议配置前请阅读 [2.5 → 2.6](docs/migration-2.5-to-2.6.md)。

## 1.x 兼容合约

1.7.x 期间保持稳定的内容：

- 工具名称和必填参数。
- 响应**格式**（markdown 形态）；修复中的具体措辞和细节可能演进。
- `GAMEDATA_PATH` 和 `STORYJSON_PATH` 语义。
- 默认从 GitHub Releases 自动同步。

1.7.x 维护版本中可能变动的内容：

- 兼容性和安全性修复。
- 数据同步韧性和上游数据兼容修复。
- 保持既有工具名、必填参数和默认输出格式不变的关键缺陷修复。

## 1.x Patch 策略

1.7 LTS 线上的 Patch 版本仅用于 bug 修复、文档、兼容性、安全性和 数据同步维护。**不新增工具，不增加必填参数，不改变默认输出格式。**

## 1.x Non-Goals

- 不接入所有明日方舟数据表——只挑同人创作真正用得到的。
- 不在 PyPI wheel 中嵌入大体积兜底数据。
- 不替换 GitHub Release 同步机制。
- 不把 LLM 生成内容作为运行时强依赖。

---

## Minor 发布规划

每个 minor 版本聚焦一个数据域。跨源融合工具与其数据依赖一同或随后发布。

### 1.6.0 — 关卡跨源融合 + 道具/材料数据域

已于 2026-05-28 合入。发布详情见 Python 和 TypeScript CHANGELOG。

**关卡跨源融合**
- `get_stage_enemies(stage_id)` — 该关卡出现的敌人 + **关卡级数值** （而非 `get_enemy_info` 返回的 level-0 默认值）。
- `get_enemy_appearances(name)` — 反向查询：该敌人出现在哪些关卡。
- `get_enemy_info(name)` 增加可选 `stage_id` 参数，返回该关卡下的具体数值变体。

**主：道具数据域**
- `list_items(category?)` — 按类别列出物品（材料、装置、芯片等）。
- `get_item_info(name)` — 物品详情：用途、获取方式。
- `search_items(pattern)` — 正则搜索。

### 1.7.0 — 剧情角色追踪（LTS）

**剧情角色追踪（无新数据源——基于现有剧情 JSON 索引化）**
- `find_character_appearances(name, scope?, max_events?)` — 该角色出现的章节 / 活动（说话：对话角色名精确匹配；被提及：名字作为子串出现在台词/旁白中）。已在 develop 上为 1.7.0 实现。
- `find_speakers_in(event_id)` — 该活动中所有发言角色及其台词数。已在 develop 上为 1.7.0 实现。

1.7.0 是最后一个 1.x 功能版本。原计划中的干员深度能力不再继续作为 1.x 新工具加入，而是推迟到 2.0 工具面重设计中重新评估。

### 1.7 LTS 之后暂缓的功能

以下功能设想仍然有价值，但不再作为 1.x minor 版本排期；应在 2.0 工具模型下重新评估：

**干员深度**
- 基建技能与跨干员基建技能搜索。
- 皮肤列表与皮肤描述。

**Wiki 增强 + 公招**

**主：PRTS Wiki 增强（B 类一次性集中交付）**
- `get_prts_images(page_title)` — 通过 `prop=images` 获取图片列表。
- `resolve_prts_redirect(title)` — 重定向解析；解决长期遗留的 1.1.1 "已知问题"。

**公招**
- `query_recruit_tags(tags)` — 反查：给定标签组合可招到哪些干员。

---

## 1.7 LTS 维护线

1.7.x 发布维护 LTS 基线，不扩展公共工具面。

| 1.7.x 允许范围 | 示例 |
|----------------|------|
| 兼容性修复 | 上游 schema 漂移、客户端握手兼容、打包元数据 |
| 安全性修复 | 依赖 CVE、不安全解析行为、传输层加固 |
| 数据同步修复 | GitHub Release 查询、zip 校验、重试/兜底行为 |
| 关键缺陷修复 | 错误结果、崩溃、资源泄漏、双实现 parity 回归 |
| 文档修复 | LTS 支持说明、部署修正、迁移说明澄清 |

1.7.x 不规划新能力。原 patch 线中的搜索合并、PRTS 页面合并、JSON 输出默认值和 golden test 基础设施，除非用于修复 1.7 LTS 回归，否则 都归入 2.0 规划。

---

## 2.0 边界变化

三个值得 major 升级的结构性变更。

### 工具面合并（上下文预算）

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

### Output channel（structuredContent）

2.0 经 MCP 原生 `structuredContent` 字段新增结构化输出。控制面是单个**连接级** `output_channel` 开关（`content`（默认）/ `structured` / `both`），Python 经 `PRTS_OUTPUT_CHANNEL` 环境变量设置，TypeScript 经查询字符串 / 请求头 / 环境变量设置。结构化工具（17 个）携带真实结构化载荷，含可链式调用的 ID 与 raw/label 字段对；叙事工具（6 个）仅 content。默认 `content` 通道保留 1.x 人类可读的 markdown 输出，故不支持的客户端（如 Chatbox）无需配置即不受影响。

**设计选择——用通道，而非 per-call 格式参数。** 原路线图提出 per-call 的 `output_format=markdown|json` 参数，并在 2.0 把默认翻转为 `json`。**该形态在设计阶段被否决。** 主要消费者是 LLM agent，JSON 会令 prompt token 膨胀 ~15–30%——这将抵消工具面合并带来的上下文预算收益。因此 markdown 始终作为 `content` 文本，结构化数据走独立通道，两轴正交。**默认不**翻转为 JSON。

各工具的通道映射与客户端配置见 [2.0 迁移指南](docs/migration-1.x-to-2.0.md)。

### 双实现等价化（Python ↔ TypeScript）

2.0 收窄但未取消两套实现之间事实上的角色分工。**已在 2.0 交付**：

- npm 包和 PyPI 包的**能力面对等**——相同的 23 个工具名、参数、structuredContent 载荷，以及跨实现共享的 parity fixture。
- 环境变量名称和默认值统一（`PRTS_OUTPUT_CHANNEL`、`GAMEDATA_PATH`、`STORYJSON_PATH`、 `GITHUB_TOKEN`、`GITHUB_MIRRORS`）。

**跨传输协议同步——已于 2.3.0 交付。** 原目标「两套实现都同时支持 stdio **和** Streamable HTTP」（Python 上 HTTP、TypeScript 上 stdio）曾后置到 2.0 之后，已在 2.3.0 交付。Python 经 `PRTS_TRANSPORT` 选择传输（stdio 默认 | http）；TypeScript 经 bin 选择（`prts-mcp-ts`[-bun] = HTTP，`prts-mcp-ts-stdio` = stdio）。自 2.3.0 起部署推荐为「按场景选择，而非按语言」。

### 清理

- 移除晚期 1.x 仍残留的 0.x 兼容 shim（如果有）。
- 移除 2.0 迁移方案引入的 deprecated 工具别名（见上方"工具面合并"部分）。

### 2.0 Non-Goals

- 不重写 MCP 协议层。
- 不引入 stdio + HTTP 之外的传输方式。
- 不破坏数据同步语义。
- **不实现自定义的 deferred tool loading 方案**。若 MCP spec 标准化（如 SEP-1821 合入），则采纳；否则合并 + 描述优化就是我们的回答。

---

## 决策原则

1. **1.7 LTS 不再新增能力**——让稳定线保持小而可维护。
2. **每个功能版本一个数据域**——便于宣传、便于迁移、便于回滚。
3. **Patch 不增加新能力**——只修 bug、改善兼容性，并保持 1.7 合约。
4. **重大改动必须有明确迁移文档**——2.0 的工具面和输出格式变化需在预发布前写清楚。
5. **跨源融合工具绑定其数据依赖**——`get_stage_enemies` 在关卡数据域之后发布，不会提前。
6. **按 schema 形态合并，而非按数据域合并**——合并参数结构相似的工具能保持选择准确率；按"所有干员相关的"合并则不行。
7. **新数据域优先扩 `scope` enum，而非为每个域新增 list/get/search 三件套**——接入新数据域（如基建技能、皮肤、家具）时，先评估能否并入既有统一入口的 enum（如 `search(scope)`）；仅当输出形态确属异质、无法被现有工具承载时才新增工具。此原则针对 1.x 期间"每加一个数据域就 +3 工具"、把工具面从 24 推到 32 的增长斜率。

---

## 详细计划

- [1.0 架构计划](docs/dev/plans/1.0-architecture-plan.md)
- [1.0 开发路线图](docs/dev/plans/1.0-development-roadmap.md)
