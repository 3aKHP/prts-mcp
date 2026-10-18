# 代码规范与架构 — PRTS-MCP 3.x

本文面向编写与审查代码的协作者，定义 PRTS-MCP 3.x 的模块分层、Rust 编码规范、版本与 CHANGELOG 规则、测试要求及已知工程陷阱。

- 公开文档写作规范见 [`DOCUMENTING.md`](DOCUMENTING.md)
- 跨平台开发环境与验证命令见 [`ENVIRONMENT.md`](ENVIRONMENT.md)
- PR 分级与双轨评审流程见 [`WORKFLOW.md`](WORKFLOW.md)
- 外部贡献者指南见 [`CONTRIBUTING.zh-CN.md`](../../CONTRIBUTING.zh-CN.md) / [`CONTRIBUTING.md`](../../CONTRIBUTING.md)
- AI 协作者日常指令见 [`CLAUDE.md`](../../CLAUDE.md)

---

## 1. 模块分层与职责边界

### 文件粒度与单一职责

- **单一职责**：每个源文件只负责一项核心职责。例如 `domain/operator.rs` 只负责干员数据读取与格式化，不混入搜索逻辑；`text/sanitizer.rs` 只负责 Wikitext 清洗，不发起网络请求。
- **文件长度预警线**：当单个源文件超过约 **300 行**时，应审视其是否同时持有了无关的状态、更新与查询职责。超过预警线并不意味着必须按行数机械拆分，而应以职责内聚和可独立测试性为准绳。
- **严禁跨层调用**：
  - `domain/` 只负责业务数据解析、计算与格式化，不直接发起 HTTP 请求。
  - 数据同步的 HTTP 请求收敛在 `sync/` 层；PRTS Wiki 的 MediaWiki API 请求收敛在 `wiki/` 层。
  - `app.rs` 负责启动与运行时 `DataState` 编排；MCP 工具的注册与参数分发由 `tools/` 持有。

### 架构分层图

```text
app.rs             ← 进程启动、配置加载与 DataState 编排
protocol/          ← stdio / Streamable HTTP 传输、JSON-RPC、协议时代与会话管理
tools/             ← 24 个工具的 Schema 声明、参数校验、分发与输出通道包装
domain/            ← 干员 / 敌人 / 关卡 / 物品 / 剧情 / 搜索 / 立绘等领域逻辑与缓存
storage/           ← DirectoryStore / ZipStore 抽象、文件身份（FileIdentity）与代际解析
sync/              ← GitHub Release 发现、下载、manifest/SHA-256 校验、跨进程锁与代际激活
wiki/              ← PRTS MediaWiki API 客户端（搜索、页面解析、模板提取与图片拉取）
text/              ← 纯文本清洗、JS 数字/UTF-16 兼容处理与正则引擎封装
config.rs          ← 命令行 Profile、启动路径与环境变量解析
native/ + vendor/  ← QuickJS libregexp 与 OS 进程内存统计的 C FFI 绑定
```

调用方向自上而下：`app` / `protocol` / `tools` 调用 `domain` 与 `wiki`，底层文件读取统一经过 `storage`。禁止从 `storage`、`text` 或 `config` 反向依赖 `domain` 或 `tools`。

- **存储抽象**：所有本地数据文件读取均须通过 `storage/` 的 `DirectoryStore` 或 `ZipStore`，禁止在工具函数或领域逻辑中直接调用 `std::fs::read()` 读取原始 JSON。
- **立绘双后端隔离**：本地立绘后端只读取已激活的图片代际目录并校验路径与 Token 归属；在线立绘后端通过 `wiki/` 客户端按需拉取并缓存。两者通过统一的索引契约衔接，不将底层文件访问逻辑混入 MCP 工具入口。

### 函数抽取与重构准则

遇到以下情况时，应考虑抽取独立函数或子模块：

- 同一计算公式或校验逻辑在 **≥ 2 处**重复出现；
- 单个函数超过 **~50 行**，或缩进嵌套超过 **3 层**；
- 一段逻辑具备明显的“状态 + 更新 + 查询”三要素（适合抽为独立结构体/模块）；
- 一段纯计算或解析逻辑需要单独编写单元测试。

**重构边界**：单次使用、少于 10 行且语义清晰的内联代码无需为了“模块化”强行拆碎。如果在开发新功能前发现既有模块结构需要先清理，请**先单独提交一个 `refactor` PR**，合并后再提交 `feat` PR，不要在同一个 PR 中混入大面积重构与功能变更。

### 常见反模式（禁止出现）

