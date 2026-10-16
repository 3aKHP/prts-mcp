# CD 发布恢复手册

本手册面向项目维护者，说明当 Rust 发布工作流（[`.github/workflows/release-rust.yml`](../../.github/workflows/release-rust.yml)）在发布中途失败时，如何在**不重新编译、不篡改已发布版本字节**的前提下安全恢复发布。

- 候选发行物的汇总与正常发布流程见 [`RELEASE-CANDIDATES.md`](RELEASE-CANDIDATES.md)
- 2.8.x / 1.7.x 旧版 Python 与 TypeScript 的发布恢复请查阅 [`lts/2.8` 分支上的恢复手册](https://github.com/3aKHP/prts-mcp/blob/lts/2.8/docs/admin/release-cd-recovery.md)

---

## 1. 核心原则：严禁重建覆盖已部分公开的版本

`release-rust.yml` 采用**“先构建汇总、后分渠道发布”**的两阶段设计：
1. 构建与汇总阶段生成唯一且经过完整校验的 `rust-release-candidate` 工件（内含 5 平台原生包、9 个 npm tarball、2 个 Docker 镜像归档及 `RELEASE.json` 哈希清单，并含预生成的 `github/` 公开附件）；
2. `publish-npm` 与 `publish-non-npm`（GHCR + GitHub Release）两个发布任务只读取该工件，核对 SHA-256 后向外发布，绝不现场重新打包。

一旦某个版本的任意一个 npm 包、Docker 镜像或 GitHub Release 资产已经对外公开，该版本的字节内容即视为**不可变（Immutable）**：
- **切勿点击“Re-run all jobs”全量重跑**：全量重跑会重新执行五平台编译和容器构建，导致归档时间戳、OS 基础包或镜像 digest 发生变化，从而与已公开的包产生哈希冲突。
- **始终优先使用“Re-run failed jobs”**：复用原始 run 中已汇总成功的 `rust-release-candidate` 快照，仅重跑失败的发布任务。
- **若源码或打包逻辑本身有误**：不要试图删除已发布的 npm 版本或强推移动 Git tag；请直接修复问题后**递增版本号（如发布下一个 `alpha.N` 或补丁版本）**。

---

## 2. 标准恢复操作步骤

### 第一步：定位失败的原始 Workflow Run

```bash
# 列出最近的 release-rust.yml 运行记录
gh run list --workflow release-rust.yml --limit 5

# 查看失败 run 的具体阶段与报错日志（请替换为实际 Run ID）
release_run_id=38491785379
gh run view "$release_run_id"
```

### 第二步：核查各公开渠道的当前状态

根据报错阶段，使用只读命令检查外部渠道是否已有部分制品公开（请将示例中的版本号替换为当前排查的版本）：

```bash
# 1. 检查 npm 包版本、SRI integrity 与 dist-tag 状态
npm view prts-mcp@3.0.0 version dist.integrity --json
npm dist-tag ls prts-mcp
npm dist-tag ls prts-mcp-ts

# 2. 检查 GitHub Release 已上传的资产列表
gh release view v3.0.0 --repo 3aKHP/prts-mcp
```

### 第三步：在原始 Run 上重跑失败任务

排查并解决外部原因（如等待 npm registry 传播收敛、修正 Trusted Publisher 权限或环境审批）后，在原始 run 上仅重跑失败任务：

```bash
gh run rerun "$release_run_id" --failed
```

（也可在 GitHub Actions 网页端打开该次 run，点击右上角的 **Re-run failed jobs**。）

**发布脚本的幂等恢复机制**：
- **npm（`publish-npm.mjs`）**：按依赖顺序逐包检查。若某包在 registry 上已存在且 `dist.integrity` 与 `rust-release-candidate` 中的 tarball 完全一致，脚本会自动跳过重复上传，仅核对并修复缺失的 dist-tag（如 `next`）。
- **GHCR（`publish-docker.mjs`）**：若远端已存在同版本镜像且 Image ID 一致，复用该镜像；多架构 manifest 按两个原生架构的 digest 核对并补齐。若已有镜像或版本 manifest 不一致则立即报错中止，防止覆盖。
- **GitHub Release（`publish-github.mjs`）**：核验快照中 `github/` 的 7 项公开附件，并逐项比对已上传资产的 SHA-256，仅补传缺失的附件，且绝不使用 `--clobber` 覆盖哈希不匹配的同名文件。

---

## 3. 常见故障分类与处置对照表

| 故障现象 | 原因判断 | 处置方式 |
| --- | --- | --- |
| **npm 上传返回 0，但轮询版本或 dist-tag 超时（404）** | npm 服务端异步校验与 CDN 传播延迟（首发新包有时超过 20 分钟）。 | 先用 `npm view` 观察版本是否已可读；待可读或恢复正常后，直接执行 `gh run rerun <id> --failed` 继续完成剩余包与标签核验。 |
| **npm 版本已可读且 `integrity` 一致，但 `next` 标签未更新** | 包内容已成功落地，仅标签更新步骤中断。 | 执行 `gh run rerun <id> --failed` 让发布脚本自动补齐标签并完成校验（或由维护者手动修正目标 dist-tag）。 |
| **报错 `integrity` / SHA-256 / Docker digest 与远端已有同版本不一致** | 发生了跨 run 重建，或远端已存在不同来源的同名版本。 | **立即停止覆盖尝试**。保留远端已有版本原状，递增版本号发布新版本。 |
| **npm 报 `401` / `403` 或 OIDC Trusted Publisher 拒绝** | npm 包维护者权限、`rust-release` Environment 名称或工作流文件路径配置不匹配。 | 在 npm 后台核对 Trusted Publisher 绑定配置（仓库 `3aKHP/prts-mcp`、工作流 `release-rust.yml`、环境 `rust-release`），修正后重跑 `--failed`。 |
| **工作流在入口 `version-gate` 阶段即被拒绝** | Git tag 与 `Cargo.toml` 版本不一致、提交不在允许的发布分支上，或 M5 前尝试发布稳定版但 `RUST_STABLE_RELEASE_ENABLED` 未开启。 | 属于发布前置门禁拦截（尚未对外发布任何制品）。修正分支/版本后使用新版本重新走发布流程。 |
| **构建或 `collect.mjs` 汇总阶段失败** | 某平台编译/探测未通过，或构建产物缺失。 | 此时尚未进入外部发布阶段。修复代码或 CI 问题后，在新提交上重新准备发布。 |

> **哈希算法核对提示**：比对校验值时请注意区分算法——仓库 `SHA256SUMS` 与 `.sha256` 文件使用 **SHA-256**（十六进制），npm `dist.integrity` 使用 **SHA-512 SRI**（`sha512-...` Base64），而 `dist.shasum` 为 **SHA-1**，三者不可直接跨算法字面比较。
