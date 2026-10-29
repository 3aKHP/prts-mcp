# PRTS-MCP 术语表

本文汇总 PRTS-MCP 公开文档与协作讨论中反复出现的项目术语，为每个术语给出简短定义，并指向维护完整细节的权威文档。本文是术语解释的统一入口，但细节事实仍以各属主文档为准（单一事实源原则见 [dev/DOCUMENTING.md](dev/DOCUMENTING.md)）。

收录标准：在两类以上读者文档中出现，或无法从字面直接推断含义的术语。发现遗漏或口径不一致时，欢迎通过 Issue 或 PR 补充。

## 基础概念

- **PRTS Wiki**：提供泰拉世界观词条、阵营设定与剧情资料的明日方舟百科站点（MediaWiki 引擎，`https://prts.wiki`）；项目名称中的 PRTS 即指该站，服务端通过其 MediaWiki API 实时检索，不在本地保存全量词条库。详见 [README](../README.md) 与 [Agent 与 MCP 零基础入门指南](user/mcp-and-agent-basics.md)。
- **MCP（Model Context Protocol，模型上下文协议）**：一套统一的开放通信标准，让不同的 AI 客户端软件能够以一致的方式发现并调用外部工具与数据源；PRTS-MCP 就是实现了该协议的服务端。详见 [Agent 与 MCP 零基础入门指南](user/mcp-and-agent-basics.md)。
- **Agent（智能体）与 MCP 客户端**：Agent 指能够根据用户要求自主选择工具、查看结果并决定下一步动作的大模型应用形态；MCP 客户端指实现了 MCP 协议、用来接入 PRTS-MCP 等服务的宿主软件，如 Claude Desktop、Claude Code、OpenAI Codex CLI、Cursor 等。详见 [Agent 与 MCP 零基础入门指南](user/mcp-and-agent-basics.md) 与 [客户端接入与快速上手指南](user/quick-start.md)。
- **stdio 与 Streamable HTTP（传输模式）**：服务端与客户端之间的两种通信方式。stdio 模式下客户端以子进程形式拉起服务端，经标准输入输出交换报文；Streamable HTTP 模式下服务端作为独立 HTTP 服务运行（默认 `:3000/mcp`）。默认传输因发行渠道而异：npm 主包与原生二进制默认 HTTP，Docker 镜像默认 stdio，可用 `PRTS_TRANSPORT` 环境变量切换；`prts-mcp-ts` 系列兼容命令各自固定一种传输。详见 [部署指南](admin/deployment.md) 与 [快速上手](user/quick-start.md)。
- **双输出通道（content 与 structuredContent）**：工具结果的两种呈现形态。默认在 MCP `content` 字段中输出人类可读的 Markdown；支持 MCP 原生 `structuredContent` 的客户端可通过 `PRTS_OUTPUT_CHANNEL` 把连接级通道设为 `structured` 或 `both`，HTTP 模式下还可用查询参数或请求头对单次请求覆盖。详见 [README](../README.md) 的输出通道说明、[环境变量参考](admin/environment-variables.md) 与设计档案 [2.0 工具面收敛与双输出通道](archive/2.0-tool-consolidation-and-output-channel.md)。

## 数据与同步

