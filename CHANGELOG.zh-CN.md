# 更新日志

[English](CHANGELOG.md) | 简体中文

本文件记录 PRTS-MCP 各实现的完整版本变更历史：2.x 及更早版本为 Python 与 TypeScript 双实现，3.x 起统一为原生 Rust 实现。版本按版本号降序排列，LTS 维护补丁保留各自的原始发布日期。在 1.x/2.x 历史版本中，未标注实现小标题的条目同时适用于 Python 与 TypeScript；特定于某一实现的变更归入 `Python` 或 `TypeScript` 小标题下。

2.8.1 基线时的原始分语言更新日志可在 [`ts/v2.8.1` tag](https://github.com/3aKHP/prts-mcp/tree/ts/v2.8.1) 查看（[Python](https://github.com/3aKHP/prts-mcp/blob/ts/v2.8.1/python/CHANGELOG.md) · [TypeScript](https://github.com/3aKHP/prts-mcp/blob/ts/v2.8.1/ts/CHANGELOG.md)），1.7.1 与 1.7.2 的维护记录来自已发布的 [`python/v1.7.2`](https://github.com/3aKHP/prts-mcp/blob/python/v1.7.2/python/CHANGELOG.md) 与 [`ts/v1.7.2`](https://github.com/3aKHP/prts-mcp/blob/ts/v1.7.2/ts/CHANGELOG.md) 标签。

## [3.2.1] - 2026-11-01

### 新增

- 新增 crates.io 源码发行渠道：源码包仅包含五个公开二进制入口，验证从工作树外的 Cargo 归档安装，并提供带发布条件与注册表摘要核对的发布流程。首次注册使用维护者 Token，配置 Trusted Publisher 后启用后续 OIDC 发布。源码安装需要 Rust 1.89 或更新版本及 C 编译器，不含备用游戏数据。

## [3.2.0] - 2026-10-31

**升级注意事项**：游戏数据默认后端改为 SQLite。未设置 `PRTS_DATA_BACKEND`、`PRTS_DATA_DB` 与自定义 JSON 路径的部署会额外下载约 130 MiB 的 `zh_CN.sqlite.gz`，并在数据根目录下新增 `database/`：单代 DB 约 320 MiB 且随数据版本增长，首次更新后同时保留上一代（约 630 MiB），更新期间另需下载与解压暂存，峰值约 1.1 GiB；DB 就绪前继续使用 JSON 备用数据。整卷挂载 `/data` 的 Docker 部署无须调整。沿用 2.x 分卷挂载或 `--read-only` 加 `--tmpfs /data` 的部署，需要为 `/data/database` 增加卷，或设置 `PRTS_DATA_BACKEND=json` 保持原行为。详见[部署指南](https://github.com/3aKHP/prts-mcp/blob/main/docs/admin/deployment.md)与[数据同步说明](https://github.com/3aKHP/prts-mcp/blob/main/docs/admin/data-and-sync.md)。

### 新增

- 本地图片同步支持 v2 多分片 baseline 与 delta，并继续兼容 v1。同 baseline 更新只获取必要的新 delta；跨 baseline 复用校验通过的 PNG，跳过内容已满足的分片。完整校验后原子激活，3.2 图片写入器被终止后无须等待旧租约过期即可恢复。
- **工具输出信任边界说明**：[`docs/user/tools-guide.md`](https://github.com/3aKHP/prts-mcp/blob/main/docs/user/tools-guide.md#4-工具输出的信任边界面向-mcp-客户端集成者) 与 [`SECURITY.md`](https://github.com/3aKHP/prts-mcp/blob/main/SECURITY.md) 新增说明，介绍工具输出的来源、TLS 与 SHA-256 校验能证明和不能证明什么，以及 MCP 客户端如何把工具输出当作不可信数据处理。
- `/debug/metrics` 新增 `data_backend` 字段，报告偏好后端、实际服务的后端以及是否正在使用 JSON 备用。

### 变更

- 游戏数据默认后端切为 SQLite。未设置 `PRTS_DATA_BACKEND`、`PRTS_DATA_DB` 且无自定义 JSON 路径时，启动先使用 JSON 备用，DB 验收完成后自动切换新请求。显式 SQLite 或设置 `PRTS_DATA_DB` 时保持严格模式，不回落 JSON。设置 `PRTS_DATA_BACKEND=json` 可继续使用既有 JSON 卷，切换后端不会删除另一后端的数据。

### 修复

- v2 图片同步在下载和解压写入前执行声明大小上限，发布失败后回收未发布候选，并将大文件处理移出异步工作线程。摘要解析统一处理十六进制大小写，避免克隆完整索引。

### 弃用

- AKDP 计划在 2027 春节窗口切换到不兼容的 v2 图片发布并重建 baseline，前提是发布签名与受支持客户端就绪。切换后停止 v1 图片更新，已发布的数据包保留。3.2.0 已能读取 v2 图片发布，但切换所需的最低客户端版本取决于签名校验的落地，将在切换前公告。Wiki 图片模式不受影响。

## [3.1.3] - 2026-10-29

### 新增

- **自定义 GitHub 数据源**：通过 `PRTS_DATA_SOURCE_REPO=owner/repo` 为数据与本地立绘同步选择兼容仓库。自定义源使用独立目录；显式同步目录首次使用须为空，或已绑定同一源。默认源及既有数据卷行为不变。详见[数据同步说明](docs/admin/data-and-sync.md#自定义-github-数据源)。

- **术语表与架构决策记录目录**：新增 [`docs/glossary.md`](docs/glossary.md)，统一解释项目术语与缩写并指向各权威文档；新增 [`docs/dev/adr/`](docs/dev/adr/) 架构决策记录目录（ADR-0001 至 ADR-0017，含对 3.1 前仍然生效决策的补录），附状态机与撰写规范。
- **版本一致性门禁**：新增仓库根 [`versions.json`](versions.json)，统一声明稳定版、开发版、两条 LTS 最新补丁与 LTS EOL 日期；`tools/ci/versions.mjs` 校验所有登记的文档副本与之一致，并按目标分支交叉校验 `Cargo.toml`（纳入 CI 与 `scripts/check-runtime.sh` 快速段），漂移时逐处报出文件与行号。全部登记副本已核对对齐，包括 STATUS 中一处滞后的 `lts/2.8` 行。

## [3.1.2] - 2026-10-22

### 安全

- **针对 eMudhra/emSign CA 密钥泄露事件更新原生 TLS 信任库**（[RUSTSEC-2026-0383](https://rustsec.org/advisories/RUSTSEC-2026-0383.html) / CVE-2026-111943）：内嵌根证书快照由 `webpki-roots` 1.0.9 升至 1.0.10（移除 `emSign ECC Root CA - G3`，其下属 8 个中间证书私钥可从公开数据恢复），路径校验器由 `rustls-webpki` 0.103.15 升至 0.103.16（无论使用何种根库，均拒绝包含受影响中间证书的任何路径）。若不更新，网络位置攻击者可对 <= 3.1.1 的原生版本冒充 `prts.wiki` 或 GitHub Release 端点，静默投毒 wiki 工具输出与数据同步，并可窃取已配置的 GitHub token。证书链到被除名 CA 的自定义镜像此后将按预期连接失败。新增回归测试同时钉住根库状态与中间证书路径拒绝行为。

## [3.1.1] - 2026-10-20

### 新增

- **贡献者评测工具**：支持本地、SSH 与容器 A/B 或 A/B/C 对照实验，提供版本化 benchmark 契约、私有环境初始化、尝试记录保留、归档校验与可分享的指标报告，附带函数、描述覆盖率和 HTTP MCP 冒烟适配器。

### 变更

- **同步摘要**：降低无 SHA 扩展 CPU 上 Release 下载和 SQLite 同步的 SHA-256 计算成本。
- **SQLite 校验**：新增 `PRTS_VALIDATION_MODE=normal|strict`，默认 `normal`。新同步数据库始终完整验收；通常模式重启后重新比对整文件摘要，并复用匹配的结构验收记录；严格模式重新检查完整性与外键。记录缺失或失效时执行完整验收。两种模式均保留落盘读回摘要和发布保护，并移除解压流重复摘要及未使用的图片下载摘要。
- **SQLite 查询**：跨域搜索与长剧情扫描分别限制并发，并通过绑定数据库代际的有界缓存复用剧情元数据。
- **SQLite 剧情搜索**：按需建立有内存上限的块预筛选索引，并在同一数据代际内复用，减少带必需字面量的搜索反复读取全文。首次相关查询承担所访问块的索引构建成本。没有可用字面量的正则继续流式扫描，保持原有精确匹配规则。

### 修复

- **SQLite 密录字典**：自定义数据库路径被原子替换时，角色字典与读取中的数据库代际保持一致。

## [3.1.0] - 2026-10-18

- **实验性 SQLite 数据后端（3.1）**：设置 `PRTS_DATA_BACKEND=sqlite` 启用，或通过 `PRTS_DATA_DB` 选择预编译离线 DB。默认仍为 JSON，保留旧路径、数据卷和同步开关；只运行所选后端的游戏数据同步与缓存，安装包备用数据继续为 JSON。计划在 3.2 翻转普通默认值，3.x 持续支持 JSON。

### 变更

- **GitHub Release 下载附件**：提供 5 个采用简洁平台文件名的原生安装包、1 个发行验证资料 ZIP 和统一的 `SHA256SUMS`。npm 包通过 npm 获取，Docker 镜像通过 GHCR 获取。

### 修复

- **SQLite 指针恢复**：当已校验的上一份 DB 与最新发行版相同时，修复损坏的当前指针，无需重新下载。

## [3.0.0] - 2026-10-16

实现：Rust。

3.0.0 是首个原生 Rust 正式版。工具名、参数、输出格式与数据同步语义与 2.8.1 一致，仅保留 `contracts/baseline.json` 中封闭枚举的已批准差异。升级前请阅读 [2.x → 3.0 迁移指南](https://github.com/3aKHP/prts-mcp/blob/main/docs/migration-2.x-to-3.0.md)。`CHANGELOG.zh-CN.md` 中的 `3.0.0-rc.1` 至 `3.0.0-rc.3` 条目记录了预发布历史。

### 新增

- **统一的原生 Rust 运行时（`prts-mcp`）**：服务端为仓库根目录下的单一原生 Rust 实现（最低 Rust 版本 `1.89`），静态链接内嵌的 QuickJS C 正则组件（`vendor/quickjs-regexp/`），完整保留 TS/v2.8.1 的 24 个工具契约、新旧两代 MCP 协议（有状态 `legacy` 会话与无状态 `2026-07-28` `modern` 信封）、`stdio` 与 Streamable HTTP 传输，以及感知数据代际激活的后台游戏数据与立绘同步。
- **五平台预编译原生归档包**：提供 `linux-x64`、`linux-arm64`（`glibc >= 2.28`）、`windows-x64`（静态链接 CRT）、`darwin-arm64` 与 `darwin-x64`（`macOS 14.0+`）独立归档包，内置 5 个入口可执行文件、ABI/构建清单、完整第三方许可声明以及经过校验的只读备用游戏数据（游戏表、关卡、剧情），无需安装 Node、Bun 或 Python。
- **9 包架构的 Rust 版 npm 分发**：新主入口包 `prts-mcp` 与兼容入口包 `prts-mcp-ts` 通过 `@3akhp/prts-mcp-runtime`（要求 `Node >= 22` 的轻量启动桥，支持信号转发与 Windows 父进程退出联动）启动原生二进制，配套 `@3akhp/prts-mcp-data`（共享只读备用数据）与 5 个按平台自动筛选的二进制包（`@3akhp/prts-mcp-<platform>`），9 个包均附带 npm OIDC provenance 签名。
- **双架构原生 Docker 镜像**：`ghcr.io/3akhp/prts-mcp`（`linux/amd64` 与 `linux/arm64`）以 `tini` 运行原生 Rust 服务，内置 `/app/data` 只读备用数据，并兼容 2.x 既有的 `/data` 整卷与分卷挂载。
- **独立的 `lts/2.8` 长期维护分支**：Python 与 TypeScript 2.8.x 双实现在 `lts/2.8` 继续维护，与 `lts/1.7` 一同维护至 `2027-07-02`。

### 变更

- **稳定渠道**：`prts-mcp-ts` 与各新增包的 npm `latest`、GHCR `:latest` 与 `:3`，以及 GitHub Latest 发行版均指向 3.0.0，`main` 分支改为承载 Rust 工程。2.8.x 仍可通过 npm `lts-2.8` 与 GHCR `:2` 安装。
- **入口命令与默认传输模式**：新主命令 `prts-mcp` 默认启动 Streamable HTTP（`:3000/mcp`，设 `PRTS_TRANSPORT=stdio` 切换为 stdio）；`prts-mcp-ts` / `prts-mcp-ts-bun`（固定 HTTP）与 `prts-mcp-ts-stdio`（固定 stdio）保留 2.x 固定传输行为，无需安装 Bun；Docker 镜像入口（`prts-mcp-ghcr`）保留默认 `stdio`（设 `PRTS_TRANSPORT=http` 切换为 HTTP）。
- **内存占用**：各数据集在首次使用时加载，且仅保留工具实际读取的字段；技能、敌人与剧情文本采用紧凑的共享结构，同一数据代际内并发的首次查询共享一次加载。在混合查询负载下，常驻内存低于 2.8.1，且没有旧版的瞬时峰值。
- **原生诊断指标（`D-001`、`D-002`）**：`/debug/metrics` 的 `process.runtime` 标识为 `"rust"`，内存统计改为操作系统原生驻留集（`process.rss_bytes`）与采样中观察到的最高 RSS（`process.rss_high_water_bytes`），不再输出 V8/Python 堆字段；`/debug/cache` 保留按领域分组的缓存计数（详见 `contracts/baseline.json`）。

### 移除

- **3.x 线不再包含 Python 与 TypeScript 源码，并停止 3.x PyPI 发布**：双语言源码目录及 `data/` 下过时的四表样本数据不再属于 3.x 工程。Python 与 TypeScript 的 2.8.x / 1.7.x 在各自 LTS 分支继续维护；3.x 通过 npm、GitHub Release 原生归档与 GHCR 镜像分发，`crates.io` 计划在 3.0.0 之后上架。

## [3.0.0-rc.3] - 2026-10-15

### 变更

- **工具响应分配**：将已有 Markdown、结构化结果和图片字符串直接移入 MCP 响应，减少临时复制，保持各输出通道的行为不变。
- **关卡敌人查询**：按需读取六项展示属性及其关卡覆盖值，避免重建整条敌人记录，仅为消费的波次与引用字段创建 JSON 对象，保留覆盖与等级回退行为。
- **敌人数据库内存占用**：直接将战斗数据解析为共享字段名的紧凑缓存，读取属性时无需重建整条记录，保持敌人查询与关卡覆盖结果不变。
- **剧情索引内存与搜索**：按章连续存储文本，复用章内重复角色名，并直接遍历记录位置以省去重复数组，保留全部索引台词及搜索顺序。
- **干员内存占用**：干员缓存仅保留面板、天赋及技能查询实际读取的字段，在保持工具输出不变的同时降低内存占用。

### 修复

- **混合查询后的内存占用**：关卡、搜索和立绘查询共享缓存数据，单敌人查询不再复制整个敌人数据库，干员、敌人、关卡、基建与皮肤表仅保留工具实际使用的字段。敌人出场索引解析波次数据时不再为无关关卡结构分配内存。
- **并发首次查询**：同一数据代际内，每个数据集的首次加载串行执行，让同时到达的请求共享缓存结果；加载失败后仍可重试。
- **战斗技能加载与搜索**：缓存紧凑的技能数据并直接构建搜索文本，减少常驻内存与临时分配，保留原有等级编号、占位符和输出值语义。

## [3.0.0-rc.2] - 2026-10-15

### 修复

- **旧协议 Streamable HTTP 客户端兼容性**：携带受支持的 2024/2025 `MCP-Protocol-Version` 请求头时，继续使用有状态旧协议。RC.1 错将此类请求判为新协议并要求 `_meta` 信封，导致 Codex 等客户端无法调用工具。

## [3.0.0-rc.1] - 2026-10-15

实现：Rust。

### 新增

- **统一的原生 Rust 运行时（`prts-mcp`）**：将服务端迁移为仓库根目录下的单一原生 Rust 实现（最低 Rust 版本 `1.89`），静态链接内嵌的 QuickJS C 正则组件（`vendor/quickjs-regexp/`），完整保留 TS/v2.8.1 的 24 个工具契约、新旧两代 MCP 协议（`legacy` 会话与 `2026-07-28` 无状态 `modern` 信封）、`stdio` 与 Streamable HTTP 传输，以及感知数据代际激活的后台游戏数据与立绘同步。
- **五平台预编译原生归档包**：提供 `linux-x64`、`linux-arm64`（`glibc >= 2.28`）、`windows-x64`（静态链接 CRT）、`darwin-arm64` 与 `darwin-x64`（`macOS 14.0+`）独立发行归档包，内置 5 个入口可执行文件、ABI/构建清单、完整第三方许可声明以及经过校验的只读备用游戏数据（游戏表、关卡、剧情）。
- **9 包架构的 Rust 版 npm 分发**：新增主入口包 `prts-mcp` 并保留兼容入口包 `prts-mcp-ts`，底层由 `@3akhp/prts-mcp-runtime`（要求 `Node >= 22` 的轻量启动桥，支持 POSIX 信号转发与 Windows 父进程句柄退出联动）、`@3akhp/prts-mcp-data`（共享只读备用数据）及 5 个按平台自动筛选的二进制包（`@3akhp/prts-mcp-<platform>`）支撑，已通过 npm OIDC provenance 签名发布候选版 `3.0.0-rc.1`（`@next`）。
- **双架构原生 Docker 镜像**：`ghcr.io/3akhp/prts-mcp`（支持 `linux/amd64` 与 `linux/arm64`）切换为原生 Rust 二进制，由 `tini` 作为 PID 1 转发停止信号，内置 `/app/data` 只读备用数据，并直接兼容 2.x 既有的 `/data` 整卷与分卷挂载。
- **独立的 `lts/2.8` 长期维护分支**：在 `lts/2.8` 分支保留 Python 与 TypeScript 2.8.x 双实现维护线，与 `lts/1.7` 一同维护至 `2027-07-02`。

### 变更

- **入口命令与默认传输模式**：新主命令 `prts-mcp`（原生二进制与 npm 主包）默认启动 Streamable HTTP（`:3000/mcp`，设 `PRTS_TRANSPORT=stdio` 切换为 stdio）；`prts-mcp-ts` / `prts-mcp-ts-bun`（固定 HTTP）与 `prts-mcp-ts-stdio`（固定 stdio）在 Rust 二进制之上保留 2.x 固定传输行为（无需安装 Bun）；Docker 镜像入口（`prts-mcp-ghcr`）保留默认 `stdio`（设 `PRTS_TRANSPORT=http` 切换为 HTTP）。
- **原生诊断指标（`D-001`、`D-002`）**：`/debug/metrics` 的 `process.runtime` 标识为 `"rust"`，内存统计改为操作系统原生驻留集（`process.rss_bytes`）与采样中观察到的最高 RSS（`process.rss_high_water_bytes`），不再输出 V8/Python 堆字段；`/debug/cache` 保留按领域分组的缓存计数（详见 `contracts/baseline.json`）。

### 移除

- **从 `develop` 移除旧 `python/` 与 `ts/` 目录及 3.x PyPI 渠道**：从 3.x 主开发树移除双语言源码目录及 `data/` 下过时的四表样本数据。Python 与 TypeScript 的 2.8.x / 1.7.x 维护在各自 LTS 分支进行；3.x 通过 npm、GitHub Release 原生归档与 GHCR 容器镜像分发（`crates.io` 计划在 3.0.0 正式发布后独立上架）。

## [2.8.1] - 2026-10-11

### 新增

- **支持肉鸽剧情补充目录。** 当剧情包携带 `story_supplement.json`（由 arknights-data-pipeline 生成，属于 `prts-mcp-data/v1` 契约中的新增文件）时，六个 `rogue_N` 肉鸽活动作为正式剧情内容接入：`list_story_events` 列出它们，并新增 `category="roguelike"` 筛选；`list_stories` / `read_activity` 对其章节排序；`search_stories` 及两个角色工具通过共享搜索索引收录它们；`read_story` / `get_story_summary` 解析其 key。不带该文件的包行为完全不变；目录存储缓存开始跟踪补充文件，使自托管目录树正确失效；剧情包校验器在该文件存在时检查目录中的章节引用。MCP 工具数仍为 24。

### 修复

- 目录存储的剧情搜索缓存分别跟踪每个目录文件，因此即使修改后文件大小不变、时间戳早于另一个目录文件，也会使索引失效。Python 剧情包校验与 TypeScript 一致，跳过补充目录中非列表类型的章节字段。

## [2.8.0] - 2026-10-10

### 新增

- **干员战斗技能：`get_operator_basic_info(action="skills")` 和 `skills` 搜索范围。** skills 操作返回干员战斗技能各等级的效果，涵盖 Lv1-7 及专精 1-3，包括 SP 消耗、初始 SP、充能次数、持续时间/弹药量，以及替换黑板占位符后生成的描述（`{key}` / `{key:0%}` 为 .NET 风格格式；未知占位符保留原文）。统一 `search` 工具新增 `skills` 范围，可跨干员检索所有等级描述中的关键词。`skills` 范围返回每个匹配技能的最高等级效果行，因此命中的关键词可能位于较低等级描述中，而不在显示行里。`skill_table.json` 成为 AKDP `zh_CN-excel.zip` 数据集契约中的已验证条目（压缩包一直包含此文件，因此旧部署重新下载即可恢复契约合规）；用户自行提供的数据根缺少该文件时会降级：skills 操作说明缺失，搜索范围返回无匹配。`skill` 域注册到数据集访问契约，并作为第十一个模块出现在 `/debug/cache` 中。MCP 工具数仍为 24；既有调用和用户配置保持兼容。

- **干员属性面板：`get_operator_basic_info(action="stats")`。** stats 操作展示 `character_table.json` 中此前没有工具读取的阶段关键帧：不提供 `phase`/`level` 时，返回所有精英阶段的 Lv1/LvMax 面板，以及满信赖和潜能加成摘要；同时提供两者时，返回该等级的精确插值面板（关键帧间线性插值，四舍五入且中点远离零——采用社区验证的游戏内公式，测试套件以 PRTS Wiki 公布的阿米娅关键帧数值校准）。无需新增数据文件，沿用干员域缓存。

- **`get_operator_basic_info` 中的分档天赋效果。** 每个天赋槽位新增各档候选项，包含每个变体的解锁精英阶段、`unlock_level` 及从零开始的原始 `potential_rank`，同时保留最高档的 `name`/`description` 标题；Markdown 新增紧凑的注释行，例如 `精英1解锁；精英1 Lv55强化` 或 `精英1解锁；精英2强化；潜能5档强化`，结构化使用者可获得完整候选列表。高于 Lv1 的解锁等级会显式显示，潜能注释采用玩家看到的档位（`potential_rank + 1`）。仅为载荷增量变更。

- **所有发行产物均携带 NOTICE 文件（#200）。** npm 包、PyPI sdist/wheel 和 Docker 镜像携带仓库的第三方内容及知识产权声明；仅改变包装，不影响运行行为。

### 变更

- **统一干员信息入口，MCP 工具数仍为 24。** `get_operator_basic_info` 接受可选的 `action="basic"|"skills"|"stats"`，默认为 `basic`。既有只传名称的调用保留基础档案；仅在选择对应操作时返回技能和面板，输出通道行为不变。`phase` 和 `level` 仅供 `stats` 使用，必须同时提供或同时省略。尚未发布的独立技能/属性工具注册已撤回。

### 修复

- **发行身份解析支持上游以连字符连接的 versionId 格式。** 2026 年 10 月，上游数据 versionId 从 `YY-MM-DD-HH-MM-SS_hash` 改为尾部使用连字符的 `YY-MM-DD-HH-MM-SS-hash`，但已存身份解析器只识别下划线格式。对于采用新格式的来源，2.7.3 引入的防降级保证静默退化为普通字符串比较：已安装的 `datarev` 修复修订不再拒绝同来源的普通发行版，保护盲目下载和 ZIP 缺失恢复的身份检查也被绕过。后缀模式现接受两种分隔符，恢复两种格式的元组比较。发行发现及正常更新原本就不依赖格式，行为不变。

## [2.7.4] - 2026-09-15

### 新增

#### Python

- **HTTP 会话空闲清理支持 `SESSION_IDLE_TIMEOUT_MS`（#193）。** Python HTTP 传输此前将会话生命周期完全交给 MCP Python SDK，没有配置其空闲超时，因此空闲会话会一直存活到客户端断开或进程重启，而 TypeScript 会清理它们。现按与 TypeScript 相同的语义读取该变量：未设置时回退到 24h，有限正数按毫秒使用，其他值禁用清理；将其传给 SDK 会话管理器，在最后一次请求经过一个超时周期后回收空闲会话。

### 修复

#### TypeScript

- **HTTP 会话约在配置空闲超时的 2× 后才被清理（#193）。** 空闲计时器触发时，如果距上次请求尚未经过 `SESSION_IDLE_TIMEOUT_MS`（只要 `initialize` 之后有请求就必然发生，因为该请求在计时器启用后刷新活跃时间），原实现会重新等待完整周期，而非剩余时间，导致默认 24h 超时实际约在 48h 才清理，且 `/debug/metrics` 可能报告远高于 `idle_timeout_ms` 的 `oldest_age_ms`。计时器现按剩余空闲时间重新启动。变量在 `config.ts` 中按严格十进制解析，因此 `0x10` 等非十进制写法被判为无效，不再按十六进制解释并导致几乎立即清理。`sessionIdleTimeout` 回归测试现于初始化后发送一次请求，并在阈值两侧断言清理时间，替代过去在两种行为下都能通过的 2× 时长等待。

## [2.7.3] - 2026-09-05

### 修复

- 章节列表和单章摘要现统一优先使用有效的 LLM 摘要，以官方摘要为备用。

- 数据同步发现不可变的 `datarev-<versionId>-r<N>` 修复发行版，并按来源版本和修订号排序更新，使修正数据可以经正常 Auto-Sync 到达，无需更改客户端配置。

- 修复发行版要求匹配的 manifest。拒绝重复身份，运行时和构建选择器均排除草稿及预发布。

- 缓存 ZIP 缺失或无效时，已记录的发行身份继续防止降级；恢复可下载相同或更新的修订，不使用未经验证的 Latest 备用下载。

### 变更

- 整合环境变量及 HTTP 部署指南，并澄清 1.7 LTS 生命周期政策。

## [2.7.2] - 2026-08-22

### 修复

#### Python

- 未找到及校验消息中向用户回显的标识符，现通过 `json.dumps(..., ensure_ascii=False)` 使用双引号，与 TypeScript `JSON.stringify` 的渲染结果逐字节一致；涉及关卡/关卡敌人/道具未找到、`threat_level`/搜索范围/PRTS `direction` 校验、图片下载保护，以及剧情的 `Event not found` / `Story not found` KeyError。

#### TypeScript

- 用户可见的 ID 列表现通过共享的 `compareIds` 比较器（新增 `data/sort.ts`）按码点排序，对齐 Python `sorted()`：包括立绘列表（`artworkLocal` + `artworkMediawiki`）、道具列表及道具搜索的同分排序、敌人列表的同分排序和关卡列表排序。此前 `localeCompare` 的 ICU 排序会颠倒 `1+.png` 与 `1.png` 等标点组合，并把大写道具 ID（`AP_GAMEPLAY`）排到小写 ID 后，因此 `list_items` 的分页顺序在真实数据上已经偏离 Python。

## [2.7.1] - 2026-08-18

### 修复

- **形状错误的 `building_data.json` 与损坏 JSON 一样降级（#178）。** JSON 有效但形状错误的 `building_data.json`（列表/null/标量）此前未进入容错分支：Python 的 `get_operator_basic_info` 抛出 `AttributeError`，TypeScript 则返回空的 `building_skills` 载荷，形成实现差异。现通过顶层形状检查，在两种实现中转换为相同的降级处理：basic_info 省略该字段，`search` 的 `building_skills` 范围报告降级情况而不崩溃。Python 搜索范围的捕获元组也加入 `ValueError`，因此损坏 JSON 的表在此处也会降级（此前会导致该范围崩溃；`JSONDecodeError` 是 `ValueError` 子类）；2.7.0 引入的 basic_info 损坏 JSON 处理不变。

#### Python

- **图片同步应用完整 AKDP 增量链（#179）。** 同步器此前下载基线分片及最新的 `images-delta-<currentVersion>.zip`，从未枚举中间增量发行版。工厂在基线之后发布两个或更多非空增量时，新安装的 `LOCAL_IMAGE=true` 或跨版本同步会构建不完整代际，并在 sha256 检查处失败，此前却已消耗约 1.5 GB 基线下载量（`ORIGINAL_IMAGE=true` 时约 5.1 GB）。同步器现枚举满足 `baselineVersion < v <= currentVersion` 的所有 `images-*` 增量发行版，并按版本顺序应用整条链；`index.json` 中的 `currentVersion` 为权威来源，并与最新增量 tag 交叉核对，不一致即拒绝；增量链断裂（缺少增量资产、版本重复）会在开始下载基线前立即失败；发行发现持续分页，直到覆盖增量链起点，避免最新 100 条记录的页面静默截断增量链；快速路径中的代际只吸收晚于自身 `currentVersion` 的增量，索引回退到活跃代际之前时，会从基线重建，而不复用更新内容。原子暂存、sha256 校验、离线备用和代际清理语义不变。现有测试也重建为真实 ZIP 配合准确索引的用例（旧 mock 对空立绘集合进行校验时天然通过，导致此缺陷漏检），TypeScript 首次获得 `imagesSync` 测试覆盖。

#### TypeScript

- **图片同步应用完整 AKDP 增量链（#179）。** 同步器此前下载基线分片及最新的 `images-delta-<currentVersion>.zip`，从未枚举中间增量发行版。工厂在基线之后发布两个或更多非空增量时，新安装的 `LOCAL_IMAGE=true` 或跨版本同步会构建不完整代际，并在 sha256 检查处失败，此前却已消耗约 1.5 GB 基线下载量（`ORIGINAL_IMAGE=true` 时约 5.1 GB）。同步器现枚举满足 `baselineVersion < v <= currentVersion` 的所有 `images-*` 增量发行版，并按版本顺序应用整条链；`index.json` 中的 `currentVersion` 为权威来源，并与最新增量 tag 交叉核对，不一致即拒绝；增量链断裂（缺少增量资产、版本重复）会在开始下载基线前立即失败；发行发现持续分页，直到覆盖增量链起点，避免最新 100 条记录的页面静默截断增量链；快速路径中的代际只吸收晚于自身 `currentVersion` 的增量，索引回退到活跃代际之前时，会从基线重建，而不复用更新内容。原子暂存、sha256 校验、离线备用和代际清理语义不变。TypeScript 也首次获得 `imagesSync` 测试覆盖，与 Python 的增量链用例对应。

## [2.7.0] - 2026-08-15

### 新增

#### Python

- **干员基建技能。** `get_operator_basic_info` 新增 `building_skills` 载荷字段和 `## 基建技能` Markdown 小节，包含技能名、设施、精英阶段解锁条件和去掉标记后的效果描述，每个技能槽位保留最高精英阶段的变体。统一 `search` 工具新增 `building_skills` 范围，可按设施、效果或技能名称跨干员查询，例如哪些干员提高贸易站效率。由新增的 `data/building` 模块提供数据，采用数据集访问契约，并作为第十个模块出现在 `/debug/cache` 中；`building_data.json` 和 `skin_table.json` 成为 AKDP `zh_CN-excel.zip` 数据集契约中的已验证条目。`building_data.json` 缺失时（较旧的用户自备数据根），basic_info 载荷省略该字段，搜索范围返回无匹配，不报告数据错误。MCP 工具数仍为 24，仅扩展范围枚举。

- **本地立绘列表新增三项皮肤元数据。** `LOCAL_IMAGE=true` 时，`operator_artwork(action="list")` 将每张立绘关联到其 `skin_table.json` 条目，并新增三个可为空的载荷字段：`skin_group`（系列/主题）、`acquisition` 和 `description`；存在系列时，Markdown 行追加 `｜{skin_group}`。MediaWiki 后端不补充这些信息，因为其 artwork_id 为 Wiki 文件名，没有 skin_table 关联键。工具接口不变。

- **CD 中的 PyPI 产物校验（#157）。** Python CD 的 `github-release` job 在创建 GitHub Release 前，通过 PyPI JSON API 将已发布 wheel 和 sdist 的 sha256 与 PyPI 上传时记录的摘要核对，并轮询等待索引延迟；对齐 #156 新增的 TypeScript npm tarball 校验。

#### TypeScript

- **干员基建技能。** `get_operator_basic_info` 新增 `building_skills` 载荷字段和 `## 基建技能` Markdown 小节，包含技能名、设施、精英阶段解锁条件和去掉标记后的效果描述，每个技能槽位保留最高精英阶段的变体。统一 `search` 工具新增 `building_skills` 范围，可按设施、效果或技能名称跨干员查询。由新增的 `data/building.ts` 模块提供数据，采用数据集访问契约，并作为第十个模块出现在 `/debug/cache` 中；`building_data.json` 和 `skin_table.json` 成为 AKDP `zh_CN-excel.zip` 数据集契约中的已验证条目。`building_data.json` 缺失时（较旧的用户自备数据根），basic_info 载荷省略该字段，搜索范围返回无匹配，不报告数据错误。MCP 工具数仍为 24，仅扩展范围枚举。

- **本地立绘列表新增三项皮肤元数据。** `LOCAL_IMAGE=true` 时，`operator_artwork(action="list")` 将每张立绘关联到其 `skin_table.json` 条目，并新增三个可为空的载荷字段：`skin_group`（系列/主题）、`acquisition` 和 `description`；存在系列时，Markdown 行追加 `｜{skin_group}`；`CharSkinLike` 相应扩展。MediaWiki 后端不补充这些信息，因为其 artwork_id 为 Wiki 文件名，没有 skin_table 关联键。工具接口不变。

### 变更

#### Python

- **拆分立绘/图片模块簇（P3.B）。** `tools_artwork.py`（382 行）的两个数据源后端分别移到 `data/artwork_local`（本地 AKDP：char-id 形态别名、索引加载、经 realpath 保护的 PNG 读取）、扩展后的 `data/artwork_mediawiki`（承接 MediaWiki 的 list/get 编排，仅通过 API 客户端取数），并新增 `data/artwork_format`（结果形状及共享列表渲染）；`tools_artwork` 现负责注册、分派和输出通道包装。后端返回消息字符串或结果元组，因此数据模块仍不导入输出模块。`data/images_sync` 以 `sync/images_sync` 移到 `sync/` 层，因为它是同步状态机而非数据读取器；导入 `prts_mcp.data.images_sync` 的调用方需调整导入路径（使用者为 startup_sync、tools_artwork）。其代际文件系统状态移到 `sync/generation_store`，共享的原子写入/清理基础操作移到 `sync/primitives`，去除每侧四份 JSON tmp+replace 重复代码，并统一两个清理变体；图片清理仍跳过隐藏的暂存目录。流式分片下载（`_download_large`）移到 `sync/transport.stream_cascading`，30 分钟期限语义不变。images_sync 从同步层跨模块导入的八个下划线“私有”符号现公开：`get_cascading`、`github_headers`、`url_candidates`、`list_releases`、`latest_release_by_prefix`、`asset_url`、`safe_extract_zip`、`with_archive_activation_lock`（`data/sync` 汇总模块重新导出新名称）。**边界行为变化**：图片代际清理现删除符号链接条目（目标无法 stat 的悬空链接仍跳过，与发行树清理变体一致），并容忍目录扫描失败。MCP 工具接口不变。

- **拆分敌人模块簇（P3.A）。** `data/enemy` 和 `data/stage_enemy` 将纯逻辑分离到四组新的 1:1 对应模块：`enemy_stats`（属性提取及 m_defined 覆盖合并）、`enemy_render`（仓库首个渲染模块，共享图鉴卡片及属性块）、`level_parser`（zh_CN-levels JSON 解析），以及扩展后的 `enemy_database`（level0_index 投影）。`stage_enemy` 现使用 enemy/stage 的共享缓存访问器，不再把同一 JSON 重复加载到并行缓存中；其数据集缩减为仅有 `enemy_appearance_index`。**用户可见变化（调试）**：`/debug/cache` 的 `stage_enemy` 部分去掉四个重复键（`stage_table`/`enemy_handbook`/`enemy_database`/`enemy_name_to_id`，数据仍在其所属的 `enemy`/`stage` 部分可见）。**用户可见变化（同步数据异常时）**：已配置 levels，但底层 excel/levels 输入缺失或形状错误时，关卡工具现输出 `无数据库记录`（enemy_database.json 缺失），而非被包装的读取错误；部分失败包装中的内部消息改用所属模块措辞。两种实现在此对齐，TS 同步改变。

- **DatasetAccess 契约（P1.B）。** 新增 `prts_mcp.data.dataset_access`（工厂、命名注册表及 `excel_store`/`levels_store`）、`prts_mcp.data.gamedata_attrs`（从 enemy/stage_enemy 去重提取 `m_value`）和 `prts_mcp.data.messages`（统一缺失数据/边界/正则消息构造器）。七个 gamedata 家族模块（item、operator、enemy、stage、stage_enemy、images、search）均迁移到该契约；缓存键、具名清理函数及载荷或字符串的返回形式不变。`server.py` 的 `/debug/cache` 处理器和 `startup_sync` 的同步后清理列表改从数据集注册表读取，不再手工枚举模块列表；输出形状和键顺序不变，两种实现的投影均显式采用固定键顺序，因为注册表插入顺序依赖导入顺序。**用户可见变化**：item/stage 缺失数据消息现统一包含自动同步提示、GITHUB_TOKEN 建议及路径回显，替代“请检查 GAMEDATA_PATH 配置…”措辞；enemy 原来不同的 `无效的 limit/offset 参数：…，需 ≥ N。` 校验消息统一为 `limit 必须 >= 1。` 等消息，并新增 limit ≤ 200 检查，对齐工具层 schema。

- 内部激活与缓存观测符号从 `prts_mcp.config` 移到专用模块；从 `prts_mcp.config` 导入这些内部符号的使用者会看到导入路径变更：`activation_aware_cache`/`cache_stat` → `prts_mcp.cache_stats`；`activation_snapshot`/`check_activation_change`/`register_activation_listener` → `prts_mcp.activation`。MCP 工具接口（名称/参数/输出）不变（#162）。

- HTTP 传输和发行发现的底层模块从 `prts_mcp.data.sync` 提取到新的 `prts_mcp.sync` 层（`sync.transport`、`sync.release_discovery`），数据同步 HTTP 仅由该层发起，`api/` 中的 PRTS Wiki API 客户端不受影响。P2.A→P2.B 迁移期间，`data/sync` 重新导出这些模块，使既有 `prts_mcp.data.sync.*` 导入路径继续可用；发行/压缩包/配对状态机在 P2.B 前保留于 `data/sync`。`check_latest_release` 日志现来自 `prts_mcp.sync.release_discovery`。MCP 工具接口不变。

- 发行压缩包激活子系统（跨进程锁、代际树、暂存、ZIP 校验/解压、清理）和发行状态机（CacheMeta、资产下载、manifest 校验、`sync_release`）从 `prts_mcp.data.sync` 移到 `prts_mcp.sync.release_activation` / `prts_mcp.sync.release`；共享 spec/result 类型移到 `prts_mcp.sync._types`，避免反向依赖。`data/sync` 重新导出这些符号，并保留 GameData 配对状态机（于 P2.B.2 移到 `sync.gamedata_pair`）。发行路径日志现来自 `prts_mcp.sync.release`。MCP 工具接口不变。

- GameData 配对状态机（`sync_release_archive` / `sync_release_archive_pair` 及配对加载/保存/初始化）移到 `prts_mcp.sync.gamedata_pair`，原样保留 #152/#155 的幂等保护。`data/sync` 现为纯重新导出汇总模块；完整同步状态机（传输、发现、激活、发行、配对）均位于 `sync/`。MCP 工具接口不变。

#### TypeScript

- **拆分立绘/图片模块簇（P3.B）。** `tools/artworkTools.ts`（453 行）的两个数据源后端分别移到 `data/artworkLocal`（本地 AKDP：char-id 形态别名、索引加载、经 realpath 保护的 PNG 读取）、扩展后的 `data/artworkMediawiki`（承接 MediaWiki 的 list/get 编排，仅通过 API 客户端取数），并新增 `data/artworkFormat`（结果形状及共享列表渲染）；`tools/artworkTools` 现负责注册、分派和输出通道包装。`data/imagesSync` 以 `sync/imagesSync` 移到 `sync/` 层，导入 `./data/imagesSync.js` 的使用者需调整导入路径（使用者为 startupSync、artworkTools）。其代际文件系统状态移到 `sync/generationStore`（新增单元测试，此文件此前没有覆盖），共享原子写入/清理基础操作移到 `sync/primitives`，去除三份 JSON tmp+rename 重复代码并统一两个清理变体。流式分片下载（`downloadLarge`）原样移到 `sync/transport.streamCascading`。**边界行为变化**：图片代际清理现采用 `lstat` 语义，删除符号链接条目，与发行树清理变体对齐；测试固定了一个已记录的 PY/TS 差异：Python 的代际根包含检查解析符号链接（`Path.resolve()`），本侧的 `activeGenerationSync` 仅作词法检查，而下游 #169 的 artwork doGet 保护仍约束实际文件读取，此差异列为 D2 账本候选。MCP 工具接口不变。

- **拆分敌人模块簇（P3.A）。** `data/enemy.ts` 和 `data/stageEnemy.ts` 将纯逻辑分离到新的 1:1 对应模块：`enemyStats.ts`（属性提取、mergeDefined 和去重后的格式化辅助函数 `pythonFloatString`/`formatNumber`，此前散落着四份私有副本；提取路径中无条件 `f"{n:,}"` 的语义与仅对整数生效的紧凑属性变体分开保留）、`enemyRender.ts`（共享图鉴卡片及属性块，保留 TS 独有的 `hasEnemyStatsContent` 检查）、`levelParser.ts`（关卡 JSON 解析，去除两份 `parseLevel` 重复代码），且 `enemyDatabase.ts` 新增 `level0Index`。`stageEnemy.ts` 使用 enemy/stage 导出的访问器，不再建立并行缓存实例；其数据集缩减为 `enemy_appearance_index`。**用户可见变化（调试）**：`/debug/cache` 的 `stage_enemy` 部分去掉四个重复键。**用户可见变化（同步数据异常时）**：已配置 levels，但底层 excel/levels 输入缺失或形状错误时，关卡工具现输出 `无数据库记录`（enemy_database.json 缺失），而非抛出读取错误；部分失败包装中的内部消息改用所属模块措辞，此前 TypeScript 抛错而 Python 降级，两者现对齐。

- **DatasetAccess 契约（P1.B）。** 新增 `data/datasetAccess.ts`（工厂、命名注册表及 `excelStore`/`levelsStore`）、`data/gamedataAttrs.ts`（从 enemy/stageEnemy 去重提取 `mValue`，并以重载保留 enemy 的有类型调用位置）及 `data/messages.ts`（统一缺失数据/边界/正则消息构造器）。七个 gamedata 家族模块均迁移到该契约，移除手写的 `let` + `checkActivationChange()` + `CacheMetrics` 框架（约 200 行；三态 `TableCache` 的后置检查是死代码，因为加载抛错总会让变量保持 null，即重试语义，因此被删除）；缓存键、具名清理函数及载荷或字符串的返回形式不变。`cacheStats.ts` 现通过数据集注册表按显式固定键顺序汇总，与 Python 投影一致；单凭注册表插入顺序仍取决于导入顺序，但不会泄漏到输出。附带修正的 `/debug/cache` 行为均与 Python 对齐：`operator` 的 `handbook_table`/`charword_table` 计数现统计内部字典（`handbookDict`/`charWords`），而非总为 1 的顶层键；zone 文件缺失时，`stage` 的 `zone_table` 报告 `loaded: false`，保留旧 `_zoneTableFailed` 布尔值的行为，采用契约中已加载空值的快照规则。**用户可见变化**：item/stage 缺失数据消息统一；enemy 原来不同的 `无效的 limit/offset 参数：…` 校验消息统一为 `limit 必须 >= 1。` 等消息，并检查 limit ≤ 200。

- 内部激活符号（`withActivationSnapshot`/`checkActivationChange`/`registerActivationListener`）从 `config.js` 移到专用 `activation.js` 模块，需从 `activation.js` 而非 `config.js` 导入。MCP 工具接口不变（#162）。

- HTTP 传输和发行发现的底层模块从 `data/sync.ts` 提取到新的 `sync/` 层（`sync/transport.ts`、`sync/releaseDiscovery.ts`），数据同步 HTTP 仅由该层发起，`api/` 中的 PRTS Wiki API 客户端不受影响。P2.A→P2.B 迁移期间，`data/sync.ts` 重新导出这些模块，使既有 `./sync.js` 导入路径继续可用；发行/压缩包/配对状态机在 P2.B 前保留于 `data/sync.ts`。MCP 工具接口不变。

- 发行压缩包激活子系统（跨进程锁、代际树、暂存、ZIP 校验/解压、清理）和发行状态机（CacheMeta、资产下载、manifest 校验、`syncRelease`）从 `data/sync.ts` 移到 `sync/releaseActivation.ts` / `sync/release.ts`；共享 spec/result 类型及 `errorMessage` 辅助函数移到 `sync/types.ts`，避免反向依赖，`errorMessage` 同时供 release 和 releaseActivation 使用。`data/sync.ts` 重新导出这些符号，并保留 GameData 配对状态机（于 P2.B.2 移到 `sync/gamedataPair`）。MCP 工具接口不变。

- GameData 配对状态机（`syncReleaseArchive` / `syncReleaseArchivePair` 及配对加载/保存/初始化）移到 `sync/gamedataPair.ts`，原样保留 #152/#155 的幂等保护。`data/sync.ts` 现为纯重新导出汇总模块，完整同步状态机均位于 `sync/`。MCP 工具接口不变。

### 修复

#### Python

- **剧情工具文本与 TypeScript 实现对齐**，根据 2.7.0 E2E 可用性检查的发现修正。`read_activity` 现采用 TS 的渲染形式：Markdown `#` 标题、`（共 N 章，当前为部分内容）` 部分内容标记、每章 `简介：` 行（此前被省略）、可执行的页尾提示 `[还有更多章节，请调用 read_activity(event_id="…", page=N)]`，以及活动为空时的消息，替代原来的 `【】` 括号标题和行内分页措辞。回显 ID 的未找到消息现使用双引号（`未找到活动："…"` / `未找到剧情："…"` / `未找到匹配的活动："…"`，对齐 TS 字符串），替代 Python repr 的单引号；`read_story` 的未找到消息新增 `请通过 list_stories 确认章节 key。` 后缀。`get_operator_memoirs` / `find_character_appearances` / `find_speakers_in` 不再用 repr 引号包裹 KeyError 消息。TypeScript 行为不变，它是标准实现；E2E 中一项疑似差异（压缩包竞态文本）实际由预览截断造成，无需修复。

- 本地立绘路径包含检查：Python 行为不变；TypeScript 实现中 `operator_artwork(action="get")` 本地模式的保护从词法检查升级为 realpath 解析，修复符号链接逃逸。此项为纵深防御：同步 ZIP 解压只写普通文件，因此不存在纯粹由上游触发的链接植入路径；使用 `Path.resolve()` 的 Python 原本没有此问题。两种实现现执行相同的包含检查语义。

- 激活锁等待超时现抛出具名 `_ActivationLockTimeoutError`，它是 `TimeoutError` 子类，因此既有 `except TimeoutError` 使用者继续可用；从 `prts_mcp.data.sync` 重新导出，对齐新增的 TS `ActivationLockTimeoutError`。错误消息不变。

- 大分片图片下载（`_download_large`）现采用**每次镜像尝试 30 分钟的期限**，默认从 300 秒提高；只要分块持续到达，就在分块循环中通过 `time.monotonic()` 检查期限。同一数值仍作为 httpx 连接/读取停滞时的每操作超时；与 TS 的 `AbortSignal.timeout` 不同，后者还会在读取中途强制中止，因此镜像长时间持续下载后在读取中途停滞，可能让 Python 一次尝试耗时达到预算的约 2×。此前 Python 完全没有总时长上限，连接或分块间停滞超过 300 秒就快速失败，而缓慢但持续推进的下载可以无限运行。现收紧为总时长超过 30 分钟的持续下载会失败，并以新预算切换到下一个镜像；每个失效镜像的最坏等待从 300 秒升至 1800 秒。仅影响分片/增量下载；发行发现（10 秒）、发行资产（120 秒）和锁等待（120 秒）不变。

- 两种实现现一致归一化 `GITHUB_MIRRORS` 条目：去掉首尾空白和全部末尾斜杠。此前 Python 保留条目内的空白，TypeScript 只去掉一个末尾斜杠，导致 `https://ghproxy.net//` 产生被代理拒绝的错误候选 `...//https://...`。归一化后为空的条目，如 `///`，两侧均丢弃。

- 游戏数据列表工具（`list_enemies`/`get_enemy_appearances`/`list_stages`/`list_items`）现通过 `Field(ge=, le=)` 在框架层检查 `limit`（`1–200`）和 `offset`（`≥ 0`）边界，对齐 TypeScript Zod schema，使两种实现一致拒绝越界分页（#161）。

#### TypeScript

- 剧情工具文本对齐：TypeScript 行为不变；Python 实现的 `read_activity` 渲染、未找到消息引号和 KeyError 消息显示已对齐本侧标准字符串。2.7.0 E2E 中一项疑似差异（压缩包竞态文本）由预览截断造成，两侧原本一致。

- **本地立绘路径包含检查现解析符号链接（realpath）。** `operator_artwork(action="get")` 本地模式中，将索引声明的 `file` 限制到同步代际目录内的保护此前仅作词法检查，因此代际目录中指向主机其他位置的符号链接会通过检查并被读取，进而以 base64 返回该主机文件。同步 ZIP 解压始终只写普通文件，因此不存在纯粹由上游触发的磁盘链接植入路径；此修复补上纵深防御，并与已使用 `Path.resolve()` 的 Python 实现对齐。现先通过 `realpathSync` 解析两个路径，再检查包含关系；逃逸返回既有的 `图片文件缺失` 消息。

- 激活锁等待超时现抛出具名 `ActivationLockTimeoutError`（从 `./data/sync.js` 导出），替代普通 `Error`，对齐 Python `_ActivationLockTimeout`。错误消息不变。

- 大分片图片下载：Python 实现的默认超时对齐本侧每次镜像尝试 30 分钟的总期限；TypeScript 行为不变，注释更新为已对齐的语义。

- 两种实现现一致归一化 `GITHUB_MIRRORS` 条目：去掉首尾空白和全部末尾斜杠。此前 TypeScript 只去掉一个末尾斜杠，导致 `https://ghproxy.net//` 产生被代理拒绝的错误候选 `...//https://...`。归一化后为空的条目，如 `///`，两侧均丢弃。

- **npm tarball 校验容忍传播延迟（#156）。** TypeScript CD 的 `Verify npm published bytes` 步骤现为 registry/CDN URL 避免缓存，重试约 10 分钟，区分传播超时与真实字节不匹配，并在永久不匹配时快速失败。此步骤从 `publish-npm` 移到 `github-release`，传播超时不再导致跳过发行创建，可用 `gh run rerun <run-id> --failed` 恢复；版本已存在时跳过 `npm publish`，使 job 可安全重跑。

- 用户输入的搜索正则（`search`、`search_stories` 及 enemy/stage/item 范围）现使用 Unicode（`/u`）标志编译，使非 BMP 码点处理（如 emoji、扩展字符）与默认使用 Unicode 的 Python `re` 对齐（#161）。JS `\w` 即使用 `/u` 仍仅匹配 ASCII，而 Python `\w` 匹配 CJK；此残余差异来自基本语义，无法通过标志修复。

## [2.6.2] - 2026-08-12

### 修复

- GameData Excel/Levels Auto-Sync 在数据未变化时不再替换 `.gamedata_pair.json`，避免误报激活变化和周期性缓存失效（#152）。

- 真实代际变化及配对元数据缺失或无效时，仍会原子重建配对并使 GameData 缓存失效。

## [2.6.1] - 2026-08-10

### 修复

- `prts_page(action="template")` 现将嵌套模板字段渲染为完整可读文本，不再静默丢弃文本或返回 parsetree XML 片段（#125）。

- `read_activity` 现一致校验分页输入，请求页超出现有活动范围时，返回清楚的纯内容消息（#137）。

#### Python

- 某个嵌套值渲染为空时，模板渲染保留其他有效字段，检查错误的 MediaWiki 响应形状和标记边界，并保持意外本地处理错误可被观察。

#### TypeScript

- 某个嵌套值渲染为空时，模板渲染保留其他有效字段，将错误的 MediaWiki 响应形状和标记边界归一为文档说明的纯内容备用结果。

## [2.6.0] - 2026-08-09

### 新增

#### Python

- **缓存观测（`/debug/cache` 端点）。** 每个数据模块导出 `cache_stats()`，返回每个缓存的 `{loaded, count}`，MediaWiki 图片 LRU 另有 `bytes`。只读 `/debug/cache` HTTP 端点汇总九个模块供观测（#104）。

#### TypeScript

- **缓存观测（`/debug/cache` 端点）。** 每个数据模块导出 `getCacheStats()`，返回每个缓存的 `{loaded, count}`，图片 LRU 另有 `bytes`。只读端点汇总九个模块（#104）。

- **Issue #90 的汇总运行指标。** TypeScript Streamable HTTP 服务提供可选的 `/debug/metrics` 端点，包含进程内存高水位、请求/工具耗时及错误总量、会话年龄/空闲超时/生命周期总量，以及九个域的缓存命中/未命中/失效计数。指标仅作汇总，不保留 MCP 参数/结果或会话标识。

- **生产 cgroup 采样器。** 新增 systemd 定时器模板，动态解析 PRTS 服务 cgroup，将已校验的五分钟内存及运行指标样本追加到 JSONL，配合日志轮转，不配置公共反向代理路由。

- **六会话内存金丝雀门禁（#90）。** 隔离的回环基准测试通过六个并发会话，执行档案、数据搜索、剧情搜索、章节/活动读取及一次真实立绘图片获取，要求缓存稳定、请求回到静止状态且 RSS 有界。版本控制中的同机金丝雀资产新增独立回环服务、带认证的临时路由，以及 `MemoryHigh=1G` / `MemoryMax=1536M` cgroup 限制，不修改稳定服务。

### 修复

#### Python

- **立绘形态及诊断访问边界（#123）。** `operator_artwork` 将 `阿米娅(近卫)` 和 `阿米娅(医疗)` 的半角/全角括号写法解析到各自立绘 char ID，不改变其他工具的名称解析。本地及 MediaWiki 模式中的不透明立绘 token 均要求形态精确匹配。`/debug/cache` 现要求 `PRTS_DEBUG_TOKEN` Bearer 认证，否则返回 404。

#### TypeScript

- `Readable.fromWeb` 的类型断言通过 `Parameters<typeof Readable.fromWeb>[0]` 从裸 `any` 收窄到精确参数类型（#100）。

- **立绘形态及诊断访问边界（#123）。** `operator_artwork` 将 `阿米娅(近卫)` 和 `阿米娅(医疗)` 的半角/全角括号写法解析到各自立绘 char ID，不改变其他工具的名称解析。本地及 MediaWiki 模式中的不透明立绘 token 均要求形态精确匹配。`/debug/cache` 和 `/debug/metrics` 现要求 `PRTS_DEBUG_TOKEN` Bearer 认证，否则返回 404。

### 变更

#### Python

- 基础立绘标签映射（`BASE_ILLUST_LABELS`）统一由 `data/images.py` 持有；`data/artwork_mediawiki.py` 导入它，不再维护重复副本（#100）。

- **MCP SDK v2 及双协议时代服务（#84）。** 迁移到精确依赖 `mcp[cli]==2.0.0` 和 `MCPServer` API。继续支持旧式 initialize/会话客户端；新的 stdio 连接或 HTTP 请求可以选择无状态的 `2026-07-28` 信封，无需 initialize 即可使用 `server/discover`、`tools/list` 和 `tools/call`。Python 结果模型构造使用 SDK v2 的 snake_case API，同时保留 camelCase 传输字段。

#### TypeScript

- 缓存调试投影现包含进程整个生命周期的 `hits`、`misses` 和 `clears` 字段，保留原有九域形状。

- **MCP SDK v2 及双协议时代服务（#84）。** 迁移到 SDK v2。继续支持旧式 initialize/会话客户端；HTTP 客户端可选择无状态的 `2026-07-28` 信封，无需 initialize 或 `Mcp-Session-Id` 即可使用 `server/discover`、`tools/list` 和 `tools/call`。

- 基础立绘标签映射（`BASE_ILLUST_LABELS`）统一由 `data/images.ts` 持有；`data/artworkMediawiki.ts` 导入它，不再维护重复副本（#100）。

## [2.5.2] - 2026-08-09

### 安全

- 更新锁定的 npm 生产依赖图，包括 `@modelcontextprotocol/sdk` 1.30 和 `adm-zip` 0.6，解决审计发现的生产依赖安全公告，无需进行不兼容的 SDK 主版本升级。

### 修复

- **适配当前 AKDP 敌人数据库。** `get_stage_enemies` 和 `get_enemy_info` 现读取当前 `zh_CN-levels.zip` 发行版生成的直接敌人 ID 映射，同时保留旧版包装格式支持。

- **标量剧情选项。** 字符串类型的 `Decision.options` 现返回为一条完整选项行，不再被丢弃或拆成字符。

- **立绘 token 归属。** `operator_artwork(action="get")` 在读取本地图片数据或请求 MediaWiki 前，拒绝属于另一干员的立绘 token。

## [2.5.1] - 2026-08-07

### 修复

- **GameData 配对重试不再由 commit_sha 不一致触发。** excel 和 levels 压缩包均为最新，但 `commit_sha` 不同（本地元数据过时，而非数据缺失）时，同步不再安排密集的 30s/120s/600s 重试。下一次周期同步会消除元数据差异；只有 `offline_fallback` / `no_data` 状态触发重试。

#### Python

- **发行 manifest 的 404 处理。** 镜像以 HTTP 404 确认发行版没有 `manifest.json` 时，同步会直接跳过该镜像，避免后续镜像的通用网络 404 覆盖明确的缺失信号。新增 `_AssetNotFoundError`，区分“该发行版确实没有 manifest”和“无法访问此镜像”。

- **图片分片 sha256 校验。** 下载 AKDP 图片分片后，同步在激活前核对每个所需变体的 sha256。所需变体的 PNG 缺失计为不匹配并阻止激活，此前会静默跳过。

- **MCP `initialize` 版本握手备用值。** 包元数据不可用时，例如未经安装直接从源码运行，握手报告 `0.0.0`，不再因 `PackageNotFoundError` 崩溃。

#### TypeScript

- **发行 manifest 的 404 处理。** 镜像以 HTTP 404 确认发行版没有 `manifest.json` 时，同步会直接跳过该镜像，避免后续镜像的通用网络 404 覆盖明确的缺失信号。新增 `AssetNotFoundError`，区分“该发行版确实没有 manifest”和“无法访问此镜像”。

- **图片分片 sha256 校验。** 下载 AKDP 图片分片后，同步在激活前核对每个所需变体的 sha256，现采用异步方式。所需变体的 PNG 缺失计为不匹配并阻止激活，此前会静默跳过。

### 变更

- CI 升级到 Node 24，`actions/*` 升至兼容 Node 24 的版本。

## [2.5.0] - 2026-08-07

### 新增

- 新增 `operator_artwork` 工具，默认启用。`action="list"` 返回带语义标签、数量有界的元数据；`action="get"` 返回一张 base64 `ImageContent` 图片，默认 `large` 变体，最大 1024px。默认模式（`LOCAL_IMAGE=false`）在 #85 的完整安全边界（主机名/MIME/文件魔数/1MiB/流式读取/重定向）内按需从 PRTS MediaWiki 获取，使用 256 MiB LRU 缓存（`PRTS_IMAGE_CACHE=true`）。设置 `LOCAL_IMAGE=true` 同步约 1.5 GB AKDP 本地 PNG 资产；`ORIGINAL_IMAGE=true` 加入全分辨率分片。MediaWiki 标签来自 CharinfoV2 的 `时装N名称`；AKDP 标签来自 `skin_table.json`。MediaWiki 模式拒绝 `original` 变体，因为 PRTS 原图超过 1 MiB 上限。工具数 23 → 24。

### 变更

- **自动同步数据源切换到自托管的 `arknights-data-pipeline`。** 默认同步现使用 `3aKHP/arknights-data-pipeline`（工厂仓库）的 `zh_CN-excel.zip`、`zh_CN-levels.zip` 及剧情 `zh_CN.zip` Release。2.5.0 版本线不再依赖旧上游仓库的数据。收紧发行 manifest 校验，防止部分或损坏的压缩包被视为健康数据。

#### TypeScript

- `tsx` 开发依赖从 4.21 升至 4.23。

### 修复

- **`operator_artwork` allimages 分页。** MediaWiki `allimages` 现使用 `aifrom` 续页，每页 50 条，避免干员皮肤图片超过 50 张时静默截断。

#### Python

- **数据同步使用 tag 前缀筛选，替代 `/releases/latest`。** `arknights-data-pipeline` 仓库现同时包含 `data-*` 和 `images-*` GitHub Release。`check_latest_release` 从 `/releases/latest` 端点改用带 `data-` tag 前缀筛选的发行列表 API，防止 GitHub 将 `images-*` 发行自动标为“Latest”时同步静默停滞。共享的 `_list_releases` / `_latest_release_by_prefix` / `_asset_url` 辅助函数从 `images_sync` 提取到 `sync`，避免重复。

- **MCP `initialize` 握手报告产品版本。** 服务现通过 `importlib.metadata` 报告实际包版本，替代空占位符，使 MCP 客户端可以显示正确版本。

#### TypeScript

- **数据同步使用 tag 前缀筛选，替代 `/releases/latest`。** `arknights-data-pipeline` 仓库现同时包含 `data-*` 和 `images-*` GitHub Release。`checkLatestRelease` 从 `/releases/latest` 端点改用带 `data-` tag 前缀筛选的发行列表 API，防止 GitHub 将 `images-*` 发行自动标为“Latest”时同步静默停滞。共享的 `listReleases` / `latestReleaseByPrefix` / `assetUrl` 辅助函数从 `imagesSync` 提取到 `sync`，避免重复。CI 的 `gh release download` 现先解析最新 `data-*` tag，再下载。

- **TS stdio 入口不再启动 HTTP 监听。** stdio 入口（`server-stdio.ts`）此前从 `server.ts` 导入，后者加载模块时会调用 `app.listen()`，导致 stdio 传输之外还在配置的 `PORT` 上启动一个额外 HTTP 服务。现提取无副作用的 `server-core.ts` 工厂，由两个入口共享。

- **`LOCAL_IMAGE=true` 的 Docker 图片卷。** 三个 Dockerfile 均创建 `/data/images`，使使用命名卷运行时，`LOCAL_IMAGE=true` 同步路径有可写的目标目录。

- **TS `{}` 空对象占位符崩溃。** 上游 AKDP 数据有时在数组字段（`waves`、`fragments`、`actions`、`unlockCondition`、`talents`、`tagList` 等）中输出 `{}` 而非 `[]`。TS 的 `?? []` 只捕获 `null`/`undefined`，使 `{}` 继续进入 `.map()` / `for...of` 并崩溃。全部 21 处来自 JSON 的 `?? []` 现改为 `Array.isArray(x) ? x : []`，对齐 Python 假值 `or []` 的容错。

## [2.4.0] - 2026-07-29

### 修复

#### Python

- 将 MCP Python SDK 限制在 2.0 以下，使 Docker 和其他未锁定依赖的 `pip` 安装保留兼容的 `mcp.server.fastmcp` API。

### 新增

- 新增贯穿进程生命周期的自动同步：启动检查之后，每小时检查 GameData excel、GameData levels 及 StoryJson Release，无需重启服务。`PRTS_AUTO_SYNC_INTERVAL_SECONDS` 配置间隔，设为 `0` 时保留仅启动同步行为。

- 新增压缩包激活元数据，使中断的解压在下一周期重试，完成后才将已下载 Release 视为活跃数据。

- GameData excel 和 levels 现作为同一原子代际生效，周期更新期间工具不会观察到新旧混合配对。

- 共享卷发布锁在持有期间持续续租，防止耗时下载或解压被误判为锁已遗弃。

## [2.3.1] - 2026-07-10

### 变更

#### Python

- Python 包版本保持与 TypeScript 2.3.1 安全更新一致。

### 安全

#### TypeScript

- 更新生产环境传递依赖，解决 HTTP 和 JSON-schema 支持包的已知漏洞。

### 修复

#### TypeScript

- 同步 `package-lock.json` 中的 `prts-mcp-ts-stdio` bin 元数据。

## [2.3.0] - 2026-07-08

### 新增

#### Python

- 新增 Streamable HTTP 传输：`PRTS_TRANSPORT=http` 启动 Starlette + uvicorn 服务，提供 `/mcp` 端点、`/health` 探针和 `HOST`/`PORT` 环境变量控制，默认 `0.0.0.0:3000`。默认仍为 `stdio`。结束 2.0 的传输分工，Python 实现现同时支持 stdio 和 Streamable HTTP。

- 新增 `test_e2e_http.py`，覆盖 HTTP health、initialize + tools/list，以及仅通过环境变量设置的 output_channel 行为。

- 将 `starlette>=0.27` 和 `uvicorn>=0.31` 声明为显式依赖，此前通过 `mcp[cli]` 间接引入。

#### TypeScript

- 新增 stdio 传输支持：新增 `prts-mcp-ts-stdio` npm bin 和 `ts/src/server-stdio.ts` 入口。复用现有 `createMcpServer` 工厂及 `runStartupSync`，连接 `StdioServerTransport`，面向单会话本地 MCP 客户端（Claude Desktop、Claude Code、Cursor）。结束 2.0 的传输分工，TypeScript 实现现同时支持 Streamable HTTP（既有 `prts-mcp-ts` / `prts-mcp-ts-bun` bin）和 stdio。

- 新增 `start:stdio` / `start:stdio:bun` npm 脚本。

- 新增 `e2eStdio.test.ts`，覆盖 stdio initialize 握手、tools/list 及错误的妥善处理。

- 扩展 `smoke-package-bun.mjs`，断言 `npm pack` + `bun add` 后安装的 `prts-mcp-ts-stdio` bin shim 存在且非空。

### 变更

#### Python

- 将 `OUTPUT_CHANNEL` 从模块级常量改为 `contextvars.ContextVar`，为传输层覆盖预留支持。工具代码不变；`render_result` 在调用时通过 `get_output_channel()` 解析通道。**说明**：此时 Python HTTP 的 output_channel 为进程级，仅由环境变量控制，因为 FastMCP 的会话模型使工具代码看不到每请求的 contextvars。TypeScript HTTP 传输支持每请求解析。

#### TypeScript

- `server.ts` 现导出原为模块私有的 `createMcpServer`、`SERVER_VERSION` 和 `log`，让 stdio 入口可复用它们，无需重复工具注册逻辑。

## [2.2.0] - 2026-07-08

### 变更

#### Python

- Python 没有用户可见变化。此次发行使 Python 包版本与仓库 2.2.0 发行一致，后者切换了 TypeScript 默认运行时。

#### TypeScript

- Bun 成为 TypeScript 实现的默认生产运行时：默认 `ts/Dockerfile`、主要 CI 验证路径（`verify-ts`）及推荐 Docker 部署均使用 Bun，以 Bun `1.3.14` 验证。**Node.js 继续作为受支持的旧版/可选运行时**，通过 `prts-mcp-ts` npm bin（因此 `npx prts-mcp-ts` 仍无需额外依赖）、`npm install -g` 及新增的 `ts/Dockerfile.node` 构建路径使用。npm 发布路径不变，仍使用不依赖具体运行时的 `npm publish --provenance`。

- 默认 npm 脚本（`start`、`smoke:http`、`smoke:http:fixture`）现使用 Bun 入口；`start:bun` / `smoke:bun` / `smoke:bun:package` 原样保留，兼容 2.1.0。

- CI 矩阵切换：`verify-ts` 现使用 Bun，执行类型检查、构建、运行时冒烟及打包后的冒烟；`node:test` 单元套件移到新增 `test-ts` job；`build-image-ts` 构建默认 Bun 镜像；新增 `build-image-ts-node` job 覆盖旧 Node 镜像。

### 新增

#### TypeScript

- 新增 `ts/Dockerfile.node`，作为受支持的 Node.js 旧版 Docker 构建路径。

- 新增 Node 旧版 npm 脚本：`start:node`、`smoke:http:node`、`smoke:http:fixture:node`；以及用于 Bun 原生开发的 `dev:bun`。

- 在 `verify-ts` 中显式检查 `bun.lock`/`package.json` 差异，使双锁文件失步时立即失败并提供可操作消息。

- 扩展 `build-image-ts`，在 `release/**` pull request 上也运行，使默认 Bun 镜像在交付到 main 前经过验证。

### 修复

#### TypeScript

- 修复默认 Docker 镜像没有随包备用数据：`.dockerignore` 的 `*.zip` 规则将 CI 预取的 `data/storyjson/zh_CN.zip` 和 gamedata 压缩包从 `COPY data/ data/` 中剔除，导致容器缺少离线 storyjson 备用数据。新增反向匹配规则，使随包数据 ZIP 进入镜像。

### 移除

#### TypeScript

- 移除已冗余的 `ts/Dockerfile.bun`，其内容成为默认 `ts/Dockerfile`。

- 移除 `verify-ts-bun` 和 `build-image-ts-bun` CI job，其覆盖由新的 Bun 默认 `verify-ts` 和 `build-image-ts` 承接。

## [2.1.0] - 2026-07-07

### 变更

#### Python

- Python 没有用户可见变化。此次发行使 Python 包版本与仓库 2.1.0 发行一致。

#### TypeScript

- 将 Bun 运行时及 `ts/Dockerfile.bun` 从候选覆盖提升为受支持的可选 TypeScript 运行路径，以 Bun `1.3.14` 验证。Node/npm 仍为默认运行时、Dockerfile 和 Trusted Publishing 路径。

### 新增

#### TypeScript

- 新增公共 bin `prts-mcp-ts-bun`，作为受支持的可选 Bun 运行时入口。默认 `prts-mcp-ts` bin 仍基于 Node.js。

- 新增打包后的 Bun 冒烟测试：运行 `npm pack`，在临时项目中使用 Bun 安装 tarball，启动 `prts-mcp-ts-bun`，并复用 HTTP MCP 冒烟测试框架。

## [2.0.2] - 2026-07-07

### 修复

- PRTS Wiki 搜索响应缺少重定向元数据时，`search_prts` 现将类似重定向的命中解析到目标页面；后续查询失败时回退到原结果。

#### Python

- `search_prts` 更精确地过滤技术/Wiki 实现页面，即使可见结果被过滤，也保持 `totalhits` 不变。

#### TypeScript

- `search_prts` 更精确地过滤技术/Wiki 实现页面，即使可见结果被过滤，也保持 `totalHits` 不变。

### 新增

#### TypeScript

- 新增可复用的 TypeScript 服务 HTTP MCP 冒烟测试框架，并为 Node、Bun 及候选 Bun Docker 镜像提供 CI 覆盖。

- 新增可选 Bun 候选运行路径，包含 Bun 脚本、已提交的 `bun.lock`、`ts/Dockerfile.bun` 和 CI 冒烟覆盖。Node/npm 仍为默认 TypeScript 运行时和 npm Trusted Publishing 路径。

## [2.0.1] - 2026-07-03

### 修复

#### Python

- 剧情数据尚不可用时，`list_story_events` 不再输出多余的 `structuredContent` 包装，对齐其他八个剧情工具，它们此前就以纯 content 文本返回数据缺失消息。

### 变更

#### TypeScript

- 纯 content 工具处理器现统一通过共享的 `textResult(...)` 辅助函数返回，集中构造文本结果，返回的 MCP 载荷形状不变。

## [2.0.0] - 2026-07-03

### 新增

#### Python

- **输出通道设计替代每次调用的 `output_format` 参数（2.0 设计决策）。** 原路线图提出可选的 `output_format=markdown|json` 参数，并在 2.0 将默认值改为 `json`。**这一形式在设计过程中被否决。** 主要使用者是 LLM Agent，JSON 相比 Markdown 使提示词 token 增加约 15–30%，会抵消工具接口整合节省的上下文预算。2.0 因而保留始终输出的 Markdown `content` 文本，并通过 MCP 原生 `structuredContent` 字段承载结构化数据；使用**连接级** `output_channel` 开关，经 `PRTS_OUTPUT_CHANNEL` 环境变量选择 `content`（默认）/ `structured` / `both`。默认值**没有**改为 JSON。各工具通道映射及客户端配置见 [`docs/migration-1.x-to-2.0.md`](https://github.com/3aKHP/prts-mcp/blob/main/docs/migration-1.x-to-2.0.md)。

- **输出通道（2.0）。** 可通过 MCP 原生 `structuredContent` 通道选择交付结构化内容，由连接级 `PRTS_OUTPUT_CHANNEL` 环境变量控制（`content` 默认 / `structured` / `both`）。默认 `content` 通道为仅消费 MCP `content` 的客户端保留人类可读的 Markdown 内容。迁移后的工具有意改变 MCP manifest/传输形状，将 FastMCP 自动生成的 `outputSchema={result:string}` 和 `structuredContent={"result": markdown}` 包装替换为显式 `CallToolResult` 交付，因此支持结构化内容的客户端只有选择 `both` 时才收到重复 Markdown。`list_stages` 为试点工具，其 `structuredContent` 同时包含原始枚举（如 `type=ACTIVITY`）及渲染标签（`type_label=活动`）；合法空页（筛选无匹配/offset 超出末尾）返回结构化空载荷，同时保留原始 Markdown 文本。其他结构化工具及 TypeScript 实现在后续提交跟进。说明：`structured` 模式用于已确认客户端支持 structuredContent 的部署；不支持的客户端（如 Chatbox）只收到一行摘要，因此未确认支持前应保留默认 `content`。

- **叙事工具传输输出精简（2.0）。** 六个叙事/散文工具（`get_operator_archives`、`get_operator_voicelines`、`read_story`、`read_activity`、`get_story_summary`、`prts_page`）从 `-> str` 迁移为通过新增的 `text_result(markdown)` 辅助函数显式返回 `CallToolResult`。content 文本不变，但不再派生 FastMCP 自动 `outputSchema`，也不再输出重复的 `structuredContent={"result": markdown}`，因为叙事输出没有有用的结构化形式。其余结构化工具通过 `output_channel` 控制结构化载荷。

- **详情工具 structuredContent（2.0，P2b PR1）。** 四个详情工具（`get_operator_basic_info`、`get_enemy_info`、`get_stage_info`、`get_item_info`）迁移到构造/渲染分离，提供真实的 `structuredContent` 载荷。`render_result` 新增可选 `summary` 覆盖，使详情工具（单记录，没有 `total`）可在 `structured` 模式返回有意义的一行摘要，替代通用备用值。`structuredContent` 同时包含原始枚举及渲染标签（如 `profession_raw=CASTER` + `profession=术师`），使下游自动化可以按原始值筛选，中文使用者可获得本地化文本。列表/融合工具（`list_enemies`、`search` 等）及 `search` 整合在 P2b PR2/PR3 跟进。

- **游戏数据列表/融合 structuredContent（2.0，P2b PR2a）。** 四个游戏数据列表/融合工具（`list_enemies`、`list_items`、`get_stage_enemies`、`get_enemy_appearances`）迁移到构造/渲染分离，提供真实的 structuredContent。列表载荷包含分页元数据、筛选条件（原始用户输入及归一化筛选值），以及携带可串联使用的 ID 和原始值/标签字段对的条目；融合工具（`get_stage_enemies`）包含每种敌人的出现数量、等级、覆盖标记及属性文本。**空结果契约**：合法空结果（筛选无匹配、offset 超出末尾）现返回结构化载荷 `{total:0, entries:[]}`，通过结构化通道交付，content 通道仍原样输出原人类可读消息，因此结构化使用者可统一依赖“空 ⇒ {total:0}”。真实错误（无效参数、数据缺失）仍只通过 content 返回。剧情列表/Wiki 搜索工具及异构 `search` 在 P2b PR2b/PR3 跟进。

- **剧情导航和 Wiki 搜索 structuredContent（2.0，P2b PR2b）。** 六个剧情/Wiki 导航工具（`list_story_events`、`list_stories`、`get_operator_memoirs`、`find_character_appearances`、`find_speakers_in`、`search_prts`）迁移为显式 `CallToolResult` 交付，采用构造/渲染载荷。剧情载荷包含可串联使用的活动/剧情 ID、原始剧情条目标签，以及发言/被提及布尔标记；`search_prts` 的 `total` 现来自 MediaWiki `totalhits`，可能大于返回页的结果数。合法空结果通过结构化通道携带 `{total:0}`，同时保留现有 Markdown 文本；无效参数、剧情数据缺失和 PRTS 网络失败仍只通过 content 返回。

- **搜索 structuredContent（2.0，P3）。** 剩余 Python 搜索工具（`search` 和 `search_stories`）迁移为显式 `CallToolResult` 交付，采用结构化搜索信封。`search` 现返回稳定的外层信封（`scope`、`pattern`、`total`、`results`），同时为干员、敌人、关卡和道具保留各范围专属条目；每个条目包含可串联使用的 ID，以及重新渲染现有 Markdown 卡片所需字段。`search_stories` 现暴露原始筛选条件、带 `is_match` 标记的结构化上下文行，以及用于后续读取的 `story_key`。合法无匹配搜索通过结构化通道携带 `{total:0, results:[]}`；无效正则、无效筛选条件和缺失数据仍只通过 content 返回。全工具 outputSchema 不变条件留给专门的 PR4 测试层跟进。

#### TypeScript

- **输出通道设计替代每次调用的 `output_format` 参数（2.0 设计决策）。** 原路线图提出可选的 `output_format=markdown|json` 参数，并在 2.0 将默认值改为 `json`。**这一形式在设计过程中被否决。** 主要使用者是 LLM Agent，JSON 相比 Markdown 使提示词 token 增加约 15–30%，会抵消工具接口整合节省的上下文预算。2.0 因而保留始终输出的 Markdown `content` 文本，并通过 MCP 原生 `structuredContent` 字段承载结构化数据；使用**连接级** `output_channel` 开关，经查询字符串 / `x-prts-output-channel` 请求头 / `PRTS_OUTPUT_CHANNEL` 环境变量选择 `content`（默认）/ `structured` / `both`。默认值**没有**改为 JSON。各工具通道映射及客户端配置见 [`docs/migration-1.x-to-2.0.md`](https://github.com/3aKHP/prts-mcp/blob/main/docs/migration-1.x-to-2.0.md)。_（Python 实现另有“叙事工具传输输出精简”条目，记录移除 FastMCP 自动 `outputSchema={result:string}` 包装；TS 传输没有对应的自动包装，因此叙事工具在本侧直接属于纯 content 交付路径。）_

- **输出通道试点（2.0）。** Streamable HTTP 会话可通过查询字符串、`x-prts-output-channel` 请求头或 `PRTS_OUTPUT_CHANNEL` 选择 `output_channel=structured` 或 `output_channel=both`。这一首批 TS 迁移为 `list_stages` 启用 structuredContent，保留默认纯 content Markdown 输出；合法空页（筛选无匹配/offset 超出末尾）也提供结构化空载荷。

- **结构化数据工具的输出通道覆盖（2.0）。** TS 的其余游戏数据和剧情导航工具现支持 structuredContent：干员/道具/敌人/关卡详情及列表、关卡敌人融合、剧情活动/章节列表、干员密录、角色出场和活动发言者计数。

- **搜索工具的输出通道覆盖（2.0）。** TS 的 `search`、`search_stories` 和 `search_prts` 工具现通过 `structured`/`both` 通道输出 structuredContent，包含合法无匹配结果的结构化空载荷，以及与 Python 实现共享的对齐测试夹具。

### 变更

- **参数名称归一（2.0，不兼容变更）。** 干员工具（`get_operator_archives`、`get_operator_voicelines`、`get_operator_basic_info`、`get_operator_memoirs`）现使用 `name` 替代 `operator_name`，与敌人/关卡/道具/角色工具已采用的 `name` 约定一致。

- **统一搜索（2.0，不兼容变更）。** `search_data`、`search_enemies`、`search_stages` 和 `search_items` 合并为一个 `search(scope, pattern, max_results)` 工具，要求提供 `scope` 枚举（`operators` / `enemies` / `stages` / `items`）。剧情对白搜索保留独立 `search_stories`，因为筛选条件不同。工具数 32 → 28。

- **统一 PRTS 页面工具（2.0，不兼容变更）。** `read_prts_page`、`list_prts_sections`、`get_prts_categories`、`get_prts_links` 和 `get_prts_template` 合并为一个 `prts_page(page_title, action, ...)` 工具，要求提供 `action` 枚举（`read` / `sections` / `categories` / `links` / `template`）。Wiki 关键词搜索保留独立 `search_prts`。工具数 28 → 24。

- **工具描述规范化（2.0）。** 所有工具描述改写为统一风格：以动词开头说明用途，注明输出形状，最多一个交叉引用，参数语义放在参数 schema 中；篇幅缩减约 20%，减少小上下文模型的上下文预算占用。工具名、参数和输出格式不变。

#### Python

- **`list_stories` 吸收活动级摘要（2.0，不兼容变更）。** `list_stories(event_id, include_summaries=True)` 现于已有每章一句摘要之前，在可用时加入活动的 LLM 总览（来自 `event_summaries.json`），使其涵盖原 `get_event_summary` 的全部功能。工具数 24 → 23。

#### TypeScript

- **`list_stories` 吸收活动级摘要（2.0，不兼容变更）。** `list_stories(event_id, include_summaries=true)` 现于已有每章一句摘要之前，在可用时加入活动的 LLM 总览（来自 `event_summaries.json`），使其涵盖原 `get_event_summary` 的全部功能。工具数 24 → 23。

- **剧情空结果措辞与 Python 对齐（2.0）。** TS 剧情导航工具现为活动/章节列表、角色出场及发言者计数使用兼容 Python 的空结果消息，包含 Python 风格带引号的筛选值。这是输出通道迁移路径中有意进行的 TS 开发版文本变更，其他方面保持内容兼容。

### 移除

- **`search_data`、`search_enemies`、`search_stages`、`search_items`、`list_search_scopes`（2.0，不兼容变更）。** 由统一 `search(scope, ...)` 替代；原由 `list_search_scopes` 返回的范围目录合入 `search` 工具描述。

- **`read_prts_page`、`list_prts_sections`、`get_prts_categories`、`get_prts_links`、`get_prts_template`（2.0，不兼容变更）。** 由统一 `prts_page(page_title, action, ...)` 替代。

#### Python

- **`get_event_summary`（2.0，不兼容变更）。** 合入 `list_stories(include_summaries=True)`；`get_story_summary`（单章深度摘要）不变。

#### TypeScript

- **`get_event_summary`（2.0，不兼容变更）。** 合入 `list_stories(include_summaries=true)`；`get_story_summary`（单章深度摘要）不变。

## [1.7.2] - 2026-09-26

1.7 LTS 线的维护发行版（Python 和 TypeScript）。

### 修复

- 缓存元数据保存改为原子操作，使用唯一临时文件及 rename，避免写入中途崩溃造成损坏；发行资产下载使用唯一临时名称，防止并发进程争用共享 `.tmp` 文件。

- 两种实现现一致归一化 `GITHUB_MIRRORS` 条目：去掉首尾空白和全部末尾斜杠。此前 TypeScript 只去掉一个末尾斜杠，导致 `https://ghproxy.net//` 产生被代理拒绝的错误候选 `...//https://...`；Python 保留首尾空白，并在归一化前筛选空白条目。归一化后为空的条目，如 `///`，两侧均丢弃。

- `get_enemy_info` / `get_stage_enemies` 恢复读取当前上游 `enemy_database.json` 的直接映射形状，恢复敌人战斗属性；继续支持旧版 `enemies` 包装形状。

- `get_stage_enemies` 缺少属性时的备用输出，不再重复渲染 `战斗属性：战斗属性：` 前缀。

#### Python

- `read_activity` 现通过 `Field(ge=, le=)` 在框架层限制 `page`（`>= 1`）及 `page_size`（`1-20`），对齐 TypeScript Zod schema，因此无效分页会在进入数据层前被拒绝，例如 `page_size=0` 此前会生成无穷空页且 `has_more=True`。

- 游戏数据列表工具（`list_enemies`/`get_enemy_appearances`/`list_stages`/`list_items`）现通过 `Field(ge=, le=)` 在框架层检查 `limit`（`1-200`）及 `offset`（`>= 0`）边界，对齐 TypeScript Zod schema，使两种实现一致拒绝越界分页。

- `get_operator_memoirs`、`find_character_appearances` 和 `find_speakers_in` 不再将 KeyError 消息（未知干员、干员没有密录数据、未知活动）包在 Python repr 引号中；直接显示干净的消息文本，对齐 TypeScript 实现。

- Python 和 TypeScript 运行时共用一个数据目录时，`release_meta.json` 同步元数据现可互通：两种实现均在防御性字段校验下读取任一键名风格（`commit_sha`/`commitSha`、`fetched_at`/`fetchedAt`），并统一写 snake_case。此前 TypeScript 写的缓存会被 Python 丢弃并视为缺失，Python 写的缓存则使 TypeScript 得到未定义 commit SHA 及 NaN 新鲜度，强制重新下载。现容忍文件中的未知键，不再使缓存失效。

- **标量剧情选项。** 字符串类型的 `Decision.options` 现返回为一条完整选项行，不再按每个字符生成一条错误选项行。

- 将 mcp SDK 依赖限制在兼容的 1.x 线（`mcp[cli]>=1.28,<2`），使新安装及 Docker 构建不再解析到不兼容的 2.x 主版本。

#### TypeScript

- **HTTP 会话可能在配置空闲超时的约 2× 后才被清理。** 空闲计时器触发时，如果距上次请求尚未经过 `SESSION_IDLE_TIMEOUT_MS`（只要 `initialize` 之后有请求就必然发生，因为该请求在计时器启用后刷新活跃时间），原实现会重新等待完整周期，而非剩余时间，导致默认 24h 超时可能约在 48h 才清理。计时器现按剩余空闲时间重新启动。

- **`SESSION_IDLE_TIMEOUT_MS` 现按严格十进制解析。** `0x10` 等非十进制写法此前被 `Number()` 接受并解释为毫秒级超时，使会话几乎立即被清理。无效或非正值现按文档说明禁用空闲清理。

- Python 和 TypeScript 运行时共用一个数据目录时，`release_meta.json` 同步元数据现可互通：两种实现均在防御性字段校验下读取任一键名风格（`commit_sha`/`commitSha`、`fetched_at`/`fetchedAt`），并统一写 snake_case。此前 TypeScript 写的缓存会被 Python 丢弃并视为缺失，Python 写的缓存则使 TypeScript 得到未定义 commit SHA 及 NaN 新鲜度，强制重新下载。Python 还开始容忍文件中的未知键，不再使缓存失效。

- 用户可见的 ID 列表（道具列表及搜索、敌人图鉴同分排序、关卡列表及搜索）现像 Python 后端的 `sorted()` 一样按 Unicode 码点排序，替代 ICU 区域排序，后者在 sortId 相同时把大写 ID 排到小写 ID 后，如 `AP_GAMEPLAY` 与 `ap_item_*`。

- 用户提供的搜索模式（`search`、`search_stories` 及 enemy/stage/item 搜索范围）现以 RegExp `/u` 标志编译，使非 BMP 字符像默认 Unicode 的 Python `re` 一样按单码点匹配。`/u` 拒绝的无特殊含义转义，如 `\ `，现返回既有无效正则错误，不再静默容忍。

- **标量剧情选项。** 字符串类型的 `Decision.options` 现返回为一条完整选项行，不再静默丢弃。

- 为来自 JSON 的数组读取加入上游 `{}` 空对象占位符保护：游戏数据把空数组编码为 `{}` 时，不再使 `get_stage_info`（解锁条件）、`get_stage_enemies` / `get_enemy_appearances`（关卡 waves、fragments、actions、enemyDbRefs）、敌人查询（图鉴伤害类型/标签、数据库 enemies/skills/blackboard）、干员档案及基础信息（剧情音频、剧情、天赋、候选项）和 `get_item_info`（关卡掉落列表）崩溃。相关字段现按空列表处理。

### 安全

#### TypeScript

- 更新生产依赖，解决当前 npm 安全公告：将 `@modelcontextprotocol/sdk` 更新至 ^1.30.0，保留 v1 SDK 线，将 `adm-zip` 更新至 ^0.6.0，两者均为直接依赖；使用 `overrides` 将传递依赖 `@hono/node-server`、`hono`、`body-parser`、`type-is`、`fast-uri`、`ip-address` 和 `qs` 固定到修补版本，`content-type` 2.x 通过修补后的 `body-parser` / `type-is` 链引入。仅用于开发的 `tsx` / `esbuild` 更新清除开发 esbuild 安全公告。`npm audit` 现报告零漏洞。

## [1.7.1] - 2026-07-10

1.7 LTS 线的维护发行版（Python 和 TypeScript）。

### 修复

- `search_prts` 现解析类似重定向的搜索结果，更精确地过滤技术页面，同时保留上游总命中数。

- Docker 构建保留随包游戏及剧情数据压缩包，供离线备用。

### 安全

#### TypeScript

- 更新锁定的生产依赖，解决当前 npm 安全公告。

## [1.7.0] - 2026-07-02

1.7.0 是 1.x 最后一个功能发行版，也是 1.7 LTS 基线。后续 1.7.x 更新仅包括兼容性、安全、数据同步及严重缺陷修复。

### 新增

- **剧情角色追踪。** 两个新工具复用现有剧情搜索索引，无需新数据源：`find_character_appearances(name, scope?, max_events?)` 返回角色**发言**（对白角色精确匹配）或**被提及**（任意行文本中的名称子串匹配）的章节；`find_speakers_in(event_id)` 列出活动中所有发言者及对白行数。工具数增至 32。

### 变更

#### Python

- **拆分职责过多的 story 和 server 文件。** `data/story.py`（916 行）及 `server.py`（914 行）拆为职责集中的子模块，符合 STYLE.md 的文件大小指导线，约 300 行。`story.py` 现为 `story_reader`、`story_search`、`story_memoir` 和 `story_summary` 的重新导出兼容层。`server.py` 现为约 60 行的入口，将工具注册交给 `tools_prts`、`tools_gamedata` 和 `tools_story`，同步编排交给 `startup_sync`。所有公共符号均重新导出，行为不变。

- **移除同步死代码。** 原 GitHub raw 文件同步路径（`sync_repo`、`download_files`、`check_upstream_sha`、`sync_all`）没有外部调用者，已删除。`sync.py` 从 626 行缩减至 479 行。共享符号（`CacheMeta`、`SyncResult`、`RepoSpec`、`GAMEDATA_FILES`）保留，供基于 Release 的同步路径使用。

#### TypeScript

- **拆分职责过多的 story 和 server 文件。** `data/story.ts`（907 行）及 `server.ts`（1173 行）拆为职责集中的子模块，符合 STYLE.md 的文件大小指导线，约 300 行。`story.ts` 现为 `storyReader`、`storySearch`、`storyMemoir` 和 `storySummary` 的重新导出兼容层。`server.ts` 现为约 200 行的入口，负责 Express 及会话管理，将工具注册交给 `tools/prtsTools`、`tools/gamedataTools` 和 `tools/storyTools`，同步编排交给 `startupSync`。所有公共符号均重新导出，行为不变。

- **移除同步死代码。** 原 GitHub raw 文件同步路径（`syncRepo`、`downloadFiles`、`checkUpstreamSha`、`syncAll`、`cacheMetaPath`、`loadCacheMeta`、`saveCacheMeta`、`filesPresent`）没有外部调用者，已删除。`sync.ts` 从 700 行缩减至 504 行。其余导出的同步符号（`SyncResult`、`RepoSpec`、`GAMEDATA_FILES`）保留，供基于 Release 的同步路径使用。

## [1.6.1] - 2026-06-03

### 新增

- **干员密录发现。** 新 `get_operator_memoirs(operator_name)` 工具通过 `chardict.json` 将干员中文名解析为密录剧情 key，使 LLM Agent 可以找到并读取干员密录对白。

- 此新工具作为补丁线的一次性特例，因为它提供发现入口的剧情数据原本已经存在于同步后的 StoryJson 压缩包中，只是无法通过公共工具接口找到。

- `list_story_events(category="memoirs")` 现显示此前隐藏的 372 个干员密录活动。

- 干员密录对白现纳入 `search_stories` 索引。

### 变更

- 基于本地游戏/剧情数据的搜索工具现复用缓存搜索记录，不再每次调用都重建解析后的文本，显著改善重复进行完整剧情和完整表格正则搜索的性能。

- 敌人搜索记录的可搜索文本现包含 `enemyTags`。

### 修复

- 剧情搜索现一致限制 `max_results` 和 `context_lines`，防止长时间运行的全数据集搜索产生过大的 MCP 响应。

- `search_stages` 和 `search_items` 现检查 `max_results` 边界（1–100），与其他搜索工具一致。

- `list_story_events` 和 `search_stories` 不再忽略具有有效剧情数据的 `entryType: "NONE"` 条目，这是密录无法被发现的根因。

## [1.6.0] - 2026-05-28

### 新增

- **道具/材料数据域。** 三个新工具 `list_items`、`get_item_info` 和 `search_items` 读取 `item_table.json`，提供材料/道具列表、详情、获取方法、关卡掉落、生产及商店/兑换券链接。

- **关卡/敌人跨来源融合。** 新增基于 `zh_CN-levels.zip` 的 `get_stage_enemies(stage_id)` 及 `get_enemy_appearances(name, limit, offset)`。`get_enemy_info(name)` 新增可选 `stage_id`，提供关卡特定的敌人等级及覆盖后的战斗属性，同时保留默认图鉴行为。

- 工具数从 24 扩展至 29。`list_search_scopes` 现包含道具域。

#### Python

- 运行时数据同步现处理三个数据集：`zh_CN-excel.zip`、`zh_CN-levels.zip` 和剧情 `zh_CN.zip`。Docker 镜像在已有随包备用数据之外，预热 `data/gamedata-levels`。

#### TypeScript

- 运行时数据同步现处理三个数据集：`zh_CN-excel.zip`、`zh_CN-levels.zip` 和剧情 `zh_CN.zip`。Docker 镜像和 npm 包在已有随包备用数据之外，预热 `data/gamedata-levels`。

### 变更

- 关卡掉落格式化现于可用时通过 `item_table.json` 解析道具 ID，例如 `招聘许可（7001）`。

#### Python

- `fetch_gamedata.py` 现预热 excel 和 levels 两种 Release 压缩包；`check_package_data.py` 在包装前验证随包关卡数据。

### 修复

- **发行压缩包校验。** 压缩包同步在解压前校验必需的 ZIP 条目，解压后再次检查必需文件，使部分或损坏的 `zh_CN-levels.zip` 不会被记录为健康数据。

- **敌人出场查询内存占用。** `get_enemy_appearances` 现扫描所请求的敌人，不再于首次使用时永久缓存所有敌人的出场索引。

#### Python

- **ZipStore 生命周期加固。** `ZipStore` 现支持显式 `close()` 及上下文管理器。以 ZIP 路径工作的剧情辅助函数在每次调用后关闭临时存储，避免反复剧情读取/搜索留下 `ZipFile` 句柄。

#### TypeScript

- **Release ZIP 缓存校验对齐。** 网络备用路径中，`syncRelease` 现将未通过数据集校验器的缓存 ZIP 视为不可用，对齐 Python 行为，防止损坏的剧情压缩包被报告为健康备用数据。

- **会话计时器生命周期。** 空闲会话计时器现调用 `unref()`，不会让原本空闲的 Node 进程持续存活。

## [1.5.0] - 2026-05-25

### 新增

- **关卡数据域。** 三个新工具 `list_stages`、`get_stage_info`、`search_stages`，数据来自 ArknightsGameData 中的 `stage_table.json`（3319 个关卡）及 `zone_table.json`（434 个区域）。`list_stages` 支持区域和关卡类型筛选及分页；`get_stage_info` 返回每关详细数据，包括掉落、解锁条件和关联变体；`search_stages` 跨名称、代号、描述和类型执行正则搜索。

- 工具数从 21 扩展至 24。`list_search_scopes` 新增关卡和敌人条目。

- `stage_table.json` 和 `zone_table.json` 加入同步 manifest，供完整性校验。

## [1.4.2] - 2026-05-25

### 变更

#### Python

- **版本与 TS 1.4.2 同步。** Python 侧没有变化，此版本的会话池修复仅适用于 TypeScript Streamable HTTP 传输。Python stdio 传输不受过时会话问题影响。

#### TypeScript

- **会话空闲超时默认值延长**，从 30 分钟改为 24 小时，降低正常交互期间会话被清理的概率。通过 `SESSION_IDLE_TIMEOUT_MS` 环境变量配置。

- **会话空闲超时测试**收紧为断言精确 404 状态及错误码，并新增初始化自动恢复路径子测试。

### 修复

#### TypeScript

- **过时会话 ID 导致会话池返回 400。** 客户端复用因空闲超时被清理或服务重启而丢失的会话 ID 时，服务现返回符合规范的 404（错误码 `-32002`）及 LLM 可据此操作的消息，替代原来的 400“Server not initialized”。携带过时会话 ID 的 Initialize 请求会自动恢复，剥离旧 ID 并作为新握手处理；这是对 MCP Streamable HTTP §3.2 的有意放宽，适配报错后不会用新握手重试的客户端。

## [1.4.1] - 2026-05-19

### 修复

#### Python

- **ZipStore 的 ZIP 实例缓存。** `ZipFile` 现缓存，而非每次 `exists()`/`read_text()` 都重新打开。`exists()` 从 O(n) 的 `namelist()` 改为 O(1) 的 `getinfo()`。不带 `event_id` 筛选的 `search_stories` 此前约有 3000 次冗余 ZIP 打开，超过 MCP 客户端 120 秒超时。

- **HTTP 客户端复用。** 模块级共享 `httpx.AsyncClient` 替代每次调用新建实例，共涉及 7 个调用位置，恢复连接池并避免重复 TLS 握手。

- **限速器竞态。** 使用基于时隙预留的方案，对齐 TS 实现，替代可能让并发协程超出配置速率的先检查再执行模式。

- **保留 parsetree `.tail`。** 提取标题/值时，保留嵌套 `<comment>` 和 `<template>` 元素之后的文本，不再静默丢弃。

- **剧情搜索容错。** `read_activity` 新增 `page >= 1` 校验。`search_stories` 和 `read_activity` 的异常处理从裸 `except Exception` 收窄到预期错误类型。便捷包装函数（`search_stories`、`get_event_summary`、`get_story_summary`）现统一使用 `_story_store()`。

- **API 错误语义。** MediaWiki API 错误使用 `RuntimeError` 替代 `ValueError`，符合 Python 异常层级约定。

#### TypeScript

- **ZipStore 的 ZIP 实例缓存。** `AdmZip` 现缓存，而非每次 `exists()`/`readText()` 都重新创建。不带 `event_id` 筛选的 `search_stories` 此前约有 3000 次冗余 ZIP 解析，超过 MCP 客户端 120 秒超时。

- **会话内存泄漏。** `SESSION_IDLE_TIMEOUT_MS`（默认 30 分钟）清理客户端断开但未妥善关闭会话时遗留的 MCP 传输，防止内存无限增长。

- **敌人黑板对齐。** 筛选/切片顺序修正为与 Python 一致：先取前 6 条，再筛掉空值。

- **HTML 实体解码。** 以 `String.fromCodePoint` 替代 `String.fromCharCode`，正确处理非 BMP Unicode。命名实体表从 6 处硬编码替换扩展为查询表，对未识别实体采用正则备用处理。

- **剧情搜索容错。** `read_activity` 新增 `page >= 1` 校验。`search_stories` 和 `read_activity` 的异常处理从裸 `catch {}` 收窄到预期错误类型。便捷包装函数（`searchStories`、`getEventSummary`、`getStorySummary`）现统一使用 `storyStore()`。

### 新增

#### Python

- **E2E 测试套件。** MCP 协议级测试（`test_e2e.py`），覆盖握手、全部 21 个工具接口、干员数据，以及可选数据不可用时的妥善降级。

#### TypeScript

- **E2E 测试套件。** MCP 协议级测试（`e2e.test.ts`），覆盖握手、全部 21 个工具接口、干员数据，以及可选数据不可用时的妥善降级。

## [1.4.0] - 2026-05-19

### 新增

#### Python

- **PRTS 模板数据提取。** `get_prts_template(page_title)` 从页面上的 MediaWiki 模板调用返回结构化键值数据。通过 `action=parse&prop=parsetree` 支持 `CharinfoV2`（干员）、`敌人信息/common2`（敌人）、`道具信息`（道具）及其他 name=value 模式模板。仅返回顶层模板，值中的嵌套模板从值文本中剔除。

- **敌人图鉴工具。** 三个新工具基于 `enemy_handbook_table.json`，可选合并来自 `levels/enemydata/enemy_database.json` 的战斗属性：
  - `list_enemies(threat_level, limit, offset, full)`：分页列表，可按 `boss` / `elite` / `normal` 筛选。默认前 50 条；`full=true` 返回全部 1500+ 条，普通使用不推荐。
  - `get_enemy_info(name)`：图鉴条目合并完整战斗属性，包括 HP / ATK / DEF / RES、攻击间隔、重量等级、状态免疫和带冷却/黑板参数的技能列表。
  - `search_enemies(pattern, max_results)`：跨敌人名称、描述及能力文本的正则搜索。

#### TypeScript

- **PRTS 模板数据提取。** `get_prts_template(page_title)` 通过 `action=parse&prop=parsetree`，从页面上的 MediaWiki 模板调用返回结构化键值数据。仅返回顶层模板，值中的嵌套模板剔除。

- **敌人图鉴工具。** 三个新工具基于 `enemy_handbook_table.json`，可选合并来自 `levels/enemydata/enemy_database.json` 的战斗属性：
  - `list_enemies(threat_level?, limit, offset, full)`：分页列表，支持 `boss` / `elite` / `normal` 筛选。默认前 50 条。
  - `get_enemy_info(name)`：图鉴条目合并 HP / ATK / DEF / RES、免疫及带黑板参数的技能列表。
  - `search_enemies(pattern, max_results)`：跨敌人名称、描述及能力的正则搜索。

## [1.3.1] - 2026-05-19

### 修复

#### Python

- **干员名称到 ID 的冲突。** `operator.py` 的 `_build_name_to_id()` 现仅筛选 `char_*` 条目，避免同中文名的 `trap_*` 和 `token_*` 条目静默覆盖真实干员 ID。修复受影响干员（阿米娅、森蚺、狮蝎、佩佩、断罪者等）的 `get_operator_basic_info`、`get_operator_archives`、`get_operator_voicelines` 和 `search_data`。

#### TypeScript

- **干员名称到 ID 的冲突。** `resolveCharId()` 和 `searchOperatorData()` 现仅筛选 `char_*` 条目，避免同中文名的 `trap_*` 和 `token_*` 条目静默覆盖真实干员 ID。修复受影响干员（阿米娅、森蚺、狮蝎、佩佩、断罪者等）的 `get_operator_basic_info`、`get_operator_archives`、`get_operator_voicelines` 和 `search_data`。

## [1.3.0] - 2026-05-18

### 新增

#### Python

- **PRTS 页面目录。** `list_prts_sections(page_title)` 返回 Wiki 页面的章节索引。每节标注索引（如 `[1]`，由模板嵌入的章节为 `[T-1]`）、标题层级和标题。

- **PRTS 页面分类。** `get_prts_categories(page_title)` 返回 Wiki 页面的分类标签，如“干员”“术师干员”。

- **PRTS 页面链接。** `get_prts_links(page_title, direction, limit)` 分页返回页面出站链接或入站反向链接。

#### TypeScript

- **PRTS 页面目录。** `list_prts_sections(page_title)` 返回 Wiki 页面的章节索引。

- **PRTS 页面分类。** `get_prts_categories(page_title)` 返回 Wiki 页面的分类标签。

- **PRTS 页面链接。** `get_prts_links(page_title, direction, limit)` 分页返回出站链接或入站反向链接。

### 变更

#### Python

- **`read_prts_page` 新增 `section_index` 参数。** 设置时仅返回指定章节的纯文本内容，而非整页。向后兼容，参数默认 `None`，即整页。

- **增强 `search_prts`。** 新增 `search_mode` 参数（`text` / `title`）、`filter_technical` 开关（默认 `true`，过滤 `/spine`、`/data` 等技术页面）和结果中的 `totalhits` 计数。向后兼容，新参数均有安全默认值。

#### TypeScript

- **`read_prts_page` 新增 `section_index` 参数。** 向后兼容。

- **增强 `search_prts`。** 新增 `search_mode`（`text` / `title`）、`filter_technical` 开关及结果中的 `totalHits`。向后兼容。

## [1.2.0] - 2026-05-14

### 新增

- **剧情章节摘要。** 基于此前未使用的 `zh_CN/storyinfo.json` 索引（1,945 条），新增两个工具及一项增强，并在数据源 fork 中加入 LLM 摘要生成管线：
  - `get_event_summary(event_id)`：活动全部章节的叙事总览，包含章节代号、标签、名称和摘要文本。有 LLM 活动摘要（`zh_CN/event_summaries.json`）时，在章节列表上方加入基于完整对白的 V2 梗概。
  - `get_story_summary(story_key)`：单章摘要，采用三级备用链：LLM 长摘要（`zh_CN/summaries.json`，5~7:1 压缩）、官方一句简介（`zh_CN/storyinfo.json`）及章节 `storyInfo` 字段。
  - `list_stories` 新增 `include_summaries`（bool）参数。为 `true` 时，每章行下方加入缩进摘要。

- **LLM 摘要生成管线**（`3aKHP/ArknightsStoryJson` fork）：`scripts/summarize.py` 在 CI 发行过程中通过 DeepSeek V4 Flash API 生成每章（5~7:1）及每活动（10:1）摘要，写入 `zh_CN.zip`，供 MCP 服务透明使用。

## [1.1.1] - 2026-05-14

### 修复

- **`read_prts_page` 现返回完整页面内容。** 从会剔除全部模板渲染内容的 `action=query&prop=extracts`，改为 `action=parse&prop=text`。角色页现返回 22K+ 字符的可读文本，替代此前约 400 字符的空章节标题。

- **`search_prts` 限制为主命名空间。** 新增 `srnamespace=0`，使搜索结果不再混入其他 MediaWiki 命名空间的技术数据页面。

#### Python

- **清理搜索片段中的 HTML 实体及 JSON 片段。** 在 `strip_wikitext` 后新增 `html.unescape` 解码及残余 wikitext 清理。

#### TypeScript

- **清理搜索片段中的 HTML 实体及 JSON 片段。** 在 `stripWikitext` 后新增 HTML 实体解码及残余 wikitext 清理。

## [1.1.0] - 2026-05-14

### 新增

- **搜索工具。** 三个新 MCP 工具对干员数据和剧情对白提供全文正则搜索，无需预先知道准确干员名或剧情 key 即可探索查询：
  - `list_search_scopes`：列出可搜索的数据域及其内容类型。
  - `search_data(pattern, scope, max_results)`：搜索干员名称、描述、档案文本及语音。
  - `search_stories(pattern, character, line_type, context_lines, max_results, event_id)`：搜索剧情对白、旁白及选项行，支持按发言者和行类型筛选，以及配置每个匹配周围的上下文行数。

## [1.0.0] - 2026-05-13

### 变更

- **冻结公共工具接口。** 9 个 MCP 工具的名称、必需参数和响应格式已锁定。自动化测试在 Python 和 TypeScript 的 CI 中确保这一契约。

- CI 现于运行 Python 测试前下载 storyjson `zh_CN.zip` 夹具，剧情集成测试不再被静默跳过。

- 迁移指南补充相较 0.x 的行为变化：Release 压缩包同步、`archives/` 缓存元数据、移除 `local_repo.jsonc`，以及将 `story_review_table.json` 列为必需 gamedata 文件。

### 修复

#### Python

- `read_story` 中的 `include_narration=false` 现也过滤无名发言者行（以 `（旁白）：text` 显示的舞台指示），不再仅过滤 `type="narration"` 的贴图/字幕/动画行。

#### TypeScript

- `readStory` 中的 `include_narration=false` 现也排除无名发言者行（以 `（旁白）：text` 显示的舞台指示），不再仅排除 `type="narration"` 的贴图/字幕/动画行。

## [1.0.0-beta.1] - 2026-05-12

## [1.0.0-alpha.2] - 2026-05-04

### 新增

#### Python

- 为启动同步加入有界重试循环：`offline_fallback` 和 `no_data` 结果安排守护线程在 30s、120s 及 600s 重试，之后放弃直至下次进程启动。对齐现有 TypeScript 行为，使两种实现都能在临时网络故障后恢复，无需手动重启。

- 首次同步尝试包装在 `_run_initial_sync` 中，因此 `sync_release` / `sync_release_archive` 中的意外异常不再终止守护同步线程；会记录日志并视为需要重试，对齐 TypeScript `.catch(() => true)` 基线。

#### TypeScript

- 为 storyjson Release 资产加入下载后 ZIP 完整性校验：`story_review_table.json` 引用的每章必须存在于下载 ZIP 中，才可替换缓存副本。缺失或无法读取的压缩包被拒绝，进入正常 `offline_fallback` / 重试路径，不再静默损坏本地缓存。对齐 Python 已有行为。

## [1.0.0-alpha.1] - 2026-05-03

### 新增

- 新增共享本地数据集读取层，提供目录、ZIP 和备用存储。

- 新增 GameData excel 和剧情 JSON Release 资产的数据集 spec。

- 为 Docker 和 npm 发行管线新增随包数据校验。

### 变更

- 干员及剧情解析器现通过新存储抽象读取，保留现有 MCP 工具名、参数及输出格式。

#### Python

- 运行时同步配置现使用数据集 spec，不再在服务启动代码及预热脚本中重复 Release 元数据。

#### TypeScript

- 运行时同步配置现使用数据集 spec，不再在服务启动代码中重复 Release 元数据。

## [0.4.2] - 2026-05-03

实现：Python。

### 变更

- ArknightsGameData 自动同步现从 `3aKHP/ArknightsGameData` 下载 `zh_CN-excel.zip` Release 资产，解压到现有 `gamedata` 布局，使游戏数据和剧情数据同步均采用 GitHub Release 压缩包。

- `fetch_gamedata.py` 现从同一 Release 压缩包预热随包游戏数据，不再逐个下载 raw JSON 文件。

- Python 干员数据完整性现要求 `story_review_table.json`，对齐 TypeScript 实现及新的完整 excel 压缩包。

- 每次工具调用重新解析干员数据配置；启动自动同步写入更新后的游戏数据后，清理表缓存。

- 新增回归覆盖，验证数据在同一进程中稍后变得可用的情况。

## [0.4.0] - 2026-04-25

实现：Python。

### 新增

- `GITHUB_MIRRORS` 环境变量：以逗号分隔的 ghproxy 风格代理基础 URL 列表，如 `GITHUB_MIRRORS=https://ghproxy.net`，直接 GitHub URL 失败后按顺序尝试，支持位于 GFW 后的服务器自动同步。

- `sync_repo` 和 `sync_release` 的盲目下载路径：GitHub API 不可达，但配置了镜像且没有本地数据时，直接经镜像获取文件，无需先检查 SHA；storyjson 使用不要求 API 调用的 `releases/latest/download/` 重定向 URL。

### 变更

- `download_files` 将共享 `httpx.Client` 替换为每文件调用 `_get_cascading`，使每个文件独立切换镜像。

## [0.3.3] - 2026-05-03

实现：TypeScript。

### 修复

- HTTP 服务现先开始监听，再在后台运行 GameData 和剧情自动同步，避免缓慢 GitHub Release 下载导致 systemd 已活跃但端口不可用。

## [0.3.2] - 2026-05-03

实现：TypeScript。

### 变更

- ArknightsGameData 自动同步现从 `3aKHP/ArknightsGameData` 下载 `zh_CN-excel.zip` Release 资产，解压到现有 `gamedata` 布局，使游戏数据和剧情数据同步均采用 GitHub Release 压缩包。

- npm 随包游戏数据现通过 `python/scripts/fetch_gamedata.py` 预热，与运行时同步使用同一 Release 压缩包，不再直接下载 raw JSON 文件。

- 此过渡发行版的包元数据目标版本为 `0.3.2`。

- 启动自动同步写入更新后的游戏数据后，清理干员表缓存，并以 Node 测试运行器冒烟测试覆盖核心干员行为。

## [0.3.0] - 2026-04-10

实现：TypeScript。

### 新增

- `GITHUB_MIRRORS` 环境变量：以逗号分隔的 ghproxy 风格代理基础 URL 列表，如 `GITHUB_MIRRORS=https://ghproxy.net`，直接 GitHub URL 失败后按顺序尝试，支持位于 GFW 后的服务器自动同步。

- `sync_release` 的盲目下载路径：GitHub API 不可达，但配置了镜像且没有本地数据时，通过不要求 API 调用的 `releases/latest/download/` 重定向 URL 获取 storyjson ZIP。

- 新增 `list_story_events`、`list_stories`、`read_story`、`read_activity` 工具，查询来自 ArknightsStoryJson 的明日方舟剧情脚本及活动元数据。

- npm 包包含随包游戏数据（`data/gamedata/`、`data/storyjson/`），使服务无需预先同步，即可带离线备用数据启动。

- `config.ts` 现相对 `import.meta.url`（包根目录）解析数据路径，使随包路径在 npm 安装及 Docker 中均正常工作。

### 修复

- `story_review_table.json` 加入随包数据和 `cache_meta.json`；剧情功能将它加入 `REQUIRED_OPERATOR_FILES` 后，随包数据中原本缺少该文件，使随包路径的 `filesComplete()` 总返回 false。

- 移除死代码（`STORYINFO` 常量）及未使用导入；空角色格式与 Python 实现对齐。

## [0.2.2] - 2026-04-10

实现：Python。

### 变更

- 仓库重组为 monorepo：Python 实现移到 `python/` 子目录，共享游戏数据位于仓库根目录的 `data/gamedata/`。包本身没有功能变化。

### 修复

- 更新 `fetch_gamedata.py` 和 `package_operator_data.py` 的路径解析，适配新的 `python/` 子目录位置。

- Docker 构建上下文改为仓库根目录，使 `COPY data/` 正确将游戏数据打包进镜像。

## [0.2.1] - 2026-04-14

实现：Python。

### 新增

- 随包干员数据文件（`data/gamedata/zh_CN/gamedata/excel/*.json`）现提交到仓库，构建时写入 Docker 镜像，在卷中尚无数据时作为只读离线备用。

### 变更

- 数据路径架构拆为两个独立根：`/data/gamedata`（卷，自动同步写入目标）及 `/app/data/gamedata`（Docker 内随包只读备用数据）；`config.py` 解析实际读取路径时，有文件则优先使用卷，否则回退到随包数据。

- Docker 内的 `_DEFAULT_GAMEDATA_PATH` 现固定为 `/data/gamedata`（卷挂载点），不再从 `PRTS_MCP_ROOT` 派生；Docker 外保留各用户数据目录备用路径。

- 自动同步跳过条件从路径比较改为 `is_custom_gamedata` 标记：仅当用户显式设置 `GAMEDATA_PATH` 时禁用同步，与路径值无关。

- `Config` dataclass 新增 `is_custom_gamedata: bool` 和 `effective_excel_path: Path | None` 字段；`has_operator_data` 现同时反映卷路径及随包备用数据。

- 干员工具错误消息改为说明自动同步可能尚在进行，不再要求用户设置 `GAMEDATA_PATH`。

- Dockerfile 创建空目录 `/data/gamedata` 和 `/data/storyjson`，作为卷挂载点。

- 推荐 Docker 调用改为携带命名卷：`docker run -i --rm -v prts-mcp-data:/data/gamedata prts-mcp`。

- 更新 `.mcp.example.json`、`docker-compose.override.example.yml`、`README.md`、`CONTRIBUTING.md` 和 `docs/deployment.md`，说明新的卷优先流程。

- CI 验证断言更新为匹配新的错误消息前缀。

### 修复

- 未设置 `GAMEDATA_PATH` 时，挂载的数据目录此前会被静默忽略；服务现于 Docker 内正确使用 `/data/gamedata` 作为同步目标，无需用户设置环境变量。

- 干员数据文件缺失时，原始 `[Errno 2] No such file or directory` 曾传到 MCP 客户端；现捕获并返回人类可读消息。

### 移除

- 基于 `PRTS_MCP_ROOT` 的数据根解析不再决定同步写入路径，仅保留作为 Docker/非 Docker 环境标记。

## [0.2.0] - 2026-04-08

### 新增

#### Python

- 通过 `src/prts_mcp/data/sync.py` 提供基于 GitHub 的干员数据同步，包含上游 SHA 检查、基于 TTL 的缓存复用、原子文件替换和离线备用行为。

- 新增 `scripts/fetch_gamedata.py`，在 CI、本地开发和镜像构建流程中预热最小干员数据集。

- 可选 `GITHUB_TOKEN` 支持用于 GitHub API 请求，降低匿名限速风险。

- 为容器化 MCP 服务提供 Docker/CI 冒烟测试覆盖，包含符合协议的 MCP initialize 握手。

- `CONTRIBUTING.md` 中新增面向贡献者的仓库政策。

#### TypeScript

- 新增 `get_operator_basic_info` 工具，从 `character_table.json` 提供干员稀有度、职业、阵营及描述。

- Streamable HTTP 传输（MCP 2025-03-26 规范）替代此前基于 SSE 的方式；端点为 `/mcp`，健康检查为 `/health`。

- 提供用于自托管 HTTP 服务部署的 Docker 镜像。

- 提供 npm 包（`prts-mcp-ts`），支持 `npx` / 全局安装使用。

- GitHub Actions CD workflow（`cd-ts.yml`）通过 Trusted Publishing 发布到 npm，并推送 Docker 镜像到 GHCR。

### 变更

#### Python

- 默认数据流程现优先自动同步必需的最小干员文件，不再将 `local_repo.jsonc` 或手动包装作为主要流程。

- 安装路径的数据解析在 Docker、可编辑安装及用户数据目录间采用更安全的备用路径。

- 服务启动不再因数据同步阻塞主线程；启动刷新在后台守护线程运行。

- CI 更明确地验证新的数据/启动准备路径及镜像流程。

- 更新 `README.md` 和 `CONTRIBUTING.md`，移除 `local_repo.jsonc` / `local_repo.example.jsonc` 引用，并说明自动同步优先流程。

- 重写 `docs/deployment.md`，将自动同步列为默认方式；为卷挂载并列提供 Windows（PowerShell）及 Linux/macOS 示例；环境变量参考表新增 `GITHUB_TOKEN` 和 `PRTS_MCP_ROOT`。

- `.mcp.example.json` 简化为默认自动同步调用；本地路径覆盖示例移到 `docs/deployment.md`。

- `.env.example` 更新为当前环境变量集合，使用空默认值，并新增 `GITHUB_TOKEN` 条目。

- 清理 `docker-compose.override.example.yml`：移除未使用的 `STORYJSON_PATH` 卷，增加 `GITHUB_TOKEN` 传递及 Windows 路径格式注释。

### 修复

#### Python

- 将 `local_repo.jsonc` 重新加入 `.gitignore`；此前重构无意移除该规则，使文件可能被意外暂存。

### 移除

#### Python

- 删除 `local_repo.example.jsonc`，没有代码读取该文件，也不再被文档或工具引用。

### 弃用

#### Python

- `scripts/package_operator_data.py` 仅保留作为兼容路径，不再是推荐的主要流程。

## [0.1.0] - 2026-03-18

### 新增

- PRTS MediaWiki API 集成，包含限速及自定义 User-Agent。

- Wikitext 清洗器，剔除模板、文件链接和 HTML 标签。

#### Python

- FastMCP 服务，提供 4 个工具：`search_prts`、`read_prts_page`、`get_operator_archives`、`get_operator_voicelines`。

- 本地 ArknightsGameData JSON 读取器，采用 LRU 缓存，包含 character_table、handbook_info_table、charword_table。

- 配置模块支持环境变量 / local_repo.jsonc 备用配置。

- Dockerfile 支持基于 stdio 的容器部署。

- 通过 pyproject.toml（PEP 621）提供项目元数据。

#### TypeScript

- FastMCP TypeScript 服务，提供 4 个工具：`search_prts`、`read_prts_page`、`get_operator_archives`、`get_operator_voicelines`。

- 本地 ArknightsGameData JSON 读取器，采用 LRU 缓存。
