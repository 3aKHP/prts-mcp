# PRTS-MCP 文档目录

本目录按读者的实际身份与任务将公开文档划分为三大板块：**客户端用户指南（`user/`）**、**服务端部署与运维手册（`admin/`）**、以及**代码开发与发版规范（`dev/`）**。

- 了解项目功能与完整工具列表，请参阅根目录 [README（中文）](../README.md#中文) / [README (English)](../README.md#english)。
- 查看当前版本线状态与近期发布记录，请参阅 [STATUS.zh-CN.md](../STATUS.zh-CN.md) / [STATUS.md](../STATUS.md)。
- 参与代码或文档贡献，请先阅读 [CONTRIBUTING.zh-CN.md](../CONTRIBUTING.zh-CN.md) / [CONTRIBUTING.md](../CONTRIBUTING.md)。
- 查阅项目特有术语与缩写的统一解释，请参阅 [术语表](glossary.md)。

English readers: the root [README](../README.md#english) and [Security Policy](../SECURITY.md#english) are bilingual, and [STATUS](../STATUS.md), [CONTRIBUTING](../CONTRIBUTING.md), [ROADMAP](../ROADMAP.md), and [CHANGELOG](../CHANGELOG.md) provide full English editions alongside their Chinese counterparts.

---

## 1. 客户端用户与创作者指南（`docs/user/`）

面向在 Claude Desktop、Claude Code、Roo Code / Cline、Cursor、OpenAI Codex CLI、Chatbox 等客户端中接入并使用 PRTS-MCP 的用户与同人创作者：

- [user/mcp-and-agent-basics.md](user/mcp-and-agent-basics.md)：Agent 与 MCP 零基础入门指南（用方舟考据实例讲清大模型、MCP 与客户端的关系、`stdio` 与 `HTTP` 模式怎么选、客户端推荐与首次使用的基本操作）。
- [user/quick-start.md](user/quick-start.md)：客户端接入与快速上手指南（本地 `stdio` 一键启动、连接 HTTP 端点、各大客户端配置片段、输出通道与常见接入问题）。
- [user/tools-guide.md](user/tools-guide.md)：工具使用与同人创作工作流指南（五大场景化工具串联工作流、24 个工具的 JSON 调用参数速查表与使用技巧）。

---

## 2. 服务端部署与运维管理员手册（`docs/admin/`）

面向在服务器、NAS、工作站或容器环境中部署与维护 PRTS-MCP 的系统管理员（Administrator / Operator）：

- [admin/deployment.md](admin/deployment.md)：服务端部署与容器运维指南（Streamable HTTP 独立服务、Docker 整卷/分卷/Bind Mount 挂载、非 root 与 `--read-only` 加固、`systemd` 守护进程托管、升级与回滚）。
- [admin/data-and-sync.md](admin/data-and-sync.md)：数据同步、离线包与立绘存储管理（数据目录结构、内置备用数据 vs 用户数据优先级、GitHub Token 与镜像加速、挂载自定义离线数据源、`LOCAL_IMAGE=true` 全量立绘与原图分片规划、数据卷备份与恢复）。
- [admin/environment-variables.md](admin/environment-variables.md)：运行时环境变量完整参考（全量配置字典、默认值、布尔与端口解析规则）。
- [admin/diagnostics-and-troubleshooting.md](admin/diagnostics-and-troubleshooting.md)：监控诊断与故障排查手册（`/health` 探活、`/debug/cache` 与 `/debug/metrics` 鉴权与 Rust 指标结构解读、日志收集脱敏与全场景排障矩阵）。

---

## 3. 版本升级与迁移指南（`docs/migration-*.md`）

- [migration-2.x-to-3.0.md](migration-2.x-to-3.0.md)：**2.x → 3.0 升级与迁移指南**（升级渠道选择、启动命令与默认传输模式对照、2.x 数据卷无缝兼容与回滚指南）。
- **历史版本迁移档案**（保留完稿时的版本背景，其中 2.5 → 2.6 的现代无状态协议信封说明对 3.x 仍适用）：
  - [migration-2.5-to-2.6.md](migration-2.5-to-2.6.md)：2.5 → 2.6 迁移指南（Streamable HTTP 与 `2026-07-28` 现代协议信封支持）。
  - [migration-1.x-to-2.0.md](migration-1.x-to-2.0.md)：1.x → 2.0 迁移指南（工具面收敛、`operator_name` → `name`、输出通道设计）。
  - [migration-0.x-to-1.0.md](migration-0.x-to-1.0.md)：0.x → 1.0 迁移指南。

---

## 4. 代码开发、分发与发版维护规范（`docs/dev/`）

面向项目代码贡献者与发行维护者：

- **架构、编码与协作规范**
  - [dev/ENVIRONMENT.md](dev/ENVIRONMENT.md)：跨平台开发环境搭建与本地验证命令（Linux/WSL、Windows、macOS）。
  - [dev/STYLE.md](dev/STYLE.md)：Rust 架构分层、代码规范、CHANGELOG 编写规则与已知工程陷阱。
  - [dev/adr/](dev/adr/)：架构决策记录（ADR）——自 3.1 起逐条记录影响契约、公开行为、数据语义、分发与安全姿态的决策，附编号、状态与撰写规范。
  - [dev/DOCUMENTING.md](dev/DOCUMENTING.md)：公开文档写作、角色划分与审查规范。
  - [dev/WORKFLOW.md](dev/WORKFLOW.md)：变更分级、双轨 Code Review、普通与全量 CI 策略及最小验证矩阵。
  - [dev/VERSIONING.md](dev/VERSIONING.md)：版本号语义与向后兼容性承诺。
  - [dev/LTS.md](dev/LTS.md)：`lts/1.7` 与 `lts/2.8` 两条长期支持分支的维护规则。
  - [dev/E2E.md](dev/E2E.md)：全量 E2E 真机测试流程。
  - [dev/COMPARATIVE-EVALUATION.md](dev/COMPARATIVE-EVALUATION.md)：通用 A/B、A/B/C 对照实验、私有环境配置、量化指标与证据保存。
- **平台构建、分发与发版恢复**
  - [dev/NATIVE-PLATFORMS.md](dev/NATIVE-PLATFORMS.md)：五平台预编译原生归档包的 ABI 基线、构建与验证说明。
  - [dev/NPM-DISTRIBUTION.md](dev/NPM-DISTRIBUTION.md)：Rust 版 npm 9 包架构、Node 启动桥与打包验证。
  - [dev/DOCKER-DISTRIBUTION.md](dev/DOCKER-DISTRIBUTION.md)：Rust 版 Docker 镜像构建、运行权限与数据卷验证。
  - [dev/RELEASE-CANDIDATES.md](dev/RELEASE-CANDIDATES.md)：跨平台汇总、GitHub 下载附件与验证资料、发布门禁与渠道保护。
  - [dev/RELEASE-CD-RECOVERY.md](dev/RELEASE-CD-RECOVERY.md)：CD 发布工作流（`release-rust.yml`）异常中断时的幂等重跑与恢复手册。

---

## 5. 工程演进与架构档案库（`docs/archive/`）

收录从 1.0 到 3.0 演进过程中按版本里程碑精编的架构决策档案、基准测试报告与深度技术复盘（导览见 [archive/README.md](archive/README.md)）；自 3.1 起的逐条架构决策记录（ADR）见 [dev/adr/](dev/adr/)：

- [archive/1.0-architecture-and-hardening.md](archive/1.0-architecture-and-hardening.md)：1.0 四层存储抽象定型与 1.5 运行时非功能性加固。
- [archive/2.0-tool-consolidation-and-output-channel.md](archive/2.0-tool-consolidation-and-output-channel.md)：2.0 工具面收敛（32 → 23）与正交双输出通道设计。
- [archive/2.2-bun-runtime-benchmark.md](archive/2.2-bun-runtime-benchmark.md)：2.x TypeScript 运行时演进：Node.js → Bun 基准测试。
- [archive/2.4-background-sync-and-paired-activation.md](archive/2.4-background-sync-and-paired-activation.md)：2.4 常驻后台同步、成对代际激活与共享卷恢复。
- [archive/2.5-operator-artwork-architecture.md](archive/2.5-operator-artwork-architecture.md)：2.5 `operator_artwork` 双后端架构设计（AKDP 本地分片与 MediaWiki 按需拉取）。
- [archive/2.7-modular-refactoring-and-dataset-access.md](archive/2.7-modular-refactoring-and-dataset-access.md)：2.7 “上帝文件”解耦审计、`DatasetAccess` 基石抽象与 `sync/` 独立分层。
- [archive/2.8-roguelike-story-coverage-study.md](archive/2.8-roguelike-story-coverage-study.md)：2.8 跨仓库剧情覆盖率盘点与肉鸽补充目录设计。
- [archive/3.0-unified-rust-stack-assessment.md](archive/3.0-unified-rust-stack-assessment.md)：3.0 统一技术栈选型评估：从双实现到原生 Rust。
- [archive/3.0-rust-parity-and-native-performance.md](archive/3.0-rust-parity-and-native-performance.md)：3.0 Rust 行为复刻、QuickJS C 正则剥离与原生性能报告。

---

## 6. 根目录及其他随仓文档

| 文档 | 中文入口 | English | 说明 |
| --- | --- | --- | --- |
| 项目总览与工具表 | [README](../README.md#中文) | [README](../README.md#english) | 功能简介、快速开始、24 个工具说明与数据源 |
| 项目状态 | [STATUS.zh-CN.md](../STATUS.zh-CN.md) | [STATUS.md](../STATUS.md) | 各分支状态、仓库结构与历史版本发布表 |
| 贡献指南 | [CONTRIBUTING.zh-CN.md](../CONTRIBUTING.zh-CN.md) | [CONTRIBUTING.md](../CONTRIBUTING.md) | 外部贡献流程、Issue 规范与仓库卫生 |
| 路线图 | [ROADMAP.zh-CN.md](../ROADMAP.zh-CN.md) | [ROADMAP.md](../ROADMAP.md) | 3.0 迁移阶段与后续规划 |
| 更新日志 | [CHANGELOG.zh-CN.md](../CHANGELOG.zh-CN.md) | [CHANGELOG.md](../CHANGELOG.md) | 0.x–3.x 完整版本变更记录 |
| 安全政策 | [SECURITY.md](../SECURITY.md#中文) | [SECURITY.md](../SECURITY.md#english) | 受支持版本线与安全漏洞私密报告流程 |
| 第三方内容与知识产权声明 | [NOTICE](../NOTICE) | [NOTICE](../NOTICE) | PRTS Wiki、明日方舟游戏数据与随包组件许可声明 |

其他专项说明：

- AI 协作者工作流指令：[CLAUDE.md](../CLAUDE.md)、[AGENTS.md](../AGENTS.md)
- 源代码许可证：[LICENSE](../LICENSE)
- 本地游戏数据目录说明：[data/README.md](../data/README.md)
- 随仓原生组件与测试夹具说明：[vendor/quickjs-regexp/README.md](../vendor/quickjs-regexp/README.md)、[tests/fixtures/native-smoke/README.md](../tests/fixtures/native-smoke/README.md)
