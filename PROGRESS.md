# 执行进度

最后更新：2026-10-11（P2 完成）。

| 阶段 | 状态 | 报告 | 下一步 |
|---|---|---|---|
| P0 | complete (tag local/p0-complete) | [reports/P0.md](reports/P0.md)、[reports/P0-audit.md](reports/P0-audit.md) | — |
| P1 | complete (tag local/p1-complete) | [reports/P1.md](reports/P1.md) | — |
| P2 | complete (tag local/p2-complete) | [reports/P2.md](reports/P2.md) | — |
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

## P2 交付摘要（2026-10-11）

- **存储**：Directory/Zip/Fallback 三存储完整读路径（primary 坏 JSON 不静默回退、不安全路径报错传播）+ 代际指针读取器（activatedRoot/activatedPair，realpath 逃逸拒绝）。
- **Release 状态机**：fresh 跳过、离线/no_data 分支、盲下载（仅镜像+无记录版本）、防降级（tuple 比较、记录版本阻止替换、重复身份 fail-closed）、manifest 全错误族校验；`data-release-selection` 9 例共享发布语料通过。
- **锁**：目录 owner 租约协议（心跳 utimes、陈旧隔离、释放前 owner 校验）与 `.gamedata-pair → activation → release` 层级；跨进程（Rust↔真实 TS dist）双向争用验证。
- **成对代际**：双幂等守卫（#152 activationSha 短路、#155 pair 无变化不重写——inode/mtime 级断言）；混合代不发布；Story 原子换包。
- **架构**：TS `config↔activation` 循环按计划消解——RuntimeConfig 静态 + DataState 签名缓存快照，单次工具调用单代一致，缺数据→后台激活→不重启可读（输出与 TS golden 逐字节一致）。
- **调度**：single-flight、30/120/600s 密集重试（仅启动轮）、周期不重叠、interval=0 仅启动；stdio EOF 在重试已武装时 <10s 退 0。
- **互操作**：TS 写↔Rust 读 / Rust 写↔TS 读 / 元数据字节一致 / 锁争用 5 案例全过；差分案例 `stage.list.pair-activated`（TS 同步代码写入的 fixture 卷）33/33。
- **峰值**：3 轮实测（artifacts/p2-bench.json）：Rust 冷同步峰值 RSS ~23MB（流式，不随 60.6MB 包体增长）vs TS ~321MB（整包缓冲）；无变化周期 454ms。
- **门禁**：fmt/clippy(-D)/112 测试/release 全过；P0 自检 29/29、P1 32/32、P2 33/33 差分。
- 工具数 1（阶段契约）。图片完整链（baseline/delta/.images.lock）按计划留 P6；bundle 回退与入口 profiles 留 P7。

## 交接入口

- 分支 `rust-local`；HEAD 见 `git log -1`（tag local/p2-complete）；工作树干净。
- 阶段 bundle：`artifacts/p0.bundle`、`artifacts/p1.bundle`（hash 以最终文件为准，因 bundle 含其自身说明提交而自我递归，此处不内嵌 hash；请维护者另存备份并自行记录）。
- 差分重跑：`node tools/verify.mjs --phase P2`（Rust 需 `cargo build --locked --release`）；oracle 重建见 P0 报告；峰值 `node tools/bench-p2.mjs`。
- P3 首个任务：operator 身份/档案/台词/basic 工具（docs/07 P3 顺序），复用 P2 的 DataView 快照与存储层；`LocaleCompare`（stageEnemy）与排序碰撞案例按 docs/02 在 P3 验证。
