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

不要直接 push 长期分支。工作分支使用 `<type>/v<version>-<topic>` 命名，并通过
PR 合并。当前版本与分支状态以 [`STATUS.md`](STATUS.md) 为准。

## Make And Verify Changes

先按 [`docs/dev/ENVIRONMENT.md`](docs/dev/ENVIRONMENT.md) 初始化环境，再按改动
范围运行测试。完整 runtime audit 应在提交 PR 前通过。

- 两套实现的同名工具必须保持工具名、必填参数和输出语义一致。
- 用户可见行为变化需要同步对应 README 与 CHANGELOG。
- Python 依赖变化同时更新 `python/pyproject.toml` 和 `python/uv.lock`。
- TS 依赖变化同时审阅 `ts/package.json`、`ts/package-lock.json` 和
  `ts/bun.lock`。
- 具体架构与 targeted test 命令见 [`docs/dev/STYLE.md`](docs/dev/STYLE.md)。

## Repository Hygiene

根目录 `AGENTS.md` 与 `CLAUDE.md` 有意记录维护者当前工作站上的唯一、已验证
配置，避免 AI 每次会话自行猜测平台。其他平台上的 contributor 可以参照
[`docs/dev/ENVIRONMENT.md`](docs/dev/ENVIRONMENT.md) 临时调整本地副本，再启动
AI contributor。

这类个人环境适配不得进入普通 PR。不要提交个人绝对路径、用户名、解释器位置、
私有主机或镜像、token，以及仅适用于个人 shell shim 的事实。提交前检查：

```bash
git diff HEAD -- AGENTS.md CLAUDE.md
```

只有在有意更新仓库的标准协作环境时，才提交这两份文件的环境变化。不要使用
`skip-worktree` 或 `assume-unchanged` 隐藏它们，否则可能错过上游更新。

同样不要提交 `.env`、`.mcp.json`、`docker-compose.override.yml`、`dev/` 下的
本地材料、生成包、日志或大体积私有数据。公开配置从 `.env.example`、
`.mcp.example.json` 和各实现的 override example 开始。

## Pull Requests

- 单个 PR 聚焦一个主题，提交信息遵循 Conventional Commits。
- PR 描述说明行为变化、验证命令、结果、skip 项与未尽事项。
- 修改公共 MCP 行为时明确说明 Python/TS parity 检查结果。
- 确认 diff 中没有 secrets、个人路径或本地 AI 环境适配。
- 依赖、部署、数据路径或版本变化需要同步相应 lockfile 与文档。
