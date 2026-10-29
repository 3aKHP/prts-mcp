# 参与贡献

[English](CONTRIBUTING.md)

感谢你参与 PRTS-MCP 的开发与维护。本指南适用于仓库根目录下的原生 Rust 工程（`develop` 分支，当前目标版本 `3.1.4-dev.0`）；2.8.x 与 1.7.x 的 Python/TypeScript 维护工作分别在 `lts/2.8` 与 `lts/1.7` 分支上进行。

开始前建议先阅读以下文档（全仓文档索引见 [`docs/README.md`](docs/README.md)）：

- [`docs/dev/ENVIRONMENT.md`](docs/dev/ENVIRONMENT.md) — 本地工具链配置与跨平台验证命令
- [`docs/dev/STYLE.md`](docs/dev/STYLE.md) — 架构分层、代码规范与测试要求
- [`docs/dev/DOCUMENTING.md`](docs/dev/DOCUMENTING.md) — 公开文档写作、维护与审查规范
- [`docs/dev/LTS.md`](docs/dev/LTS.md) — `lts/2.8` 与 `lts/1.7` 长期维护分支规则
- [`SECURITY.md`](SECURITY.md#中文) — 安全漏洞的私密报告流程

## 1. 选择目标分支

| 改动类型 | 起点分支与 PR 目标 |
|------|---------------|
| 新功能、重构、性能优化、非紧急缺陷修复、常规文档与工程维护 | `develop` → `develop` |
| 2.8.x / 1.7.x 兼容性、安全性、数据同步或关键缺陷修复（及对应 LTS 文档） | `lts/2.8` 或 `lts/1.7` → 同一 LTS 分支 |
| 最新公开稳定版的阻断性紧急修复（Hotfix） | `main` → `main`（合并后再按需移植至 `develop` 与 `lts/2.8`） |

请勿直接向 `main`、`develop`、`lts/2.8` 或 `lts/1.7` 推送提交。工作分支请按 `<type>/v<version>-<topic>` 命名（例如 `fix/v3.0.0-sync-retry`），并通过 Pull Request 合并。各分支当前版本号见 [`STATUS.zh-CN.md`](STATUS.zh-CN.md)。

## 2. 开发与验证

请先按 [`docs/dev/ENVIRONMENT.md`](docs/dev/ENVIRONMENT.md) 配置本地开发环境并运行 `./scripts/check-runtime.sh`，再根据 [`docs/dev/WORKFLOW.md`](docs/dev/WORKFLOW.md) 中的验证矩阵选择检查范围：

- **文档改动**：核对技术事实、命令示例与本地相对链接。
- **对照实验**：按[对照实验指南](docs/dev/COMPARATIVE-EVALUATION.md)初始化自己的本地、SSH 或容器环境。Benchmark 定义与公开 SOP 可复用，私有拓扑与操作规范留在本地。
- **代码改动**：运行 `cargo fmt --all -- --check`、`cargo clippy --locked --all-targets -- -D warnings`、`cargo test --locked`；涉及工具契约、数据同步或传输层时，请运行完整验证 `./scripts/check-runtime.sh --full`。
- **行为对齐契约**：Rust 版的工具名、参数与输出行为严格对齐 TS/v2.8.1 基线。经批准的实现差异封闭枚举在 `contracts/baseline.json` 中，请勿未经讨论自行扩大差异范围。
- **依赖与许可声明**：调整 Rust 依赖时，请同步检查 `Cargo.toml`、`Cargo.lock`、最低 Rust 版本（`rust-version`）及随包第三方许可声明。
- **用户可见变更**：若改动影响工具行为、配置项或部署方式，请在同一 PR 中同步更新对应文档（`README.md`、`docs/user/`、`docs/admin/`）及中英文 `CHANGELOG`。

## 3. 仓库卫生规范

根目录的 `AGENTS.md` 与 `CLAUDE.md` 记录了面向 AI 协作者的仓库公共工作流。如果你在本机做了个人环境适配，请勿将其混入公共提交：

- 切勿提交个人绝对路径、用户名、Token、私有代理/镜像地址或仅适用于个人终端 shim 的配置。
- 提交前请执行 `git diff HEAD -- AGENTS.md CLAUDE.md` 检查；仅在有意更新仓库公共协作规则时才提交这两个文件的改动。请勿使用 `git update-index --skip-worktree` 或 `--assume-unchanged` 隐藏本地修改，以免后续拉取时漏掉上游更新。
- 请勿提交 `.env`、`.mcp.json`、`docker-compose.override.yml`、`dev/` 下的本地工作文件、构建产物、运行日志或下载的游戏数据集。

## 4. 提交 Issue

- **普通缺陷与功能建议**：请通过公开的 GitHub Issue 提交。报告缺陷时，请尽量提供受影响的版本号、运行入口（`prts-mcp`、`prts-mcp-ts*` 或 Docker）、传输模式（`stdio` 或 Streamable HTTP）、复现步骤、预期与实际结果，以及脱敏后的 `stderr` 日志；提出功能建议时，请说明具体使用场景及是否涉及公共 MCP 工具 Schema 变更。
- **安全漏洞**：**请勿通过公开 Issue 披露**，请按 [`SECURITY.md`](SECURITY.md#中文) 中的私密渠道联系维护者。
- **自动化辅助分诊**：仓库配置的 KHPilot GitHub App 可能会在 Issue 下生成 AI 辅助分诊回复。Bot 回复仅作为排查参考，不代表维护者已接受需求或承诺排期；最终分类、优先级与关闭均由人类维护者决定。

## 5. 提交 Pull Request 与代码审阅

- 每个 PR 请聚焦单一主要意图，提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)（格式为 `<type>(<scope>): <subject>`，祈使语气小写开头，不超过 72 个字符）。
- PR 描述中请包含清晰的 **Summary**（改动摘要）、**Test plan**（实际执行的验证命令、结果与未验证范围）以及 **未尽事宜**。
- **文档贡献**：请勿提交由 GPT 系模型起草或大幅改写的文档正文。GPT 系模型可用于事实核对、文档审查，以及保留原有文风的局部事实修正。

### 审阅机制

PR 打开后，可能会收到人类维护者、自动化 Bot（KHPilot）以及维护者安排的独立上下文 Reviewer 的审阅意见（机制详见 [`docs/dev/WORKFLOW.md`](docs/dev/WORKFLOW.md)）。外部贡献者在提交 PR 前无需自行运行特定的 AI 审阅工具。

- 自动化评论属于待核实的审查线索，并非自动合并门禁。推送修复提交后，如确有必要请求 Bot 复审或追问，可在 PR 评论中提及 `@khpilot`（或 `@khpilot[bot]`）。
- 请逐条回应审阅中的实质问题；若对某条意见有异议，请附上代码、测试或文档依据说明理由。
- CI 通过状态以 GitHub Checks 为准，最终是否合并由人类维护者决定。
