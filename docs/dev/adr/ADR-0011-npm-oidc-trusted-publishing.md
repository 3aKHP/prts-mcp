# ADR-0011：npm 渠道的 OIDC Trusted Publishing、Node 启动桥与免常设探测门禁

- 状态：Accepted（补录）
- 决策日期：2026-10-13（设计与落地；子决策日期分别注于正文）
- 关联：PR [#231](https://github.com/3aKHP/prts-mcp/pull/231)/[#234](https://github.com/3aKHP/prts-mcp/pull/234)/[#239](https://github.com/3aKHP/prts-mcp/pull/239)/[#242](https://github.com/3aKHP/prts-mcp/pull/242)、[CHANGELOG 3.0.0](../../../CHANGELOG.zh-CN.md)、[release-rust.yml](../../../.github/workflows/release-rust.yml)、[NPM-DISTRIBUTION.md](../NPM-DISTRIBUTION.md)、[RELEASE-CANDIDATES.md](../RELEASE-CANDIDATES.md)

> 补录说明：本决策落地于 ADR 目录建立之前（3.0 发布窗口），机制至今现役且档案库无逐条记录，按本目录的补录例外整理自决策期间（2026-10-13 至 2026-10-16）的内部工作记录与公开 git 历史。本篇合并记录三条同属 npm 分发身份的子决策：OIDC 发布、Node 启动桥、免常设探测门禁。

## 背景与问题

3.0 统一为原生 Rust 后，npm 渠道不再分发 TypeScript 业务源码，分发形态与发布身份需要重建：共 9 个同版本包（5 个平台包、`@3akhp/prts-mcp-data`、`@3akhp/prts-mcp-runtime`、`prts-mcp`、`prts-mcp-ts`），其中 8 个是新注册包名。外部背景是 npm 当时正收紧绕过 2FA 的令牌，长期 `NPM_TOKEN` 属供应链薄弱点；2.x TypeScript 线已于 2026-04-10 完成 token 到 OIDC 的切换（CHANGELOG 0.2.0 条目）。

另有两个结构性约束：npm 要求包已存在才能配置 Trusted Publisher（首次建包的引导问题）；预发布实测暴露了 npm 服务端异步校验的摩擦——版本与标签可读性滞后（有包超过 20 分钟才公开），且 `npm dist-tag rm latest` 返回 E400（registry 契约要求 `latest` 必须存在）。

## 备选方案

以下裁决除标注外均有当时书面记录：

- **长期 NPM_TOKEN（Granular Access Token）**：否决。2.x 线 2026-04-10 已用同一理由完成切换；3.x 沿用该模式。
- **首次建包走 CI 自动注册**：否决（npm 要求包先存在）；**空占位包**亦否决。3.0.0-alpha.1 由维护者以审核后的真实 tarball 人工发布并浏览器 2FA 批准，明确记录“首次人工发布不作为 OIDC 成功证据”，自 alpha.2 起以真实新版本验证 OIDC。
- **postinstall 下载二进制或用户机现场编译**：否决。二进制通过 npm 平台包分发，不另造依赖 GitHub 下载或本机编译的正常安装路径。
- **保留 JS/TS 业务回退**：否决（PR #231 正文明文 “No JS/TS business fallback is introduced”）。
- **强制清理 8 个新包的自动 `latest` 别名**：在 alpha.2 实测 E400 后否决；改为冻结全部既有标签、预发布只推进 `next`（PR #239）。
- **常设临时标签 ADD/RM 探测门禁**：曾引入以证明独立 dist-tag 写权限，2026-10-14 维护者指出该验证投入已偏离目标，PR #242 移除；维护者规则为“除真实事故外不新增独立验证门禁；正常切换直接操作目标标签并确认实际结果”。
- **以 `npm trust` CLI 配置九个 publisher**：未采用。当时固定的 npm 版本未暴露独立的 dist-tag 权限开关，改用 npm 网页逐包配置。

事后推断（无当时文字记录，如实标注）：启动桥默认 Node 而非 Bun 没有独立的选型对比记录——可确证的实现事实是 bin shim 以 `#!/usr/bin/env node` 启动、engines 要求 Node ≥ 22、CI 仅覆盖 Node 桥；“npm 生态 bin 以 Node shebang 启动、Bun 非常驻于用户机”的论证属事后推断。固定 `npm@11.21.0` 的遴选过程亦无记录。

## 决定

**OIDC Trusted Publishing**（2026-10-13 设计，2026-10-14 真实验证收口）：

- 发布任务 `publish-npm`（[release-rust.yml](../../../.github/workflows/release-rust.yml)）：`environment: rust-release`、`permissions: id-token: write`、显式安装固定 `npm@11.21.0`，无 `NPM_TOKEN`。
- 9 个包在 npm 后台绑定 Trusted Publisher（owner/repo/workflow/environment 四要素），publish 与 dist-tag 两项独立权限均开启；`rust-release` 环境的部署策略仅允许 `v3.*` tag，不设额外人工审批；旧 `cd-ts.yml` 的 LTS 身份保留不替换。
- 发布顺序按依赖序：5 平台包 → `@3akhp/prts-mcp-data` → `@3akhp/prts-mcp-runtime` → `prts-mcp` 与 `prts-mcp-ts`；预发布 `--tag next`、正式版 `--tag latest`；[tools/release/publish-npm.mjs](../../../tools/release/publish-npm.mjs) 在 30 分钟窗口内轮询确认版本 integrity 与目标标签就位，既有标签逐项冻结核验，同版且 integrity 一致则幂等跳过、仅修复缺失标签。

**Node 启动桥，终端用户无需 Bun**（2026-10-13 落地，Bun 兼容裁定 2026-10-15）：

- `@3akhp/prts-mcp-runtime` 为共享薄启动桥（[packaging/npm/runtime.cjs](../../../packaging/npm/runtime.cjs)，纯 Node CJS 零依赖），按 os/cpu/libc 解析平台包与数据包后 spawn Rust 二进制；POSIX 信号转发、退出码与信号终止镜像；Windows 传 `--launcher-parent-pid` 由 Rust 侧监听父进程句柄退出。
- 环境要求 Node ≥ 22、npm ≥ 10、Linux glibc ≥ 2.28（运行时校验）；`--ignore-scripts` 可正常安装。
- `prts-mcp-ts-bun` 仅保留命令名兼容旧启动脚本，实际同样运行 Rust 二进制；既有 Bun 部署可显式沿用，Node 为兼容路径（2026-10-15 维护者裁定申明：原有“Bun 优先、Node 作为兼容性回退”的部署意图不变）。

**免常设探测门禁**（2026-10-14）：

- 发布流水线不含独立的权限/可见性探测门禁；版本与标签的读回确认内嵌于发布脚本本身（30 分钟有界等待）。
- 标签切换与回滚直接操作真实目标标签并确认实际结果；临时标签工具仅保留作真实事故排查。
- 构建期 CI 门禁保留：本地回环 registry 的全量安装探测（[tools/npm/probe.mjs](../../../tools/npm/probe.mjs)）仍在 [native-platforms.yml](../../../.github/workflows/native-platforms.yml) 每平台执行；`npm-install-diagnostics.yml` 为手动诊断流，与发布 workflow 权限隔离。

## 后果

正面：

- 3.0.0-alpha.3（2026-10-14）九包完成真实 OIDC 发布，9 份 SLSA provenance 经 Sigstore 与 TUF 信任根密码学验证；3.0.0 正式版（2026-10-16）九包 `provenance=true`，[CHANGELOG 3.0.0](../../../CHANGELOG.zh-CN.md) 记载 “All nine packages are published with npm OIDC provenance”。npm registry 侧的 provenance 徽章与 dist-tag 状态可由任何人只读复核。
- 发布耗时结构被认清：3.0.0-rc.2 的 npm 步骤约 53 分 53 秒，其中九次 `npm publish` 命令合计约 63 秒，其余为逐包读回与元数据确认（2026-10-15，GitHub-hosted runner 口径）——发布时长的主体是等待 registry 异步校验，而非上传。
- Bun/Node 双桥实测（2026-10-15，生产 Linux x64，`prts-mcp-ts@3.0.0-rc.1`）：HTTP/stdio 初始化、中文查询、信号退出均通过；该结论不扩大为五平台 Bun 全量验证。

负面与遗留：

- 8 个新包名的自动 `latest` 别名按裁决冻结不清理（其中 6 个为 npm 自动生成的 `0.0.0-stage`）。
- 九包的独立 dist-tag 写权限未逐包认领（部分平台包实测成功，未全量证明）。
- alpha.2 的 `dist-tag rm latest` E400 与 alpha.3 的超 20 分钟可读性滞后，分别是“冻结 latest”与“30 分钟有界等待”两条规则的直接成因（保留为失败教训记录）。

材料缺口：启动桥运行时选型与 `npm@11.21.0` 遴选无当时记录（见“备选方案”节标注）；维护者撤销探测门禁的原始指示无逐字原文（两处内部记录互证，且 PR #242 正文记录了该规则）；npm 网页端九包 Trusted Publisher 的配置动作无机器可读凭据，仅以事后 provenance 结果佐证。

公开记录：[release-rust.yml](../../../.github/workflows/release-rust.yml)、[publish-npm.mjs](../../../tools/release/publish-npm.mjs)、[runtime.cjs](../../../packaging/npm/runtime.cjs)、[NPM-DISTRIBUTION.md](../NPM-DISTRIBUTION.md)（9 包架构与启动桥生命周期）、[RELEASE-CANDIDATES.md](../RELEASE-CANDIDATES.md)（渠道开关表）、[RELEASE-CD-RECOVERY.md](../RELEASE-CD-RECOVERY.md)（Trusted Publisher 绑定排障）、[2.x → 3.0 迁移指南](../../migration-2.x-to-3.0.md)（“需 Node >= 22、npm >= 10 作为启动桥，不再需要 Bun”）、[CHANGELOG](../../../CHANGELOG.zh-CN.md) 3.0.0 与 0.2.0 条目。
