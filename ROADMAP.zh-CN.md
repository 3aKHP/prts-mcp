# PRTS-MCP 路线图

_最近更新：2026-05-28_ · [English](ROADMAP.md)

PRTS-MCP 已进入 1.x 稳定期。公共工具面和数据架构受 1.x 兼容合约 约束。本文档记录**接下来要做什么**——已发布的内容请查看 Python 和 TypeScript 各自的 CHANGELOG。

## 当前发布

- Python：`1.6.1`
- TypeScript：`1.6.1`
- `dev` 分支当前目标版本：`1.7.0-dev`
- 1.x 期间冻结 30 个公共 MCP 工具（CI 强制检查）。
- 0.x → 1.0 迁移说明见 [迁移指南](docs/migration-0.x-to-1.0.md)。

## 1.x 兼容合约

1.x 期间保持稳定的内容：

- 工具名称和必填参数。
- 响应**格式**（markdown 形态）；具体措辞和细节可能演进。
- `GAMEDATA_PATH` 和 `STORYJSON_PATH` 语义。
- 默认从 GitHub Releases 自动同步。

minor 版本中可能变动的内容：

- 新增工具（增量、不破坏）。
- 新增可选参数（带安全默认值）。
- 新增可选数据源 / 兜底机制。
- 在相同格式内丰富输出内容。

## 1.x Patch 策略

Patch 版本（1.x.y）仅用于 bug 修复、文档以及不破坏兼容的体验改进 （见下方"Patch 线"）。**不引入新能力，不增加必填参数。**

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
- `get_stage_enemies(stage_id)` — 该关卡出现的敌人 + **关卡级数值**
  （而非 `get_enemy_info` 返回的 level-0 默认值）。
- `get_enemy_appearances(name)` — 反向查询：该敌人出现在哪些关卡。
- `get_enemy_info(name)` 增加可选 `stage_id` 参数，返回该关卡下的
  具体数值变体。

**主：道具数据域**
- `list_items(category?)` — 按类别列出物品（材料、装置、芯片等）。
- `get_item_info(name)` — 物品详情：用途、获取方式。
- `search_items(pattern)` — 正则搜索。

### 1.7.0 — 剧情角色追踪 + 干员深度

**剧情角色追踪（无新数据源——基于现有剧情 JSON 索引化）**
- `find_character_appearances(name, scope?, max_events?)` — 该角色出现的章节 /
  活动（说话：对话角色名精确匹配；被提及：名字作为子串出现在台词/旁白中）。
  已在 dev 上为 1.7.0 实现。
- `find_speakers_in(event_id)` — 该活动中所有发言角色及其台词数。已在 dev 上
  为 1.7.0 实现。

**主：基建技能数据域**
- `get_operator_building_skills(name)` — 基建技能、效率、槽位。
- `search_building_skills(building_type, pattern)` — 跨干员搜索基建技能。

**皮肤**
- `get_operator_skins(name)` — 皮肤列表与描述。

### 1.8.0 — Wiki 增强 + 公招

**主：PRTS Wiki 增强（B 类一次性集中交付）**
- `get_prts_images(page_title)` — 通过 `prop=images` 获取图片列表。
- `resolve_prts_redirect(title)` — 重定向解析；解决长期遗留的 1.1.1
  "已知问题"。

**公招**
- `query_recruit_tags(tags)` — 反查：给定标签组合可招到哪些干员。

---

## Patch 线（1.x.y）

Patch 版本滚动交付体验和基础设施改进，不引入新能力。每个 patch 携带 1-2 项改动；与具体 minor 版本的绑定仅作示意——实际工作流跟随 可用窗口推进。

| 暂定版本 | 主题 | 范围 |
|----------|------|------|
| 1.5.1 | 搜索工具合并（阶段一） | 新增 `search(scope, pattern, ...)` 合并 `search_data` / `search_stories` / `search_enemies` / `list_search_scopes`。旧名作为 deprecated 别名保留。 |
| 1.5.2 | 分页格式统一 | 所有列表工具采用 `{total, offset, limit, items}` 标准结构。 |
| 1.6.1 | 结构化错误 | 新增 `{error_code, message}`，旧字符串作为 fallback 保留。 |
| 1.6.2 | PRTS 页面工具合并（阶段一） | 新增 `prts_page(page_title, action="read\|sections\|categories\|links\|template", ...)` 合并 5 个 `*_prts_*`/`*_prts_page` 工具。旧名 deprecated 保留。 |
| 1.6.3 | 工具描述优化 | 给所有工具的 description 加关键词和典型用例。提升客户端 ToolSearch / RAG 的召回率（Claude Code、Cursor）。服务端改动，零协议风险。 |
| 1.7.1 | 共享 fixture | 双实现的 fixture / golden 测试基础设施。 |
| 1.7.2 | Golden 测试 | Python 和 TS 在共享输入上的 byte-equal 输出测试。 |
| 1.7.3 | 开发者文档 | 数据架构图 + 新数据域接入指南。 |

