# 管理 CLI（`prtsctl`）使用指南

本文面向服务端管理员与高级用户，介绍 `prtsctl` 管理命令行的配置管理、本地环境诊断、数据完整性校验、一次性数据同步、systemd 服务管理、在线任务与配置重载，以及脚本集成方法。

- 容器、裸机与 `systemd` 常驻部署方案见[服务端部署与容器运维指南](deployment.md)。
- 数据目录结构、离线包挂载与立绘存储规划见[数据同步、离线包与立绘存储管理](data-and-sync.md)。
- 全部运行时配置项字典与解析规则见[运行时环境变量完整参考](environment-variables.md)。
- 运行中实例的 `/health` 与 `/debug/*` 在线诊断见[监控诊断与故障排查手册](diagnostics-and-troubleshooting.md)。

> **版本可用性说明**：`prtsctl` 随开发中的 `3.2.2` 版本提供；公开稳定版中实际可用的命令与参数请以所安装版本的 `--help` 输出为准。

---

## 1. 快速上手与安装入口

### 1.1 典型管理与启动流程

`prtsctl` 将配置文件生成、环境自检、数据预同步与服务启动整合在同一入口下：

```bash
# 1. 在默认用户配置路径生成带注释的 TOML 配置模板
prtsctl config init

# 2. 查看当前生效的配置值、来源（参数/环境变量/配置文件/默认值）及联动说明
prtsctl config show --sources

# 3. 校验配置文件语法与最终合并配置是否合法
prtsctl config validate

# 4. 检查本地配置、数据目录归属与权限条件（加 --network 可额外探测上游连通性）
prtsctl doctor

# 5. 执行一次性游戏数据同步，并校验本地数据完整性
prtsctl data sync
prtsctl data verify

# 6. 在前台启动 MCP 服务器（默认使用 Streamable HTTP）
prtsctl serve
```

直接运行无参数的 `prtsctl` 会显示帮助信息，不会直接启动服务器或触发数据下载。

### 1.2 各发行渠道的调用方式

| 发行渠道 | `prtsctl` 获取与调用方式 |
| --- | --- |
| **预编译原生归档包** | 解压后位于 `bin/prtsctl`（Windows 下为 `bin\prtsctl.exe`），无运行时依赖。 |
| **npm 包（`prts-mcp`）** | 全局安装主包后可直接运行 `prtsctl`；项目本地安装后使用 `npx prtsctl` 或 `node_modules/.bin/prtsctl`。临时调用可执行 `npx --yes --package prts-mcp prtsctl --help`（需目标发布渠道已包含 `3.2.2+`，预发布阶段可指定 `prts-mcp@next`）。 |
| **PyPI Wheel（`prts-mcp`）** | 安装后直接提供 `prtsctl` 命令入口。 |
| **Cargo 源码安装** | 默认 `cargo install prts-mcp --locked` 会一并安装 `prtsctl`；若仅需安装管理 CLI，可执行 `cargo install prts-mcp --locked --bin prtsctl`。 |
| **Docker 容器镜像** | 通过覆盖入口点调用：`docker run --rm --entrypoint /app/bin/prtsctl <image> --help`。检查或操作生产数据时，请挂载相同的数据卷（如 `-v prts-data:/data`）并传入一致的环境变量。 |

### 1.3 与原有服务器启动入口的关系

引入 `prtsctl` 后，原有的 `prts-mcp`、`prts-mcp-ts*` 与 Docker 默认入口 `prts-mcp-ghcr` **保持无参数启动行为不变**，现有部署与客户端配置无需迁移：

- **新增通用参数**：原有服务器入口均新增 `--help`、`--version` 以及显式指定配置文件的 `--config <path>`。
- **不自动加载用户配置文件**：为避免安装新版本或创建用户级配置文件后悄然改变既有部署行为，原有服务器入口**只有在显式传入 `--config <path>` 时**才会读取 TOML 配置文件；仅 `prtsctl` 会自动读取默认用户路径下的 `config.toml`。
- **默认传输模式与进程托管**：
  - `prtsctl serve` 在所有发行渠道下默认启动 **Streamable HTTP**；若作为 MCP 客户端的 `stdio` 子进程运行，请使用 `prtsctl serve --transport stdio`（此时标准输入输出专用于 MCP 协议通信）。
  - 原生与 npm 主入口（`prts-mcp`）默认 HTTP；PyPI 与 Docker 服务器入口默认 `stdio`；`prts-mcp-ts` / `prts-mcp-ts-bun`（固定 HTTP）与 `prts-mcp-ts-stdio`（固定 `stdio`）保持各自固定传输模式。
  - `prtsctl serve` 始终在当前前台进程运行，不会自行转入后台守护进程；进程保活与生命周期仍由 MCP 客户端、Docker 或 `systemd` 等服务管理器负责。

