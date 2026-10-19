# 开发环境指南（Development Environment）

本文介绍 PRTS-MCP 3.x（根目录原生 Rust 工程）在 Linux/WSL、Windows 与 macOS 下的工具链要求、初始化步骤与验证命令。

- 分支模型与 PR 流程见 [`CONTRIBUTING.zh-CN.md`](../../CONTRIBUTING.zh-CN.md) / [`CONTRIBUTING.md`](../../CONTRIBUTING.md)
- 代码规范与模块分层见 [`STYLE.md`](STYLE.md)
- 变更分级与验证矩阵见 [`WORKFLOW.md`](WORKFLOW.md)
- 2.8.x / 1.7.x 旧版 Python 与 TypeScript 开发环境请查阅对应 LTS 分支文档

---

## 1. 工具链要求

| 工具 | 版本与用途 |
| --- | --- |
| **Rust 工具链** | `rust-toolchain.toml` 固定开发编译器为 `1.96.1`；`Cargo.toml` 声明的最低受支持版本（MSRV）为 `1.89`。需安装 `rustfmt` 与 `clippy` 组件。 |
| **C 编译器** | Linux / macOS 使用系统 `cc`（GCC 或 Clang）；Windows 使用 Visual Studio C++ SDK 与 `clang-cl`。用于编译内嵌的 QuickJS 正则组件（`native/regexp.c`）与进程内存统计组件（`native/process_memory.c`）。 |
| **Node.js 与 npm** | `Node.js >= 22`、`npm >= 10`。用于运行契约对照脚本（`tools/`）、数据准备脚本及 npm 打包测试。 |
| **Bun** | 固定使用 `1.3.14`，仅在运行全量差分测试时用于启动冻结的 TS/v2.8.1 对照基准（Oracle），不用于生产运行时。 |
| **Python（对照实验工具）** | 可选的 Python `3.6+`，仅标准库。运行[对照实验](COMPARATIVE-EVALUATION.md)及其测试时需要；不是 Rust 服务构建或运行依赖。SSH/容器执行端也需提供解释器。 |
| **Shell 与基础工具** | Linux / WSL / macOS 使用 `bash`、`git`、`tar`、`curl`、`openssl`；原生 Windows 使用 `PowerShell 7+`（`pwsh`）。 |

> 预编译原生归档包与 Docker 镜像已静态链接所需 C 组件，终端用户无需安装上述编译工具链。五大目标平台的 ABI 基线详见 [`NATIVE-PLATFORMS.md`](NATIVE-PLATFORMS.md)。

---

## 2. 初始化与快速自检

克隆仓库后，在根目录执行以下命令验证工具链并完成首次编译：

```bash
rustup show
rustup component add rustfmt clippy
./scripts/check-runtime.sh
cargo build --locked
```

- `./scripts/check-runtime.sh` 为只读快速环境审计：检查 `cargo`、`rustc`、`cc` 与锁定的 Cargo 元数据，不会修改锁文件或下载外部数据集。
- 如需构建最小化的 TS/v2.8.1 对照基准与测试夹具（供差分测试使用），可执行：
  ```bash
  node tools/prepare-validation.mjs --minimal
  ```
  该脚本会从仓库 Git 历史中的固定提交（`e0ba36096cdd46640166b0a5db02902fa9a6a24c`）将 TS/v2.8.1 对照源码解压至被 `.gitignore` 忽略的 `.reference/ts-v2.8.1/` 目录，并在其中执行 `npm ci`（请确保本地克隆包含该历史提交，浅克隆需先 `git fetch` 补齐历史）。

---

## 3. 本地验证命令

### Linux / WSL / macOS（Bash）

```bash
# 1. 快速工具链与元数据检查
./scripts/check-runtime.sh

# 2. 全量验证（首次运行会准备固定测试资产，后续自动复用缓存）
./scripts/check-runtime.sh --full
```

`./scripts/check-runtime.sh --full` 会依次执行：
1. 准备测试夹具与 `contracts/validation-assets.json` 中固定 SHA-256 的四项 AKDP 验证资产（写入 `.runtime/`）；
2. `cargo fmt --all -- --check` 与 `cargo clippy --locked --all-targets -- -D warnings`；
3. 全量 Rust 单元与集成测试（`cargo test --locked`）及打包辅助程序测试（`cargo test --locked --example package_data`）；
4. Release 二进制与打包辅助程序联合构建（`cargo build --locked --release --bins --example package_data`）；
5. 384 个冻结 MCP 差分对照用例、进程级生命周期测试与扩展原生正则测试。

