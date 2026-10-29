# ADR-0006：同步校验链去重与 SHA-256 后端切换至 ring

- 状态：Accepted
- 决策日期：2026-10-20（选型结论形成于 2026-10-19）
- 关联：[PR #272](https://github.com/3aKHP/prts-mcp/pull/272)（提交 `8b7429d`，经 merge commit `7402beb` 合入）、[Issue #266](https://github.com/3aKHP/prts-mcp/issues/266)、[CHANGELOG 3.1.1](../../../CHANGELOG.zh-CN.md)、[ADR-0001](ADR-0001-sqlite-data-backend.md)、[ADR-0005](ADR-0005-sqlite-validation-modes.md)

> 本文整理自决策期间（2026-10-19 至 2026-10-20）的内部工作记录（防御性验证审计的 A1/A3 发现与摘要后端选型研究）。

## 背景与问题

3.1.0 的 SQLite 后端在同步链路上明显落后于 JSON 基线（[Issue #266](https://github.com/3aKHP/prts-mcp/issues/266)：受控首次同步 9.55 s 对 JSON 3.0.0 的 2.85 s，已有数据启动复核 4.45 s 对 0.30 s；口径：Linux x64、2 vCPU/约 3.7 GiB、同一 AKDP 数据、四轮交替 A/B、共 4,328 次调用、保留 OS 页缓存、固定本地镜像）。Issue 正文已公开指出一处重复：解压时已计算 SHA-256，随后 `database_io::verify` 再计算一次。

2026-10-19 的防御性验证审计把该问题落实为两条发现：

- **A1（解压流摘要重复）**：解压在写入时流式计算原始数据库的 SHA-256 并与 manifest 比对；随后激活前的 `verify` 又读回整文件重算同一摘要。在当时唯一调用链下，解压流摘要对最终是否接纳这份文件没有独立贡献。审计同时明确警告：不得两次都删，激活前的落盘读回校验必须保留。
- **A3（无人消费的图片摘要）**：transport 层对每次下载都计算 SHA-256，但图片索引、分片与 delta 三处下载均丢弃该统计；这些摘要未参与任何接纳、拒绝或日志判断。图片真正的屏障是激活前逐图片与索引的内容比对。

并行的摘要后端选型研究针对大体积下载（gzip 响应体约 111.5 MB）与 303 MB 数据库读回摘要的 CPU 成本比较了候选实现。

## 备选方案

摘要后端选型（同构建六轮交替 A/B；Linux x86_64 容器、1 CPU/512 MiB、无 SHA 指令扩展、固定数据与本地回环镜像、保留 OS 页缓存、无插桩生产构建）：

- **维持 sha2 0.10（基线）**：否决。无 SHA 指令环境下整库摘要中位 2,916 ms（范围 1,774–4,134 ms，n=6），占显著 CPU。
- **升级 sha2 0.11**：否决。完整迁移构建与现有 API 冲突失败（保留失败记录）；独立探针实测收益微小（整库摘要配对比值约 0.958，压缩流约 0.975）。
- **sha-asm（汇编加速依赖）**：否决。当时记录原文：“dependency explicitly rejects Windows”——与五平台分发承诺冲突；仅作构建期探索，未形成性能主张。
- **ring 0.17.14**：采纳。已随 TLS 栈（rustls 的 `ring` feature）链接进二进制，只新增根直接依赖、不新增本仓库 unsafe 代码；实测整库摘要中位 1,382 ms，对基线配对比值 0.588，压缩流比值 0.492。

去重两项（A1/A3）：

- **删除解压流摘要**：采纳。前提是保留激活前读回校验、长度上限与解码/写入错误检查。
- **图片下载不再请求摘要**：采纳。摘要无消费者；数据 ZIP 与 SQLite 对受信 manifest 摘要的比较、激活前逐图片比对全部保留。

材料缺口（如实标注）：未留下 OpenSSL、系统哈希工具或自实现 SHA-256 等方案的任何考察记录，不能写成“曾评估并否决”；研究阶段的保留清单仍含解压流摘要，从“保留”到“删除”的转折发生在审计建议与最终交付之间，无单独书面裁决；后端切换与两项去重合并为一个 PR 的打包理由亦无当时记录（同属摘要成本主题且各自很小，属事后推断）。

## 决定

以 PR #272（提交 `8b7429d`）落地：

- 新增 [src/storage/digest.rs](../../../src/storage/digest.rs)：封装 `ring::digest::Context`，`finish()` 手工小写 hex 编码，与资产契约逐字节一致；`hash_file` 以 64 KiB 有界缓冲整文件散列；内嵌 NIST 标准向量与跨分块边界（1/63/64/65/65535/65536/65537 字节）对 sha2 独立实现的交叉比对单测。
- `Cargo.toml` 新增直接依赖 `ring = "0.17"`（锁定 0.17.14）；`sha2` 保留为直接依赖——图片变体激活前内容校验仍在使用（按：PR 评审中“sha2 降为 dev-only”的说法与锁文件及源码不符，本文以二者为准）。
- [src/sync/transport.rs](../../../src/sync/transport.rs) 内部收敛为统一的 `stream_file`，长度上限在写入时逐块实时检查；新增不返回容器摘要的 `download_file` 供图片路径使用。
- [src/sync/database_io.rs](../../../src/sync/database_io.rs)：解压路径删除流式 SHA-256 计算，仅校验实际长度（可观察行为细节：错误文案由 `decoded SQLite length/SHA-256 mismatch` 变为 `decoded SQLite length mismatch`）；`verify` 保留 manifest 摘要的落盘读回比对、元数据、完整性与外键检查。
- [src/sync/images_sync.rs](../../../src/sync/images_sync.rs)：图片索引、基线分片、delta 三处下载改用 `download_file`；激活前逐图片 SHA-256 比对保持原样。

## 后果

正面（口径同上节实验；仅替换摘要后端，未隔离两项去重的独立收益）：空卷首次同步中位 9.491 s 降至 7.692 s（配对比值 0.808）；已有数据重启复核 4.180 s 降至 2.850 s（比值 0.663）。更早一轮四轮插桩实验未达“首次同步改善 ≥15%”的预定目标，被作为失败记录保留；最终实验改用无插桩生产构建后方得出上述结论。

负面与代价：两项去重的独立收益从未单独测量，无法归因各自贡献；Windows/macOS 原生性能与真实公网同步未验证（以同步损坏、回退、并发与冻结契约的定向验证代替）。

验证：PR 自述 `./scripts/check-runtime.sh --full` 通过（294 个 Rust 测试、JSON/SQLite 各 384 项冻结差分、进程生命周期、3,276 项扩展正则）；[tests/database_sync.rs](../../../tests/database_sync.rs) 覆盖损坏传输不替换 active 指针、同长度且恢复 mtime 的改写被拒绝。

公开记录：[CHANGELOG 3.1.1](../../../CHANGELOG.zh-CN.md)（“同步摘要”与“SQLite 校验”条目）、[src/storage/digest.rs](../../../src/storage/digest.rs)、[src/sync/transport.rs](../../../src/sync/transport.rs)、[src/sync/database_io.rs](../../../src/sync/database_io.rs)、[src/sync/images_sync.rs](../../../src/sync/images_sync.rs)、[tests/database_sync.rs](../../../tests/database_sync.rs)、[PR #272](https://github.com/3aKHP/prts-mcp/pull/272)、[Issue #266](https://github.com/3aKHP/prts-mcp/issues/266)。