- **AKDP（arknights-data-pipeline）**：项目自托管的上游数据流水线仓库，通过 GitHub Releases 定时发布结构化游戏数据包（游戏表 `zh_CN-excel.zip`、关卡 `zh_CN-levels.zip`、剧情 `zh_CN.zip`）与干员立绘分片，服务端的后台同步即来自该渠道。详见 [数据同步与存储管理](admin/data-and-sync.md)。
- **gamedata / gamedata-levels / storyjson**：数据目录下三类游戏数据的存放位置：`gamedata/` 为干员档案、物品、敌方图鉴等游戏表；`gamedata-levels/` 为关卡战斗数据与刷怪波次；`storyjson/` 为剧情正文与梗概（服务端直接从 ZIP 按需流式读取，无需预先解压全量文本）。目录布局的权威说明见 [data/README.md](../data/README.md)。
- **内置备用数据与用户数据**：正式发行的原生归档包、npm 包与 Docker 镜像均内置只读备用数据，开箱即可查询；当可写的用户数据目录中存在完整且校验通过的数据时，服务端始终优先读取用户数据，后台同步也只写入用户目录；从源码编译的安装不含备用数据。详见 [数据同步与存储管理](admin/data-and-sync.md)。
- **代际（Generation）与成对激活（Paired Activation）**：每次同步下载的数据落盘为一个不可变的代际目录；`gamedata` 与 `gamedata-levels` 两个包必须双双通过下载、校验与解压后，才一起切换 `.gamedata_pair.json` 中的激活指针，任一步失败都继续读取上一代，避免混代数据对外可见。运维语义见 [数据同步与存储管理](admin/data-and-sync.md)，设计脉络见 [2.4 常驻后台同步与成对激活](archive/2.4-background-sync-and-paired-activation.md)。
- **立绘资产（operator_artwork / LOCAL_IMAGE / ORIGINAL_IMAGE）**：干员立绘由 `operator_artwork` 工具提供；`IMAGES_ENABLED=false` 时该工具不注册（工具总数由 24 减为 23）。默认 `LOCAL_IMAGE=false` 从 PRTS MediaWiki 按需拉取并缓存图片；`LOCAL_IMAGE=true` 时后台同步 AKDP 的 GB 量级本地 PNG 包，`ORIGINAL_IMAGE=true` 额外同步未缩放原图分片。详见 [数据同步与存储管理](admin/data-and-sync.md)。
- **JSON / SQLite 双数据后端**：服务端支持两种数据后端——默认的 JSON 后端直接读取上述数据目录，实验性的 SQLite 后端通过 `PRTS_DATA_BACKEND=sqlite` 启用，数据来自 AKDP 的 `zh_CN.sqlite.gz` 并使用独立的 `database/` 目录；两种后端不同时同步，工具契约与既有 JSON 数据卷保持兼容。详见 [STATUS.zh-CN.md](../STATUS.zh-CN.md) 与 [数据同步与存储管理](admin/data-and-sync.md)。

## 分发与发布

- **五平台原生目标（native targets）**：官方提供预编译归档包的五个目标平台：`linux-x64` 与 `linux-arm64`（glibc ≥ 2.28）、`windows-x64`、`darwin-arm64` 与 `darwin-x64`（macOS 14.0+）；预编译二进制与 Docker 镜像无需安装任何语言运行时，musl/Alpine 不在支持范围。详见 [NATIVE-PLATFORMS.md](dev/NATIVE-PLATFORMS.md)（英文）。
- **Node 启动桥（launcher bridge）**：npm 九包布局中 `@3akhp/prts-mcp-runtime` 承担的角色：一段不含业务逻辑的 Node 代码，按当前操作系统与 CPU 架构解析平台二进制与内置数据目录，并透传标准流与退出信号。这是 npm 安装方式需要 Node.js >= 22 与 npm >= 10 的原因。详见 [NPM-DISTRIBUTION.md](dev/NPM-DISTRIBUTION.md)。
- **data-release 与 data-* 标签**：发行物内置备用数据的版本由 [packaging/npm/data-release.json](../packaging/npm/data-release.json) 固定，其中记录上游 AKDP 的 Release 标签、manifest 与各 ZIP 的 SHA-256；上游仓库以 `data-*` 前缀的标签发布数据版本。详见 [NPM-DISTRIBUTION.md](dev/NPM-DISTRIBUTION.md)。
- **LTS 线（lts/1.7 与 lts/2.8）**：与 3.x Rust 主线并行的两条长期维护分支，保留 Python/TypeScript 双实现，以成对的 `python/v*` 与 `ts/v*` 标签发版，两条线均维护至 2027-07-02。维护规则见 [LTS.md](dev/LTS.md)（英文）。

