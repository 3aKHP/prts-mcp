# 架构决策记录（ADR）

本目录自 3.1 起逐条记录 PRTS-MCP 的架构决策：每条决策一个文件，带编号与状态，在决策当时写成。

## 与 docs/archive/ 的分工

- 本目录（ADR）：逐决策粒度的当时记录，自 3.1 起。文件正文一经合入不再修改，仅状态字段与笔误可更正。
- [docs/archive/](../../archive/README.md)：按版本里程碑组织的事后复盘档案，覆盖 1.0 至 3.0 的决策脉络，可引用本目录的 ADR。3.1 前的决策历史原则上以档案库为准，不回填为 ADR；例外是决策后果延续至 3.1 之后且档案库尚无逐条记录的，可补录为 ADR，但须在头部标注“补录”并说明素材来源。

## 何时需要 ADR

决策影响以下任一方面时，应在同一 PR 中附带 ADR：

- `contracts/` 契约、工具公开行为或 wire 兼容语义；
- 数据存储、同步语义或数据目录布局；
- 分发渠道、包布局与发布流程；
- 安全姿态（信任根、校验、权限边界）；
- 仓库治理与评审发布机制（分支模型、评审机制、发布门禁）；
- 否决了值得记录的备选方案（防止未来重复提案与重复论证）。

拿不准是否需要时，在 PR 讨论中提出即可。

## 编号与文件

- 文件名：`ADR-NNNN-<英文小写连字符摘要>.md`，编号四位、顺序递增、永不复用。
- 新 ADR 合入前，须登记到本文件末尾的决策索引表。
- 文档语言为中文单语，文风与格式遵循 [DOCUMENTING.md](../DOCUMENTING.md)。

## 状态生命周期

- `Proposed`：提议中，可随 PR 先行提交评审。
- `Accepted`：决策生效。
- `Deferred`：决策已作出但实施搁置（决策与实现周期天然不同步的情形）；恢复实施时改回 `Accepted` 并注明恢复日期与原搁置理由。
- `Rejected`：提议被否决，保留记录并说明理由。
- `Deprecated`：决策不再适用，但无直接替代。
- `Superseded by ADR-XXXX`：被新决策替代；新 ADR 应在头部标注 `Supersedes ADR-XXXX`。

## 撰写纪律

- 区分当时有记录的裁决与事后根据实现作出的解释；材料缺口如实标注，不从现有实现反推伪造历史裁决。
- 内部工作记录（`dev/docs/` 等被 `.gitignore` 忽略的目录）仅作素材，须脱敏蒸馏后成文，公开文档一律不链接内部路径。
- 公开证据优先引用仓库内可跟踪文件、版本 tag、PR 与 Issue；测量数据注明口径与获取时间。

## 模板

新 ADR 复制以下骨架：

```markdown
# ADR-NNNN：<决策标题>

- 状态：Proposed
- 决策日期：YYYY-MM-DD
- 关联：<Issue / PR / 契约文件，可选>

## 背景与问题

<促使做出决策的事实、约束与触发事件。>

## 备选方案

<每个候选方案的内容，以及被采纳或被否决的理由；否决理由须有据可查。>

## 决定

<最终决策内容，直接陈述；分阶段决策写明各阶段口径。>

## 后果

<正面与负面后果、验证结果与遗留事项；可按需增设小节（如“验证与证据”）。>
```

## 决策索引

| 编号 | 决策 | 状态 | 决策日期 |
| --- | --- | --- | --- |
| [ADR-0001](ADR-0001-sqlite-data-backend.md) | 3.1 引入实验性 SQLite 数据后端 | Accepted | 2026-10-18 |
| [ADR-0002](ADR-0002-lts-akdp-projection.md) | lts/1.7 数据源的 AKDP 兼容投影仓 | Accepted（补录） | 2026-08-05 |
| [ADR-0003](ADR-0003-management-cli-scope.md) | 3.x 管理 CLI 的范围与时序裁决 | Accepted（补录） | 2026-10-13 |
| [ADR-0004](ADR-0004-emudhra-trust-roots.md) | eMudhra 信任根事件的 3.1.2 安全响应与 LTS 处置 | Accepted | 2026-10-22 |
| [ADR-0005](ADR-0005-sqlite-validation-modes.md) | SQLite 接纳验证的双模式（`PRTS_VALIDATION_MODE`） | Accepted | 2026-10-20 |
| [ADR-0006](ADR-0006-sync-checksum-dedup-ring.md) | 同步校验链去重与 SHA-256 后端切换至 ring | Accepted | 2026-10-20 |
| [ADR-0007](ADR-0007-sqlite-query-performance-strategy.md) | 3.1.x SQLite 查询性能优化策略 | Accepted | 2026-10-20 |
| [ADR-0008](ADR-0008-tiered-ci-metadata-gates.md) | 分层 CI 与 PR 元数据门禁 | Accepted（补录） | 2026-10-17 |
| [ADR-0009](ADR-0009-search-quality-redirect-filtering.md) | 2.0.2 `search_prts` 搜索质量裁决 | Accepted（补录） | 2026-07-06 |
| [ADR-0010](ADR-0010-lts-dual-maintenance-lines.md) | LTS 双维护线的设立与支持参数 | Accepted（补录） | 2026-07-02 / 2026-10-13 |
| [ADR-0011](ADR-0011-npm-oidc-trusted-publishing.md) | npm 渠道的 OIDC Trusted Publishing、Node 启动桥与免常设探测门禁 | Accepted（补录） | 2026-10-13 |
| [ADR-0012](ADR-0012-rc-known-issue-discretion.md) | RC 阶段已知问题的分级裁量 | Accepted（补录） | 2026-10-15 |
| [ADR-0013](ADR-0013-docs-system-rebuild.md) | 3.0 文档体系重建与 DOCUMENTING.md 的诞生 | Accepted（补录） | 2026-10-15 |
| [ADR-0014](ADR-0014-branch-model-and-merge-back.md) | 长期分支模型与回灌规则 | Accepted（补录） | 多点（2026-07-02 起） |
| [ADR-0015](ADR-0015-dual-track-review.md) | 双轨评审的引入 | Accepted（补录） | 2026-07-10 |
| [ADR-0016](ADR-0016-self-hosted-object-storage-data-source.md) | 自建对象存储数据源（R2+COS）的选型与实施搁置 | Deferred（补录） | 2026-09-16 |
