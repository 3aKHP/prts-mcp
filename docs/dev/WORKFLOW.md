# 变更分级、评审与验证工作流

本文件定义"一次变更需要什么级别的评审与验证"：变更分级、高风险域、双轨 CR 机制（含 KHPilot 行为特征）、评审输出处置与最小验证矩阵。操作步骤（分支命名、迭代路径 A–F、命令清单）以 `CLAUDE.md` 为单一来源；版本语义与兼容承诺见 [`VERSIONING.md`](VERSIONING.md)；全量 E2E 真机流程见 [`E2E.md`](E2E.md)。

## 硬规则

- 一切改动经 PR；不直推 `main` / `develop` / `lts/1.7`（本仓库不引入 Develop Direct）。
- 一个分支或 PR 只承载一个主要意图；大变更先拆分。
- 行为、配置、协议、部署契约或用户文档变化时，同一变更更新拥有该事实的文档。
- 难以判断属于哪一级时，**向上分级**。
- 无法执行的验证必须在 PR / 交接中明确报告为未验证，不得当作通过。

## 变更分级

| 等级 | 范围 | 评审 | 合并路径 |
|---|---|---|---|
| **Quick PR** | 小/中型、低风险、不触高风险域 | KHPilot Bot Review 一轮 | Bot 无 Blocking 后人工合并 |
| **Standard PR** | 中型，或触及任一高风险域 | 独立 CR + Bot Review **并行**（"双轨 CR"） | 无未解决 Blocking / Should-fix 后人工合并 |
| **Huge PR** | 大型、跨模块、高风险 | 专题计划 + 拆分为多个 Standard PR + 整体多透镜审查 + 全量 E2E | Deep-CR 结论收口后人工合并 |
| **Hot-Fix** | `main` / 已发布 tag 的阻断回归 | 非平凡变更至少独立 CR | PR 到 `main`，再回灌 `develop` |
| **Release** | 公开发布（含 patch / minor / 预发布） | 至少 Standard；命中 Huge 条件按 Huge 执行 + 全量 E2E | release PR 合 `main` 后打 tag |

评审输出统一四分类：**Blocking**（合并前必须修复）、**Should-fix**（除非 PR 记录延后理由否则修复）、**Nits**（酌情）、**Verified claims**（可记录于 PR / merge notes）。

## 高风险域

命中以下任一领域的改动，最低按 Standard PR 执行：

- `sync/` 层（传输 / 镜像 / 激活 / 代际 / 锁）
- `api/` 工具契约与双实现 parity 面（工具名、参数、输出格式）
- MCP 传输层（stdio / Streamable HTTP）与会话管理
- artwork / images 域（两条数据源的缝合处）
- 部署、CI/CD 与发布 workflow
- debug / 鉴权端点

前四项同时是 [`E2E.md`](E2E.md) 的强制全量 E2E 触发条件——**Huge PR 与 Release 合并前必须完成全量 E2E**。对 Standard 及以下等级，全量 E2E 同为默认要求；仅当维护者按改动范围与验证成本明确决定时，可以面向改动范围的轻量化真机验证替代**当次**全量流程，且 PR 必须披露验证范围与未执行环节，未执行的全量 E2E 仍留在发布前检查单上（先例：PR #194 会话管理改动，合并前经维护者指示执行轻量化验证——双实现生产式部署 + 会话生命周期探测——并在 PR 记录中披露范围与未执行的重型环节）。替代是维护者对单次改动的裁量，不是作者的自助降级通道。

## 各级说明

### Quick PR

小/中型低风险改动。流程：短分支 → 实现与验证 → PR → KHPilot Bot Review 一轮并处理结论 → 无 Blocking 后请求人工合并。不要求独立 CR。

### Standard PR（双轨 CR）

中型改动或触及高风险域。流程：短分支 → 实现与验证 → **先开 PR**（触发 Bot）→ **再启动本地独立 CR**，两轨并行 → 汇总两轨结论按四分类处置 → 人工合并。

独立 CR 契约（Tier 1）：

- 由未参与实现会话的干净上下文 reviewer 执行（通常为 SubAgent），只读，不修改代码；
- 每条 finding 须引用契约与 `file:line` 举证；
- 输出按四分类整理；明确给出"可合并 / 不可合并"结论。

reviewer 独立性、不可信输入处理、交叉核对与 finding 处置的操作契约见 `CLAUDE.md` "双轨 CR 规范"一节。

### Huge PR

