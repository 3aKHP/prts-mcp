# Rust 候选发行物与发布流程

本文面向发行维护者，说明 PRTS-MCP 3.x 原生归档包、npm 包与 Docker 镜像的候选打包、跨平台汇总、工作流门禁与发布流程。

- 五平台原生归档要求见 [`NATIVE-PLATFORMS.md`](NATIVE-PLATFORMS.md)
- npm 9 包结构见 [`NPM-DISTRIBUTION.md`](NPM-DISTRIBUTION.md)
- Docker 双架构镜像见 [`DOCKER-DISTRIBUTION.md`](DOCKER-DISTRIBUTION.md)
- 发布工作流异常中断时的恢复操作见 [`RELEASE-CD-RECOVERY.md`](RELEASE-CD-RECOVERY.md)

---

## 1. 单平台候选归档本地复现

在匹配目标平台 OS/CPU 的主机上，可执行以下命令生成包含内置备用数据的独立原生候选归档包（`artifacts/candidate/<platform>/`）并运行解包探测：

```bash
node tools/native/build.mjs linux-x64
node tools/native/pack.mjs linux-x64
node tools/npm/prepare-data.mjs
node tools/npm/pack.mjs linux-x64
node tools/release/pack-native.mjs linux-x64
node tools/release/probe-native.mjs linux-x64
```

- **`tools/release/pack-native.mjs`**：将 `artifacts/native/<platform>/` 中的 6 个原生可执行文件、ABI/构建清单、完整第三方许可证与经过校验的只读备用数据（`data/`）合并打包为 `prts-mcp-<version>-<platform>-candidate.tar.gz`（Windows 为 `.zip`），并生成 `CANDIDATE.json`、`SHA256SUMS` 及外置 `.sha256` 校验文件。
- **`tools/release/probe-native.mjs`**：将候选归档解压至工作树外的独立目录，在清空 `PATH` 且阻断外部网络同步的条件下直接启动原生二进制，验证：
  1. 程序自动从相邻的 `bin/../data` 加载内置备用数据并完成中文查询；
  2. 当用户数据目录中存在完整数据时，优先读取用户数据，且运行全过程不修改安装目录内的任何文件（校验前后全部文件 SHA-256 不变）。

---

## 2. 跨平台产物汇总（`collect.mjs`）

在 CI 发布流水线（[`.github/workflows/release-rust.yml`](../../.github/workflows/release-rust.yml)）中，5 个原生平台 runner 与 2 个 Linux Docker runner 完成构建和自检后，由汇总步骤调用 `node tools/release/collect.mjs artifacts/incoming` 生成统一的发布目录 `artifacts/release/`：

1. **一致性与完整性校验**：
   - 校验 `candidate-<五平台>`、`npm-<五平台>`、`pypi-<五平台>` 与 `docker-<两Linux架构>` 全部来自同一个干净的 Git Commit SHA 与同一个 `Cargo.toml` 版本号；
   - 校验每份原生归档、npm tarball、PyPI Wheel 与 Docker 镜像的 SHA-256 均与其运行验证回执（`*-evidence.json`）严格绑定；
   - 校验 5 个平台各自生成的共享 npm 包（`prts-mcp`、`prts-mcp-ts`、`@3akhp/prts-mcp-runtime`、`@3akhp/prts-mcp-data`）在归一化可执行权限位与 gzip 头后字节完全一致。
2. **内部完整快照**：
   - 5 个平台的原生候选归档包（`.tar.gz` / `.zip`）及其 `.sha256`；
   - 9 个唯一 npm tarball（`.tgz`）；
   - 5 个平台的 PyPI 原生 Wheel（`.whl`）；
   - 2 个 Linux 架构的 Docker 镜像归档（`.docker.tar.gz`）及其 `.sha256`；
   - 各平台构建/运行验证回执、顶层 `RELEASE.json` 与总 `SHA256SUMS`。
3. **公开附件（`github/`，共 7 项）**：
   - 5 个原生安装包，文件名为 `prts-mcp-<version>-<platform>.tar.gz`（Windows 为 `.zip`）。公开文件名移除 `-candidate`，macOS 使用 `macos-arm64` / `macos-x64`；归档字节与内部候选包一致，内部平台标识与 npm 包名保持 `darwin-*`。
   - `prts-mcp-<version>-release-metadata.zip`，包含构建/运行验证 JSON、原始 `RELEASE.json`、原始完整快照校验清单，以及记录公开文件名与候选文件名、哈希对应关系的 `PUBLIC-ASSETS.json`。
   - `SHA256SUMS`，覆盖上述 5 个安装包与 metadata ZIP。顶层完整快照的 `SHA256SUMS` 还覆盖整个 `github/` 子目录；ZIP 内保留加入公开附件前的校验清单，避免循环哈希。

公开附件由汇总阶段使用 `zip` 预先生成。npm tarball 仅经 npm 分发，PyPI Wheel 经 PyPI 分发，Docker 镜像经 GHCR 分发；三者均保留在内部快照中供发布与重试使用。

