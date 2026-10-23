# ADR-0010：LTS 双维护线（`lts/1.7` 与 `lts/2.8`）的设立与支持参数

- 状态：Accepted（补录）
- 决策日期：2026-07-02（1.7 线随 1.7.0 设立；EOL 窗口于 2026-08-22 书面化）、2026-10-13（2.8 线设立）
- 关联：[LTS.md](../LTS.md)、[SECURITY.md](../../../SECURITY.md)、[ADR-0002](ADR-0002-lts-akdp-projection.md)、[ADR-0004](ADR-0004-emudhra-trust-roots.md)、[CHANGELOG](../../../CHANGELOG.zh-CN.md)

> 补录说明：本决策的两次设立均早于 ADR 目录建立，机制至今现役且档案库无逐条记录，按本目录的补录例外整理自决策期间（1.7 线 2026-07-02 至 2026-08-22；2.8 线 2026-10-13）的内部工作记录与公开 git 历史。现行规则以 [LTS.md](../LTS.md) 为准，本文记录决策日的参数与理由，不随政策后续修订更新。

## 背景与问题

2.0 对 1.x 构成破坏性升级（工具面合并与输出通道体系重建）。1.7 线设立时的政策原文写明目的（tag `python/v1.7.0` 中的旧版 LTS 政策）：“PRTS-MCP 1.7.0 is the final 1.x feature release and the baseline for the `lts/1.7` maintenance line. The purpose of the LTS line is to keep existing 1.x users stable while new feature and breaking-change work moves to 2.0.”

3.0 切换为 Rust 单实现时，2.8 面临两类记录在案的风险：

- **发布渠道冲突**：旧 CD 按 tag 触发且与 `main` 共用稳定渠道，2.8 维护版若沿用旧 workflow，会覆盖 npm `latest`、Docker `:latest` 与 GitHub Latest。
- **历史教训**：1.7 的渠道隔离是发布后补做的（2026-07-11 的 PR #77）；当时的评估据此明确要求“本次应在维护线建立时就处理”。

另有 EOL 后误发布的风险，需要日期硬门禁。1.7 线的数据断供风险由 [ADR-0002](ADR-0002-lts-akdp-projection.md)（AKDP 投影仓）单独裁决，不在本文范围。

## 备选方案

以下裁决除标注外均有当时书面记录：

- **2.8 的 EOL 从 3.0 发布起算 6 或 12 个月**：被“与 1.7 同日到期”替代；被替代建议的原始文本与替代理由均无书面记录。**EOL 共锚的理由在全部书面材料中均缺失；维护者于本文成文时（2026-10-23）口述确认为单人维护的心智负担——两条线共用一个日期，只需维护一套门禁参数与一份对齐的政策文本。此条属事后口述，非当时记录。** 共锚的结构性收益（单一日期、一套门禁脚本参数、两份政策文本对齐）可从实现反推，同属事后解释。
- **Python 实现拆为独立维护仓**：否决（“暂不拆仓”）。当时记录要求明确唯一维护归属、避免双重发布责任，且代码迁出与 GitHub Archive 应分开处理。
- **2.8 LTS 同步新产品功能**：否决。仅接兼容性、安全性、数据同步、关键缺陷与对应文档修复，不接受新能力。
- **维护线沿用主线发布流程、更新 latest 系标签**：否决。LTS 不更新 npm `latest`、Docker `:latest` 或 GitHub Latest，“不能只复制主线发布流程”。
- **旧分支整体合并进 Rust `develop`**：禁止（会把已移除的 `python/`、`ts/` 带回主线）；修复按适用性单独移植或在 Rust 重做。
- **为建立渠道而虚构 2.8.2 或重发 2.8.1**：否决。`lts-2.8` 与 `:2` 渠道留待首次真实 LTS 发布时建立。
- **2.8 线设立（M1A）走正常 PR 流程**：本次例外。维护者单次明确授权直接推送 `lts/2.8`（无 Bot Review、不记为评审通过），授权范围明确不改变后续 PR 规则。

## 决定

**模式**：每次主线换代时，把上一主线的 Python/TypeScript 双实现冻结为同仓 `lts/<minor>` 维护分支，从该版本线的发布提交切出（1.7 线从 1.7.0 发布提交、2.8 线从 2.8.1 发布提交）。

**维护范围**（两线同类别）：接受上游数据 schema/客户端行为/打包元数据的兼容修复、安全修复（依赖 CVE、解析与传输加固）、数据同步修复、关键缺陷修复（错误结果、崩溃、资源泄漏、双实现 parity 回归）与部署/政策/迁移文档修正；拒绝新工具、新数据域、新必填参数、默认输出格式变更、工具面合并与架构重写。

