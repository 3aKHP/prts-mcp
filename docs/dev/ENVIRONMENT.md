# Development Environment

3.x 是根目录 Cargo 工程；旧 Python/TS 开发环境请切换相应 LTS 分支。M2A 已完成 Linux x64/arm64 glibc、Windows x64、macOS arm64/x64 原生构建及解压运行验证，实际系统/ABI 基线见 [NATIVE-PLATFORMS.md](NATIVE-PLATFORMS.md)。这不代表 3.x 已公开发布。

## 工具链

rust-toolchain.toml 固定 Rust 1.96.1，Cargo.lock 固定依赖；Cargo.toml 的最低 Rust 版本为 1.89，生产依赖以该版本实际检查。五平台的系统/ABI 基线及打包命令见 [NATIVE-PLATFORMS.md](NATIVE-PLATFORMS.md)。源码构建需要 C 编译器（Linux: cc，Windows: clang-cl 配合 Visual Studio SDK，macOS: 系统 cc），原生 regexp 以静态库链接进二进制，无 JS VM。开发检查还需 rustfmt、clippy：

```bash
rustup show
rustup component add rustfmt clippy
./scripts/check-runtime.sh
cargo build --locked
```

Node >=22、npm、Bun 1.3.14、Git、tar、curl 和 openssl 用于开发期对照与 fixture，不是原生服务的运行依赖。WSL 使用 Linux 文件系统及普通 npm/npx。

## 验证

```bash
node tools/prepare-validation.mjs --minimal
cargo test --locked
./scripts/check-runtime.sh --full
cargo package --locked
```

prepare-validation 从固定提交 e0ba36096cdd46640166b0a5db02902fa9a6a24c 的 Git 历史重建 .reference/ts-v2.8.1；新 clone 需要完整历史（CI checkout fetch-depth: 0），浅 clone 应先取得 ts/v2.8.1 的历史。对照依赖由 npm ci 安装，首次完整检查下载 contracts/validation-assets.json 固定的四项 AKDP 数据资产并校验 SHA-256，后续复用缓存。运行时 fixture 位于 .runtime/，结果位于 artifacts/，均不入 Git。无 --minimal 时重建全规模剧情 fixture；不会重录 contracts 或 goldens。

--full 包含 fmt、clippy、Rust tests、release build、384 个离线 MCP 对照案例、生命周期和扩展原生 regex 案例。生命周期的图片回读使用由真实冻结 TS syncImages 写出的代表性 baseline/delta 小卷，完整规模图片及真实客户端仍由 M4 收口。它不等于实时上游网络测试、五平台发行验证或 M4 完整真机 E2E。现场资产缺失、超时或校验失败应记为失败，不跳过案例后声称全绿。

PowerShell check-runtime.ps1 提供 Cargo 元数据 audit；-Full 不把该 audit 误算为完整冻结对照，而是指向 Linux/WSL 的 check-runtime.sh --full。Windows 原生产物的独立构建、静态 CRT、Unicode 安装路径及运行验证使用 tools/native/build.mjs、pack.mjs、probe.mjs windows-x64；Node 是构建/测试工具，不是原生服务运行依赖。npm 安装验收仍在 M2B。

cargo package 验证独立源码归档能够离开工作树构建。publish=false 保持公开发布关闭，源码包中的 native/、vendor/、许可证和 NOTICE 必须齐全；cargo install 面向具备 Rust/C 开发工具链的用户，M5 后另行上架 crates.io。