汇总生成的 `rust-release-candidate` 工件是原生归档、npm、PyPI 与 Docker 发布任务的唯一输入源；这些任务只读取并复核该工件，绝不重新编译或重新打包。Cargo 源码候选单独生成，见第 5 节。

---

## 3. 版本门禁与发布开关

### 版本与分支门禁

- **单一版本源**：`Cargo.toml`、`Cargo.lock` 与 Git tag（去掉前缀 `v`）必须完全一致。带有 `-dev.0` 后缀的开发版本仅用于开发分支 CI，拒绝公开发布。
- **3.x 预发布分支策略（`-alpha.N` / `-beta.N` / `-rc.N`）**：
  - 3.x 预发布版本从已审查的 `develop` 快照拉出 `release/v3.x.y-alpha.N`（或 `-beta.N` / `-rc.N`）短分支，经独立审查与 PR 完整 CI 验证后，在该发布分支提交上打 `v3.*` tag 触发发布。
  - 预发布分支不提前合入 `main`，也不将 `develop` 长期停留在预发布版本号。
- **正式版发布**：稳定版 tag（`v3.x.y`）要求提交位于 `main` 分支，且仓库变量 `RUST_STABLE_RELEASE_ENABLED=true` 已开启。

### 渠道控制变量

`release-rust.yml` 通过仓库级变量（Repository Variables）控制实际外部发布动作：

| 仓库变量 | 作用 |
| --- | --- |
| `RUST_NPM_PUBLISH_ENABLED` | 设为 `true` 时执行 `publish-npm` 任务（通过 GitHub OIDC Trusted Publishing 发布 9 个 npm 包）。 |
| `RUST_NON_NPM_PUBLISH_ENABLED` | 设为 `true` 时执行 `publish-non-npm` 任务（推送 GHCR 双架构镜像并创建 GitHub Release）。 |
| `RUST_CRATES_PUBLISH_ENABLED` | 设为 `true` 时启用 `publish-crates` 任务（通过 OIDC 发布至 `crates.io`）；未设置时跳过该发布任务，但仍执行源码安装验证。 |
| `RUST_PYPI_PUBLISH_ENABLED` | 设为 `true` 时在正式版或预发布 tag push 事件中启用 `publish-pypi` 任务（通过 OIDC 发布 5 个平台的 PyPI 原生 Wheel）；默认关闭。 |
| `RUST_STABLE_RELEASE_ENABLED` | 稳定版总闸门；设为 `true` 时允许发布不带预发布后缀的 `v3.x.y` 正式版并推进稳定渠道标签。 |

---

## 4. 各渠道发布顺序与标签保护

1. **npm（9 包有序发布）**：
   - 使用 Node 24 与 `npm >= 11.21.0` 通过 OIDC provenance 签名按依赖顺序发布：`5 个平台包 → @3akhp/prts-mcp-data → @3akhp/prts-mcp-runtime → prts-mcp & prts-mcp-ts`。
   - 预发布版本显式使用 `--tag next` 发布，并在 30 分钟传播窗口内轮询确认 registry 上的版本 `integrity` 与 `next` 标签均已就位，同时核验 `prts-mcp-ts` 的 `latest` / `lts-2.8` / `lts-1.7` 等既有标签未被改动。
   - 正式版（自 `3.0.0` 起）以 `--tag latest` 发布并确认 `latest` 就位，其余既有标签（包括 `next`）保持不变。
   - *注：npm registry 要求每个新创建的包名必须拥有 `latest` dist-tag；8 个 3.x 新增包名在首次注册时自动生成的占位 `latest` 标签在 M5 前保持不动，候选期安装请始终显式指定 `@next` 或精确版本号。*
2. **GHCR（双架构容器镜像）**：
   - 加载经过验证的 `linux-x64` 与 `linux-arm64` 镜像归档，校验 Image ID 与架构后推送单架构标签，并合成多架构 manifest（预发布为 `:3.x.y-...` 与 `:next`；正式版为 `:3.x.y`、`:3` 与 `:latest`，不更新 `:next`）。
3. **GitHub Releases**：
   - 仅上传 `artifacts/release/github/` 中预生成的 7 项附件；预发布版本自动标记为 `--prerelease --latest=false`，正式版以 `--latest=true` 发布。
   - 发行说明直接取自中英文 `CHANGELOG` 中与发布版本精确对应的段落，并附平台下载表、精确版本的安装命令和迁移指南链接；发布分支须先将 `Unreleased` 更新为对应版本及日期。

如果在发布过程中遇到网络抖动、registry 传播延迟或单个渠道任务失败，请勿重新打 tag 或全量重跑构建，应直接按照 [`RELEASE-CD-RECOVERY.md`](RELEASE-CD-RECOVERY.md) 在原始 workflow run 上重跑失败的发布任务（`Re-run failed jobs`）。

## 5. Cargo 源码发行

