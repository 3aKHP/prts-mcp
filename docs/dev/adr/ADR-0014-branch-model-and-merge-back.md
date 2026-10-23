# ADR-0014：长期分支模型与回灌规则

- 状态：Accepted（补录）
- 决策日期：多点定型——2026-07-02（main/develop 双线雏形随 2.0 发布成形）、2026-09-16（Reopen 并入回灌 PR 的裁决）、2026-10-13（四线模型随 3.0 迁移冻结）
- 关联：[AGENTS.md](../../../AGENTS.md) §1、[CLAUDE.md](../../../CLAUDE.md) §4、[WORKFLOW.md](../WORKFLOW.md)、[VERSIONING.md](../VERSIONING.md)、[RELEASE-CANDIDATES.md](../RELEASE-CANDIDATES.md)、[ADR-0008](ADR-0008-tiered-ci-metadata-gates.md)、[ADR-0010](ADR-0010-lts-dual-maintenance-lines.md)、[ADR-0004](ADR-0004-emudhra-trust-roots.md)

> 补录说明：本决策的各部分均早于 ADR 目录建立，规则至今现役，按本目录的补录例外整理自各决策时点的内部工作记录与公开 git 历史。分工：LTS 双线的设立与 EOL 参数归 [ADR-0010](ADR-0010-lts-dual-maintenance-lines.md)，分层 CI 的门禁结构归 [ADR-0008](ADR-0008-tiered-ci-metadata-gates.md)，本文只覆盖分支模型本身、回灌机制与预发布分支。

## 背景与问题

分支模型要解决三个反复出现的问题：

- **发布回合的机械开销**：2.x 早期一次发布要三个 PR（发布合 main、backmerge 回 develop、重开开发版本号），例如 2.7.3 周期。
- **3.0 迁移制造了两条异构源码树**：main/develop 转为根目录纯 Cargo 工程并移除 `python/`、`ts/`（M1B，PR #228），旧双实现冻结在 LTS 分支——整体合并会把已删除目录带回主线，构成结构性风险。
- **过渡期的验证需求**：3.0 候选版本需要真实发布验证（npm OIDC、GHCR、五平台 CI），但既不能合入 main（会顶替当时仍是 2.8.1 的稳定版），也不能让 develop 长期背负 alpha 版本号。

## 备选方案

以下裁决除标注外均有当时记录：

- **预发布版本直接在 develop 上迭代（2.x 旧惯例）**：过渡期被显式反转——规则写明“预发布分支不提前合入 main，也不将 develop 长期停留在 alpha 版本号”（[RELEASE-CANDIDATES.md](../RELEASE-CANDIDATES.md)）。反转的论证过程无记录（事后标注）。
- **独立的“重开开发”PR**：2026-09-16 在 2.7.4 回灌时废止。裁决自述（commit `0ff85f9`）：reopen 作为追加提交随回灌 PR 走，“让双轨评审覆盖追加后的 head”，少一轮独立评审。
- **旧分支整体合并进 Rust develop**：否决，理由有明文——会把已移除的 `python/` 和 `ts/` 带回主开发线（[CLAUDE.md](../../../CLAUDE.md) §4、[LTS.md](../LTS.md) §4）；过渡期 main 上 2.x hotfix 的整体 forward-merge 同理由否决，改为“同步 lts/2.8 + Rust 按适用性重做”。

事后推断（无当时记录，如实标注）：回灌为何用同一 release 分支加 merge commit（不 squash、不 cherry-pick、不新分支）没有当时的备选对比记录。可推断的结构性收益：develop 吸收 main 的 merge commit，使发布 tag 成为 develop 祖先（自 3.1.0 起成立），版本衔接与审计链完整；cherry-pick 会在 Cargo.toml/CHANGELOG 上制造双轨差异与反复冲突；同一分支让“发布内容 = 已评审 head + 纯元数据 reopen”的评审范围可明确界定。以上均属事后解释。

## 决定

