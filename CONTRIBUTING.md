# Contributing

感谢你愿意参与 PRTS-MCP。本指南适用于仓库中的 Python 与 TypeScript 两套实现。

开始前请阅读：

- [`docs/dev/ENVIRONMENT.md`](docs/dev/ENVIRONMENT.md)：本机工具链与平台入口
- [`docs/dev/STYLE.md`](docs/dev/STYLE.md)：架构边界、代码规范与测试要求
- [`docs/dev/LTS.md`](docs/dev/LTS.md)：1.7 LTS 维护范围
- [`SECURITY.md`](SECURITY.md)：安全问题报告方式

## Choose The Target Branch

| 改动 | 起点与 PR 目标 |
|------|---------------|
| 功能、重构、性能、非紧急修复、一般或非 LTS 文档、chore | `develop` -> `develop` |
| 1.7 兼容性、安全性、数据同步、关键修复及对应文档纠正 | `lts/1.7` -> `lts/1.7` |
| 最新稳定版紧急 hotfix | `main` -> `main`，之后同步到 `develop` |

不要直接 push 长期分支。工作分支使用 `<type>/v<version>-<topic>` 命名，并通过 PR 合并。当前版本与分支状态以 [`STATUS.md`](STATUS.md) 为准。

## Make And Verify Changes

先按 [`docs/dev/ENVIRONMENT.md`](docs/dev/ENVIRONMENT.md) 初始化环境，再按改动范围运行测试。完整 runtime audit 应在提交 PR 前通过。

- 两套实现的同名工具必须保持工具名、必填参数和输出语义一致。
- 用户可见行为变化需要同步对应 README 与 CHANGELOG。
- Python 依赖变化同时更新 `python/pyproject.toml` 和 `python/uv.lock`。
- TS 依赖变化同时审阅 `ts/package.json`、`ts/package-lock.json` 和 `ts/bun.lock`。
- 具体架构与 targeted test 命令见 [`docs/dev/STYLE.md`](docs/dev/STYLE.md)。

## Repository Hygiene

根目录 `AGENTS.md` 与 `CLAUDE.md` 有意记录维护者当前工作站上的唯一、已验证配置，避免 AI 每次会话自行猜测平台。其他平台上的 contributor 可以参照 [`docs/dev/ENVIRONMENT.md`](docs/dev/ENVIRONMENT.md) 临时调整本地副本，再启动 AI contributor。

这类个人环境适配不得进入普通 PR。不要提交个人绝对路径、用户名、解释器位置、私有主机或镜像、token，以及仅适用于个人 shell shim 的事实。提交前检查：

```bash
git diff HEAD -- AGENTS.md CLAUDE.md
```

只有在有意更新仓库的标准协作环境时，才提交这两份文件的环境变化。不要使用 `skip-worktree` 或 `assume-unchanged` 隐藏它们，否则可能错过上游更新。

同样不要提交 `.env`、`.mcp.json`、`docker-compose.override.yml`、`dev/` 下的本地材料、生成包、日志或大体积私有数据。公开配置从 `.env.example`、 `.mcp.example.json` 和各实现的 override example 开始。

## Issues

普通缺陷和功能建议请使用公开 GitHub Issue；安全问题不要公开披露，按 [`SECURITY.md`](SECURITY.md) 私下报告。缺陷报告请尽量包含受影响版本、Python 或 TypeScript 实现、stdio 或 Streamable HTTP transport、复现步骤、预期与实际结果及脱敏日志。功能建议请说明实际 use case、现有工具的不足，以及是否会改变两套实现的公共 MCP surface。

仓库自动化（当前为 KHPilot GitHub App）可能在 Issue 中提供 AI 辅助分诊。Bot 回复是待核实的线索，不代表维护者已经接受建议、确定优先级、承诺版本或交付时间；最终分类、排期与关闭决定由维护者作出。

## Pull Requests

- 单个 PR 聚焦一个主题，提交信息遵循 Conventional Commits。
- PR 描述说明行为变化、验证命令、结果、skip 项与未尽事项。
- 修改公共 MCP 行为时明确说明 Python/TS parity 检查结果。
- 确认 diff 中没有 secrets、个人路径或本地 AI 环境适配。
- 依赖、部署、数据路径或版本变化需要同步相应 lockfile 与文档。

### Review

PR 可能收到人类、自动化 Bot 或 AI 辅助审阅。维护者还可能安排一次 clean-context 独立审阅；外部 contributor 无需在开 PR 前自行运行特定 Bot、模型或 SubAgent。远端 Bot CR 与独立审阅覆盖不同盲点，彼此补充但互不替代。

自动化评论是需要验证的 finding，不是 CI check、approval 或合并门禁，其触发、响应时间和覆盖范围也不保证。按当前配置，KHPilot 对同一个 PR 只会主动审阅一次；追加 commit 不会自动触发复审，应在现有 thread 或 PR conversation 中 `@KHPilot[bot]` 请求 re-review，也可以用同样方式追问具体 finding。

请逐条回应可操作反馈；若不同意，应给出代码、测试或文档证据。CI 状态以 PR Checks 为准，是否阻塞以及最终 merge 仍由人类维护者决定。