## 开发与协议

- **contracts/ 目录**：仓库存放兼容性契约与测试基线的目录，包括 24 个工具的完整输入 Schema（`tool-declarations.json`）、逐工具验证证据（`coverage.csv`）、协议快照（`wire/`）、golden 用例（`cases/`）与已批准差异清单（`baseline.json`）。总览见 [README](../README.md) 的 Rust 兼容性说明。
- **wire 快照（wire snapshots）**：`contracts/wire/` 下按传输方式与协议时代分类存放的逐请求-响应录制，记录冻结基线在 HTTP 状态码、SSE 帧格式与响应体原文层面的确切行为，用于校验 Rust 实现与原 Express + TS SDK 实现的 wire 级兼容。设计叙述见 [3.0 Rust 行为复刻与原生性能](archive/3.0-rust-parity-and-native-performance.md)。
- **冻结差分（Frozen Differential）与 384 用例**：以冻结的 TS/v2.8.1 基线（Bun 1.3.14 运行时）为对照的 384 项差分用例；涉及工具契约、输出格式与同步语义的改动必须全部跑通，且基线不随日常开发重录。规则见 [STYLE.md](dev/STYLE.md)，本地执行方式见 [ENVIRONMENT.md](dev/ENVIRONMENT.md)。
- **Oracle（冻结对照基准）**：在本地重建的 TS/v2.8.1 参考实现，用 Bun 1.3.14 启动，作为冻结差分与行为对齐的对照基准，仅用于开发验证，不用于生产；Oracle 目录被 `.gitignore` 忽略，公开文档不直接链接。重建命令见 [ENVIRONMENT.md](dev/ENVIRONMENT.md)。
- **legacy 与 modern 协议信封**：MCP 协议版本的两个支持时代。legacy 时代使用 `initialize` 握手并复用 `Mcp-Session-Id` 会话；modern 时代（协议版本 `2026-07-28`）使用无状态信封，不签发会话 ID，缺少信封的请求会被拒绝。stdio 传输由首条请求锁定时代，两个时代均受支持且没有移除 legacy 的计划。详见 [2.5 → 2.6 迁移指南](migration-2.5-to-2.6.md)（英文）。
- **baseline.json 与已批准差异（D-001 – D-007）**：3.x Rust 实现相对冻结基线的 7 项经批准实现差异的封闭枚举，每项带审批记录与验证证据；未经维护者批准不得扩大差异或重录 golden 快照。清单本体见 [contracts/baseline.json](../contracts/baseline.json)。
- **MSRV（最低受支持 Rust 版本）**：[Cargo.toml](../Cargo.toml) 以 `rust-version = "1.89"` 声明的可编译本工程的最低 Rust 工具链版本，CI 中有独立 job 使用 1.89.0 验证；日常开发的编译器版本由 `rust-toolchain.toml` 另行固定。详见 [ENVIRONMENT.md](dev/ENVIRONMENT.md)。
- **双轨评审（Dual-track CR）**：Standard 及以上级别 PR 的评审机制：先打开 PR 触发远端 KHPilot Bot 自动评审，同时在本地并行启动不共享实现上下文的只读独立 Reviewer，两轨意见按 Blocking / Should-fix / Nits / Verified claims 分类闭环后，由人类维护者执行合并。执行契约见 [CLAUDE.md](../CLAUDE.md)，分级标准见 [WORKFLOW.md](dev/WORKFLOW.md)。
- **eMudhra 信任根事件**：2026-10-17 披露的证书机构安全事件（RUSTSEC-2026-0383）：eMudhra 下属 8 个中间证书的私钥可从公开数据恢复，上游信任库随之移除其根证书；项目通过升级 `webpki-roots` 与 `rustls-webpki` 完成修复，并保留专项回归测试。修复记录见 [CHANGELOG.zh-CN.md](../CHANGELOG.zh-CN.md)，回归测试见 [tests/emudhra_trust_regression.rs](../tests/emudhra_trust_regression.rs)。
