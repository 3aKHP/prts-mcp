# Rust npm 分发

M2B 将新主入口和旧命令包装为精确同版的 npm 包，服务业务仍由预编译 Rust 程序执行。构建和安装验证在开发 CI 中进行；公开 registry 发布、名称/账号权限及 next/latest 渠道由 M3/M5 验收，当前公开稳定版仍是 2.8.1。

## 包与命令

| 包 | 职责 | 命令 |
| --- | --- | --- |
| prts-mcp | 新主入口，依赖共享启动器 | prts-mcp：默认 Streamable HTTP；PRTS_TRANSPORT=stdio 选择 stdio。 |
| prts-mcp-ts | 旧命令兼容入口，依赖同版共享启动器 | prts-mcp-ts、prts-mcp-ts-bun 固定 HTTP；prts-mcp-ts-stdio 固定 stdio。无需安装 Bun。 |
| @3akhp/prts-mcp-runtime | 无业务逻辑的 Node 启动桥 | 选择匹配平台、检查版本、传递备用数据位置、参数和标准流、处理退出与信号。 |
| @3akhp/prts-mcp-data | 同版共享只读备用数据 | 固定数据版本与校验记录，包含 Excel/levels 解压内容和剧情 ZIP。 |
| @3akhp/prts-mcp-{platform} | 五种匹配平台的同版 Rust 产物 | Linux x64/arm64 glibc、Windows x64、macOS arm64/x64；携带 M2A 的原生依赖审计和许可。 |

入口 → runtime → data 采用精确版本依赖；runtime 的五个原生包为精确版本 optionalDependencies，由 npm os/cpu/libc 条件筛选。正常安装从 npm 平台包获取二进制，不从 GitHub 临时下载，不现场编译。公共名称和 @3akhp scope 权限在 M3 发布前确认，本阶段不提前注册或发布。

五个平台的 CPU、系统和 ABI 基线沿用[原生平台说明](NATIVE-PLATFORMS.md)。npm 启动桥需要 Node >=22；npm >=10 是包装声明的安装基线。Linux 启动时还检查 glibc >=2.28；musl/Alpine 和未支持的 CPU/OS 给出明确诊断。直接原生程序和 Docker 的业务运行不因此依赖 Node。

新旧入口没有重名 bin，可同时安装；共享数据不复制进五个平台包。npm 在同一项目中会复用同版依赖，独立全局入口的安装目录由 npm 管理，可能各自存有依赖副本，不能承诺全局安装的物理文件去重。

## 数据与升级

packaging/npm/data-release.json 单独固定发行备用数据的 AKDP Release、manifest、源版本和三包大小/SHA。其更新不改写历史 contracts/validation-assets.json 的冻结验证基线。prepare-data.mjs 获取并校验文件，examples/package_data.rs 调用现有 Rust 必需文件、剧情引用检查和安全解压，并解析包内 JSON、生成 BUNDLE.json 与文件校验清单。

安装包内数据为备用读取来源；有完整用户数据时优先读取用户目录或既有卷，后台同步继续更新用户目录，不覆盖安装目录。没有用户数据且同步失败时，备用数据支持游戏数据查询；Wiki 查询、未下载立绘仍依赖各自数据源。源码安装和 Cargo 源码包保持运行时同步，不内嵌全部游戏数据。参见[数据目录政策](../../data/README.md)。

数据包装可供 M2C 镜像和 M3 原生候选产物复用；这些渠道尚未在 M2B 完成。data/ 门禁继续要求 M4 的实际候选首次启动、备用查询、用户数据优先、旧卷升级和回滚证据。独立文档补全门禁也尚未关闭。

## 生命周期

启动器以参数数组直接启动 Rust 程序，不通过 shell 解释参数；stdin/stdout/stderr 继承，MCP stdout 只承载协议。Unix 将 SIGINT/SIGTERM/SIGHUP 转发至子进程，并保持原生退出码或信号终止语义。

Windows 强制结束外层 Node 进程不会运行 Unix 信号处理器，因此 npm 入口通过内部 --launcher-parent-pid 参数，让 Rust 子进程等待父进程的 Windows OS handle；父进程结束时原生服务退出，避免遗留 HTTP listener。该监测仅在 Windows 且传入内部参数时启用，直接原生/容器运行没有此要求；不是新的公共配置项或管理 CLI。

缺少平台包（例如使用 --omit=optional）和启动器/原生/备用数据版本不一致时，错误写 stderr 并非零退出。不会切回 JS/TS 服务或在用户机器上构建补救。npm install --ignore-scripts 仍可使用完整包装，因为平台程序已经随包提供。

## 构建与验收

以下命令在干净的短分支快照中执行，平台参数必须匹配本机原生 OS/CPU；Windows 原生构建需按 native CI 配置 SDK 和 clang-cl。

```bash
node tools/native/build.mjs linux-x64
node tools/native/pack.mjs linux-x64
node tools/npm/prepare-data.mjs
node tools/npm/pack.mjs linux-x64
node tools/npm/probe.mjs linux-x64
```

tools/npm/pack.mjs 只接受经过审计、校验清单一致且 dirty=false 的原生 payload，生成五个真实 tarball：当前平台、共享 data、共享 runtime、两个入口。artifacts/npm/{platform}/packages.json 记录精确版本、来源和 tarball SHA/integrity。五个原生 runner 分别构建、安装并执行本机包；M3 汇总五个平台包并按依赖顺序发布，不将单个平台的测试输出直接当作完整发行目录。

probe.mjs 使用只读 loopback registry 和隔离 npm 配置/缓存，执行真实全局双入口安装、npx、npm ci、无用户数据的备用查询、命令与协议、退出码、信号/Windows 父进程终止、版本不匹配和缺少 optional 包的诊断。非当前平台只提供用于锁文件解析的模拟元数据，并断言 npm 没有下载它们；异平台运行结论来自各自原生 runner。具体证据位于 npm-evidence.json 与 npm-runtime-evidence.json，安装包内容不能仅以模板审查认领通过。

CI 留存 tarball 和验收证据 14 天，不执行 npm publish，也不改写 npm latest、旧版 LTS 或 GitHub Latest。当前 npm 公开安装说明仍应使用已发布的 2.8.x；3.x 候选安装示例在 M3 真正发布后补充。

npm 筛选与 optionalDependencies 行为参见 [package.json 官方说明](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/)，锁文件安装见 [npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/)，npx 对应 [npm exec](https://docs.npmjs.com/cli/v11/commands/npm-exec/)。
