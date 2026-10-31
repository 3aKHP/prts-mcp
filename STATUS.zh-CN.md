# PRTS-MCP 项目状态

[English](STATUS.md)

## 分支与版本线状态

| 分支 / 版本线 | 当前状态 |
| --- | --- |
| 公开稳定版（`main`） | [`3.2.0`](https://github.com/3aKHP/prts-mcp/releases/tag/v3.2.0)（原生 Rust），已发布至 npm（`latest`）、GitHub Releases 与 GHCR（`:latest`、`:3`）。 |
| 主开发分支（`develop`） | `3.2.0-dev.0`（根目录原生 Rust Cargo 工程）。 |
| `lts/2.8` | Python 与 TypeScript 2.8.x 长期维护线（最新补丁版本 `2.8.2`，功能基线 `2.8.1`，24 个工具）。 |
| `lts/1.7` | Python 与 TypeScript 1.7.x 长期维护线（最新补丁版本 `1.7.3`，功能基线 `1.7.0`，32 个工具）。 |
| LTS 维护截止日（EOL） | `lts/2.8` 与 `lts/1.7` 均维护至 **2027-07-02**。 |

## 3.x 架构与仓库结构

- **运行时**：仓库根目录为原生 Rust 工程，静态链接 C 正则引擎组件（`vendor/quickjs-regexp/`），无需 JavaScript 或 Python 业务运行时。
- **核心能力**：提供 24 个 MCP 工具（`IMAGES_ENABLED=false` 时为 23 个），同时支持传统有状态会话（legacy）与 `2026-07-28` 无状态现代信封（modern）两代 MCP 协议，支持 Streamable HTTP 与 stdio 两种传输方式，并具备感知数据代际激活的游戏表、关卡、剧情与立绘自动同步能力。
- **各入口默认传输方式**：
  - `prts-mcp`（原生二进制与 npm 新主包）：默认使用 Streamable HTTP（`:3000/mcp`）；设置 `PRTS_TRANSPORT=stdio` 切换为 stdio。
  - `prts-mcp-ts`、`prts-mcp-ts-bun`（HTTP）与 `prts-mcp-ts-stdio`（stdio）：底层调用 Rust 二进制，保留 2.x 固定传输行为。
  - `prts-mcp-ghcr`（Docker 镜像默认入口）：保留默认 `stdio`；设置 `PRTS_TRANSPORT=http` 切换为 HTTP。
- **仓库目录结构**：根目录包含 `Cargo.toml`、`src/`、`native/`、`vendor/`、`tests/`、`contracts/`、`tools/`、`packaging/` 与 `Dockerfile`。旧 Python 与 TypeScript 实现在 `lts/2.8` 与 `lts/1.7` 分支独立维护（见 [LTS 维护政策](docs/dev/LTS.md)）。源码许可证与第三方内容版权声明分别见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。

## 3.2 默认 SQLite 与 v2 图片

游戏数据默认使用 SQLite 后端。未设置 `PRTS_DATA_BACKEND`、`PRTS_DATA_DB` 且无自定义 JSON 路径时，DB 就绪前使用 JSON 备用，之后新请求自动切换；显式 SQLite 或设置 `PRTS_DATA_DB` 时保持严格模式，设 `PRTS_DATA_BACKEND=json` 可继续使用既有 JSON 卷。本地图片同步同时支持 v1 与 v2 多分片发布；AKDP 生产图片目前仍为 v1。详见[数据同步说明](docs/admin/data-and-sync.md)。

## 3.1.3 自定义 GitHub 数据源

`PRTS_DATA_SOURCE_REPO=owner/repo` 为数据与本地立绘同步选择兼容仓库。自定义源使用独立目录；默认源部署保留既有路径与数据卷。详见[数据同步说明](docs/admin/data-and-sync.md#自定义-github-数据源)。

## 3.1 SQLite 后端

3.1 默认 JSON，SQLite 为可选后端，通过 `PRTS_DATA_BACKEND=sqlite` 或 `PRTS_DATA_DB` 启用。工具契约与既有 JSON 数据卷保持兼容。

## 3.0 迁移阶段进展

- **M0–M1（基线冻结与根目录导入 — 已完成）**：冻结 TS/v2.8.1 行为对照契约（`contracts/`），完成 `lts/2.8` 发布隔离，将原生 Rust 工程导入仓库根目录并建立 Rust CI 与源码包校验。
- **M2（五平台原生、npm 与 Docker 分发包装 — 已完成）**：
  - **M2A**：完成五大目标平台（`linux-x64`、`linux-arm64`、`windows-x64`、`darwin-arm64`、`darwin-x64`）的原生构建、ABI 审计（Linux `glibc 2.28`、Windows 静态 CRT、macOS `14.0`）与独立归档运行验证（见 [NATIVE-PLATFORMS.md](docs/dev/NATIVE-PLATFORMS.md)）。
  - **M2B**：完成 9 包结构的 npm 分发包装（`prts-mcp`、`prts-mcp-ts`、`@3akhp/prts-mcp-runtime`、`@3akhp/prts-mcp-data` 及 5 个平台包）与内置备用数据在五大平台的安装运行验证（见 [NPM-DISTRIBUTION.md](docs/dev/NPM-DISTRIBUTION.md)）。
  - **M2C**：完成 Linux `x64` / `arm64` 双架构 Docker 镜像构建与旧版数据卷兼容验证（见 [DOCKER-DISTRIBUTION.md](docs/dev/DOCKER-DISTRIBUTION.md)）。
- **M3（候选版发布自动化 — 已完成）**：通过 `.github/workflows/release-rust.yml` 公开发布 [`3.0.0-alpha.3`](https://github.com/3aKHP/prts-mcp/releases/tag/v3.0.0-alpha.3)，完成 9 个 npm 包的 OIDC provenance 签名发布、GitHub Release 44 项资产上传与 GHCR 双架构镜像发布，同时保持 `latest` 及 LTS 渠道标签不变（见 [RELEASE-CANDIDATES.md](docs/dev/RELEASE-CANDIDATES.md)）。
- **M4（候选版真机 E2E、升级与回滚 — 已完成）**：在 WSL 环境下基于公开 `3.0.0-alpha.3` 完成 24 工具套件校验、真实 MCP 客户端干员与立绘交互、游戏数据与立绘基线/增量同步，以及 npm `2.8.1` 旧数据卷的平滑升级与回滚验证（见 [E2E.md](docs/dev/E2E.md)）。
- **M5（3.0.0 正式版发布 — 已完成）**：`3.0.0-rc.3` 通过生产服务器全生命周期观测（含一次自然的数据与立绘代际更新）及与 2.8.1 的同负载内存对照。`3.0.0` 从 `main` 发布，npm、GHCR 与 GitHub Releases 的 `latest` 已切换，并已回灌 `develop`。`crates.io` 独立上架、管理 CLI 与新功能开发均安排在 3.0.0 正式发布之后。

## 历史版本发布记录（Python / TypeScript）

下表汇总已发布的 1.x 与 2.x 版本（含 1.7 LTS 维护补丁）。完整的版本变更明细请参阅 [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md)。

| 版本 | 日期 | 亮点 |
|------|------|------|
| 2.8.2 | 2026-10-22 | LTS：除名已被泄露的 eMudhra CA 根证书（3.1.2 安全响应的回移） |
| 2.8.1 | 2026-10-11 | 肉鸽剧情补充目录：六个事件的发现、读取、搜索与角色追踪；旧数据包兼容 |
| 2.8.0 | 2026-10-10 | 干员深度数值（面板插值 / 技能逐等级 / 天赋逐档 + `skills` 搜索范围）；连字符 `versionId` 同步兼容 |
| 2.7.4 | 2026-09-15 | HTTP 会话空闲淘汰双实现一致（Python 支持 `SESSION_IDLE_TIMEOUT_MS`；TS 剩余预算重排 + 严格十进制解析） |
| 2.7.3 | 2026-09-05 | 数据修订（`datarev-`）发现与校验；缓存恢复防降级；章节摘要一致性 |
| 2.7.2 | 2026-08-22 | ID 回显引号双实现统一；artwork/item 列表排序码点序对齐 |
| 2.7.1 | 2026-08-18 | 图片同步应用完整 AKDP 增量链（#179）；结构不符的 `building_data` 在双实现中一致降级（#178） |
| 2.7.0 | 2026-08-15 | 干员基建技能（`basic_info` 新段 + `building_skills` 搜索范围）；本地立绘皮肤元数据；2.7 模块重构收口 |
| 2.6.2 | 2026-08-12 | GameData 成对同步幂等性修复：未变化同步周期不再替换激活元数据或清空缓存（#152） |
| 2.6.1 | 2026-08-10 | 模板嵌套字段安全渲染与响应格式错误处理；活动剧情页码校验与越界提示 |
| 2.6.0 | 2026-08-09 | MCP SDK v2 双时代协议支持；阿米娅升变形态立绘；聚合指标、六会话内存基准与同机金丝雀对照 |
| 2.5.2 | 2026-08-09 | npm 生产依赖安全更新；AKDP 直接敌人数据库支持；剧情标量 `Decision`；立绘 token 归属校验 |
| 2.5.1 | 2026-08-07 | GameData 成对同步重试修复；manifest 404 时兼容降级；图片 SHA-256 校验；CI 升级 Node 24 |
| 2.5.0 | 2026-08-07 | 干员立绘工具 `operator_artwork`；数据源切换至自建 `arknights-data-pipeline`；TS stdio HTTP 泄漏修复 |
| 2.4.0 | 2026-07-29 | 常驻服务自动同步；GameData excel/levels 原子成对发布；共享卷跨进程协调与锁续租 |
| 2.3.1 | 2026-07-10 | TypeScript 生产依赖安全更新；同步 `prts-mcp-ts-stdio` npm 锁文件 bin 元数据 |
| 2.3.0 | 2026-07-08 | 传输方式对齐：Python 新增 Streamable HTTP，TypeScript 新增 stdio，两套实现均支持两种传输 |
| 2.2.0 | 2026-07-08 | TypeScript 默认生产运行时切换为 Bun（Dockerfile/CI/scripts）；Node 保留为可选路径 |
| 2.1.0 | 2026-07-07 | TypeScript 正式支持 Bun 可选运行时；新增 `prts-mcp-ts-bun` 与 Bun Dockerfile |
| 2.0.2 | 2026-07-07 | TS HTTP MCP 冒烟测试程序；Bun 候选运行路径；`search_prts` 重定向解析与技术页面过滤修复 |
| 2.0.1 | 2026-07-03 | 修复 `list_story_events` 缺失剧情数据时的输出通道包装；统一 TS 文本结果辅助函数；补充 MCP 示例配置 |
| 2.0.0 | 2026-07-03 | 工具面收敛（32 → 23）与连接级结构化输出通道（`structuredContent`） |
| 1.7.3 | 2026-10-22 | LTS：除名已被泄露的 eMudhra CA 根证书（3.1.2 安全响应的回移） |
| 1.7.2 | 2026-09-26 | LTS：共享同步元数据兼容与原子写入；镜像归一化；分页、Unicode 排序/正则、剧情决策与敌人数据库修复；依赖安全更新 |
| 1.7.1 | 2026-07-10 | LTS：PRTS 搜索重定向与技术页过滤；Docker 离线备用数据；TS 生产依赖安全更新 |
| 1.7.0 | 2026-07-02 | 1.7 LTS 基线：剧情角色追踪 + 模块拆分（32 工具） |
| 1.6.1 | 2026-06-03 | 干员密录发现 + 搜索缓存优化（30 工具） |
| 1.6.0 | 2026-05-28 | 关卡敌人跨源融合 + 物品/材料数据域（29 工具） |
| 1.5.0 | 2026-05-25 | 关卡数据域：`list_stages`、`get_stage_info`、`search_stages`（24 工具） |
| 1.4.2 | 2026-05-25 | 修复 Streamable HTTP 会话池 400 错误 |
| 1.4.1 | 2026-05-19 | 生产修复：ZipStore 缓存、会话泄漏、`httpx` 复用与双实现一致性修正 |
| 1.4.0 | 2026-05-19 | 模板提取工具 + 敌人图鉴（含战斗属性） |
| 1.3.1 | 2026-05-19 | 修复 trap/token 同名干员 ID 碰撞 |
| 1.3.0 | 2026-05-18 | PRTS 深度集成：章节列表、分类标签、链接遍历 |
| 1.2.0 | 2026-05-14 | 剧情摘要工具 + LLM 管线 |
| 1.1.1 | 2026-05-14 | PRTS API 修复（`action=parse` 替代 `prop=extracts`） |
| 1.1.0 | 2026-05-14 | 全文搜索工具 |
| 1.0.0 | 2026-05-13 | 首个稳定版，1.x 工具面冻结 |