---

## 2. 命令速查与子命令详解

### 2.1 子命令总览

| 子命令 | 功能说明 |
| --- | --- |
| `config show [--sources]` | 显示本次调用的最终生效配置、各字段来源及配置联动说明 |
| `config validate` | 校验 TOML 配置文件与合并后的最终配置；环境变量继续遵循既有的解析与回退规则 |
| `config init [--force] [--dry-run]` | 在目标路径创建带注释的 TOML 配置模板；覆盖已有文件须显式加 `--force` |
| `config set <key> <value> [--dry-run]` | 修改已有配置文件中的指定字段（保留原有注释与排版） |
| `config unset <key> [--dry-run]` | 从配置文件中删除指定字段；若字段原本不存在也视为成功 |
| `doctor [--network]` | 检查本地配置、数据路径、数据源归属及可观察的目录权限条件 |
| `data status` | 查看本地磁盘上的数据候选状态、当前激活代际与内置备用数据路径 |
| `data verify` | 按当前生效的数据后端与立绘配置，对本地 SQLite、JSON/剧情 ZIP 或立绘分片执行完整校验 |
| `data sync [--target game\|images\|all] [--wait-timeout <seconds>]` | 执行一次性同步并退出，不启动周期性后台轮询 |
| `serve [--transport http\|stdio] [--host <address>] [--port <number>]` | 在当前进程中显式启动 MCP 服务器 |
| `service status/start/stop/restart/enable/disable` | 通过 systemd 管理显式 unit 或实例映射中的服务；支持系统级与用户级服务 |
| `service template` | 输出单元模板，由管理员安装 |
| `runtime status`、`runtime data status` | 通过本机管理端点查询运行中实例与实际数据视图 |
| `runtime config show/diff/reload` | 查看运行时配置、比较候选文件，并按 revision 原子重载允许字段 |
| `runtime data sync`、`runtime jobs list/show/cancel` | 提交、查询或取消在线同步任务 |
| `completion <bash\|zsh\|powershell>` | 向标准输出打印对应 Shell 的命令补全脚本，供用户按需加载 |

### 2.2 全局选项与参数解析规则

- **共享选项**：`--config <path>` 适用于包括 `serve` 在内的所有读取业务配置的子命令；`--output text|json`（简写为 `-o`）适用于各管理检查、配置与同步子命令（`serve` 不接受 `--output`，`completion` 忽略该选项并直接输出补全脚本）。这两个全局选项均可放在子命令之前或之后。
- **参数语法**：所有选项与子命令名称均区分大小写，不支持长选项自动前缀缩写；带值选项同时支持 `--name value` 和 `--name=value` 两种写法，使用 `--` 可显式终止选项解析。
- **零副作用保证**：`--help`、`--version` 与 `completion` 不读取任何业务配置；所有只读检查命令（`config show/validate`、`doctor`、`data status/verify`）均不会启动 MCP 服务、不会触发网络下载，也不会自动创建或初始化数据目录。

### 2.3 环境诊断（`doctor`）

- **默认本地只读检查**：`prtsctl doctor` 默认完全在本地运行，检查配置文件与环境变量组合、数据目录路径、自定义数据源归属绑定（见 `PRTS_DATA_SOURCE_REPO`）以及目录读写权限条件。权限检查不会尝试在磁盘上创建测试文件；当受操作系统机制限制无法仅凭元数据可靠判断写权限时，状态会诚实标记为 `unknown`。
- **可选上游网络探测（`--network`）**：传入 `prtsctl doctor --network` 时，会额外对 GitHub 数据源与 PRTS Wiki 发起轻量连通性探测（每项超时上限为 5 秒，仅测试连接与响应，不下载实际数据资产）。

