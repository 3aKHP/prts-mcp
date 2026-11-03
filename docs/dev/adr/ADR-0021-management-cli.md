# ADR-0021：兼容增量的管理 CLI 与配置文件

- 状态：Accepted
- 决策日期：2026-11-02
- 关联：[ADR-0003](ADR-0003-management-cli-scope.md)、[ADR-0020](ADR-0020-pypi-native-wheels.md)、[管理 CLI 使用指南](../../admin/cli.md)、[Issue #292](https://github.com/3aKHP/prts-mcp/issues/292)、[Issue #314](https://github.com/3aKHP/prts-mcp/issues/314)

## 背景与问题

3.x 原生 Rust 迁移与核心发行渠道已落地，[ADR-0020](ADR-0020-pypi-native-wheels.md) 中的 PyPI 原生 Wheel 候选也需要正式的 `--help` 与 `--version` 入口才能完成发版前验收。同时，[ADR-0003](ADR-0003-management-cli-scope.md) 留存的五个运维痛点（环境变量联动不直观、配置来源与覆盖关系不透明、缺少无副作用的本地诊断与数据校验入口等）亟待解决。

维护者决定将 ADR-0003 的设计储备正式开题，不再仅交付最小 `--help` / `--version` 占位，而是在 `3.2.2` 中以向后兼容的增量 Patch 一次性交付覆盖配置管理、环境诊断、数据检查与一次性同步的完整一期管理 CLI。

## 备选方案

- **按操作系统或 Shell 改变命令行参数语法**：否决。同一操作系统下常并存多种 Shell（如 Windows PowerShell、Git Bash、CMD），且 MCP 客户端往往直接通过系统调用拉起子进程；命令行参数契约必须在全平台保持一致语义。
- **将既有服务器入口重命名为 `prtsd` 并内建后台守护进程管理**：本期不采用，保留为后续独立议题。一期不迁移或废弃现有服务器启动命令，也不实现自身后台化（daemonize）或跨进程在线控制通道，进程生命周期仍交由客户端、Docker 或系统服务管理器（如 `systemd`）托管。
- **让既有服务器入口自动加载默认用户配置文件**：否决。升级版本或在用户目录下生成 `config.toml` 不应悄然改变既有部署与 MCP 客户端子进程的运行行为；既有入口仅在显式传入 `--config <path>` 时读取配置文件。
- **新增独立的 `prtsctl` 管理入口，与服务器入口共享 Rust 配置解析及同步内核**：采纳。通过统一的跨平台子命令、Shell 自动补全脚本、标准化的 JSON 机器输出与平台路径约定适配不同操作系统与 Shell 环境。

## 决定

1. **双入口分工与向后兼容**：
   - 新增 `prtsctl` 管理命令：无参数运行时显示帮助并安全退出；提供 `config show/validate/init/set/unset`、`doctor`、`data status/verify/sync`、`serve` 与 `completion` 子命令。
   - `prtsctl serve` 在当前前台进程运行服务，各发行渠道统一默认使用 Streamable HTTP，`stdio` 模式可通过显式参数、环境变量或配置文件指定。
   - 既有服务器入口（`prts-mcp`、`prts-mcp-ts*`、`prts-mcp-ghcr`）保留无参数启动、默认传输模式及未知参数兼容行为，仅增量支持 `--help`、`--version` 与显式 `--config <path>`。
2. **版本化 TOML 配置文件与优先级**：
   - 采用带 `schema_version = 1` 的单文件 TOML 配置，生效优先级固定为：**显式命令行参数 > 进程环境变量 > TOML 配置文件 > 内置默认值**。
   - 配置文件字段执行严格类型与枚举校验；环境变量继续保持既有的宽松解析与回退规则。
   - 仅 `prtsctl` 自动读取固定用户级配置路径（Linux/macOS 下为 `$XDG_CONFIG_HOME/prts-mcp/config.toml` 或 `~/.config/prts-mcp/config.toml`，Windows 下为 `%APPDATA%\prts-mcp\config.toml`）；不搜索当前工作目录，也不自动加载 `.env`。
   - 配置文件内的相对路径相对于该配置文件所在目录解析；环境变量与命令行参数中的相对路径保持相对于当前工作目录解析。
   - `config set` / `unset` 通过文件锁与原子替换执行无损编辑（保留注释与无关排版），拒绝操作符号链接目标，`--dry-run` 不写盘、不加锁。长期凭据（Token）禁止通过 `config set` 写入，且所有配置与诊断输出均对敏感字段脱敏。
3. **只读命令边界与机器可读输出契约**：
   - 只读管理命令在服务器初始化之前分流，绝不构造 `App`、不触发网络下载，也不写入数据源归属标记或 SQLite 准入缓存。完整数据校验（`data verify`）与上游网络连通性探测（`doctor --network`）均须由用户显式调用。离线数据观察结果仅反映当前磁盘状态，不代表运行中服务实例的实时状态。
   - 管理命令支持 `--output text|json`（`-o`），该选项与控制 MCP 工具返回通道的 `PRTS_OUTPUT_CHANNEL` 完全正交。JSON 输出作为受兼容性承诺保护的脚本接口，固定顶层 `schema_version`、字段类型、枚举值与标准退出码（`0`/`1`/`2`/`3`/`130`/`143`）。
4. **一次性同步（`data sync`）语义**：
   - 复用服务端既有的数据源归属校验、跨进程文件锁、SHA-256 摘要校验、代际原子激活与恢复规则。
   - `--wait-timeout` 仅控制本次调用等待获取跨进程同步锁的预算（不改变后台轮询默认值，也不计入下载耗时）。
   - 立绘同步须显式指定 `--target images` 或 `all` 且满足配置开关；自定义只读数据路径受保护不被覆盖。
   - 收到取消信号（`Ctrl+C` / `SIGTERM`）时立即中止新的网络请求，但允许已进入的本地目录原子发布临界区安全完成落盘。

## 后果

正面：

- 管理员与高级用户可通过 `prtsctl` 一站式完成“生成配置模板 → 查看来源解释 → 诊断环境 → 预同步与校验数据 → 启动服务”的完整闭环，同时既有 MCP 客户端与容器部署零破坏升级。
- PowerShell 与 Bash 等脚本环境可直接通过 `-o json`（如配合 `ConvertFrom-Json` 或 `jq`）消费结构化诊断与配置报告，无需为特定 Shell 维护额外的业务封装层。

负面与后续事项：

- TOML 配置 Schema、JSON 报告结构与管理退出码成为需要长期维护的公开兼容接口。
- 实施与评审按“配置与路径重构 → CLI 主体实现 → 各发行渠道接入”拆分为多个 Standard PR 推进，并对整体变更执行 Huge 级别双轨审查；发版前须完成五平台原生包、npm、PyPI、Cargo 与 Docker 入口及旧环境兼容性验证。
- 管理 CLI 合入后将重新构建并验证包含 `prtsctl` 的 PyPI 原生候选 Wheel，正式公开发布仍纳入后续统一发版流程。