这些改动均为增量、向后兼容。它们不阻塞对应的 minor 发布，只是 跟随自然的交付窗口推进。

---

## 2.0 边界变化

三个值得 major 升级的结构性变更。

### 工具面合并（上下文预算）

1.x 工具面持续增长（1.6.0 已 29 个，预计 1.8.0 后达 30+）。旗舰长上下文模型不在乎；但对 128K 级别模型，每个工具 schema 都吃 prompt 预算并降低工具选择准确率。

**背景**：MCP 协议层目前无原生 deferred tool loading 支持。已关闭 提案：lazy hydration（#1978）、lazyRegistration（#2376）。开放草案： tool-search query（#1821）、token-bloat 缓解（#1576）。Claude Code 的 ToolSearch 是 Anthropic API 层特性（`tool_reference` blocks）， 不能移植到 Cursor / Cline / Chatbox。

**方法**：服务端按 *schema 形态* 合并，而非按数据域合并。合并参数 结构和输出形态相似的工具，保留语义真正不同的工具。预估缩减： 24 → ~16 个工具（约 1/3），不损失能力。

**阶段一（1.x 内引入 deprecated 别名）**：

- `search(scope, pattern, ...)` 合并 `search_data` / `search_stories` /
  `search_enemies` / `list_search_scopes`。四者参数形态完全相同，
  仅 `scope` 不同。（1.5.1）
- `prts_page(page_title, action, ...)` 合并 `read_prts_page` /
  `list_prts_sections` / `get_prts_categories` / `get_prts_links` /
  `get_prts_template`。共享主键 `page_title`，`action` 选择子操作。（1.6.2）

**阶段二（2.0）**：移除 deprecated 别名。旧名在整个 1.x 期间保留， 留足迁移空间。

**明确不合并的部分**：

- 干员三件套（`get_operator_archives` / `voicelines` / `basic_info`）：
  输出形态和长度差异大，合并反而降低 LLM 选择准确率，得不偿失。
- 敌人三件套（`list_enemies` / `get_enemy_info` / `search_enemies`）：
  同上。
- 剧情工具（`read_story` / `read_activity` / `get_event_summary`）：
  在相关但不同的数据上做真正不同的动作。

合并的门槛：参数形态相同、输出长度和结构相似、LLM 在它们之间 做选择本质上是在选近义词。

### 输出格式可选

- 新增可选 `output_format=markdown|json` 参数，1.x 默认
  `markdown`（增量、不破坏）。
- JSON 模式返回结构化对象，便于下游自动化。
- 2.0 翻转**默认值**为 `json`，这才是 break point。
- markdown 在 2.0 仍可显式选择，不删除。

这种分阶段迁移让用户在 1.x 期间提前切到 JSON，2.0 翻转默认值前 有充足缓冲期。

### 双实现等价化（Python ↔ TypeScript）

目前两套实现存在事实上的角色分工：Python 主要面向 Docker / stdio， TypeScript 主要面向 `npm install -g` / HTTP。2.0 取消这种不对称：

- 两套实现都同时支持 stdio **和** Streamable HTTP。
- npm 包和 PyPI 包能力对等。
- 环境变量名称和默认值统一。
- 部署推荐折叠为"用你 stack 里顺手的那个 runtime 即可"。

### 清理

- 移除晚期 1.x 仍残留的 0.x 兼容 shim（如果有）。
- 移除 1.5.1 / 1.6.2 引入的 deprecated 工具别名（见上方"工具面
  合并"部分）。

### 2.0 Non-Goals

- 不重写 MCP 协议层。
- 不引入 stdio + HTTP 之外的传输方式。
- 不破坏数据同步语义。
- **不实现自定义的 deferred tool loading 方案**。若 MCP spec 标准化
  （如 SEP-1821 合入），则采纳；否则合并 + 描述优化就是我们的回答。

---

## 决策原则

1. **每个 minor 版本一个数据域**——便于宣传、便于迁移、便于回滚。
2. **Patch 不增加新能力**——只修 bug、改进体验，可以引入合并别名
   （语义已被现有工具覆盖），但绝不引入真正新的能力。
3. **重大改动提前一年铺路**——2.0 的 `output_format` 翻转和别名
   移除全程在 1.x 期间准备，不会临时宣布。
4. **跨源融合工具绑定其数据依赖**——`get_stage_enemies` 在关卡数据域
   之后发布，不会提前。
5. **按 schema 形态合并，而非按数据域合并**——合并参数结构相似
   的工具能保持选择准确率；按"所有干员相关的"合并则不行。

---

## 详细计划

- [1.0 架构计划](docs/dev/plans/1.0-architecture-plan.md)
- [1.0 开发路线图](docs/dev/plans/1.0-development-roadmap.md)