- 职责混杂的巨型文件（所谓 God File）；
- 在工具入口直接操作文件系统或拼接锁/代际状态机；
- 堆砌不相关函数的 `utils.rs` / `helpers.rs` 杂物堆（应按职责命名专用模块）；
- 同一业务常量散落在多个文件中（应收敛至 `config.rs` 或对应模块的顶层常量）；
- 擅自偏离 TS/v2.8.1 冻结的工具契约，或未经批准扩大 `contracts/baseline.json` 中的差异项；
- 为新数据域机械复制 `list_X` / `get_X` / `search_X` 三件套（应优先扩展 `search(scope)` 或既有工具的 `action` 枚举）。

---

## 2. MCP 工具描述与错误提示规范

### 工具描述模板

MCP 工具的 `description` 与参数 Schema 是 LLM 选择工具的核心依据，同时直接消耗客户端的上下文预算。所有工具描述遵循以下四段式结构：

1. **首句定性**：动词开头的一句话说明“做什么 + 面向哪类数据”；
2. **返回格式**：简明提示输出结构与大致长度（如“每行格式为 `- 编号 名称`”）；
3. **工具分流指引**：必要时给出简短指向（如“如需跨干员按技能效果搜索，请使用 `search(scope="skills")`”）；
4. **参数细节下放**：具体参数取值规则写在参数 Schema 的描述中，不在工具主描述里重复罗列。

**硬性约束**：

- 使用简洁的中文，面向最终调用方说明 **What & Why**，不描述内部实现细节（How）；
- 工具主描述控制在 **3 句以内**；
- 参数命名保持全仓一致：实体名称统一用 `name`，正则搜索统一用 `pattern` + `max_results`，分页列表统一用 `limit` + `offset`，Wiki 关键词搜索用 `query`（与正则 `pattern` 区分）。

### 错误处理

- **缺失数据或未同步完成**：返回可读的中文提示（保持与冻结契约一致的文案），绝不向客户端抛出未捕获的裸异常或底层堆栈。
- **网络与同步失败**：后台同步的重试与降级由 `sync/` 模块统一处理；Wiki 请求失败由 `wiki/` 客户端封装为清晰的错误消息，工具层不自行叠加隐式重试。
- **用户输入校验**：在工具入口完成参数范围与必填项校验（`tools/zodish.rs` 等），返回明确的校验错误。

---

## 3. Rust 与 FFI 编码规范

### 代码风格与静态检查

- 所有代码必须通过 `cargo fmt --all -- --check` 与 `cargo clippy --locked --all-targets -- -D warnings`。
- 按数据域实际消费的字段定义反序列化结构体，无需为上游 JSON 中未使用的庞大冗余字段建立无意义的类型定义。
- 公开函数与关键模块边界使用 `///` 或 `//!` 编写注释，聚焦设计意图与非显而易见的约束，不写复述代码字面意思的废话注释。
- 生产代码保持纯 Rust + 静态链接 C 组件（`native/`、`vendor/quickjs-regexp/`），严禁在生产运行时引入 Node.js / Bun / Python 虚拟机或脚本回退路径。

### 缓存与代际失效

- 领域层缓存必须绑定底层文件的 `FileIdentity` 与当前激活代际（Generation）。当后台同步激活新代际时，相关领域缓存必须随之失效，切勿编写不感知数据代际切换的静态全局缓存。
- 默认路径与数据卷解析必须始终遵循“完整用户数据优先于内置只读备用数据”的规则。

### `unsafe` 与原生 C 边界

- 仓库中的 `unsafe` 仅限两处边界：正则引擎绑定（`text/regex_compat.rs` + `native/regexp.c`）与进程内存统计（`diagnostics/` + `native/process_memory.c`）。
- 每一处 `unsafe` 块必须注释说明指针有效性、缓冲区长度、生命周期与释放责任；严禁将裸指针泄露到高层业务模块。

### 标准流与进程生命周期

- **`stdout` 仅用于输出 MCP 协议报文**；所有启动、同步与调试日志一律输出至 `stderr`。
- 保持 stdio EOF 正常退出、HTTP 会话空闲淘汰、POSIX 信号（`SIGINT`/`SIGTERM`/`SIGHUP`）优雅停机以及 Windows 下 npm 启动桥父进程退出的联动清理语义。

---

## 4. 版本号与 CHANGELOG 规范

### 版本源与同步点

版本语义与向后兼容承诺见 [`VERSIONING.md`](VERSIONING.md)。在 3.x 中，`Cargo.toml` 的 `[package].version` 是唯一的产品版本源，`Cargo.lock`、npm 包装包、Docker 镜像标签与 MCP `serverInfo.version` 均与其保持一致。

版本变更或发版时需同步检查以下位置：

