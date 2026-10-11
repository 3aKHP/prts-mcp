# 执行进度

最后更新：2026-10-11（P0 完成，P1 进行中）。

| 阶段 | 状态 | 报告 | 下一步 |
|---|---|---|---|
| P0 | complete (tag local/p0-complete) | [reports/P0.md](reports/P0.md)、[reports/P0-audit.md](reports/P0-audit.md) | — |
| P1 | in-progress | — | rmcp 实证评估→协议层、list_stages、session、正则/文本探针 |
| P2 | not-started | — | 存储、同步、恢复与共享卷 |
| P3 | not-started | — | 完整12个GameData工具 |
| P4 | not-started | — | 完整9个Story工具 |
| P5 | not-started | — | 完整2个Wiki工具 |
| P6 | not-started | — | 图片工具与完整图片同步 |
| P7 | not-started | — | 配置、诊断、部署和本地分发 |
| P8 | not-started | — | 最终全范围验收与转正评估 |

## P0 交付摘要（2026-10-11）

- 冻结 oracle：`.reference/ts-v2.8.1`（git archive e0ba360）+ bun frozen 安装 + tsc 构建，锁文件 hash 入 P0 报告。
- 数据固化：`contracts/data-manifest.json`（minimal fixture、bundled 样本、上游 datarev/images release 快照 SHA-256；60MB 资产在 gitignored `.runtime/data/`，可按 pinned tag 重下）。
- wire 快照：`contracts/wire/` 15 流程（四格矩阵、6 版本协商探测、会话生命周期、era 边界、三通道）。
- 差分 runner：`tools/verify.mjs`（P0 自检模式 + golden 模式 + 差分模式骨架）；29 golden 来自冻结 TS；自检 29/29 一致 + 篡改检出。
- Rust 骨架：Cargo 工程（1.96.1 工具链、Cargo.lock 214 包、13 直接依赖 license 清单）；fmt/clippy/test/release 全过；工具数 0。
- 首次源码审计：GAMEDATA_FILES/metadata/锁路径表、42 测试取舍表、R1-R17/S-F-J 风险语料、59 源文件→coverage 映射（reports/P0-audit.md）。

## 交接入口

- 分支 `rust-local`；P0 末提交见 `git log`；无未提交改动（除本文件所属文档提交）。
- oracle 重建命令在 reports/P0.md「命令与结果」；数据重建 `node tools/fetch-data.mjs`、fixture `node tools/make-fixtures.mjs`。
- P1 首个任务：以 contracts/wire 为基准实证 rmcp 3.5.1（初始化能力集、SSE 响应形状、legacy/modern 路由、session 语义）；不匹配则按 10-research 风险表走薄适配并留最小复现证据。
