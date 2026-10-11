# 执行进度

最后更新：2026-10-11（P1 完成）。

| 阶段 | 状态 | 报告 | 下一步 |
|---|---|---|---|
| P0 | complete (tag local/p0-complete) | [reports/P0.md](reports/P0.md)、[reports/P0-audit.md](reports/P0-audit.md) | — |
| P1 | complete (tag local/p1-complete) | [reports/P1.md](reports/P1.md) | — |
| P2 | not-started | — | 存储、同步、恢复与共享卷 |
| P3 | not-started | — | 完整12个GameData工具 |
| P4 | not-started | — | 完整9个Story工具 |
| P5 | not-started | — | 完整2个Wiki工具 |
| P6 | not-started | — | 图片工具与完整图片同步 |
| P7 | not-started | — | 配置、诊断、部署和本地分发 |
| P8 | not-started | — | 最终全范围验收与转正评估 |

## P1 交付摘要（2026-10-11）

- **选型落定**：rmcp 3.5.1 经 `examples/rmcp_probe.rs` 实证无法复现 oracle wire 指纹（SSE priming/帧、未知会话体、discover 版本集、modern JSON 格式）→ 薄 JSON-RPC 适配（`src/protocol`），rmcp 留 dev-deps 保证据可复现。
- **协议层**：HTTP（SSE 帧、202/404/405/406/415、会话 idle 剩余预算重排、失效 initialize 恢复、legacy 通道会话固定 vs modern 逐请求）+ stdio（时代规则、stdout 纯净、EOF 退 0）。
- **第一条完整链**：真实 `list_stages`（DirectoryStore 读取、UTF-16 排序、Zod 等价校验含 JS 数字语义与多字段错误、oracle 逐字 schema、三通道包装）。
- **语言探针**：QuickJS 正则适配器 49 例语料与 Bun 零差异；UTF-16 排序/切片、浮点整数语义差分；J1 孤立代理对边界实证并登记维护者决策项。
- **验证**：差分 31/31（四格×三通道+会话生命周期+空数据启动）；进程测试（无监听、双会话通道隔离）；fmt/clippy(-D)/test(28)/release 全过；Node 辅助对照 2 案例；性能基线入 `artifacts/p1-bench.json`。
- 工具数 1（阶段契约）；24 工具面 tools/list 差分以 `diff_phase=P8` 推迟（07 明示允许）。
- **维护者 2026-10-11 批准差异**：D-005-input-surrogate-rejection（拒孤立代理码元+明确解析错误）、D-006-unparseable-body-json-error（400+JSON-RPC 解析错误替代 HTML 页）——已登记 baseline.json 并配回归测试；有效代理对/正常 Unicode 由 `stage.list.chapter-astral-pair` 差分与截断单测守护。

## 交接入口

- 分支 `rust-local`；HEAD 见 `git log -1`（tag local/p1-complete）；工作树干净。
- 阶段 bundle：`artifacts/p0.bundle`、`artifacts/p1.bundle`（hash 以最终文件为准，因 bundle 含其自身说明提交而自我递归，此处不内嵌 hash；请维护者另存备份并自行记录）。
- 差分重跑：`node tools/verify.mjs --phase P1`（Rust 需 `cargo build --locked --release`）；oracle 重建见 P0 报告。
- P2 首个任务：DirectoryStore/ZipStore/FallbackStore 完整化 + `.gamedata_pair.json` 双指针接入（config.rs 已留 `activated_root` 单指针接入点）+ Release 状态机。