### 2.4 数据检查与完整性校验（`data status` 与 `data verify`）

- **`data status`（快速元数据观察）**：
  - 仅读取本地磁盘上的目录结构、代际指针与元数据清单，适合快速排障。
  - 状态标记为 `present_unverified` 表示本地文件与元数据可读，但尚未执行全量哈希或结构校验。
  - 报告中的 `available_backend` 仅反映当前命令对本地磁盘的静态观察结果，不能替代运行中服务实例的 `/debug/metrics` 实时状态。
- **`data verify`（完整深度校验）**：
  - 根据当前生效的后端、备用策略与立绘开关按需执行深度检查（可能读取大量本地文件并计算摘要），任一检查失败即返回非零退出码（`1`）：
    - **SQLite 候选库**：当后端为 `sqlite` 时，校验候选数据库的表结构与外键完整性，并对带有激活代次指针的受管数据库比对整文件 SHA-256 及元数据版本。该过程为纯只读操作，不会写入或更新运行时的结构准入缓存文件。
    - **JSON 数据表与剧情 ZIP**：当显式选择 `json` 后端，或允许 JSON 备用回退且当前尚无可用 SQLite 数据库时，遍历并解析游戏表与关卡目录下的全部 `.json` 文件，同时校验剧情 ZIP 归档结构并解析其中的 `.json` 条目。
    - **本地立绘分片**：当同时启用 `IMAGES_ENABLED=true` 与 `LOCAL_IMAGE=true` 时，根据激活代索引逐一校验立绘文件（含启用 `ORIGINAL_IMAGE=true` 时的原图变体）的字节大小与整文件 SHA-256。
  - **WAL/Journal 注意事项**：若目标 SQLite 数据库存在非空的 WAL 或回滚日志（意味着可能有写入进程尚未正常关闭或未完成 checkpoint），请先正常停止写入方进程使其完成归并，再执行 `data verify`。

### 2.5 一次性数据同步（`data sync`）

`prtsctl data sync` 复用服务端的同步、校验与代际原子切换逻辑，在完成单次同步后立即退出，非常适合在部署镜像构建、容器启动前初始化（Init Container）或定时任务（Cron / systemd timer）中使用：

- **同步目标选择（`--target`）**：
  - 默认值为 `game`（仅同步当前后端对应的游戏数据与剧情）。
  - 指定 `--target images` 或 `--target all` 时，要求配置中已同时启用 `IMAGES_ENABLED=true` 与 `LOCAL_IMAGE=true`，执行后可能下载 GB 量级的 AKDP 本地立绘资产。
  - 通过 `GAMEDATA_PATH`、`STORYJSON_PATH` 或 `PRTS_DATA_DB` 挂载的自定义只读数据源受保护，不会被同步覆盖。
- **跨进程锁等待预算（`--wait-timeout`）**：
  - 当多个进程共享同一可写数据目录时，通过文件锁串行化同步。默认锁等待预算为 **30 秒**，有效范围为 `0..86400` 秒；设为 `0` 表示立即尝试获取锁，若锁已被占用则直接返回退出码 `3`。
  - 该预算**仅统计等待获取同步锁的时间**，一旦拿到锁开始下载与解压，后续耗时不计入锁等待超时。
- **失败与中断语义**：
  - 与后台静默降级不同，在显式执行 `data sync` 时，即便本地已有可用的旧缓存数据，只要本次网络拉取或校验失败，命令仍会明确返回失败状态（退出码 `1`）。
  - 同步期间按下 `Ctrl+C` 或收到 `SIGTERM` 会立即中止新的网络下载；若此时已进入最后的本地目录原子发布阶段，程序会等待该短暂收尾动作安全落盘后再退出，确保不会在磁盘上留下半写入的损坏状态。

---

## 3. TOML 配置文件管理

### 3.1 配置优先级与默认路径

配置项按以下优先级从高到低生效：

**显式命令行参数 > 进程环境变量 > TOML 配置文件 > 内置默认值**

- **默认用户配置文件路径**（仅 `prtsctl` 会自动读取，文件不存在时静默跳过并使用环境变量与默认值）：
  - **Linux / macOS**：`$XDG_CONFIG_HOME/prts-mcp/config.toml`（未设置 `XDG_CONFIG_HOME` 时为 `~/.config/prts-mcp/config.toml`）。
  - **Windows**：`%APPDATA%\prts-mcp\config.toml`（环境变量缺失时回退至用户主目录下的 `AppData\Roaming\prts-mcp\config.toml`）。
