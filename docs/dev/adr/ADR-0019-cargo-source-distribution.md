# ADR-0019：Cargo 源码发行与首次发布引导

- 状态：Accepted
- 决策日期：2026-11-01
- 关联：[PR #317](https://github.com/3aKHP/prts-mcp/pull/317)、[Issue #314](https://github.com/3aKHP/prts-mcp/issues/314)、[候选发行流程](../RELEASE-CANDIDATES.md#5-cargo-源码发行)、[ADR-0011](ADR-0011-npm-oidc-trusted-publishing.md)

## 背景与问题

Rust 服务器已通过 npm、GHCR 和原生归档发布，crates.io 仍是待补渠道。已有 CI 验证 Cargo 源码归档可以构建，但尚未验证用户从该归档默认安装的入口集合。原清单会同时发布五个公开入口与内部测试程序 `prts-mcp-rust`。

源码发行还需要处理两个与预编译渠道不同的条件：Cargo 发布会重新打包源码；crates.io 当前要求先发布真实 crate，之后才能配置 Trusted Publishing。新增渠道需要复用既有版本与发布规则，并明确这两项差异。

## 备选方案

- **直接开放现有 Cargo 清单发布**：改动最少，但会安装内部测试入口，也不能证明归档独立安装和运行，未采用。
- **通过非默认 feature 隔离测试入口**：能够限制默认安装，但会要求调整既有测试与差分命令。实际打包验证表明，Cargo 能自动从归一化清单中移除被 `include` 排除的入口，因此采用仅排除发行文件的方式，保留工作树中的测试行为。
- **长期保存 API Token 供 CI 发布**：可以覆盖首次与后续版本，但增加常驻凭据维护。采用首次 Token 引导、后续 OIDC 的两阶段方式，延续 ADR-0011 的发布身份方向。
- **自行实现 crates.io 归档上传协议**：可直接上传候选文件，但会新增一套 Cargo 已提供的发布逻辑。采用 Cargo 原生命令，并对其重新打包结果核对摘要。

## 决定

1. 根包 `prts-mcp` 作为源码安装渠道，沿用产品版本。归档保留五个公开入口、构建需要的 C 源码、契约与许可证，排除内部测试入口。源码包不带备用游戏数据，不新增稳定 Rust SDK 承诺。
2. 从实际 `.crate` 在仓库外执行默认 `cargo install --locked`，检查安装入口集合，再复用原生 stdio、HTTP、协议和退出探测。记录归档摘要、源码提交、Cargo 版本与安装验证结果。首期自动独立安装验证运行于 Linux x64；不能将现有其他平台的原生构建验证冒充其源码包安装验证。
3. 首次发布使用维护者的 Cargo 凭据发布经过验收的真实版本。注册后绑定仓库、发布 workflow 与 release 环境，启用独立的 crates.io 发布开关，再撤销引导 Token。首次 Token 发布不作为 OIDC 成功证据。
4. 原生归档、npm 和 Docker 继续直接使用既有候选快照。Cargo 源码发布允许在相同干净提交与相同 Cargo 版本上重新打包，但上传前生成的摘要必须与已安装候选一致，上传后注册表索引摘要也必须一致。这是源码渠道的限定例外，不允许重新构建其他渠道来恢复发布。
5. 发布脚本沿用已有 tag、分支和稳定版开关检查，拒绝开发版本。已有同版同摘要时跳过上传；摘要冲突或 yanked 版本中止。部分渠道失败时复用原始候选恢复，不覆盖已有不同内容，不增加常设权限探测发布。

## 后果

Cargo 用户可选择源码安装，代价是需要 Rust >=1.89 与 C 编译环境，并自行等待首次数据同步或提供离线数据。默认安装不包含测试程序，本地现有测试命令保持可用。

发行流程增加源码候选和独立发布任务。普通 Linux CI 执行真实安装；源码候选通过后才允许 npm 发布，启用 crates.io 自动发布时，GHCR 与 GitHub Release 还需等待该渠道成功。首次人工引导期间，维护者单独核对 Cargo 发布回执。

PR #317 的本地验证已完成归档外安装、五个公开入口的 8 项探测，以及干净提交的重复打包摘要核对。首次真实发布、后续 OIDC 发布与其他平台的独立源码安装仍待各自验收。正式流程与恢复步骤分别由[候选发行流程](../RELEASE-CANDIDATES.md#5-cargo-源码发行)和[恢复手册](../RELEASE-CD-RECOVERY.md)维护。

外部依据：[Cargo 发布行为](https://doc.rust-lang.org/cargo/commands/cargo-publish.html)、[crates.io Trusted Publishing](https://crates.io/docs/trusted-publishing)。
