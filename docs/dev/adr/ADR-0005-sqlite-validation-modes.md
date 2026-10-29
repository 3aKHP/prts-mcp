# ADR-0005：SQLite 接纳验证的双模式（`PRTS_VALIDATION_MODE`）

- 状态：Accepted
- 决策日期：2026-10-20（设计裁定完成于 2026-10-19）
- 关联：[PR #273](https://github.com/3aKHP/prts-mcp/pull/273)、[Issue #266](https://github.com/3aKHP/prts-mcp/issues/266)、[CHANGELOG 3.1.1](../../../CHANGELOG.zh-CN.md)、[ADR-0001](ADR-0001-sqlite-data-backend.md)、[ADR-0006](ADR-0006-sync-checksum-dedup-ring.md)

> 本文整理自决策期间（2026-10-19 至 2026-10-20）的内部工作记录（防御性验证审计与验证模式设计文档）。文中测量数字的实验口径在“后果”节注明。

## 背景与问题

3.1 引入实验性 SQLite 数据后端（[ADR-0001](ADR-0001-sqlite-data-backend.md)）后，维护者对 3.x 数据链路做了一次防御性验证审计（2026-10-19），逐项回答“输入来自哪里、阻止哪种故障、前面已有何种证明、证明何时失效、实际成本在哪”。

审计发现（编号 A4）：验证结论只在进程内复用。正常重启时，对已完成可信验收、摘要一致、验证契约未变化的同一受管理数据库，每个新进程仍重复完整结构与外键扫描。历史诊断口径（Issue #266 旧基线的单机分解，非本轮受控实验）：一次重启约 3.492 s，其中整文件摘要约 1.868 s、完整结构检查约 1.590 s。

审计同时确认了必须保留的屏障清单（两种模式均不得削弱）：下载超时与 manifest 摘要比对、解压长度边界、兼容性与元数据检查、只读连接、原子发布、跨进程锁、代际一致性、路径约束等；运行时变量不得影响 CI/CD 验证。设计目标原文：“减少重复证明同一性质的工作，使通常模式的代价与本项目‘可重新下载的只读数据快照’的定位相匹配”。故障模型覆盖错误下载、解压/写入失败、断电残留、本地误改、版本冲突与共享卷并发更新；明确不宣称本地记录能对抗同权限进程的并发改写。

## 备选方案

以下裁决均见于当时的审计与设计文档：

- **`off` 模式与“遇错自动降级为通常模式”**：否决。验证强度只能由部署方显式选择，不允许静默消失。
- **模块级布尔开关、多个各自解释的严格开关、请求级覆盖与运行中切换**：否决。深层函数不反复读环境变量；所有原生、npm、Docker 入口共用同一启动期字段。
- **扩展 active/previous 指针格式承载验证状态，或用 lease 文件承载记录**：否决。指针保持 v1 格式且不含验证规则版本；记录独立为可丢弃的旁路文件。
- **按产品版本号或时间戳使记录失效**：否决。避免每个小修订强制重扫；改用“验证契约标识 + SQLite 库版本 + 整文件 SHA-256 + 体积”四元组判定复用资格。
- **签名凭据、独立记录数据库、周期审计服务**：不建设。记录只是可重建缓存，不是认证设施。
- **通用验证规则框架、插件式验证器、多级用户配置**：暂缓。
- **以 `quick_check` 替代完整结构检查**：否决。两者约束覆盖不同（依据 sqlite.org 的 pragma 官方文档），完整检查时也不先额外做 `quick_check`。
- **本阶段取消重启时的整文件摘要**：否决，保留 O(N) 整文件摘要；是否进一步取消，需单独裁决损坏发现时机的保证。
- **`strict` 在查询、轮询或退出时重验**：否决。`strict` 只加强新进程接纳时的强度。
- **Windows 上借 `normal` 直接启用元数据复用**：否决。Windows 写句柄未关闭时 last-write 信息可能未更新，进程内复用继续禁用，跨进程复用仍重读全部字节。
- **只给后台同步路径加模式**：否决。同步、首次查询、离线 ZipStore 与剧情路径必须收敛到共享接纳入口；把深检推迟到首个工具调用以美化 `sync_ready` 指标，被作为测量护栏明令禁止。

## 决定

引入单一启动期环境变量 `PRTS_VALIDATION_MODE=normal|strict`（默认 `normal`），在 `RuntimeConfig` 解析一次并收敛为 `ValidationMode`：

- 未设置或去除空白后为空则取 `normal`；仅接受去除空白后的小写 `normal`/`strict`；其他取值（含 `STRICT`）打印错误并以配置错误退出码 2 拒绝启动（[src/config.rs](../../../src/config.rs)）。
- 新同步产物、来源不明的缓存、记录缺失/失效/验证规则变化：两种模式执行完全相同的完整验收（整文件 SHA-256 + 兼容性/元数据 + 完整结构/外键检查）。
- 已验收的受管理数据库被新进程接纳：`normal` 重算整文件 SHA-256 并比对，旁路记录 `<db>.verified.json`（[src/storage/validation_stamp.rs](../../../src/storage/validation_stamp.rs)，契约标识 `prts-mcp-sqlite-validation/v1`）的四元组匹配则复用结构结论；`strict` 在此基础上重新执行完整结构与外键检查。
- 同一进程内、文件身份与验证上下文未变：复用本进程已完成的结论（绑定文件身份与代际租约；Windows 按上节保守处理）；`normal` 的历史结论不能为 `strict` 通行。
- 自定义 `PRTS_DATA_DB`：兼容性检查加既有 `quick_check`（`strict` 下为完整结构/外键检查），不写验收记录。
- 查询、轮询、退出路径不新增整库验证。
- 记录写入失败不影响已验收数据的使用（只读挂载可用）；记录随受管理数据库一同清理；旧版本程序忽略记录，旧数据卷在首次接纳后逐步建立记录。
- 所有接纳路径收敛到统一入口 [src/storage/admission.rs](../../../src/storage/admission.rs)，按路径串行准入，全局登记锁不包围重 IO；DataView、剧情存储与工具层共用已接纳的同代际句柄。

## 后果

正面：

- 已有有效记录时重启至 ready 的中位数由 3.956 s 降至 1.039 s；空卷首次同步 8.806 s 降至 7.018 s。口径：PR #273 记录的本地受控实验——Linux x64、1 CPU/512 MiB 受限容器、固定同一数据快照与本地镜像、保留 OS 页缓存，四轮 A/B/C/D 均衡共 10,704 次工具调用、输出零差异。注意：相对 3.1 基线的收益包含同系列前置优化（[ADR-0006](ADR-0006-sync-checksum-dedup-ring.md) 等），不能全部归因于验证模式。
- 同步与离线加载收敛到同一接纳入口，语义统一且可测试（[src/storage/admission_tests.rs](../../../src/storage/admission_tests.rs)）。

负面与代价：

- 离线首次响应回归：0.682 s 升至 1.028 s（`normal`）/ 2.520 s（`strict`），因为现在需要验证受管理指针指向文件的 SHA-256。
- 当轮混合 8 并发 P95 出现退化（基线 288 ms、`strict` 348 ms、`normal` 392 ms），保留记录并由后续 PR #274 的过滤优化收口（见 [ADR-0007](ADR-0007-sqlite-query-performance-strategy.md)）。

遗留事项：

- Windows/macOS 性能未验证，Windows 未变化轮询是否继续反复摘要/深检须以原生测试明确；完整重型图片负载与真实客户端 E2E 未验证（均为当时材料自述）。
- 材料缺口（如实标注，不从实现反推伪造历史裁决）：`PRTS_VALIDATION_MODE` 的命名讨论、`normal` 作为默认值的独立裁决、按 Patch（3.1.1）而非 Minor 发布的定级论证、`strict` 的推荐使用场景均无书面记录；默认值与目标场景只能从事后实现与威胁模型推断。`strict` 下仍写验收记录（便于切回 `normal` 时立即复用）亦属事后推断。验证记录格式 v1 向 v2 的演进仅有“实质影响的验收规则变化时升级”的原则性表述。

公开记录：[CHANGELOG 3.1.1](../../../CHANGELOG.zh-CN.md)、[环境变量参考](../../admin/environment-variables.md)、[数据同步与存储管理](../../admin/data-and-sync.md)、[.env.example](../../../.env.example)、[src/config.rs](../../../src/config.rs)、[src/storage/admission.rs](../../../src/storage/admission.rs)、[src/storage/validation_stamp.rs](../../../src/storage/validation_stamp.rs)、[tests/database_sync.rs](../../../tests/database_sync.rs)、[PR #273](https://github.com/3aKHP/prts-mcp/pull/273)、[Issue #266](https://github.com/3aKHP/prts-mcp/issues/266)。
