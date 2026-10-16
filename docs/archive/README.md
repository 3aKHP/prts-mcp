# PRTS-MCP 工程演进与架构档案库（`docs/archive/`）

本目录收录 PRTS-MCP 从 **1.0 双实现定型** 到 **3.0 原生 Rust 统一技术栈** 演进过程中的核心架构决策记录（ADR）、基准测试报告与深度技术复盘。

> **阅读提示**：本目录下的文档均为特定版本里程碑的**历史工程档案**，旨在保留“当时为什么这样设计、权衡了哪些备选方案、实测数据如何”的技术脉络。日常接入、部署运维与开发规范请以现行文档为准：
> - 客户端接入与工具使用：[客户端接入指南](../user/quick-start.md) · [工具工作流指南](../user/tools-guide.md)
> - 服务端部署与存储运维：[服务端部署指南](../admin/deployment.md) · [数据同步与立绘存储管理](../admin/data-and-sync.md)
> - 现行架构与开发规范：[代码规范与架构（STYLE）](../dev/STYLE.md) · [文档总目录](../README.md)

---

## 演进时间轴与档案目录

| 阶段 / 版本 | 归档时间 | 档案文件 | 核心技术主题 |
| --- | --- | --- | --- |
| **1.0 – 1.6** | 2026-05 | [1.0-architecture-and-hardening.md](1.0-architecture-and-hardening.md) | **数据存储抽象定型与运行时非功能性加固**：确立 `DatasetSource → Store → Reader → Domain Parser` 四层模型（`DirectoryStore` / `ZipStore` / `FallbackStore`），并在 1.5 审计中修复 Python `ZipStore` 句柄确定性关闭、TS 缓存 ZIP 回退校验与会话空闲定时器 `.unref()`。 |
| **2.0** | 2026-07 | [2.0-tool-consolidation-and-output-channel.md](2.0-tool-consolidation-and-output-channel.md) | **工具面收敛（32 → 23）与双输出通道设计**：基于“可约风险 vs. 不可约风险”判据压平工具数量增长斜率；否决 `output_format=json` 默认翻转方案，确立正交的连接级 `content` / `structuredContent` 双通道架构。 |
| **2.0.2 – 2.2** | 2026-07 | [2.2-bun-runtime-benchmark.md](2.2-bun-runtime-benchmark.md) | **TypeScript 运行时演进：Node.js → Bun 基准测试**：对比冷安装、Docker 镜像体积、常驻内存与 ZIP 剧情流式读取延迟（`read_story` p50 从 `58.79ms` 降至 `24.39ms`，并披露尾分位与 Tarball 磁盘占用权衡），确立分阶段引入 Bun 的路线。 |
| **2.4 – 2.7** | 2026-07 – 2026-08 | [2.4-background-sync-and-paired-activation.md](2.4-background-sync-and-paired-activation.md) | **常驻后台同步、成对代际激活与共享卷恢复**：梳理从“启动时直接覆盖解压”演进到“暂存 → 校验 → `.gamedata_pair.json` 成对激活”与带心跳续租的跨进程共享卷锁状态机，以及 2.5–2.7 的 Manifest 校验与幂等防抖加固。 |
| **2.5 – 2.7** | 2026-08 | [2.5-operator-artwork-architecture.md](2.5-operator-artwork-architecture.md) | **`operator_artwork` 双后端架构设计**：统一签名下兼容“AKDP 本地分片资产（`LOCAL_IMAGE=true`）”与“PRTS MediaWiki 实时按需拉取 + 256 MiB LRU（`LOCAL_IMAGE=false`）”，记录双路径解耦、安全边界与完整增量链重放演进。 |
| **2.7** | 2026-08 | [2.7-modular-refactoring-and-dataset-access.md](2.7-modular-refactoring-and-dataset-access.md) | **“上帝文件”解耦审计与 `DatasetAccess` 基石抽象**：对 15 个核心模块开展耦合度与双实现 Parity 审计，消除 6 件套重复脚手架，将 `sync/` 从 `data/` 中独立分层（直接奠定 3.0 Rust 模块边界）。 |
| **2.8** | 2026-10 | [2.8-roguelike-story-coverage-study.md](2.8-roguelike-story-coverage-study.md) | **跨仓库剧情覆盖率盘点与肉鸽补充目录设计**：按四套分母口径联合清点 AKDP 生产端与 PRTS-MCP 消费端，定位 `Dialog` / `PopupDialog` 文本丢失、增量缓存跳过与 `versionId` 连字符防降级缺陷，设计向后兼容的 `story_supplement.json`。 |
| **3.0（战略）** | 2026-10 | [3.0-unified-rust-stack-assessment.md](3.0-unified-rust-stack-assessment.md) | **3.0 统一技术栈选型评估：从双实现到原生 Rust**：基于双实现维护成本、多渠道真实分发统计、生产环境内存采样与 Docker/LTS 连续性要求，区分选型时的初始输入与后续验证结果，论证为何收敛至单一原生 Rust 实现。 |
| **3.0（内核）** | 2026-10 | [3.0-rust-parity-and-native-performance.md](3.0-rust-parity-and-native-performance.md) | **3.0 Rust 行为复刻、QuickJS C 正则剥离与原生性能报告**：复盘 `rmcp 3.5.1` 探针与薄协议适配、五种正则方案实测及剥离静态链接 `libregexp.c` + 字节码字面量前缀加速，实现四核冷索引提速 2.72×、热查询全面领先且常驻内存降至 ~123 MiB。 |
