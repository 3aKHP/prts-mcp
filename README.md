# PRTS MCP 本地 Rust 完整复刻计划

本目录用于将 TypeScript `ts/v2.8.1` 的完整运行时能力逐阶段迁移到 Rust，并积累未来 3.x 可直接复用的工程。目标已经从选型纵向原型扩大为完整复刻；各阶段持续验证，不等全部功能完成才验收。完整复刻不代表已决定公开发布 Rust 或停止 2.x 维护。

基线提交：`e0ba36096cdd46640166b0a5db02902fa9a6a24c`。计划日期：2026-10-11。当前交付只有计划、契约声明快照和调研材料，尚无 Rust 业务实现。阶段状态见 [PROGRESS.md](PROGRESS.md)。

## 已确定的边界

- 工具、数据、输出、配置、协议和运行行为以 TS/v2.8.1 为唯一业务基准。Python 不参与语言选型或业务差分。
- GHCR 兼容入口单独继承既有 Python 镜像的启动和部署契约；不借此引入第二套业务行为。
- 项目自有错误文案、错误层级和错误码对齐；Zod、JS 正则、HTTP/OS 库产生的底层详情按错误类别和可读原因比较，不逐字复制。
- 诊断端点、鉴权和通用指标保留；JS heap / ArrayBuffer 等实现专属指标采用 Rust schema 和明确迁移映射，禁止伪造数值。
- 修复内部结构技术债，保持外部契约；不机械翻译 TS 文件、测试脚手架和 Python parity 辅助 API。
- 本地仓库位于外层仓库忽略的 `dev/rust-rewrite/`。执行 Agent 已获维护者授权：每个可验证小步骤自动本地 commit；不得 push、发布或修改外层主线。

## 执行阅读顺序

| 文件 | 拥有的事实 |
|---|---|
| [AGENTS.md](AGENTS.md) | 执行权限、Git 边界、工作方法 |
| [01-scope-and-baseline.md](docs/01-scope-and-baseline.md) | 完整复刻定义、基线、差异裁决 |
| [02-architecture.md](docs/02-architecture.md) | Rust 模块和状态设计、依赖选择、技术债处置 |
| [03-tool-contracts.md](docs/03-tool-contracts.md) | 24 工具及全部 action/scope、数据域迁移清单 |
| [04-runtime-contracts.md](docs/04-runtime-contracts.md) | 协议、配置、启动、输出、诊断 |
| [05-sync-and-assets.md](docs/05-sync-and-assets.md) | 存储、同步、图片、锁与回滚 |
| [06-validation.md](docs/06-validation.md) | 差分规则、测试取舍、实机与性能证据 |
| [07-phases.md](docs/07-phases.md) | P0–P8 交付顺序、入口和完成条件 |
| [08-local-workflow.md](docs/08-local-workflow.md) | 本地工程、提交、证据与交接操作 |
| [09-promotion.md](docs/09-promotion.md) | 未来转正所需的可移植性与独立决策 |
| [10-research.md](docs/10-research.md) | 源码与外部依赖调研、已发现风险 |
| [contracts/baseline.json](contracts/baseline.json) | 机器可读基线和允许差异编号 |
| [contracts/tool-declarations.json](contracts/tool-declarations.json) | 从已核对发布源码提取的 24 工具描述与输入声明 |
| [contracts/data-declarations.json](contracts/data-declarations.json) | 三个Release数据集、必要文件与图片分片声明 |
| [contracts/coverage.csv](contracts/coverage.csv) | 必须交付的功能覆盖账本，状态不能等同测试通过 |
| [research/source-inventory.json](research/source-inventory.json) | 发布源码、测试、共享 fixture 路径与 SHA-256 |
| [research/baseline-artifacts.json](research/baseline-artifacts.json) | 锁文件、打包/部署、GHCR入口和规则文档的发布态hash |

先读 01、02、06、07，再按阶段读领域文档。不得只看任务表就开始实现。发生矛盾按 01 的裁决规则处理；不要自行把差异改成通过。

## 第一个执行任务

从 P0 开始，在本地仓库准备冻结 TS oracle 和运行数据，采集真实 MCP schema 与基线结果。声明快照不是 `tools/list` 的线上抓包，也不是全面行为 spec。P0 未完成前可以准备工程，但不得宣称兼容验收通过。后续每阶段同时交付实现与验证证据。

不需要重新询问本计划已经授权的内部实现、可逆测试和本地提交。只有外部契约变更、新的运行时依赖取舍超出 02 的决策、生产操作或公开发布才需要重新决策。

本轮文件和声明验证记录见 [计划校验报告](reports/plan-validation.md)。
