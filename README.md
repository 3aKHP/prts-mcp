# PRTS MCP Server

PRTS-MCP provides Arknights game data, story search, PRTS Wiki content and operator artwork to MCP clients. The 3.x development branch uses one native Rust implementation with a statically linked C regexp component.

**Release status:** the latest public stable release is still **2.8.1**. This branch is **3.0.0-dev.0**, with root import/validation in M1B. Five-platform native binaries, npm distribution and published Docker follow in M2/M3. The planned npm main package is prts-mcp; prts-mcp-ts will remain a Rust-backed compatibility entry. Neither is a published 3.x release yet. See the [migration plan](docs/dev/plans/3.x-rust-migration.md), [roadmap](ROADMAP.md) and [2.8.1 installation guide](https://github.com/3aKHP/prts-mcp/blob/ts/v2.8.1/README.md).

## Run from source

Source development requires Rust and a C compiler; use the pinned toolchain and lockfile. Native release users will not need them.

```bash
cargo build --locked --release --bins
./target/release/prts-mcp
# For clients spawning a stdio server:
PRTS_TRANSPORT=stdio ./target/release/prts-mcp
```

The new prts-mcp defaults to Streamable HTTP on :3000 (/mcp, /health). PRTS_TRANSPORT=stdio chooses stdio; whitespace/case are normalized, empty or unknown values retain HTTP. The old prts-mcp-ts and prts-mcp-ts-bun aliases remain HTTP; prts-mcp-ts-stdio remains stdio. They all run the same Rust core. Docker compatibility uses prts-mcp-ghcr: default stdio, only PRTS_TRANSPORT=http selects HTTP.

Data sync, paths and user settings are documented in [environment variables](docs/user/environment-variables.md). GameData and story data auto-sync from arknights-data-pipeline Releases; explicit data paths disable the corresponding sync. Read-only fallback, atomic activation, lock/lease, generations and offline recovery follow the frozen 2.8.1 contract. LOCAL_IMAGE=false fetches artwork through MediaWiki; LOCAL_IMAGE=true syncs AKDP PNG assets. IMAGES_ENABLED=false removes the artwork tool.

## MCP contract

The server provides 24 tools (23 without artwork) across operator/enemy/stage/item lookup, unified search, story/event/character tracing, PRTS Wiki search/page and operator_artwork. Legacy MCP 2024-11-05 / 2025-03-26 / 2025-06-18 and modern 2026-07-28 support are preserved in both transports. PRTS_OUTPUT_CHANNEL selects content, structured or both; HTTP per-request overrides are preserved.

[Tool declarations](contracts/tool-declarations.json) and [frozen differences](contracts/baseline.json) own exact comparison evidence. Approved differences D-001–D-007 remain disclosed, including product version/diagnostic schemas and selected Unicode regexp case-folding behavior. This migration does not promise byte identity beyond the approved contract.

## Development and maintenance

```bash
./scripts/check-runtime.sh
./scripts/check-runtime.sh --full
cargo package --locked
```

The full development check reconstructs the fixed TS oracle and fixtures in ignored directories; Node/Bun are development tools, not native service dependencies. Full release-candidate real-client E2E is planned for M4. M1B proves Linux x64 glibc only; Windows, macOS and Linux arm64 await native M2 validation.

Python/TS maintenance remains on lts/2.8 and lts/1.7, both EOL 2027-07-02. See [LTS policy](docs/dev/LTS.md) and [contributing](CONTRIBUTING.md). CLI and new functionality follow 3.0; crates.io source publication is a separate post-M5 task.

## 中文

3.x 将技术栈统一为根目录 Rust 工程，正则使用随二进制提供的原生 C 组件，不执行 JS/TS 业务。当前公开稳定版仍为 2.8.1，本分支 3.0.0-dev.0 尚未发行；此阶段只完成源码迁移、开发验证和独立源码打包。后续依次完成五平台发行验证、npm 与 Docker 包装、发布自动化、真实客户端 E2E、3.0 正式发布。新主命令默认 Streamable HTTP，旧 TS 命令及 Docker 的默认传输分别保留。配置见[环境变量](docs/user/environment-variables.md)，阶段和边界见[中文路线图](ROADMAP.zh-CN.md)。

## License / 许可

Project source is MIT; vendored native code has its included notices. Game content and PRTS Wiki content remain under their respective terms. [LICENSE](LICENSE), [NOTICE](NOTICE), [native component notices](vendor/quickjs-regexp/NOTICES.txt).