- **显式指定配置文件（`--config <path>`）**：
  - 传入 `--config` 时将**完全使用该指定文件**，不会与默认用户配置文件叠加合并；若显式指定的文件不存在，命令会立即报错退出（退出码 `2`）。
- **路径解析与环境边界**：
  - 程序**不会**自动搜索当前工作目录下的配置文件，也**不会**自动加载 `.env` 文件。
  - 配置文件内部书写的相对路径，统一**相对于该配置文件所在的目录**解析；而通过环境变量或命令行参数传入的相对路径，则保持相对于当前工作目录（CWD）解析。
  - 环境变量名遵循操作系统大小写规则（Windows 下不区分大小写，Unix 下区分大小写）；TOML 配置文件中的键名在所有平台下**始终区分大小写**。

### 3.2 配置文件结构与编写规范

运行 `prtsctl config init` 可生成包含全量字段说明与类型注释的模板。最小有效配置示例如下：

```toml
schema_version = 1

[runtime]
PRTS_TRANSPORT = "http"
HOST = "127.0.0.1"
PORT = 3000
PRTS_AUTO_SYNC_INTERVAL_SECONDS = 3600
LOCAL_IMAGE = false
```

编写与修改配置文件时请注意：

- **字段命名与范围**：`[runtime]` 表下的键名直接沿用[运行时环境变量完整参考](environment-variables.md)中的业务变量名。操作系统基础目录发现（如 `XDG_DATA_HOME`、`LOCALAPPDATA`）、容器内部布局标记（`PRTS_MCP_ROOT`）以及内部启动桥参数不属于配置文件字段；网络代理（`HTTP_PROXY` 等）与自定义 CA 证书仍通过环境变量配置，其来源可在 `prtsctl config show -o json` 中查看。
- **强类型校验**：不同于环境变量的宽松回退，TOML 文件中的字段执行严格校验——布尔开关必须使用原生布尔字面量 `true` / `false`，端口与同步间隔秒数使用整数，会话超时毫秒数允许有限数值，路径必须为非空字符串。未知字段名、非法枚举值或互相冲突的配置组合均会被拒绝。
- **切勿盲目取消所有注释**：模板中被注释掉的高级选项具有特定联动语义。例如，显式写入 `PRTS_DATA_BACKEND = "sqlite"` 会关闭首次同步完成前的默认 JSON 备用回退；写入 `GAMEDATA_PATH` 则会直接关闭对应的 JSON 自动同步。只需取消注释你需要修改的字段即可。

### 3.3 使用命令行安全编辑配置（`config set` / `unset`）

你既可以使用文本编辑器直接修改 TOML 文件，也可以使用 `prtsctl` 提供的命令进行结构化修改：

```bash
# 初始化自定义路径的配置文件
prtsctl --config ./server.toml config init

# 修改字段（键名支持写 PORT 或带表前缀的 runtime.PORT）
prtsctl --config ./server.toml config set PORT 3100
prtsctl --config ./server.toml config set runtime.HOST 127.0.0.1

# 移除字段以恢复默认值
prtsctl --config ./server.toml config unset PORT

# 让原服务器入口显式加载该配置文件启动
prts-mcp --config ./server.toml
```

命令行编辑具备以下安全保障：

- **无损编辑与并发保护**：`config set` 与 `config unset` 会保留文件中无关的字段、空行与注释，并通过文件锁与原子替换防止并发写入导致文件损坏；传入 `--dry-run` 可预览修改结果而不实际写入磁盘或创建锁文件。
- **环境变量覆盖提醒**：如果当前终端中设置了同名环境变量（优先级高于配置文件），`config set` 修改成功后会在输出中明确提示该字段当前仍被环境变量覆盖。
- **符号链接与敏感凭据保护**：为防止路径穿越或误改外部文件，编辑命令拒绝直接操作符号链接（symlink）目标，请直接指定真实文件路径。出于安全考虑，`config set` **拒绝写入各类 Token 字段**（如 `GITHUB_TOKEN`、`PRTS_DEBUG_TOKEN`），长期凭据请优先通过环境变量注入；即便手工写入了配置文件或环境变量，所有诊断与配置输出都会对敏感值自动脱敏。
- **生效时机**：修改配置文件不会热更新已在运行中的服务进程，将在下一次启动或执行命令读取该文件时生效。

