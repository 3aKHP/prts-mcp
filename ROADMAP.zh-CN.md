# PRTS-MCP 路线图

_最近更新：2026-07-10_ · [English](ROADMAP.md)

PRTS-MCP 已进入 1.x 稳定期。1.7.0 是最后一个 1.x 功能版本和 1.7 LTS 基线。本文档记录**接下来要做什么**——已发布的内容请查看 Python 和 TypeScript 各自的 CHANGELOG。

## 当前发布

- Python：`1.7.1` LTS
- TypeScript：`1.7.1` LTS
- LTS 发布后 `dev` 分支当前目标版本：`2.0.0-dev`
- 1.7 LTS 线冻结 32 个公共 MCP 工具（CI 强制检查）。
- 0.x → 1.0 迁移说明见 [迁移指南](docs/migration-0.x-to-1.0.md)。

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
- `get_stage_enemies(stage_id)` — 该关卡出现的敌人 + **关卡级数值**
  （而非 `get_enemy_info` 返回的 level-0 默认值）。
- `get_enemy_appearances(name)` — 反向查询：该敌人出现在哪些关卡。
- `get_enemy_info(name)` 增加可选 `stage_id` 参数，返回该关卡下的
  具体数值变体。

**主：道具数据域**
- `list_items(category?)` — 按类别列出物品（材料、装置、芯片等）。
- `get_item_info(name)` — 物品详情：用途、获取方式。
- `search_items(pattern)` — 正则搜索。

### 1.7.0 — 剧情角色追踪（LTS）

**剧情角色追踪（无新数据源——基于现有剧情 JSON 索引化）**
- `find_character_appearances(name, scope?, max_events?)` — 该角色出现的章节 /
  活动（说话：对话角色名精确匹配；被提及：名字作为子串出现在台词/旁白中）。
  已在 dev 上为 1.7.0 实现。
- `find_speakers_in(event_id)` — 该活动中所有发言角色及其台词数。已在 dev 上
  为 1.7.0 实现。

1.7.0 是最后一个 1.x 功能版本。原计划中的干员深度能力不再继续作为 1.x 新工具加入，而是推迟到 2.0 工具面重设计中重新评估。

### 1.7 LTS 之后暂缓的功能

以下功能设想仍然有价值，但不再作为 1.x minor 版本排期；应在 2.0 工具模型下重新评估：

**干员深度**
- 基建技能与跨干员基建技能搜索。
- 皮肤列表与皮肤描述。

**Wiki 增强 + 公招**

**主：PRTS Wiki 增强（B 类一次性集中交付）**
- `get_prts_images(page_title)` — 通过 `prop=images` 获取图片列表。
- `resolve_prts_redirect(title)` — 重定向解析；解决长期遗留的 1.1.1
  "已知问题"。

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

1.7.x 不规划新能力。原 patch 线中的搜索合并、PRTS 页面合并、JSON 输出默认值和 golden test 基础设施，除非用于修复 1.7 LTS 回归，否则均属于已交付的 2.x 历史。

---

## 2.0 边界变化（已交付）

2.0 已完成规划中的 major 迁移，同时保持 1.7 LTS 线不变：

- **工具面：** 按 schema 形态合并后，2.x 公共工具面从 32 降至 23；1.7 LTS
  继续保留全部 32 个名称。
- **结构化输出：** 2.x 通过 MCP `structuredContent` 和 `output_channel`
  控制面提供结构化输出，默认仍保留人类可读的内容。
- **传输等价：** 2.x 的两个实现均支持 stdio 与 Streamable HTTP；1.7 LTS
  保持既有部署角色。

该迁移没有引入自定义 deferred-tool-loading 协议，也没有改变数据同步语义。

---

## 决策原则

1. **1.7 LTS 不再新增能力**——让稳定线保持小而可维护。
2. **每个功能版本一个数据域**——便于宣传、便于迁移、便于回滚。
3. **Patch 不增加新能力**——只修 bug、改善兼容性，并保持 1.7 合约。
4. **重大改动必须有明确迁移文档**——2.0 的工具面和输出格式变化需在
   预发布前写清楚。
5. **跨源融合工具绑定其数据依赖**——`get_stage_enemies` 在关卡数据域
   之后发布，不会提前。
6. **按 schema 形态合并，而非按数据域合并**——合并参数结构相似
   的工具能保持选择准确率；按"所有干员相关的"合并则不行。

---

## 详细计划

- [1.0 架构计划](docs/dev/plans/1.0-architecture-plan.md)
- [1.0 开发路线图](docs/dev/plans/1.0-development-roadmap.md)
