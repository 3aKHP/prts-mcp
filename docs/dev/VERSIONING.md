# 版本号约定与兼容性承诺

本文件是 PRTS-MCP 版本语义与兼容性承诺的单一事实源，面向下游部署者与协作者。分支、评审、验证与发布的操作流程见 [`WORKFLOW.md`](WORKFLOW.md)；1.7 LTS 线的专门规则见 [`LTS.md`](LTS.md)。

> **Core promise (EN):** PRTS-MCP follows SemVer-shaped versioning with a closed, enumerated set of deviations declared in this document — not maintainer discretion. For every Patch and Minor release within a Major line, the default goal is a blind upgrade: `pip install -U` / `npm install -g` with no configuration change, without end users noticing anything.

## 兼容的统一定义

Patch 与 Minor 共享同一个默认姿态。**兼容** = 同时满足：

1. 下游部署者可以无脑升级（`pip install -U` / `npm install -g`），无需修改配置、部署脚本或启动方式即可维持既有功能；
2. 部署者的下游用户（MCP Client 使用者，可能就是部署者本人）可以毫无感知地继续以先前方式使用先前可用的功能。

**纯增量变更不算破坏**，包括：新增工具、新增可选参数、新增输出内容类型（如 2.5.0 的多媒体输出）、带安全默认值的新环境变量、新增协议路径或端点。

**承诺只覆盖文档化契约面**：README、`docs/user/`、`docs/admin/`、CHANGELOG 或本文件明确承诺的行为。内部模块 API、未文档化的运行时副作用、双实现间未被文档承诺的文案细节，不在承诺范围内。

## 承诺矩阵

| 契约面 | Patch | Minor | Major |
|---|---|---|---|
| 工具名 / 必填参数 / 输出格式 | 白名单例外（见下） | 同 Patch + 第四类（带强制义务） | 无承诺 |
| 环境变量语义与默认值 | 同上 | 同上 | 无承诺 |
| 部署 / 传输契约（端口、路径、health / debug 端点） | 同上 | 同上 | 无承诺 |
| 数据文件契约（读取方：AKDP 数据集、缓存格式） | 变更须优雅降级 | 同 Patch + 第四类 | 无承诺 |
| 内部模块 API | 任何级别均无承诺 | — | — |

## 例外集（封闭枚举）

- **Patch 白名单（三类，封闭）**：
  a. 行为与文档不符，修复使行为向文档对齐（如 #193：文档承诺 24h 空闲淘汰，实现实为 ~2×）；
  b. 安全修复；
  c. 外部依赖或上游的强制变化。
  命中白名单也必须在 CHANGELOG 明示影响面，且在所有可行实现中优先选择不破坏的方案。
- **Minor 第四类**：主题所必需的契约调整。强制义务三件套：CHANGELOG 版本段开头升级说明 + 迁移指南（受影响面大时独立 `docs/migration-X.Y-to-X.Z.md`）+ 可行时先标记 `Deprecated`、给一个过渡 Minor 再移除。2.6.0 是纯增量发布的先例（legacy 协议路径完整保留，`docs/migration-2.5-to-2.6.md` 为 opt-in 指南而非升级必需动作）。
- **Major**：放弃兼容目标的唯一级别（2.0 先例：工具面 32 → 23）。

即便命中例外集，"尽最大可能不破坏向后兼容"仍是义务：能增量就不改契约，能优雅降级就不报错。

**叙事惯例（非兼容规则）**：新增公共工具面优先安排在 Minor——README 与 CI 锚定工具数，值得一个主题版本。Patch 中新增工具不违反兼容承诺。

## 版本号操作规则

- **三段式 `Major.Minor.Patch`**。**预发布后缀与归一化**：tag 始终使用连字符后缀（`-alpha.N` / `-beta.N` / `-rc.N`），Python 和 TS 统一；`pyproject.toml` 内用 PEP 440（`2.6.0a1`），CD 的 version check 自动归一化 `-alpha.` → `a`；`package.json` 内用与 tag 相同的 semver 形式（`2.6.0-alpha.1`）。
- **双实现版本锁步**：`python/pyproject.toml` 与 `ts/package.json` 版本号始终一致（格式分别遵循 PEP 440 与 semver）；tag 成对（`python/vX.Y.Z` + `ts/vX.Y.Z`）。
- **develop 目标版本**：`develop` 上的版本号 = 下一计划发布目标 + 开发后缀（`.dev0` / `-dev.0`）。正式发布并回灌后，默认进入当前 Minor 的下一 Patch（如 2.7.4 发布后 → `2.7.5.dev0` / `2.7.5-dev.0`）；确定开启新主题时才改为下一 Minor（`2.8.0.dev0`），并在 ROADMAP 记录主题。目标版本只表达下一计划发布，允许随范围调整；已发布 tag 与发行物保持原样。
- **Patch 是系列内累积更新的常规载体，hotfix 只是它的特例**：Patch release 可以容纳修复、优化、功能补全与小型兼容增补，不要求也不默认是一次紧急修复。非 hotfix 的 patch 工作一律经 `develop` 累积、随标准 release 流程发布；唯一直通 `main` 的通道是 hotfix（触发条件见 [`WORKFLOW.md`](WORKFLOW.md) 的 Hot-Fix 一节）。

### 回灌后的 develop 目标版本对照表

覆盖 hotfix 占用目标版本与常规发布回灌两类场景。表中版本号以 TS（semver）形式书写；Python 侧对应 PEP 440 形式（`-dev.0` → `.dev0`）。

| 场景 | 回灌后的 develop 版本 |
|---|---|
| develop 为 `2.8.0-dev.0`，main 发布 `2.7.4` hotfix | 保持 `2.8.0-dev.0` |
| develop 为 `2.7.4-dev.0`，main 发布 `2.7.4` hotfix | 通常调整为 `2.7.5-dev.0` |
| develop 完成 `2.7.4` 正式发布，继续当前系列 | 进入 `2.7.5-dev.0` |

版本字段的合并冲突按当前发布计划处理；核对回灌结果时同时确认修复已进入 develop，且 develop 版本仍表达下一计划发布目标。

## 不变项

- `lts/1.7` 的维护规则、tag 前缀与 CD 门禁：不变，见 [`LTS.md`](LTS.md) 与 `CLAUDE.md`。
- 历史版本保留原编号与发布记录，不追溯调整。

## 明确不引入

以下机制经评估后**不采纳**（本仓库大多数情况无并行开发，且无对应需求）：开发批次号（`dev.N` 递增）、本地 CHANGELOG 草稿机制、Develop Direct（免 PR 直推集成分支——本仓库一切改动经 PR）。若未来协作规模变化需要其中任何一项，需修订本文件后引入。

## 设计基调

本约定与 SemVer 的关系：**偏离是封闭枚举，而非开放裁量**。除上文声明的偏离（Patch 可含兼容增补、Minor 第四类契约调整）外，按 SemVer 理解。下游拿到的不是"看发布说明碰运气"，而是可预期的承诺形状：Patch 与 Minor 都以无脑升级为默认目标，例外的种类、义务与披露方式全部列明。