---

## 4. 脚本集成、Shell 补全与退出码

### 4.1 JSON 机器可读输出（`-o json`）

管理命令默认输出适合人类阅读的对齐文本；在自动化脚本或运维流水线中，可传入 `-o json`（或 `--output json`）获取结构化输出：

- **通道隔离**：启用 `-o json` 时，标准输出（`stdout`）仅输出单个合法的完整 JSON 文档，所有运行日志与报错信息均输出至标准错误（`stderr`）。CLI 的 `--output` 仅控制管理命令自身的终端输出格式，与控制 MCP 工具返回结构的 `PRTS_OUTPUT_CHANNEL` 完全独立；`prtsctl serve` 不接受 `--output` 参数。
- **Schema 稳定性承诺**：JSON 报告使用稳定的英文键名，数值与布尔值使用原生 JSON 类型，集合字段始终序列化为数组，并通过顶层 `schema_version` 标识报告结构版本。已有字段的类型与语义受版本兼容性承诺保护；编写消费脚本时请忽略未知的新增字段，且不要依赖 JSON 对象键的排列顺序。
- **`config show` 字段结构**：`fields` 数组中的每个条目均包含 `key`（字段名）、`value`（最终生效值）、`input`（原始输入值）、`source`（来源：`argument`、`environment`、`file` 或 `default`）以及 `explanation`（联动说明）。

**PowerShell 调用示例**：

```powershell
$raw = prtsctl config show -o json
if ($LASTEXITCODE -ne 0) { throw '读取配置失败' }
$config = $raw | ConvertFrom-Json
$config.fields | Where-Object { $_.source -eq 'environment' }
```

**Bash + `jq` 调用示例**：

```bash
prtsctl config show -o json | jq '.fields[] | select(.source == "environment")'
```

### 4.2 跨平台 Shell 调用与自动补全

- **跨平台命令调用注意事项**：
  - 在 Windows 当前目录下直接运行解压的原生二进制时，请使用 `.\prtsctl.exe`（在 Bash 中为 `./prtsctl`），包含空格的文件路径请用引号包裹。
  - PowerShell 的 `$env:NAME = "value"` 与 Bash 的 `NAME=value prtsctl ...` 属于各自 Shell 的环境变量设置语法，由外层 Shell 处理而非 CLI 自身解析。
  - CLI 不会因为检测到当前运行在某种 Shell 或管道（pipe）中就擅自改变输出格式（文本与 JSON 完全由 `--output` 决定）。
- **加载命令自动补全（`completion`）**：
  - `prtsctl completion <bash|zsh|powershell>` 会将补全脚本内容打印到标准输出，程序绝不会自动修改用户的 Shell 配置文件（如 `.bashrc` 或 `$PROFILE`）。
  - **Bash 示例**：运行 `prtsctl completion bash > prtsctl.bash`，随后执行 `source ./prtsctl.bash` 即可在当前会话生效。
  - **PowerShell 示例**：将 `prtsctl completion powershell` 的输出保存为 `.ps1` 脚本文件后，在会话或 `$PROFILE` 中显式点源加载（`. .\prtsctl-completion.ps1`）。

### 4.3 退出码参考

以下标准退出码适用于 `prtsctl` 的各管理子命令（原有服务器入口保留既有退出行为）：

| 退出码 | 含义 |
| --- | --- |
| `0` | 操作或检查成功完成（注意：`doctor` 或 `data status` 报告中可能仍包含需要留意的 `warning` 或 `unknown` 权限项） |
| `1` | 运行时操作失败，或 `doctor` / `data verify` / `data sync` 检查未通过 |
| `2` | 命令行参数语法错误，或配置文件/环境变量校验无效 |
| `3` | `data sync` 等待跨进程同步锁超时（超过 `--wait-timeout` 预算） |
| `130` / `143` | 一次性同步（`data sync`）在受支持平台上被 `Ctrl+C`（`SIGINT`）或 `SIGTERM` 信号取消 |

## 本机在线查询

