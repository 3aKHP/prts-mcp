# Security Policy

[English](#english) | [简体中文](#中文)

<a id="english"></a>

## English

### Supported Versions

PRTS-MCP provides security fixes for the latest stable release line as well as the `1.7` and `2.8` LTS lines.

| Version Line | Security Support |
|--------------|------------------|
| `2.8.x` | Supported as an LTS line through **2027-07-02** (Python and TypeScript maintained on `lts/2.8`). |
| `1.7.x` | Supported as an LTS line through **2027-07-02** for security, compatibility, data-sync, and critical bug fixes. |
| `< 1.7` | End of life; no longer supported. Please upgrade before reporting. |
| `dev` / prerelease (`3.0.0-alpha.*`) | Best-effort fixes on `develop` prior to the stable 3.0.0 release; not a production support line. |

### Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues, pull requests, or discussions.**

Use one of the following private channels instead:

1. Email `cccp1945@vip.qq.com` with the subject prefix `[PRTS-MCP security]`.
2. If GitHub Private Vulnerability Reporting is enabled on this repository, submit a report directly through GitHub's Security tab.

Reports in either English or Chinese are welcome. To help us triage and reproduce the issue quickly, please include as much of the following information as possible:

- **Affected package and version** (Rust native archive, `prts-mcp` / `prts-mcp-ts` npm package, Docker image, legacy Python package, or Git commit/branch).
- **Runtime and transport mode** (Rust `stdio` or Streamable HTTP, legacy Python/TypeScript, Docker, npm, or native binary, plus OS and CPU architecture).
- **Clear reproduction steps** or a minimal proof of concept.
- **Security impact** (for example: path traversal, unsafe archive extraction, unintended local file access, credential exposure, denial of service, or HTTP session/transport vulnerabilities).
- **Sanitized logs and configuration** (with all private tokens and credentials redacted).

### In Scope and Out of Scope

**In scope** (issues in PRTS-MCP code, packaging, or workflows):

- MCP transport handling, session management, or JSON-RPC request parsing.
- Archive download, manifest/SHA-256 verification, ZIP extraction, or cache/generation activation logic.
- Path traversal or unintended local filesystem access.
- Unsafe parsing of PRTS Wiki responses, GameData tables, StoryJson archives, or bundled fallback data.
- Reachable vulnerabilities in locked runtime dependencies.
- Accidental exposure of tokens, credentials, or sensitive host paths in packages, Docker images, CI workflows, or configuration examples.

**Out of scope**:

- Content inaccuracies in upstream Arknights game data or PRTS Wiki articles.
- Availability or rate-limiting of GitHub, PRTS Wiki, third-party mirrors, or external networks.
- Misconfigurations in third-party MCP clients outside this repository.
- Vulnerabilities affecting only unsupported versions (`< 1.7`).
- Automated scanner output that does not demonstrate a concrete impact on PRTS-MCP.

### Coordinated Disclosure

We aim to acknowledge valid security reports within **7 days** and will coordinate a remediation and release timeline based on severity and affected version lines. Fixes are published as patch releases on the latest stable line and, where applicable, on supported LTS lines.

Please allow reasonable time for investigation and patch publication before disclosing an issue publicly. If you would like to be credited in the release notes or security advisory, please let us know in your report.

This project is a non-commercial community project and does not offer a paid bug bounty program.

---

<a id="中文"></a>

## 中文

### 受支持的版本

PRTS-MCP 为最新稳定版本线以及 `1.7`、`2.8` 两条 LTS 长期支持线提供安全修复支持。

| 版本线 | 安全支持状态 |
|--------------|------------------|
| `2.8.x` | 作为 LTS 维护线支持至 **2027-07-02**（Python 与 TypeScript 实现在 `lts/2.8` 分支维护）。 |
| `1.7.x` | 作为 LTS 维护线支持至 **2027-07-02**，支持范围涵盖安全性、兼容性、数据同步与关键缺陷修复。 |
| `< 1.7` | 已停止支持，请先升级至受支持版本后再行验证和报告。 |
| `dev` / 预发布版本（`3.0.0-alpha.*`） | 在 3.0.0 正式版发布前于 `develop` 分支尽力修复，但不属于生产支持线。 |

### 报告安全漏洞

**请勿通过公开的 GitHub Issue、Pull Request 或 Discussion 披露安全漏洞。**

请通过以下私密渠道之一提交报告：

1. 发送邮件至 `cccp1945@vip.qq.com`，邮件主题请以 `[PRTS-MCP security]` 开头。
2. 若本仓库开启了 GitHub Private Vulnerability Reporting，也可直接通过仓库 Security 标签页下的私密报告通道提交。

报告可使用中文或英文撰写。为便于快速复现与评估，请尽量附上以下信息：

- **受影响的发行包与版本号**（Rust 原生归档包、`prts-mcp` / `prts-mcp-ts` npm 包、Docker 镜像、旧版 PyPI 包或源码分支/Commit）。
- **运行环境与传输模式**（Rust `stdio` 或 Streamable HTTP、旧版 Python/TypeScript、Docker / npm / 原生二进制，以及操作系统与 CPU 架构）。
- **清晰的复现步骤**或最小概念验证（PoC）。
- **潜在安全影响**（例如：路径穿越、不安全的归档解压、非预期的本地文件读写、凭据泄露、拒绝服务或远程传输/会话隔离缺陷）。
- **脱敏后的日志与配置**（请务必先移除个人 Token 与敏感路径）。

### 受理范围

**在受理范围内**（PRTS-MCP 自身代码、打包或工作流中的安全问题）：

- MCP 传输层处理、HTTP 会话管理或请求解析缺陷。
- 数据归档下载、manifest / SHA-256 校验、ZIP 解压或缓存代际激活中的安全漏洞。
- 路径穿越（Path Traversal）或非预期的本地文件访问。
- 对 PRTS Wiki 响应、GameData 表格、StoryJson 归档或内置备用数据的不安全解析。
- 在正常使用服务时可被实际触发的依赖项安全漏洞。
- 发行包、Docker 镜像、CI 工作流或配置示例中意外泄露的 Token、凭据或敏感路径。

**通常不在受理范围内**：

- 上游游戏数据、剧情文本或 PRTS Wiki 词条内容本身的事实错误。
- GitHub、PRTS Wiki、第三方镜像站等外部服务的可用性或限流问题。
- 本仓库之外的第三方 MCP 客户端配置失误。
- 仅影响已停止支持版本（`< 1.7`）的问题。
- 未能说明对 PRTS-MCP 实际触发路径与影响的自动化扫描报告。

### 协调披露

我们会在收到有效报告后的 **7 天内**予以确认，并根据漏洞严重程度与受影响版本线协调修复和发版计划。安全修复通常会以补丁版本发布至最新稳定线及受影响的 LTS 维护线。

在漏洞修复版本正式发布前，请给予维护者合理的调查与修复时间，暂勿公开披露漏洞细节。如希望在发行说明或安全公告中署名致谢，请在报告中一并说明。

本项目为非商业社区同人项目，目前不设漏洞奖金计划（Bug Bounty）。
