# ADR-0007：3.1.x SQLite 查询性能优化策略

- 状态：Accepted
- 决策日期：2026-10-20（里程碑序列见下，随 3.1.1 发布生效）
- 关联：[Issue #266](https://github.com/3aKHP/prts-mcp/issues/266)、PR [#268](https://github.com/3aKHP/prts-mcp/pull/268)/[#269](https://github.com/3aKHP/prts-mcp/pull/269)/[#270](https://github.com/3aKHP/prts-mcp/pull/270)/[#272](https://github.com/3aKHP/prts-mcp/pull/272)/[#273](https://github.com/3aKHP/prts-mcp/pull/273)/[#274](https://github.com/3aKHP/prts-mcp/pull/274)、[CHANGELOG 3.1.1](../../../CHANGELOG.zh-CN.md)、[ADR-0001](ADR-0001-sqlite-data-backend.md)、[ADR-0005](ADR-0005-sqlite-validation-modes.md)、[ADR-0006](ADR-0006-sync-checksum-dedup-ring.md)、[COMPARATIVE-EVALUATION.md](../COMPARATIVE-EVALUATION.md)

> 本文整理自决策期间（2026-10-18 至 2026-10-20）的内部工作记录（性能 backlog、预登记实验报告与最终晋升裁决）。测量数字的口径逐处注明；被否实验分支的原始补丁与数据仅存于内部记录，公开可引用的只有 PR 正文表述与概括数字。

里程碑序列（git 时间为 UTC+8）：

- 2026-10-18：3.1.0 发布（PR #265，tag `v3.1.0`），SQLite 后端上线；同日以发布前 A/B 为基线建立 Issue #266 性能 backlog。
- 2026-10-19：PR #268（校验收据去重）、#269（查询路径优化）、#270（贡献者评测工具）合入；剧情过滤方案选型裁决“采用 Final”（内部记录日期）。
- 2026-10-20 05:31：最终晋升裁决（内部记录时间 UTC 2026-10-19T21:31:59Z）；05:33 至 05:53，PR #272、#273、#274 依次合入；06:13 发布 3.1.1（PR #275，tag `v3.1.1`）。

## 背景与问题

3.1.0 基线测量（公开 3.0.0 JSON 后端对 3.1.0 SQLite 候选；同一 AKDP 数据；Linux x64、2 vCPU/约 3.7 GiB；四轮交替 A/B、共 4,328 次调用、保留 OS 页缓存）：SQLite 后端的 RSS（133.14 对 310.33 MiB）与 8 并发吞吐（164.78 对 142.08 calls/s）占优，但暴露四类回退——首次基础查询 699.28 对 138.25 ms、热态无字面量扫描 412.75 对 340.90 ms、首次同步 9.55 对 2.85 s、重启复核 4.45 对 0.30 s；另有 P95 148.64 对 106.53 ms、响应体 106.34 对 58.06 MiB。

瓶颈定位（分段根因测量，1 vCPU/512 MiB 容器口径）：重启接纳中整库摘要占约 99%（admit 中位 1,056.20 ms 中 `hash_file` 占 1,046.18 ms）；长扫描与跨域搜索共享准入与连接（窄活动搜索执行仅约 1.5 ms，扫描许可等待约 155 ms）；剧情元数据反复解压解析；无结果搜索反复搬运剧情 BLOB。

预登记目标：整体 P95 比 ≤0.8、混合吞吐与点查询不退化、校验安全语义不削弱、内存有界。

## 备选方案

以下裁决原文保留在当时的实验结果记录中（候选轮 4 轮 16 试、10,608 次调用；全实验累计 57,618 次调用）：

- **mmap**：否决，保留实验产物。原文：“有吞吐与延迟收益，但进程 RSS/HWM 明显增加，且需要单独处理可修改自定义文件和平台生命周期。”数字：P95 比 0.541（204.89 对 374.96 ms）、吞吐 +45.5%，但 RSS/HWM +74.36 MiB（约 1.62 倍，194.66 对 120.32 MiB）。
- **单扫描连接（Serial）**：否决。整体 P95 比 0.8352，未达 ≤0.8 的预登记目标；保留失败护栏。
- **分拆查询许可（Scoped）**：否决。比值 1.2377，同样未达标。
- **按 CPU 调整预算（CPU_budget）**：否决。与流式路径相比无稳定额外收益，普通请求 P95 配对中位比 1.0399，未达不退化目标；最终代码保留原设置。
- **剧情过滤 v1（Filter_v1）**：被采纳设计的早期迭代。预筛选有效，但无字面量查询被拆分为逐 BLOB 查询造成退化（热态扫描比 1.158，超 1.1 门槛）；另建关联实验恢复原流式路径后，演进为最终被采纳的块过滤设计。

事后推断（当时无文字记录，如实标注）：中文实验名与 PR #274 正文英文排除项的对应（Serial ≈ single scan connection、Scoped ≈ split query permits）系按补丁内容建立的映射；PR 正文公开表述“未采用 mmap、单扫描连接、分拆许可或按 CPU 调整预算的实验分支”，与此一致。

边界立场（当时记录的非测量性裁决）：后台预热不计作消除校验成本；不以削弱校验换速度；AKDP 生产者侧的压缩/布局优化推迟，留在 Issue #266 跟踪。

## 决定

组合方案分五个 PR 合入 3.1.1：

- **PR #268 校验收据去重**：进程内有界验证收据（不超过 8 条）绑定文件身份与代际租约，去重 quick/full 重复检查（[src/storage/validation.rs](../../../src/storage/validation.rs)、[src/storage/identity.rs](../../../src/storage/identity.rs)）。
- **PR #269 查询路径**：搜索使用独立连接与许可道（搜索=1、剧情=2、点查询=4，[src/tools/mod.rs](../../../src/tools/mod.rs)；[src/storage/sqlite.rs](../../../src/storage/sqlite.rs) 增加搜索连接与 2 槽扫描池），另加代际所属的 8 MiB 单飞 FIFO 剧情元数据缓存（[src/storage/objects.rs](../../../src/storage/objects.rs)）。
- **PR #270 评测工具链**：[tools/experiments/](../../../tools/experiments/) 与 [COMPARATIVE-EVALUATION.md](../COMPARATIVE-EVALUATION.md)，使性能裁决可由贡献者复现。
- **PR #272 / #273**：摘要后端切换与校验链去重、双模式接纳验证——分别见 [ADR-0006](ADR-0006-sync-checksum-dedup-ring.md) 与 [ADR-0005](ADR-0005-sqlite-validation-modes.md)，本文不重复。
- **PR #274 剧情块预筛选索引**：代际所属的两字节字面量块过滤（[src/text/block_filter.rs](../../../src/text/block_filter.rs) 的 64 词位集加 [src/storage/block_filters.rs](../../../src/storage/block_filters.rs)，上限 4096 块即 2 MiB；只产生误报、不产生漏报；无可用字面量的正则保留原流式扫描与精确匹配；`mmap_size=0` 维持不变）。选型裁决原文：“采用 Final：有界剧情块预筛选索引、完整遍历后复用的有界有序元数据，并为无可用字面量的正则保留原流式扫描。保留原有点查询并发设置。”

## 后果

正面（口径：A=公开 3.0.0、B=公开 3.1.0、C=3.1.1-dev 候选；六轮新进程轮换、热态 6 进程中位数、端到端 HTTP、保留 OS 页缓存；34,680 次调用输出零差异、全部预登记门槛通过）：

- PR #269：story events 75.96 → 7.63 ms、listing+summaries 103.74 → 2.58 ms、summary 28.62 → 1.13 ms；短探针 8 并发扫描 3294.41 → 42.23 ms（P95 3367.33 → 93.22 ms）；混合吞吐较 B 提升 4.9–10.4%；90 秒 10 实例 8 客户端 soak 48.51 → 157.88 calls/s、冷却 RSS 331.28 → 138.84 MiB；孤立无字面量扫描 +0.3%（426.29 → 427.42 ms，接受）。
- PR #274（过滤前 normal 候选对 Final，六轮交替、10,248 次调用零差异、77 项护栏全过）：混合 8 并发 P95 380.19 → 60.09 ms、吞吐 95.23 → 368.37 calls/s、多样中文 P95 213.33 → 92.51 ms、RSS 123.86 → 118.66 MiB。
- 校验语义未削弱（`strict` 模式反而更严，见 [ADR-0005](ADR-0005-sqlite-validation-modes.md)）；贡献者获得公开评测工具链。

负面与代价：

- 离线首次响应变慢（`normal` +0.35 s、`strict` +1.84 s，见 [ADR-0005](ADR-0005-sqlite-validation-modes.md)）。
- 首次无命中字面量剧情查询承担约 100 ms 建索引（32.27 → 132.56 ms）；热态同类查询 30.60 → 1.84 ms，无字面量扫描 420.50 → 416.66 ms 基本不变。
- mmap 的吞吐与延迟收益被主动放弃（内存占用与平台生命周期代价）。

遗留事项：

- 首次同步/重启与 JSON 后端的差距未完全收口（空卷首次同步 A/B/C 分别为 2.365/11.114/9.357 s，重启复核 0.371/4.885/4.204 s），Issue #266 保持开放。
- 未测面（PR 正文自述）：Windows/macOS 性能、公网下载、冷页缓存、完整重型图片负载与真实客户端 E2E。
- 材料缺口：被否实验分支的原始补丁与明细数据仅存于内部记录；ADR 只能引用 PR 正文的公开表述与概括数字。

公开记录：[CHANGELOG 3.1.1](../../../CHANGELOG.zh-CN.md)、[Issue #266](https://github.com/3aKHP/prts-mcp/issues/266)、[tools/experiments/](../../../tools/experiments/)、[COMPARATIVE-EVALUATION.md](../COMPARATIVE-EVALUATION.md)、[src/text/block_filter.rs](../../../src/text/block_filter.rs)、[src/storage/block_filters.rs](../../../src/storage/block_filters.rs)、[tests/database_sync.rs](../../../tests/database_sync.rs)、[tests/data_backends.rs](../../../tests/data_backends.rs)、[tests/support/story_filters.rs](../../../tests/support/story_filters.rs)。
