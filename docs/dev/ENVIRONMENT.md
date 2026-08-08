# Development Environment

本文档只说明 contributor 的工具链、初始化、平台入口、lockfile 和本机 AI 配置。分支与 PR 规则见 [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md)，编码和 targeted test 规则见 [`STYLE.md`](STYLE.md)。

## Toolchain

| 工具 | 要求 |
|------|------|
| Python | 3.10+ |
| uv | 当前稳定版；CI 固定 0.11.28 |
| Node.js | 22+；首选 `ts/package.json` 中的 Volta 版本 |
| npm | 随受支持 Node.js 提供 |
| Bun | 1.3.14+ |
| Bash | Linux、WSL 与 macOS 的 audit 入口 |
| PowerShell | 7+，仅原生 Windows audit 使用 |

Docker 与 GitHub CLI 只在对应镜像构建或数据下载任务中需要。

## Bootstrap

从仓库根目录安装锁定依赖：

```bash
uv sync --directory python --locked
npm ci --prefix ts
```

runtime audit 本身不会安装依赖或更新 lockfile。uv 会在 `python/.venv` 中维护隔离环境，但 contributor 不应直接调用该目录中的命令，也不应依赖 ambient Python。

## Verify

Linux、WSL 与 macOS 使用 Bash 入口：

```bash
./scripts/check-runtime.sh
./scripts/check-runtime.sh --full
```

原生 Windows 使用 PowerShell 7 入口：

```powershell
.\scripts\check-runtime.ps1
.\scripts\check-runtime.ps1 -Full
```

完整检查包含 Python tests、TS build/test/typecheck 与 Bun HTTP smoke。单项验证命令见 [`STYLE.md`](STYLE.md)。

quick audit 检查 uv lock 与环境同步状态、Python 核心导入、Node/npm/Bun 版本和 npm 顶层依赖树。它不会执行依赖安装。`--full` 也不代替 Docker、packed-package、发布/CD 或真实外部网络 E2E。

## Verification Status

| 平台 | 当前状态 |
|------|----------|
| Ubuntu | GitHub Actions 已配置完整验证；当前 uv workflow 改动待远端运行 |
| WSL2 | 维护者本地完整验证 |
| Windows PowerShell 7 | 脚本语法已验证；完整 runtime 待原生 Windows 复验 |
| macOS | Bash 3.2 静态兼容审查通过；当前没有实机或 CI 实证 |

未实证的平台不应被描述为与 Ubuntu/WSL 同等级持续验证。macOS 不维护第三套命令；遇到问题时优先修复共享 Bash 入口，并在无法共享时记录明确差异。

## Platform Notes

### WSL2

- 建议把仓库放在 Linux 文件系统，而不是 `/mnt/<drive>`，以避免权限、file mode 和大量小文件访问性能问题。
- 使用普通 `npm` / `npx`，不要调用 Windows `.cmd` shim。
- Windows 路径环境变量需改写为 WSL 路径；应用代码不负责自动调用 `wslpath`。

### Windows PowerShell 7

从仓库根目录初始化：

```powershell
uv sync --directory python --locked
npm.cmd ci --prefix ts
```

- PowerShell 下优先使用 `npm.cmd` / `npx.cmd`，避免 shim 与执行策略差异。
- 环境变量使用 Windows 原生路径格式，例如 `$env:GAMEDATA_PATH = 'D:\data\ArknightsGameData'`。
- 当前正式入口要求 PowerShell 7；不承诺 Windows PowerShell 5.1 或 Git Bash。

### macOS

- 使用与 Linux 相同的 `uv`、`npm` 和 Bash 命令。
- 确保 `/usr/bin/env bash` 能找到 Bash；在 PR 中如实记录实际验证版本与结果。
- 默认数据目录沿用项目的 XDG 风格 `~/.local/share/prts-mcp`，不是 macOS 原生 `~/Library/Application Support`。

不要跨操作系统复用 `.venv` 或 `node_modules`。切换平台后重新执行 Bootstrap。

## Local AI Instructions

`AGENTS.md` 与 `CLAUDE.md` 应给 AI 一个确定的本机答案，而不是多个平台选项。非 WSL contributor 在启动 AI 会话前，可以只修改本地副本中的运行时相关段落：

- 主机与 shell
- uv 初始化和 Python 命令
- npm shim 形式
- runtime audit 入口
- 实际存在的运行时版本约束

不要加入密钥、用户名、个人数据目录或私有 endpoint。除非 PR 目标就是更新标准协作环境，这些改动应保持 unstaged，并在提交前通过 `git diff HEAD -- AGENTS.md CLAUDE.md` 复核。

## Lockfiles

- 常规 Python 命令使用 `--locked`；只有有意修改依赖时才运行 `uv lock --directory python` 并审阅 `python/uv.lock`。
- TS 依赖变化需同步 npm 与 Bun 两套 lockfile。具体检查见 [`../../ts/README.md`](../../ts/README.md)。
- TS stdio e2e 需要先 build；若 `ts/dist` 不存在，运行 `npm --prefix ts run build`。