服务器显式设置 `PRTS_CONTROL_ENDPOINT` 后提供独立的本机管理通道，`PRTS_INSTANCE_NAME` 默认 `main`。Unix 使用绝对 socket 路径，父目录须属于服务用户且权限为 `0700`；Windows 使用 `\\.\pipe\prts-mcp-<name>` 命名管道。管理通道不占用 MCP 标准流，不沿用诊断 Token 的权限。

CLI 默认读取用户配置目录中的 `instances.toml`，也可用 `--instances-file` 指定。实例映射不包含业务凭据：

```toml
schema_version = 1
[instances.main]
endpoint = "/run/prts-mcp-main/control.sock"
unit = "prts-mcp.service"
user = false
```

`prtsctl runtime status --instance main -o json` 查询实际运行状态；`runtime config show` 查看服务器配置快照；`runtime data status` 查看服务器当前数据视图。查询不自动启动实例。在线同步任务与配置热重载见下文。

## systemd 服务管理

Linux 上可直接指定现有单元，或使用实例映射中的 `unit` 和 `user`：

```bash
prtsctl service --unit prts-mcp.service status -o json
prtsctl service --unit prts-mcp.service restart
prtsctl service --user --unit prts-mcp.service stop
```

命令包括 `status`、`start`、`stop`、`restart`、`enable` 和 `disable`。`enable` / `disable` 只修改开机启动设置。权限由 systemd 和 Polkit 决定；需要管理员权限时使用部署环境的提权方式。`--timeout` 默认 30 秒，超时后 systemd 操作可能继续，使用 `status` 查询结果。

生成单元模板时指定原生 `prts-mcp` 的绝对路径、配置文件和数据目录：

```bash
prtsctl service template --executable /opt/prts/bin/prts-mcp \
  --config /etc/prts-mcp/config.toml --data-home /var/lib/prts-mcp \
  --account prts-mcp > prts-mcp.service
```

用户服务使用 `--user`，省略 `--account`。模板写入标准输出，安装及 `daemon-reload` 由管理员完成。服务启停适用于 Cargo、原生归档及 npm/Bun 部署；在线查询需要服务器启用本地管理端点。Windows 和 macOS 可使用 `runtime` 命令，本轮不提供 SCM 或 launchd 生命周期管理。

## 在线同步任务

```bash
prtsctl runtime data sync --target game -o json
prtsctl runtime jobs list -o json
prtsctl runtime jobs show <任务ID> -o json
prtsctl runtime jobs cancel <任务ID> -o json
```

`runtime data sync` 返回任务 ID，服务器继续执行同步。CLI 断开不会取消任务；`jobs cancel` 请求取消网络传输和锁等待，正在提交的数据会先完成收尾。后台同步与手动同步共享目标占用，冲突请求返回正在占用目标的任务 ID。`--wait-timeout` 只控制跨进程锁等待，默认 30 秒。

任务历史最多保留 100 个已结束任务，活动任务另计。重启清空历史，旧任务 ID 失效。`status` 可为 `running`、`cancelling`、`succeeded`、`failed` 或 `cancelled`。失败详情位于 `result`，命令自身成功仅表示请求成功，判断同步结果应检查任务状态。

## 在线配置重载

编辑服务器启动时选用的 TOML 文件，然后查询差异并使用返回的 `revision` 应用：

```bash
prtsctl runtime config show -o json
prtsctl runtime config diff -o json
prtsctl runtime config reload --expected-revision 1 -o json
```

可重载字段为 `PRTS_AUTO_SYNC_INTERVAL_SECONDS`、`GITHUB_TOKEN` 和 `GITHUB_MIRRORS`。配置以完整候选校验；只要包含需要重启的生效变更，整批不应用。其他管理员已经成功重载时，旧 revision 会被拒绝，应重新查询差异。

服务器保留启动时的参数和环境变量快照，这些值仍优先于 TOML。修改 systemd 的 `EnvironmentFile` 需要重启服务。`runtime` 命令使用服务器选用的配置文件，CLI 的 `--config` 不会替换它。报告中的令牌和镜像始终脱敏。

已有同步任务继续使用提交时的配置和 HTTP 客户端，后续任务使用新配置。修改同步周期会重新计时；设为 `0` 关闭后续周期检查，已有任务和启动失败重试仍可完成。