**EOL 参数**：

- 两线统一 EOL **2027-07-02**，即 1.7.0 基线（2026-07-02）起 12 个月；2.8 线政策明文 “The 2.8 line does not receive a new 12-month term when Rust 3.0 is released”。
- 1.7 线的窗口是设立 52 天后才书面化的维护者裁决（commit `582a911` 自述 “No EOL policy existed anywhere in the repo. Record the maintainer decision: 12 months from the 1.7.0 baseline”，经 PR #184 合入 `lts/1.7`、PR #185 同步开发线）。
- EOL 后：不再发版；分支、`python/v*`/`ts/v*` tag 与已发布产物只读保留；1.7 的两个投影 fork 在 EOL 前不得 archive，EOL 后停止投影（见 [ADR-0002](ADR-0002-lts-akdp-projection.md)）。

**发布通道隔离**（`lts/2.8` 于建立之日生效，commits `87234e4`、`9c84e3e`）：

- npm `prts-mcp-ts` 以 `--tag lts-2.8` 发布（已发布版本幂等跳过并做字节核验）；GHCR 推 `:2.8.x` 精确版本与 `:2`，不动 `:latest`/`:3`；两个 GitHub Release 均 `make_latest: false`；PyPI 正常发布 2.8.x（3.x 不发 PyPI）。
- 写入前门禁（`verify-lts-release.sh`，仅存在于 `lts/2.8` 分支）：拒绝预发布 tag、其他版本线 tag、非法前缀、tag 与包版本不一致、tag 提交不属于 `origin/lts/2.8`、EOL 后（UTC 日期晚于 2027-07-02）发布；五个写入 job 在写入边界重跑门禁，防止延迟审批或失败重跑复用旧结论。行为测试 17/17（内部验收口径）。
- 对照：`lts/1.7` 无独立门禁脚本与 EOL 日期门禁，渠道隔离内联于 workflow（PR #77：`lts-1.7` dist-tag、`make_latest: false`、拒绝预发布 tag）。

## 后果

正面：

- 渠道隔离的公开可核验证据：npm dist-tag（2026-10-23 实测 registry）`lts-2.8=2.8.2`、`lts-1.7=1.7.3`，与 `latest=3.1.2` 互不干扰；`lts-2.8` 渠道留待首次真实发布才建立（2.8.2，2026-10-22），符合“不虚构发布”的裁决。
- 机制运转实证：eMudhra 事件（[ADR-0004](ADR-0004-emudhra-trust-roots.md)）一天内四条分支线全部完成修复发布，LTS 两线经完整 fix PR → release PR → 成对 tag → 维护渠道流程各发 1.7.3 与 2.8.2（2026-10-22）。
- 成对 tag 纪律保持至今：`python/v1.7.0–1.7.3`、`ts/v1.7.0–1.7.3`、`python/v2.8.0–2.8.2`、`ts/v2.8.0–2.8.2` 全部成对存在。

负面与代价：

- 两条双实现线的维护负担延续至 EOL——这正是 EOL 共锚决策的对价。
- `lts/1.7` 缺 EOL 日期硬门禁（仅 `lts/2.8` 有），EOL 后防误发布依赖流程自律。

遗留事项与材料缺口：

- EOL 共锚理由无书面记录（见“备选方案”节的口述标注）；6/12 个月建议的原始文本未保存。
- M1A 无 PR、无 Bot Review（单次授权直推），公开评审记录缺失，仅有 commit 与 CI run 记录。
- GHCR `:2` 标签当前状态未经认证接口核验（npm 侧已实测）。

公开记录：[LTS.md](../LTS.md)、[SECURITY.md](../../../SECURITY.md)、[CHANGELOG](../../../CHANGELOG.zh-CN.md)（1.7.0/1.7.1/1.7.2 条目；1.7.3 与 2.8.2 条目在两条 LTS 分支各自的 CHANGELOG 中）、PR [#25](https://github.com/3aKHP/prts-mcp/pull/25)/[#77](https://github.com/3aKHP/prts-mcp/pull/77)/[#184](https://github.com/3aKHP/prts-mcp/pull/184)/[#185](https://github.com/3aKHP/prts-mcp/pull/185)、commits `582a911`/`87234e4`/`9c84e3e`、npm dist-tag `lts-2.8` 与 `lts-1.7`。
