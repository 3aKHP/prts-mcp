# ADR-0020：PyPI 原生 Wheel 与兼容启动桥

- 状态：Accepted
- 决策日期：2026-11-02
- 关联：[Issue #292](https://github.com/3aKHP/prts-mcp/issues/292)、[Issue #314](https://github.com/3aKHP/prts-mcp/issues/314)、[候选发行流程](../RELEASE-CANDIDATES.md)

## 背景与问题

3.x 已统一为 Rust 实现，PyPI 仍提供旧 Python LTS 包。恢复渠道需要保留历史启动方式，并复用既有五平台构建和 ABI 审计。本次维护者批准先实现候选构建与验证，等待最小 CLI 后统一发布。

## 备选方案

- 五个平台 Wheel 各内置备用数据或依赖共享数据包：未采用。沿用历史 PyPI 轻量策略，由运行时同步或用户提供数据。
- 纯二进制命令：可减少启动代码，但无法保留 Python 模块入口；维护者选择标准库薄桥。
- Maturin 重新编译、PyO3 绑定或安装时下载程序：未采用。现有原生候选已经持有所需程序，使用 Hatchling 封装即可。

## 决定

五平台 Wheel 使用产品版本，要求 Python >=3.11，不发布 sdist，不包含数据包依赖。Python 薄桥仅定位包内程序、传递参数和标准流、管理退出；业务与同步由 Rust 持有。这是分发层允许的明确例外，不恢复 Python 业务实现。

公开入口为 `prts-mcp`、`prts_mcp.server:main` 和 `python -m prts_mcp.server`，调用原始 `prts-mcp-ghcr` 程序，保持默认 stdio 和显式 HTTP 的历史语义。POSIX 使用 exec，Windows 复用父进程监测。原生和 npm 主入口仍默认 HTTP。

打包只消费同一提交、同一版本的已审计二进制。五平台安装证据与实际 Wheel 一同进入候选快照。发布身份采用 release-rust.yml 与 rust-release，旧 LTS 身份保留。公开发布默认关闭，不打测试 tag、不补发 3.2.1；真实 OIDC 上传由后续正式发布验收。

## 后果

Python 生态可安装同一 Rust 服务，同时保留常见模块启动方式。首次没有本地数据时需要同步；完全离线使用需预先提供数据。旧通用 Wheel 仍可能被不支持新平台的安装器选中，新版安装说明需使用 `prts-mcp>=3,<4` 或精确版本范围。

候选构建完成不等于公开上架。五平台运行验收与真实发布回执必须分别记录；最小 CLI 合入后需重新验证最终安装包的版本和帮助入口。
