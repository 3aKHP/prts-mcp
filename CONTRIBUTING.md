# Contributing

感谢你愿意参与 `prts-mcp`。

当前项目正处于早期演进阶段。为了避免把本地开发习惯、私有数据和临时发布方式带进公开仓库，请在提交前先阅读下面这些约束。

## Branch Strategy

- 默认分支是 `main`。
- 功能开发请从 `main` 拉出新分支。
- 分支命名建议使用 `feat/<topic>`、`fix/<topic>`、`docs/<topic>` 这类形式。
- 未经过整理的实验分支、临时部署分支和本地备份分支不要直接推到公开远程作为默认入口。

## Commit Convention

本仓库提交信息遵循 Conventional Commits。

推荐格式：

```text
type(scope): summary
```

常用类型：

- `feat`: 新功能
- `fix`: Bug 修复
- `docs`: 文档更新
- `refactor`: 重构但不改变外部行为
- `test`: 测试相关
- `chore`: 构建、工具、仓库维护
- `ci`: CI/CD 配置

示例：

```text
feat(config): support local data path fallback
docs(deployment): clarify public and private packaging boundary
ci(github): add minimal install and import verification
```

## Public Repo Boundary

公开仓库默认只接收源码、文档和必要的空目录占位。当前版本的数据主路径是 GitHub-backed auto-sync，而不是提交真实数据文件。

请不要提交以下内容：

- `data/gamedata/` 或 `data/storyjson/` 下的真实数据文件
- `local_repo.jsonc`
- `.mcp.json`
- `docker-compose.override.yml`
- 本机绝对路径、私有镜像地址、个人临时部署脚本
- 大体积打包产物，如 `*.tar`

如果你需要本地配置，请优先使用仓库里的示例文件：

- `.mcp.example.json`
- `docker-compose.override.example.yml`

## Local Development

```bash
pip install -e .
python -m compileall src scripts
```

如果你需要完整干员功能，请优先使用当前默认流程：

- 直接运行服务，让它自动同步最小数据集
- 如担心 GitHub 匿名限流，设置 `GITHUB_TOKEN`
- 如需强制使用你自己的数据目录，再设置 `GAMEDATA_PATH`

兼容脚本 `scripts/package_operator_data.py` 仍在仓库中，但已是 deprecated 入口。当前版本不建议把同步或打包得到的数据文件直接提交到公开 Git 仓库。

## Pull Requests

- 保持单个 PR 聚焦一个主题。
- 在描述中说明改动动机、行为变化和验证方式。
- 如果改动影响部署、数据路径或公开仓库边界，请同步更新 `README.md` 或 `docs/deployment.md`。
- 提交前请确认 CI 能通过。

## Architecture Note

下一个大版本预计会重构数据拉取、缓存和更新流程。因此：

- 可以修复明显问题并改进文档、工具链和边界约束。
- 涉及大规模数据架构的设计改动，建议先开 issue 或草案讨论，避免和即将到来的重构方向冲突。