| 位置 | 维护内容 |
| --- | --- |
| `Cargo.toml` / `Cargo.lock` | 产品版本号与锁定依赖 |
| `CHANGELOG.md` / `CHANGELOG.zh-CN.md` | 中英双语的用户可见变更记录与升级说明 |
| `README.md` / `STATUS.*` / `ROADMAP.*` | 当前公开版本、候选版标签与阶段状态 |
| 原生 / npm / Docker 打包产物 | 由同一干净 Commit 构建并校验版本一致性 |

### CHANGELOG 编写规则

遵循 [Keep a Changelog](https://keepachangelog.com/) 规范，按 `Added`、`Changed`、`Deprecated`、`Removed`、`Fixed`、`Security`（中文对应 `新增`、`变更`、`弃用`、`移除`、`修复`、`安全`）分类，仅列出当次有条目的分类：

1. **面向用户写作**：描述用户、部署者或客户端可感知的行为变化，不照抄 Git commit message，也不把纯内部文件搬迁或代码格式化塞进 CHANGELOG。
2. **中英双语同步**：`CHANGELOG.md` 与 `CHANGELOG.zh-CN.md` 保持相同的版本号、发布日期、分类结构与实现标注（历史 0.x–2.x 条目保留 `[Python]` / `[TypeScript]` 归属）。
3. **日常开发与发版切换**：
   - 日常合并到 `develop` 的功能与修复写入顶部的 `[Unreleased]` / `[未发布]` 段落；纯内部 `docs` / `style` / `chore` 无需追加条目。
   - 准备发布时，在 `release/vX.Y.Z` 分支中将 `[Unreleased]` 替换为 `[X.Y.Z] — YYYY-MM-DD`（`main` 分支不保留空的 `Unreleased` 段落）。
   - 发布合并并回灌 `develop` 时，在 `develop` 顶部重新开启空的 `[Unreleased]` / `[未发布]` 段落，并将版本号推进至下一目标 `-dev.0`。

---

## 5. 测试要求与已知工程陷阱

### 测试规范

本地验证命令详见 [`ENVIRONMENT.md`](ENVIRONMENT.md)，验证分级详见 [`WORKFLOW.md`](WORKFLOW.md)：

- **契约与差分测试**：修改工具名、参数校验、输出通道、渲染逻辑或数据同步时，必须通过 `./scripts/check-runtime.sh --full` 跑通 384 个冻结 TS/v2.8.1 对照用例与生命周期测试。严禁通过篡改或重录 `contracts/` 下的 golden 快照来掩盖回归错误。
- **网络隔离**：常规单元测试与 CI 测试一律使用本地 fixture 或回放（`contracts/wiki-replay/`），不直接请求公网 `prts.wiki` 或 GitHub API；若因缺少验证资产导致测试无法执行，必须报错失败，不得静默跳过（skip）后伪装成全部通过。

### 已知工程陷阱（踩坑记录）

#### PRTS Wiki MediaWiki API
- **必须使用 `action=parse&prop=text`**：MediaWiki 的 `action=query&prop=extracts` 会剥离模板渲染内容，导致干员档案与词条大量信息丢失。
- **命名空间与技术页过滤**：搜索接口需限定 `srnamespace=0`，且主命名空间下仍存在 `/spine`、`/data` 等技术子页，需配合 `filter_technical` 过滤。
- **章节编号格式**：模板嵌入产生的章节 `index` 可能带有 `T-` 前缀（如 `T-1`），并非总是纯数字。

#### 游戏数据与剧情 ZIP 结构
- **`story_review_table.json` 结构**：顶层直接是以 `event_id` 为键的对象映射，没有外层包装键。
- **`StoryJson` 压缩包路径**：`zh_CN.zip` 内的条目路径带有 `zh_CN/` 前缀；`character_table.json` 的顶层键为 `char_002_amiya` 等内部干员 ID，而非干员中文名（需排除 `trap_` / `token_` 等召唤物或装置同名实体碰撞）。

#### 数据同步与运行配置
- **环境变量空值陷阱**：JSON 后端的 `GAMEDATA_PATH` 只要存在于进程环境中（哪怕值为空字符串）就会禁用游戏表与关卡自动同步；`STORYJSON_PATH` 设为非空值时禁用剧情自动同步。
- **镜像与轮询语义**：`GITHUB_MIRRORS` 是直连失败后的回退前缀列表，而非“强制仅走镜像”；`PRTS_AUTO_SYNC_INTERVAL_SECONDS=0` 仅禁用后续定时轮询，启动时的首次同步检查仍会执行。
- **跨进程锁机制**：共享数据卷上的同步锁 owner 是随机生成的不透明标识（而非 OS PID），依赖心跳与租约过期（lease）机制协调，切勿对正在运行的活跃数据卷手动删除锁文件或激活指针。
- **尚无 CLI 子命令**：当前版本未设 `--version` 或 `--help` 命令行参数，传入未知参数仍会直接启动 MCP 服务（管理 CLI 规划在 3.0 之后）。
