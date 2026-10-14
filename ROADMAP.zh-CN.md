# PRTS-MCP 路线图

当前公开稳定版仍为 2.8.1；下一开发目标为 3.0.0-dev.0：以 Rust 统一业务技术栈，保留固定 TS/v2.8.1 产品契约。[English](ROADMAP.md)。

## 3.0 迁移

| 阶段 | 工作 |
| --- | --- |
| M0 | 冻结首发范围、入口、根目录布局、LTS 与分发决策。已完成。 |
| M1A | 保留 lts/2.8，并隔离旧线发布与稳定 latest。已完成。 |
| M1B | 导入 Rust 历史，建立根 Cargo 工程，移除旧源码目录，同步最低可用 CI/脚本/文档。已完成，PR #228 已合并。 |
| M2A/B/C | 五平台原生构建和运行，共享 npm 平台产物及两个入口包，双架构 Docker。已完成。 |
| M3 | 候选产物、单一版本检查和隔离的公开发布自动化。已完成，alpha.3 已公开。 |
| M4 | 实际候选发行物、真实 MCP 客户端、旧卷升级与回滚；Windows 和/或 WSL 完整 E2E。 |
| M5 | 收口 RC，正式发布 3.0，切换 latest，回灌开发线。 |

M2A PR #229 和 data/ 源码清理 PR #230 已合并；基线和实际证据见[原生平台说明](docs/dev/NATIVE-PLATFORMS.md)。M2B 的 npm 双入口、共享原生包和校验备用数据已通过五个平台的实际安装与运行验证，见[npm 分发说明](docs/dev/NPM-DISTRIBUTION.md)和[验收记录](docs/dev/reports/3.0-m2b-npm-distribution.md)。M2C Docker/旧卷包装已通过原生 x64/ARM64 范围内运行验证，见[Docker 分发说明](docs/dev/DOCKER-DISTRIBUTION.md)和[验收记录](docs/dev/reports/3.0-m2c-docker-distribution.md)。

M3 已完成：[3.0.0-alpha.3](https://github.com/3aKHP/prts-mcp/releases/tag/v3.0.0-alpha.3)九包实际OIDC/provenance、双原生GHCR、公开范围内安装通过，见[验收与边界](docs/dev/reports/3.0-m3-candidate-release.md)。M4 与 data/ 分发运行验收已按维护者接受的范围收口，[报告](docs/dev/reports/3.0-m4-e2e.md)保留未验证范围、两次执行事故及本地修复记录。文档恢复由维护者亲自主持，文档专场与 M5 尚未启动。

追加两项 3.0 正式发布门禁：单独整理文档，恢复并更新 2.x 仍适用的内容覆盖；重新确定 data/ 的源码、分发和运行时方案并验证。两项在 M2A 之后推进，不打断当前工作，必须在正式发布前收口；影响 npm/Docker/候选产物的 data/ 决策须在对应产物验收前落实。

决策、边界和验收详见[迁移计划](docs/dev/plans/3.x-rust-migration.md)。M1B 不代表公开发行或五平台支持；完整真机 E2E 是本次选择在 M4 执行的迁移验收，不改变通用工作流的非硬门禁政策。

## 3.0 之后

管理 CLI、新工具/数据域、公开招募反查、图片/PNG 工作、缓存/存储评估、数据容灾和 AKDP 协作均后置。[旧路线图档案](docs/dev/legacy/2.x/ROADMAP.zh-CN.md)中其余仍有价值的候选继续作为积压事项，不保留 2.9 或 3.0 交付承诺。M5 后一次选一个主题重排优先级。

M1–M2 准备独立 Cargo 源码包；crates.io 在 M5 后作为独立渠道任务上架，不阻塞 3.0，不必等 3.1，也不扩展成 SDK 项目。

## 维护政策

lts/2.8 与 lts/1.7 的 EOL 同为 2027-07-02，只接受维护修复，不推进稳定 latest；历史版本/tag 保持原样。协议和兼容性政策见 [VERSIONING](docs/dev/VERSIONING.md)，旧线规则见 [LTS](docs/dev/LTS.md)。适用于 Rust 的旧线修复逐项移植，不整体合并旧源码分支。
