# Rust npm 分发说明

本文面向构建与维护 npm 发行包的协作者，说明 PRTS-MCP 3.x 的 9 包架构、npm 启动桥生命周期、内置备用数据打包及本地验证流程。

- 终端用户的 npm 安装与服务端部署见[客户端接入指南](../user/quick-start.md)与[服务端部署指南](../admin/deployment.md)
- 五大平台的底层二进制与 ABI 基线见 [`NATIVE-PLATFORMS.md`](NATIVE-PLATFORMS.md)
- 候选版汇总与 OIDC 发布流程见 [`RELEASE-CANDIDATES.md`](RELEASE-CANDIDATES.md)

---

## 1. 九包架构与命令职责

在 3.x 中，npm 渠道不再分发 TypeScript 业务源码，而是通过精简的启动桥拉起对应平台的预编译 Rust 二进制。整套分发由 **9 个同版本 npm 包**组成：

| 包名 | 角色 | 提供的命令与职责 |
| --- | --- | --- |
| `prts-mcp` | 3.x 新主入口包 | 提供 `prts-mcp` 命令：默认启动 Streamable HTTP（`:3000/mcp`），设 `PRTS_TRANSPORT=stdio` 切换为 stdio。 |
| `prts-mcp-ts` | 2.x 命令兼容入口包 | 提供 `prts-mcp-ts`、`prts-mcp-ts-bun`（固定 HTTP）与 `prts-mcp-ts-stdio`（固定 stdio），底层同样调用 Rust 二进制，无需安装 Bun。 |
| `@3akhp/prts-mcp-runtime` | 共享启动桥 | 不含业务逻辑；负责按当前 OS/CPU 定向解析平台二进制与内置数据目录、透传标准流与退出信号。 |
| `@3akhp/prts-mcp-data` | 共享只读备用数据包 | 打包经过校验的 `gamedata/`、`gamedata-levels/` 与 `storyjson/` 备用快照（含 `BUNDLE.json` 与 `SHA256SUMS`）。 |
| `@3akhp/prts-mcp-<platform>` | 5 个平台二进制包 | 对应 `linux-x64`、`linux-arm64`、`windows-x64`、`darwin-arm64`、`darwin-x64`；携带预编译 Rust 二进制、ABI 审计记录与完整第三方许可证。 |

### 依赖关系与安装约束

- **精确同版依赖**：`prts-mcp` 与 `prts-mcp-ts` 均以精确版本号依赖 `@3akhp/prts-mcp-runtime`；`runtime` 以精确版本号依赖 `@3akhp/prts-mcp-data`，并将 5 个平台包列为精确版本的 `optionalDependencies`。
- **按平台自动筛选**：每个平台包在 `package.json` 中声明了对应的 `os`、`cpu`（以及 Linux 下的 `libc: ["glibc"]`）字段。`npm install` 时仅会下载匹配当前机器的那个平台包，无需在用户机器上执行 `postinstall` 下载脚本或现场编译（因此 `npm install --ignore-scripts` 也可正常工作）。
- **环境要求**：npm 安装及默认入口要求 `Node.js >= 22`、`npm >= 10`，Linux 下额外检查 `glibc >= 2.28`。若安装时传入了 `--omit=optional` 导致平台包缺失，或在不支持的 `musl`/架构上运行，启动桥会向 `stderr` 输出明确错误并以非零状态码退出。

- **沿用 Bun**：Linux `x64` 已验证使用 Bun `1.3.14` 显式运行兼容入口，例如 `bun /usr/bin/prts-mcp-ts-bun`。既有 Bun 服务可保留启动方式，Node 作为兼容路径。两种启动桥的业务逻辑均由 Rust 子进程执行；直接执行 npm bin 时仍按 Node shebang 启动。

---

## 2. 内置备用数据与优先级

1. **独立版本固定**：[`packaging/npm/data-release.json`](../../packaging/npm/data-release.json) 固定了发行备用数据所使用的上游 `arknights-data-pipeline` Release、manifest 与三个 ZIP 的 SHA-256（与开发测试专用的 `contracts/validation-assets.json` 互不干扰）。
2. **数据准备与校验**：`node tools/npm/prepare-data.mjs` 下载并校验三个上游归档后，调用 `cargo run --locked --example package_data` 执行安全解压、必需表格校验、剧情引用检查，并生成 `BUNDLE.json` 与 `SHA256SUMS`。
3. **运行时优先级**：启动桥通过内部参数将 `@3akhp/prts-mcp-data` 的路径传给 Rust 进程作为只读备用源。当用户数据目录已有完整数据时，服务优先读取用户数据；后台同步始终写入可写的用户数据目录，绝不修改 `node_modules` 内的备用数据包。

---

## 3. 进程生命周期与信号转发

- **无 Shell 直接拉起**：[`packaging/npm/runtime.cjs`](../../packaging/npm/runtime.cjs) 使用参数数组直接 `spawn` 原生二进制，不经过 shell 解析；`stdin`、`stdout`、`stderr` 原样继承，确保 `stdout` 仅输出纯净的 MCP 协议流。
- **POSIX 信号转发**：在 Linux 与 macOS 下，启动桥捕获 `SIGINT`、`SIGTERM`、`SIGHUP` 并转发给 Rust 子进程，待子进程退出后保持相同的退出码或信号终止状态。
- **Windows 父进程句柄监测**：由于 Windows 下强制终止外层 Node 进程不会触发 POSIX 信号处理器，启动桥在 Windows 下会向 Rust 子进程传入内部参数 `--launcher-parent-pid <pid>`。Rust 进程通过 Windows OS 句柄监听父进程状态：一旦外层 Node 启动桥退出，Rust 服务立即自动退出，防止遗留后台僵尸进程或占用端口的 HTTP 监听器。

---

## 4. 本地打包与探测验证

在匹配目标平台 OS/CPU 的机器上，依次执行以下命令完成原生构建、数据准备、npm 打包与闭环安装探测：

```bash
node tools/native/build.mjs linux-x64
node tools/native/pack.mjs linux-x64
node tools/npm/prepare-data.mjs
node tools/npm/pack.mjs linux-x64
node tools/npm/probe.mjs linux-x64
```

- **`tools/npm/pack.mjs`**：校验 `artifacts/native/<platform>/` 与备用数据的完整性，在 `artifacts/npm/<platform>/` 下生成当前平台的 5 个 `.tgz` tarball（`prts-mcp`、`prts-mcp-ts`、`runtime`、`data` 及当前 `<platform>` 包），并写入 `packages.json`。
- **`tools/npm/probe.mjs`**：在本地启动一个隔离的只读回环 npm registry，真实执行 `npm install -g`、`npx` 与 `npm ci`，全面验证双入口命令、离线备用数据查询、stdio/HTTP 双协议时代、信号退出与 Windows 父进程联动退出，以及缺失 `optionalDependencies` 或版本不匹配时的错误诊断。
