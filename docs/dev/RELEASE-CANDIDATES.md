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

- **`tools/release/pack-native.mjs`**：将 `artifacts/native/<platform>/` 中的 5 个原生可执行文件、ABI/构建清单、完整第三方许可证与经过校验的只读备用数据（`data/`）合并打包为 `prts-mcp-<version>-<platform>-candidate.tar.gz`（Windows 为 `.zip`），并生成 `CANDIDATE.json`、`SHA256SUMS` 及外置 `.sha256` 校验文件。
- **`tools/release/probe-native.mjs`**：将候选归档解压至工作树外的独立目录，在清空 `PATH` 且阻断外部网络同步的条件下直接启动原生二进制，验证：
  1. 程序自动从相邻的 `bin/../data` 加载内置备用数据并完成中文查询；
  2. 当用户数据目录中存在完整数据时，优先读取用户数据，且运行全过程不修改安装目录内的任何文件（校验前后全部文件 SHA-256 不变）。

---

## 2. 跨平台产物汇总（`collect.mjs`）

在 CI 发布流水线（[`.github/workflows/release-rust.yml`](../../.github/workflows/release-rust.yml)）中，5 个原生平台 runner 与 2 个 Linux Docker runner 完成构建和自检后，由汇总步骤调用 `node tools/release/collect.mjs artifacts/incoming` 生成统一的发布目录 `artifacts/release/`：

1. **一致性与完整性校验**：
   - 校验 `candidate-<五平台>`、`npm-<五平台>` 与 `docker-<两Linux架构>` 全部来自同一个干净的 Git Commit SHA 与同一个 `Cargo.toml` 版本号；
   - 校验每份归档、tarball 与 Docker 镜像的 SHA-256 均与其运行验证回执（`*-evidence.json`）严格绑定；
   - 校验 5 个平台各自生成的共享 npm 包（`prts-mcp`、`prts-mcp-ts`、`@3akhp/prts-mcp-runtime`、`@3akhp/prts-mcp-data`）在归一化可执行权限位与 gzip 头后字节完全一致。
2. **汇总输出（共 44 项 GitHub Release 资产）**：
   - 5 个平台的原生候选归档包（`.tar.gz` / `.zip`）及其 `.sha256`；
   - 9 个唯一 npm tarball（`.tgz`）及其 `.sha256`；
   - 2 个 Linux 架构的 Docker 镜像归档（`.docker.tar.gz`）及其 `.sha256`；
   - 各平台构建/运行验证回执、顶层 `RELEASE.json` 与总 `SHA256SUMS`。

汇总生成的 `rust-release-candidate` 工件作为后续所有发布任务的唯一输入源；后续发布任务只读取并复核该工件，绝不重新编译或重新打包。

---

## 3. 版本门禁与发布开关

### 版本与分支门禁

- **单一版本源**：`Cargo.toml`、`Cargo.lock` 与 Git tag（去掉前缀 `v`）必须完全一致。带有 `-dev.0` 后缀的开发版本仅用于开发分支 CI，拒绝公开发布。
- **3.0 过渡期分支策略（M5 前）**：
  - 在 `main` 仍为 `2.8.1` 期间，3.x 预发布版本（如 `v3.0.0-alpha.3`）从已审查的 `develop` 快照拉出 `release/v3.x.y-alpha.N` 短分支，经独立审查与 PR 完整 CI 验证后，在该发布分支提交上打 `v3.*` tag 触发发布。
  - 过渡期内预发布分支不提前合入 `main`，也不将 `develop` 长期停留在 `alpha` 版本号。
- **正式版发布（M5 及以后）**：稳定版 tag（`v3.x.y`）要求提交位于 `main` 分支，且仓库变量 `RUST_STABLE_RELEASE_ENABLED=true` 已开启。

### 渠道控制变量

`release-rust.yml` 通过仓库级变量（Repository Variables）控制实际外部发布动作：

| 仓库变量 | 作用 |
| --- | --- |
| `RUST_NPM_PUBLISH_ENABLED` | 设为 `true` 时执行 `publish-npm` 任务（通过 GitHub OIDC Trusted Publishing 发布 9 个 npm 包）。 |
| `RUST_NON_NPM_PUBLISH_ENABLED` | 设为 `true` 时执行 `publish-non-npm` 任务（推送 GHCR 双架构镜像并创建 GitHub Release）。 |
| `RUST_STABLE_RELEASE_ENABLED` | 稳定版总闸门；在 M5 正式发布前保持关闭，防止预发布期误推进稳定版标签。 |

---

## 4. 各渠道发布顺序与标签保护

1. **npm（9 包有序发布）**：
   - 使用 Node 24 与 `npm >= 11.21.0` 通过 OIDC provenance 签名按依赖顺序发布：`5 个平台包 → @3akhp/prts-mcp-data → @3akhp/prts-mcp-runtime → prts-mcp & prts-mcp-ts`。
   - 预发布版本显式使用 `--tag next` 发布，并在 30 分钟传播窗口内轮询确认 registry 上的版本 `integrity` 与 `next` 标签均已就位，同时核验 `prts-mcp-ts` 的 `latest` / `lts-2.8` / `lts-1.7` 等既有标签未被改动。
   - *注：npm registry 要求每个新创建的包名必须拥有 `latest` dist-tag；8 个 3.x 新增包名在首次注册时自动生成的占位 `latest` 标签在 M5 前保持不动，候选期安装请始终显式指定 `@next` 或精确版本号。*
2. **GHCR（双架构容器镜像）**：
   - 加载经过验证的 `linux-x64` 与 `linux-arm64` 镜像归档，校验 Image ID 与架构后推送单架构标签，并合成多架构 manifest（`:3.x.y-...` 与 `:next`；M5 前不更新 `:latest` 或 `:3`）。
3. **GitHub Releases**：
   - 上传 `artifacts/release/` 中的全部 44 项资产与校验清单；预发布版本自动标记为 `--prerelease --latest=false`。

如果在发布过程中遇到网络抖动、registry 传播延迟或单个渠道任务失败，请勿重新打 tag 或全量重跑构建，应直接按照 [`RELEASE-CD-RECOVERY.md`](RELEASE-CD-RECOVERY.md) 在原始 workflow run 上重跑失败的发布任务（`Re-run failed jobs`）。
