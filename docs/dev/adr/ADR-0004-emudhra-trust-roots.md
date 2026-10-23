# ADR-0004：eMudhra 信任根事件的 3.1.2 安全响应与 LTS 处置

- 状态：Accepted
- 决策日期：2026-10-22
- 关联：[GHSA-gg59-28x8-c9x8](https://github.com/3aKHP/prts-mcp/security/advisories/GHSA-gg59-28x8-c9x8)、[RUSTSEC-2026-0383](https://rustsec.org/advisories/RUSTSEC-2026-0383.html)、[CHANGELOG 3.1.2](../../../CHANGELOG.zh-CN.md)、[tests/emudhra_trust_regression.rs](../../../tests/emudhra_trust_regression.rs)

> 本文整理自决策当日（2026-10-22）的内部评估报告与发布记录；文中验证数字为该日本机验证口径。验证所用的攻击材料按仓库政策不进入 Git 跟踪树。

## 背景与问题

2026-10-17 披露：eMudhra / emSign 下属 8 个中间证书的私钥可从公开证书数据恢复（RUSTSEC-2026-0383 / CVE-2026-111943）。当时 3.0.0 至 3.1.1 的锁文件固定为 `webpki-roots 1.0.9` + `rustls-webpki 0.103.15`：内嵌根库仍信任涉事根证书，验证器尚无针对这些中间证书的 SPKI 封禁。

暴露面覆盖全部出站 TLS 路径：Wiki API、数据同步、GitHub Release 发现与下载、在线立绘；配置 `GITHUB_TOKEN` 时同步请求携带凭据。逐发行版 SHA-256 校验不能缓解该风险，因为 manifest 与载荷走同一条可能被劫持的通道。浏览器的撤销机制不保护独立运行的客户端。

## 备选方案

- **仅升级根库（1.0.10）**：否决。决策当日的十二链验证矩阵显示，用户若额外信任交叉签名的 AAA 根或直接信任受影响中间证书，问题链仍会复活（两种配置下分别接受 6/12、12/12 条问题链）。
- **仅升级验证器（0.103.16）**：当时未留下明确的取舍记录（材料缺口）。事后解释：SPKI 封禁在机制上与根库无关，根库同升的公开理由是遵循上游撤信信号、收缩默认攻击面。
- **切换系统信任库（native-tls 等）**：制度化否决。保持内嵌根库可钉住、跨平台行为一致；回归测试中的锁文件绊线断言不得引入旁路信任库。
- **不发 hotfix、并入常规版本**：否决。按 [CLAUDE.md 路径 C](../../../CLAUDE.md) 从 `main` 走生产紧急修复。
- **2.8 的 Bun 路径以替换 CA 文件规避**：实测否决。Bun 1.3.14 的全局 `fetch` 在显式替换 CA 后仍接受半数问题链，相关环境变量只能追加信任、不能表达撤信。
- **等 Bun 稳定修复版**：搁置。上游修复已合入主线但未进入稳定版；固定 Bun 版本有意不动，采纳过渡方案（Node 入口 + Node 安全下限 + 公开披露 Bun 路径风险），修复版发布后仅需维护提交即可恢复，无需发版。
- **Python 两线仅更新锁文件或仅发新包**：否决。`pip install .` 不使用仓库锁文件，旧版 `certifi` 仍满足宽松约束，已有环境不会被动升级。

## 决定

1. 发布 3.1.2 hotfix：`webpki-roots` 与 `rustls-webpki` 双升级，随附双语安全条目，当日经 PR 合并并打 `v3.1.2` 标签。
2. 在仓库保留专项回归测试 [tests/emudhra_trust_regression.rs](../../../tests/emudhra_trust_regression.rs)：根移除断言、锁文件绊线（版本地板、单版本、无旁路信任库）、SPKI 阻断探针，以及默认跳过的线上金丝雀；套件有效性经“同一套件在旧版本解析下按设计失败”反向验证。
3. 同日回灌 `develop`。
4. `lts/1.7` 发布 1.7.3：`pyproject.toml` 显式声明 `certifi` 安全下限，并收紧 Node 运行时下限。
5. `lts/2.8` 发布 2.8.2：同样的 `certifi` 下限与锁文件更新、Node 下限、TS Dockerfile 钉死安全 Node 版本，并在 README 披露 Bun 路径风险。
6. 公开安全通告 GHSA-gg59-28x8-c9x8（CVSS 3.1：6.5 Medium）。

## 后果

正面：

- 双升级后，三种信任配置下十二条问题链全部以 `CertDistrusted` 拒绝；从公开证书提取的 8 个唯一 SPKI 与新验证器内置封禁数据逐字节匹配。
- 全量验证通过：Rust 测试 311 项、JSON 与 SQLite 两个后端的冻结差分各 384/384；LTS 两线的 Python 与 TS 测试套件全绿。
- 正向控制（合法站点的 TLS 连通）保持正常。
- 从披露到四条分支线全部完成修复发布在一天内完成。

负面与代价：

- **Bun 缺口未关闭**：2.8 默认 Bun 入口在不可信网络下仍有中间人风险，缓解依赖公开披露与用户切换 Node 入口，待 Bun 修复进入稳定版。
- `engines` 与 `certifi` 下限不追溯修复既有部署，需用户显式升级（各 changelog 已声明）。
- 线上金丝雀依赖第三方站点存活，可能出现假阴性。
- 未做 Windows / macOS / ARM 专项验证；Python 侧未做端到端握手验证。
- 自定义镜像若证书链到被除名的 CA，将按预期连接失败（changelog 已声明的预期破坏）。

公开记录：[CHANGELOG 3.1.2](../../../CHANGELOG.zh-CN.md)、[tests/emudhra_trust_regression.rs](../../../tests/emudhra_trust_regression.rs)、[Cargo.toml](../../../Cargo.toml) 回归测试依赖注释、[GHSA-gg59-28x8-c9x8](https://github.com/3aKHP/prts-mcp/security/advisories/GHSA-gg59-28x8-c9x8)、[RUSTSEC-2026-0383](https://rustsec.org/advisories/RUSTSEC-2026-0383.html)。