[`cargo-source.yml`](../../.github/workflows/cargo-source.yml) 在 Linux `x64` 从同一提交生成 `cargo-source-candidate` 工件（包含 `.crate` 归档与 `SOURCE.json`）。`node tools/cargo/verify.mjs` 在工作树外解包并执行默认 `cargo install`，核对仅包含六个公开入口（含 `prtsctl`），随后验证 `stdio`、HTTP、协议版本、离线夹具查询与进程退出。源码包包含原生 C 源码、契约声明与许可证，不包含备用游戏数据。终端用户安装命令为 `cargo install prts-mcp --locked --bin prts-mcp`（需 `Rust >= 1.89` 与 C 编译器），首个上架版本为 `3.2.1`。

Cargo 渠道的发布与校验遵循以下流程：

1. **首次人工引导与后续 OIDC 发布**：
   - 首次注册使用维护者本地 Cargo 登录凭据：在正式 tag 的干净检出目录完成源码验证后，以该 tag 设置 `GITHUB_REF`，并传入 `RUST_STABLE_RELEASE_ENABLED=true` 与 `RUST_CRATES_PUBLISH_ENABLED=true` 运行 `node tools/cargo/publish.mjs`（若本机需绕过显式代理变量，可设置 `PRTS_CARGO_DIRECT=true`）。
   - 首次发布成功后，在 `crates.io` 后台为仓库 `3aKHP/prts-mcp`（工作流 `release-rust.yml`、环境 `rust-release`）绑定 Trusted Publisher，并将仓库变量 `RUST_CRATES_PUBLISH_ENABLED` 设为 `true`；后续版本由 CI 通过短期 OIDC 凭据自动发布。
2. **源码重打包校验与幂等保护**：
   - 由于 `cargo publish` 会在发布阶段重新生成 `.crate` 归档，`tools/cargo/publish.mjs` 强制要求当前提交、Cargo 版本与干净工作树状态与候选阶段完全一致，且重新打包的 SHA-256 必须与已通过安装验证的 `cargo-source-candidate` 完全吻合后才允许上传（npm、PyPI、Docker 与原生归档仍保持不重新打包）。
   - 上传完成后脚本直接读取 `crates.io` 注册表索引核对实际 SHA-256；若远端已存在相同版本且摘要一致则幂等跳过，若摘要冲突或版本已被 yank 则立即报错中止。
3. **跨渠道编排顺序**：
   - `cargo-source` 验证通过后才允许启动 `publish-npm`；当启用 `RUST_CRATES_PUBLISH_ENABLED=true` 时，GitHub Release 与 GHCR 发布任务（`publish-non-npm`）还会等待 `publish-crates` 成功。

---

## 6. PyPI 原生候选与发布流程

五大平台 CI 在完成原生 ABI 审计后，通过 `tools/pypi/`（依赖由 `tools/pypi/uv.lock` 锁定）构建并验证五平台原生 Wheel：

```bash
uv run --locked --project tools/pypi python tools/pypi/pack.py linux-x64
uv run --locked --project tools/pypi node tools/pypi/probe.mjs linux-x64
```

- **候选内容与运行契约**：
  - 产出目录为 `artifacts/pypi/<platform>/`，包含平台 `.whl`、来源与摘要清单及实际安装运行回执；`collect.mjs` 汇总时会核对全部五个平台 Wheel 以及包内服务器与管理二进制各自的 SHA-256。
  - Wheel 要求 `Python >= 3.11`，提供 `prtsctl` 管理入口，并保留默认 `stdio` 的 `prts-mcp` 命令与 `python -m prts_mcp.server` 模块入口。包内不包含备用游戏数据或 Python 业务依赖，游戏数据由首次启动同步或本地路径变量（`PRTS_DATA_DB`、`GAMEDATA_PATH`、`STORYJSON_PATH`）提供。架构背景见 [ADR-0020](adr/ADR-0020-pypi-native-wheels.md)。
- **发布开关与 OIDC 校验（`publish-pypi`）**：
  - 仓库变量 `RUST_PYPI_PUBLISH_ENABLED` 默认关闭（当前公开 PyPI `latest` 仍为 `2.8.x` LTS）；显式设为 `true` 后，正式版或预发布 tag 的 `push` 事件会执行 `publish-pypi` 任务（手动 `workflow_dispatch` 不触发上传）。
  - 发布任务下载 `rust-release-candidate` 快照，在上传前先查询 PyPI JSON API：若远端已存在同文件名且 SHA-256 一致的 Wheel 则自动跳过，仅补传缺失平台的 Wheel；若摘要冲突或文件已被 yank 则立即中止。
  - 通过校验后，使用 PyPA 官方发布 Action 配合 GitHub OIDC Trusted Publisher（工作流 `release-rust.yml`、环境 `rust-release`）及 PEP 740 attestations 上传，并在有界时间窗口内轮询确认 PyPI JSON 索引中的版本号、`Requires-Python`、依赖声明与全部五个 Wheel 的 SHA-256 均已就位。启用该开关时，`publish-non-npm` 会等待 `publish-pypi` 成功后方才执行。
