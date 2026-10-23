# ADR-0008：分层 CI 与 PR 元数据门禁

- 状态：Accepted（补录）
- 决策日期：2026-10-17
- 关联：[Issue #238](https://github.com/3aKHP/prts-mcp/issues/238)、PR [#259](https://github.com/3aKHP/prts-mcp/pull/259)/[#260](https://github.com/3aKHP/prts-mcp/pull/260)/[#261](https://github.com/3aKHP/prts-mcp/pull/261)（#262 为分支保护演练用的临时 PR）、[WORKFLOW.md](../WORKFLOW.md)、[.github/workflows/ci.yml](../../../.github/workflows/ci.yml)、[tools/ci/policy.mjs](../../../tools/ci/policy.mjs)

> 补录说明：本决策落地于 ADR 目录建立之前（3.1.0 发布前一日），因其机制至今现役且档案库无逐条记录，按本目录的补录例外整理自决策期间（2026-10-13 至 2026-10-18）的内部工作记录（CI/CD 计时报告与清理验证闭环）。另注：本文的“元数据门禁”指 PR 元数据（标题/描述/标签/目标分支）变更时的门禁复用机制，与 `contracts/` 下数据元数据清单的校验是两回事。

## 背景与问题

3.0 时代每个 PR 都运行五平台原生构建、完整数据打包、npm 安装探针、Docker 探针与候选聚合。成本记录（口径：GitHub-hosted runner，job/step 起止时间或 run 创建至终态含排队）：

- [Issue #238](https://github.com/3aKHP/prts-mcp/issues/238)：3.0.0-alpha.2 候选 CI 中 Windows x64 的 npm 安装验证耗时 19 分 16 秒，Linux x64 同步骤仅 33 秒；任务总耗时 Windows 27 分 08 秒对 Linux 7 分 06 秒（观察于 2026-10-13）。
- 3.0.0 发布 PR #254 的全量门禁 26 分 48 秒（2026-10-16）；其回灌 PR #256 重跑原生矩阵 21 分 24 秒。

同时存在三个记录在案的 GitHub 分支保护语义陷阱（PR #261 记录，曾在临时 PR #262 上以真实保护规则复现）：被跳过的 job 在分支保护中算作成功；只跑轻量选择的“元数据 run”缺少旧 suite 中已通过的必需检查，会让受保护 PR 卡在 BLOCKED；旧 run 的手动 rerun 保留原事件负载，PR 换 base 或增删 `ci:full` 标签后，旧 run 的“成功”不能作为当前层级的有效证明。

## 备选方案

材料中没有独立的备选方案分析文档；可确证的裁决如下，论证缺失处如实标注：

- **双层制：普通 Linux CI 为默认，`main` 目标 PR 或携带 `ci:full` 标签者升级全量**：采纳（PR #261 正文与 [tools/ci/policy.mjs](../../../tools/ci/policy.mjs)）。
- **基于变更路径自动升级全量**：否决。当时记录仅有结论性一句 “No automatic path upgrades or scheduled matrix runs are introduced”，论证过程无记录。事后推断：发布关键路径文件（`Cargo.lock`、`build.rs`、`vendor/`、`packaging/` 等）散布全仓，路径规则易漏判，且规则本身会成为新的维护面。
- **定时（scheduled）全量矩阵**：否决。同上，仅范围裁决记录。
- **原生矩阵保留 `workflow_dispatch` 手动入口、tag/CD 继续全量**：采纳，作为兜底通道。
- **元数据编辑完全不触发任何 CI 事件**：否决（隐含）。事后推断：完全不触发会让必需检查在新 check suite 下悬空——这正是 commit `b929e63` 修复的问题；ci.yml 并发组注释为当时记录：“Metadata-only edits and explicit reruns must not cancel the current PR run”。
- **门禁信任事件负载快照**：否决。层级选择与最终门禁两处都以只读 token 实时核对 PR 的 HEAD/base/层级，代码注释记录理由：“Reruns retain their original event”。
- **门禁结构：`CI gate` 立即注册并挂起等待 + 与 HEAD/身份串绑定的 `CI result` + 仅全量层发出 `Full CI gate`**：采纳。

评审闭环：独立 clean-context 评审在 commit `bc90eac` 时发现两个实质问题（加 `ci:full` 后旧普通 run 被重跑、无关元数据编辑触发不必要的取消与重建），已在最终 HEAD 修复；KHPilot 在 PR 对话中的意见无 Blocking/Should-fix 级条目（当时未形成正式 review）。

## 决定

以 PR #261（commits `219af33`/`bc90eac`/`b929e63`）落地，随 3.1.0 线生效：

- **普通层**（默认；`main`/`develop` 的 push 亦属普通层）：`workflow-lint`（层级选择 + CI 策略单测 + actionlint，5 分钟超时）、`msrv`（Rust 1.89 `cargo check --locked --bins --example package_data`，独立缓存，10 分钟）、`rust-validation`（[`scripts/check-runtime.sh --full`](../../../scripts/check-runtime.sh)：格式、clippy、全量 Rust 测试、384 例冻结 JSON 差分加 384 例 SQLite 差分、进程生命周期、3,276 例扩展正则，以及发布策略/入口/版本校验与源码包构建，15 分钟超时，热缓存目标约 5 分钟）。
- **全量层**（普通层全部，加可复用的原生矩阵工作流 [native-platforms.yml](../../../.github/workflows/native-platforms.yml)）：五平台（linux-x64、linux-arm64、windows-x64、darwin-arm64、darwin-x64）原生构建/打包/探针、npm 真实安装探针、Linux 上 Docker 构建与探针、候选聚合，最后由 Native verification gate 收口。
- **层级选择**（[tools/ci/policy.mjs](../../../tools/ci/policy.mjs)）：`pull_request` 且（base 为 `main` 或含精确 `ci:full` 标签）→ 全量；`push`/`workflow_dispatch` → 普通；其他事件直接断言失败。标签/base/HEAD 变化时重新判断；同 PR 在途旧运行被并发组取消（元数据事件与显式 rerun 除外）。`ci:full` 是公开仓库标签，描述为 “Run complete five-platform native, npm, Docker and candidate CI for this PR”。
- **元数据门禁**：标题/描述/无关标签编辑 → 选择步骤判定不运行 → 昂贵 job 全部跳过；`CI gate` 始终立即注册并保持 pending，由 [tools/ci/wait-for-result.mjs](../../../tools/ci/wait-for-result.mjs) 轮询（15 秒间隔；普通层 20 分钟、全量层 85 分钟截止）寻找与当前 HEAD/run/attempt 及身份串 `CI result / <event> / <PR 号> / <base> / <tier>` 匹配的最新成功验证；找到则刷新门禁，找不到或层级不符则失败关闭。选择处与门禁处均实时核对 PR 状态，过期运行必须用最新 run。
- **分支保护部署次序**（[WORKFLOW.md](../WORKFLOW.md)）：`develop` 要求 `CI gate`，`main` 另要求 `Full CI gate`；必须先把工作流部署到目标分支再启用对应检查名（普通层永不产生 `Full CI gate` 检查名，避免 skipped-as-success 语义放行）。

## 后果

正面（口径：GitHub-hosted runner，run 创建至终态含排队）：

- PR #261 自报：普通热缓存 CI 4 分 03 秒（首次冷 Rust 缓存 5 分 15 秒）；全量 12 分 09 秒；最终 HEAD 普通 4 分 16 秒、全量 11 分 33 秒、并发元数据刷新 12 秒且昂贵 job 全部跳过（2026-10-17）。
- 3.1.0 发布实战（2026-10-18，与 3.0.0 对比）：发布 PR 全量门禁 26 分 48 秒降至 10 分 37 秒（-60.4%；口径警告：3.1.0 的 Linux x64 与 macOS Intel Rust 缓存命中而 3.0.0 关键 macOS Intel 缓存未命中，且新增 SQLite 覆盖面，非同提交受控 A/B，不能全归因于本决策）；PR 描述更新后的元数据门禁复用仅 0 分 18 秒；回灌 PR #267 按新规则只跑普通 CI 6 分 48 秒（3.0.0 回灌为 21 分 24 秒）；正式 tag 到 CD 完成 63 分 38 秒降至 45 分 03 秒（-29.2%，外部 registry 延迟影响未排除）。

负面与代价：

- 3.1.0 后 `main` 分支的普通 CI 回退 +58.4%（6 分 01 秒升至 9 分 32 秒），原因是同窗口新增 package_data 验证、SQLite 第二套 384 例差分与独立 MSRV job；约 5 分钟的热缓存目标在该次 main 运行未达成，当时记录为待后续关注，后续是否收回该目标无记录。

遗留事项与材料缺口：

- 无备选方案的成本-风险对比记录（见“备选方案”节标注）；分层常数（普通层 15 分钟超时、门禁等待 85/20 分钟、15 秒轮询、证明搜索限最近 100 个 run、产物保留 14 天）均无记录在案的选择理由。
- 实现分支名中的 v3.0.1 最终未单独发布，变更随 3.1.0 线生效，跳号原因无记录。
- 分支保护落地状态：PR #261 的部署计划是“工作流部署到目标分支后再启用必需检查”。2026-10-23 经授权 API 核实已完成落地：ruleset `main-protect`（`main`：禁删除、禁强推、要求 PR、必需检查 `CI gate` 与 `Full CI gate`）与 `develop-protect`（`develop`：禁删除、禁强推、必需检查 `CI gate`；不要求 PR，保留直推通道）均为 active，双分支绕过名单为 RepositoryRole Triage 与 Admin 的 always（仓库唯一人类维护者即 Admin，热修直推不受阻），未启用 strict 模式（不要求分支与 base 保持最新）；双分支 ruleset 配置快照导出至 [tools/ci/rulesets/](../../../tools/ci/rulesets/)，迁移或丢失时可导入恢复。检查名可生产性同步核实：`CI gate` 在普通与全量层均产出，`Full CI gate` 仅全量层（base 为 `main` 或带 `ci:full` 标签）产出且 PR #261 head 有 success 记录；普通层被跳过的 full-gate job 上报名为未求值的表达式原文，不构成 `Full CI gate` 检查名。

公开记录：[.github/workflows/ci.yml](../../../.github/workflows/ci.yml)、[.github/workflows/native-platforms.yml](../../../.github/workflows/native-platforms.yml)、[tools/ci/policy.mjs](../../../tools/ci/policy.mjs)、[tools/ci/wait-for-result.mjs](../../../tools/ci/wait-for-result.mjs)、[WORKFLOW.md](../WORKFLOW.md)、[scripts/check-runtime.sh](../../../scripts/check-runtime.sh)、[Issue #238](https://github.com/3aKHP/prts-mcp/issues/238)、PR [#259](https://github.com/3aKHP/prts-mcp/pull/259)/[#260](https://github.com/3aKHP/prts-mcp/pull/260)/[#261](https://github.com/3aKHP/prts-mcp/pull/261)/[#265](https://github.com/3aKHP/prts-mcp/pull/265)/[#267](https://github.com/3aKHP/prts-mcp/pull/267)。