开发与测试构建默认只保留文件名和行号所需的调试信息（`debug = "line-tables-only"`），并启用增量编译，以减少本地产物占用。需要在调试器中查看变量和类型时，可临时使用 `CARGO_PROFILE_DEV_DEBUG=2 cargo build --locked`；测试使用 `CARGO_PROFILE_TEST_DEBUG=2 cargo test --locked`。Release 构建仍关闭调试信息。

日常开发中也可按需执行单项检查：

```bash
cargo fmt --all -- --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo test --locked --lib config::tests
cargo build --locked --release --bins
cargo package --locked
```

> `cargo package --locked` 用于验证 Cargo 源码归档包在脱离工作树后的可构建性以及 `native/`、`vendor/`、许可证文件的完整性（当前 `Cargo.toml` 设 `publish = false`，防止在 3.0 正式发布前误发至 `crates.io`）。

### 原生 Windows（PowerShell 7）

```powershell
.\scripts\check-runtime.ps1
cargo test --locked
```

Windows 下的完整原生归档构建、静态 CRT 审计与独立解压运行测试可使用：

```powershell
node tools/native/build.mjs windows-x64
node tools/native/pack.mjs windows-x64
node tools/native/probe.mjs windows-x64
```

---

## 4. 平台注意事项

### WSL2
- **工作树位置**：请将仓库克隆在 WSL2 原生 Linux 文件系统内（如 `~/projects/...`），**切勿放在 `/mnt/c/` 等跨系统挂载盘下**，否则会导致文件权限位异常及大量小文件 I/O 严重降速。
- **Node / npm 调用**：在 WSL 内请使用 Linux 原生的 `node`、`npm`、`npx`，不要混调 Windows 侧的 `.cmd` shim。
- **网络与代理环境**：若宿主机启用了 TUN 模式的系统代理（如 Clash 等），在 WSL 内仅清空 `HTTP_PROXY` 环境变量或传入 `--noproxy` 并不会绕过 TUN 路由。运行涉及大体积资产下载的验证前，建议先确认本地 `.runtime/` 缓存是否已就绪（真机测试的流量控制方法见 [`E2E.md`](E2E.md)）。

### Windows（PowerShell 7）
- 编译原生 C 组件需在配置了 Visual Studio C++ SDK 与 `clang-cl` 的环境中执行（例如设置 `$env:CC = 'clang-cl'`）。
- 在 PowerShell 中调用 npm 工具时，可使用 `npm.cmd` / `npx.cmd` 以避免 `.ps1` 包装脚本受执行策略限制。
- Windows 默认用户数据根目录为 `%LOCALAPPDATA%\prts-mcp`。

### macOS
- 需安装 Xcode Command Line Tools 以提供系统 C 编译器与 SDK。
- macOS 默认用户数据根目录遵循 XDG 约定：`~/.local/share/prts-mcp`（而非 `~/Library/Application Support`）。
- 请勿在不同操作系统或 CPU 架构之间直接共享 `target/` 编译目录或 `.reference/` 下的 `node_modules`。

---

## 5. 锁文件与本地配置卫生

- **锁文件纪律**：日常 Cargo 命令统一带上 `--locked`。如需修改依赖，请同时审查 `Cargo.toml`、`Cargo.lock`、MSRV（`1.89`）、C 编译兼容性与第三方许可证清单（`contracts/dependency-licenses.json`）。
- **冻结对照基线**：`.reference/` 下的 TS/v2.8.1 对照环境与 `contracts/` 下的 golden 快照是固定的历史基线，不随日常功能开发重录。
- **本地 AI 配置隔离**：根目录 `AGENTS.md` 与 `CLAUDE.md` 是全仓共享的公共协作规范。请勿将个人机器上的绝对路径、私有镜像或个人 shell 配置提交进这两个文件；提交前请通过 `git diff HEAD -- AGENTS.md CLAUDE.md` 复核。