大型、跨模块、高风险改动，或面向 release 的大型收束。

- 开始前编写专题计划：目标与验收条件、涉及子系统、风险与失败模式、拆分方案；
- 实现拆分为多个 Standard PR，每个只承载一个主要意图，各自走完双轨；
- 整体变更做多透镜审查，透镜按本仓库风险面设定：① sync 数据管线；② api / parity 契约；③ MCP 传输与会话；④ artwork 双数据源缝合；⑤ 跨实现结构、配置与部署一致性；
- 合并前完成全量 E2E（[`E2E.md`](E2E.md)），缺此环节不得视为验证完成。

### Hot-Fix

仅用于 `main` 或已发布 tag 的**阻断回归**（服务无法启动、工具面全面失败、数据损坏、凭据泄漏等）；日常紧急修复仍走 `develop`。流程：从 `main` 建 `fix/vX.Y.Z-<topic>` → 最小修复 + 可行时回归测试 → CHANGELOG → PR 到 `main`（非平凡变更至少独立 CR）→ 打 patch tag → 回灌 `develop`。Hotfix 占用 develop 目标版本时按 [`VERSIONING.md`](VERSIONING.md) 的回灌对照表处理。

### Release

按 `CLAUDE.md` 路径 D / F 执行；评审至少 Standard，命中 Huge 条件时按 Huge 执行；合并前完成全量 E2E 与 CD 产物核对。回灌完成后核对 develop 的下一目标版本（规则见 [`VERSIONING.md`](VERSIONING.md)）。

## KHPilot Bot Review 机制

KHPilot 是 PR 侧的自动评审 Bot，行为特征：

- **仅在开 PR 时主动评审一次**（不请自来）；后续 head 不主动复审，需在 PR 评论中 `@khpilot[bot]` 请求 re-review；
- 评审耗时视 diff 规模约 **3–5 分钟至近 1 小时**；
- 评审进行中 PR **HEAD 移动会立即中断**该次评审——因此本地 CR 修复推送后，若 Bot 在途评审被中断，push 后需 `@khpilot[bot]` 请求对新 head 复审。

据此的工作流编排：

1. 双轨 PR **先开 PR、再启动本地独立 CR**——本地 CR 完工时，Bot Review 通常也已到达，两轨结论正好汇合；
2. Bot Review 未到时（Quick PR 等待唯一评审轨，或双轨本地先完工），安排**后台轮询**等待其到达，上限 **1 小时**（可按 diff 规模缩短），减少人工介入：

```bash
# 等待 KHPilot 评审到达：每 3 分钟查一次，20 次（60 分钟）封顶
pr=123  # PR 号
for i in $(seq 1 20); do
  gh pr view "$pr" --json reviews \
    --jq '[.reviews[].author.login] | any(. == "khpilot")' \
    2>/dev/null | grep -q true && break
  sleep 180
done
gh pr view "$pr" --json reviews \
  --jq '[.reviews[] | select(.author.login == "khpilot")] | last | {state, submittedAt}'
```

3. 后续将以 KHPilot 的**状态查询接口 / Webhook** 替代轮询（规划项，落地后修订本节）。

## 最小验证矩阵

按改动风险选最小验证集；命令清单以 `CLAUDE.md` 路径 A 步骤 4 为单一来源，本表只标层级：

| 改动类型 | 最小验证 |
|---|---|
| 仅文档 | 术语 / 链接 targeted grep；引用代码时按需 `pytest -k <topic>`；CI workflow-lint |
| 小代码（单实现） | 对应实现的全量单测（Python pytest 或 TS build + test + typecheck） |
| 工具面 / 数据 / sync 运行时 | 双实现全量 + `./scripts/check-runtime.sh --full` |
| 高风险域改动 | 双实现全量 + check-runtime --full；全量 E2E 为默认要求，维护者可按上节规则决定当次以面向范围的轻量化真机验证替代（PR 披露范围与未执行环节） |
| Huge PR / Release | 上述全部 + 双实现 parity 测试 + CHANGELOG / 版本号 / STATUS 口径核对 + **全量 E2E**（[`E2E.md`](E2E.md)）+ CD 产物核对 |

## 其他约定

- 解决 Issue 的 PR 正文使用单独一行 `Closes #<issue>`；仅关联但未完成的使用 `Refs #<issue>`。
- 合并一律由人执行；协作者不自行 merge。
- PR 保留 merge 历史，不 squash（仓库现行惯例）。
