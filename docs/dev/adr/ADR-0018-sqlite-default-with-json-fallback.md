# ADR-0018：3.2 默认 SQLite 后端与 JSON 自动备用

- 状态：Accepted
- 决策日期：2026-10-31
- 关联：[ADR-0001](ADR-0001-sqlite-data-backend.md)、[PR #294](https://github.com/3aKHP/prts-mcp/pull/294)、[PR #302](https://github.com/3aKHP/prts-mcp/pull/302)、[Issue #263](https://github.com/3aKHP/prts-mcp/issues/263)、[Issue #266](https://github.com/3aKHP/prts-mcp/issues/266)、[Issue #298](https://github.com/3aKHP/prts-mcp/issues/298)

> 本文在 3.2.0 发布评审中补写。#294 合入时把 3.2 的落地语义直接改写进 ADR-0001 正文，违反本目录“正文合入后不再修改”的规则；ADR-0001 已恢复原文，本条接续记录 3.2 的决策。决定部分的语义取自 #294 的 PR 描述与提交 `f9c0221` 对 ADR-0001 的改写内容。#294 当时没有记录备选方案的比较，备选方案一节的否决与采纳理由均为本次补写时的事后解释，只有其中引用的 `f9c0221` 原文属于当时记录。

## 背景与问题

[ADR-0001](ADR-0001-sqlite-data-backend.md) 确定分阶段推进：3.1 默认 JSON、显式启用 SQLite；3.2 在生产试运行后翻转普通默认值；3.x 持续支持 JSON。ADR-0001 同时规定两个后端互斥，SQLite 缺失时不静默回落 JSON，并把“备用数据打包策略”留待生产试运行结果决定。

翻转默认值时需要回答三个问题：

1. 未选择后端的部署在 DB 尚未就绪时（首次启动、离线、DB 下载或校验失败）读什么数据。
2. 发行包内置哪种备用数据。
3. 已显式选择后端或指定自定义路径的部署是否受影响。

## 备选方案

- **维持 JSON 默认**：不兑现 ADR-0001 的 3.2 阶段，SQLite 的内存与冷路径收益只惠及显式启用的部署，未采纳。
- **默认 SQLite 且严格互斥（沿用 ADR-0001 互斥语义）**：未选择后端的部署在 DB 就绪前没有可用游戏数据，首次启动须等待约 130 MiB 下载，离线首次启动即使发行包带有 JSON 备用数据也无法使用。这会让“无感升级”承诺（[VERSIONING.md](../VERSIONING.md)）在首次启动时失效，未采纳。
- **发行包改为内置 SQLite 备用数据**：提交 `f9c0221` 的记录为“只内置同快照下较小的一种备用数据，目前为 JSON”，这里的“较小”按压缩后的发行体积计。2026-10-31 查询的数据：AKDP `data-26-10-22-14-02-11-51447808` 的 `zh_CN.sqlite.gz` 为 134,770,097 字节（约 128.5 MiB），当前内置 JSON 备用数据的三个 ZIP（`packaging/npm/data-release.json`，`datarev-26-10-08-04-51-28-56071834-r2`）合计 60,581,642 字节（约 57.8 MiB）。按解压后体积则相反：DB 约 316 MiB，小于同一份 JSON 备用数据在本地打包产物中展开后的约 498 MiB（游戏表与关卡解压，剧情 ZIP 原样保留）。发行包只能内置一份备用数据，按发行体积选择 JSON，未采纳。
- **默认 SQLite，DB 就绪前自动使用只读 JSON 备用（采纳）**：保留首次启动与离线可用性，DB 验收后自动切换，不需要部署者操作。

## 决定

自 3.2.0 起普通默认后端为 SQLite，落地语义如下：

- **适用范围**：只有未设置 `PRTS_DATA_BACKEND`（空白值视为未设置）、未设置 `PRTS_DATA_DB`、且未使用自定义 JSON 路径的部署采用默认偏好。自定义 JSON 路径指存在 `GAMEDATA_PATH`（空字符串也算）或非空的 `STORYJSON_PATH`。
- **默认偏好下的备用**：只运行 SQLite 同步，不启动 JSON 同步。没有已验收的 DB 时使用只读 JSON 备用数据（用户目录中的既有 JSON 或发行包内置备用数据）。DB 验收完成后新请求自动切换到 SQLite，进行中的请求保留原快照。
- **显式选择保持严格**：显式 `PRTS_DATA_BACKEND=sqlite` 或设置 `PRTS_DATA_DB` 时不回落 JSON；显式 `PRTS_DATA_BACKEND=json` 使用 JSON 后端，不打开 DB；在未显式选择后端、也未设置 `PRTS_DATA_DB` 时，自定义 JSON 路径同样选择 JSON 后端。后端选择依次看显式后端、`PRTS_DATA_DB`、自定义 JSON 路径。这部分保留 ADR-0001 的互斥语义。
- **备用数据打包**：发行包继续只内置 JSON 备用数据。
- **数据卷**：不自动转换旧数据卷，不删除另一后端的数据（与 ADR-0001 一致）。
- **可观测性**：启动日志与 `/debug/metrics` 的 `data_backend` 字段报告偏好后端、实际服务的后端以及是否处于 JSON 备用。

ADR-0001 保持 Accepted，其 3.1 阶段的决定继续有效；本条实施其 3.2 阶段，并把“SQLite 缺失时不静默回落 JSON”收窄为仅约束显式选择。

## 后果

正面：

- 默认部署获得 SQLite 的内存与冷路径收益（数据见 ADR-0001），无需修改配置。
- 首次启动与离线启动仍有可用数据，DB 下载失败时服务不中断。

负面与代价：

- 默认部署额外下载约 130 MiB 的 `zh_CN.sqlite.gz`（同上 manifest 为 134,770,097 字节），数据根目录新增 `database/`。单代 DB 约 320 MiB（同上 manifest 为 331,423,744 字节）且随数据版本增长；激活新代后保留上一代，常态约 630 MiB；更新期间另有下载与解压暂存，峰值约 1.1 GiB。
- 沿用 2.x 分卷挂载、或以 `--read-only` 加 `--tmpfs /data` 运行的 Docker 部署，`/data/database` 不在持久卷内，需要增加卷或显式选择 JSON。3.2.0 CHANGELOG 的升级注意事项与[部署指南](../../admin/deployment.md)给出了处理方式。
- 默认偏好下服务的后端会在运行中从 JSON 切到 SQLite，排障时需要查看 `data_backend` 字段确认当前状态。

遗留事项：

- ADR-0001 要求的“生产试运行后翻转”未在发布前完成。维护者于 2026-10-31 决定把 #266 的切换前复测与 #263 的独占容器内存、真实公网 DB 同步实测改为 3.2.0 发布后的生产观测，结果在对应 Issue 跟进。
- 3.2 同期引入的 v2 本地图片同步（[PR #295](https://github.com/3aKHP/prts-mcp/pull/295)）涉及同步语义，尚无独立 ADR。