- **四线模型**（[AGENTS.md](../../../AGENTS.md) §1、[CLAUDE.md](../../../CLAUDE.md) §4）：`main` 承载最新正式版（tag 推进 `latest`）；`develop` 为 3.x 集成线（不含 `python/`、`ts/`）；`lts/2.8` 与 `lts/1.7` 为双实现维护线（参数见 ADR-0010）。长期分支一律不直推，全部经 PR。
- **发布回灌闭环**：`release/vX.Y.Z` 从 develop 拉出 → PR 合入 main → tag 打在 main 的 merge commit 上 → 核验公开渠道 → 同一分支追加 Reopen 提交（版本号推进下一目标 `-dev.0` + 双语 CHANGELOG 重开空 Unreleased）→ PR 回灌 develop，**不 squash**。版本推进规则见 [VERSIONING.md](../VERSIONING.md)（默认下一 Patch；hotfix 占用则顺延；新 Minor 主题须在 ROADMAP 登记）。
- **Hot-Fix 衔接**：fix 分支直合 main 打补丁 tag，再以 backport PR 移植 develop 并顺延版本（实战：3.1.2 的 PR #277 → #278）。
- **过渡期 review-only 预发布分支**：从已审查的 develop 快照拉 `release/v3.x.y-alpha.N` 等分支，经独立审查与完整 CI 后直接在该分支提交上打 tag 触发发布（npm `@next`、GHCR `:next`、GitHub Prerelease 且 `make_latest=false`）；候选 PR 保持打开供评审、不合入 main、也不改 develop 的 `-dev.0`。“review-only”一语来自 PR 实践（候选 PR 自述 “candidate review record, not an integration merge request”），本文将其正式化。
- **禁止整并 LTS**：LTS 修复须按适用性在 develop 用 Rust 重做，任何 LTS 分支严禁整体 merge 进 main/develop。
- **门禁配套**：`develop` 要求 `CI gate`、`main` 另要求 `Full CI gate`（结构与部署次序见 [ADR-0008](ADR-0008-tiered-ci-metadata-gates.md)）；稳定 tag 要求提交位于 main 且显式开启发布开关；`tools/release/common.mjs` 拒绝发布 `-dev.` 版本（防回灌分支误发布，3.1.0 回灌评审实证过此拦截）。

## 后果

正面（merge 时间均为 UTC+8 口径）：

- 三轮完整发布回灌实战：3.0.0（PR #254 于 2026-10-16 20:50 合入，tag `v3.0.0`；#256 当晚回灌，且 rc.1–rc.3 历史先经 #252 同步、`e5b9874` 恢复 `3.0.0-dev.0`）；3.1.0（#265 于 10-18 合入 → reopen 提交 `29eabe9` → #267 回灌）；3.1.1（#275 → `94f570d` → #276）。
- review-only 实证：候选 PR #235/#237/#240（alpha）与 #245/#246（rc）全部 CLOSED 未合并；alpha.1 至 rc.3 的 tag 均落在 release 分支提交而非 main/develop。口径注意：PR #251（rc.3）显示 MERGED 是因 #252 把 rc 历史同步进 develop 而被 GitHub 标记，rc 版本号并未留在 develop。
- 回灌成本随分层 CI 收敛：3.0.0 回灌重跑原生矩阵 21 分 24 秒，3.1.0 回灌按分层规则仅普通 CI 6 分 48 秒（口径与归属见 ADR-0008）。
- eMudhra 事件（[ADR-0004](ADR-0004-emudhra-trust-roots.md)）实证四线并行处置：一天内 main hotfix、develop backport、两条 LTS 各经 fix/release PR 发版，无任何跨线整并。

负面与代价：

- 回灌链对版本号与 CHANGELOG 的元数据精度要求高，reopen 提交本身需要评审覆盖（这是 2026-09-16 裁决的直接动机）。
- 预发布分支的保留无明确时限规则（只观察到 alpha/rc 分支在稳定发布后删除、`release/v3.1.1` 尚存）。

遗留事项与材料缺口：

- 2.7.4 回灌裁决的原始讨论未保存，仅有 `0ff85f9` 的 commit message 自述。
- “同一分支回灌、不 squash、不 cherry-pick”的备选对比无当时记录（见“备选方案”节标注）。
- 落点演进无文字说明：3.0.0 的回灌未把 main merge commit 带进 develop；自 3.1.0 起 reopen 提交改为落在 main merge commit 之上（此后发布 tag 均为 develop 祖先，可经 `git merge-base` 核验）——变化原因无记录。

公开记录：[AGENTS.md](../../../AGENTS.md)、[CLAUDE.md](../../../CLAUDE.md)、[WORKFLOW.md](../WORKFLOW.md)、[VERSIONING.md](../VERSIONING.md)、[LTS.md](../LTS.md)、[RELEASE-CANDIDATES.md](../RELEASE-CANDIDATES.md)、commit `0ff85f9`、PR [#199](https://github.com/3aKHP/prts-mcp/pull/199)/[#252](https://github.com/3aKHP/prts-mcp/pull/252)/[#254](https://github.com/3aKHP/prts-mcp/pull/254)/[#256](https://github.com/3aKHP/prts-mcp/pull/256)/[#265](https://github.com/3aKHP/prts-mcp/pull/265)/[#267](https://github.com/3aKHP/prts-mcp/pull/267)/[#277](https://github.com/3aKHP/prts-mcp/pull/277)/[#278](https://github.com/3aKHP/prts-mcp/pull/278)。
