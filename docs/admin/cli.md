# 管理 CLI

[English](cli.en.md)

`prtsctl` 提供配置、诊断、数据检查和一次性同步。以下功能随开发中的 3.2.2 提供；公开稳定版的可用命令以安装版本的 `--help` 为准。

## 开始使用

```bash
prtsctl config init
prtsctl config show --sources
prtsctl config validate
prtsctl doctor
prtsctl data sync
prtsctl data verify
prtsctl serve
```

`prtsctl` 无参数显示帮助。`serve` 在当前进程持续运行服务器，各发行渠道默认 HTTP；使用 `prtsctl serve --transport stdio` 作为 MCP 客户端子进程时，标准输入输出始终用于 MCP。程序不自行转入后台，进程托管仍由客户端、Docker 或系统服务管理器负责。

原有 `prts-mcp`、`prts-mcp-ts*` 和 Docker 入口的无参数行为不变。它们新增 `--help`、`--version` 和显式 `--config <path>`，不会自动读取用户配置文件。原生与 npm 主入口默认 HTTP，PyPI 与 Docker 服务器入口默认 stdio，TS 兼容入口保持固定传输。

原生归档的 `bin/` 包含 `prtsctl`；npm 主包、PyPI Wheel 和默认 Cargo 安装也提供该命令。只安装单个 Cargo 二进制的用户可执行 `cargo install prts-mcp --locked --bin prtsctl`。Docker 可使用 `docker run --rm --entrypoint /app/bin/prtsctl <image> --help`；读取生产数据时挂载同一数据卷，并保持对应的环境变量配置。

## 命令参考

| 命令 | 行为 |
| --- | --- |
| `config show [--sources]` | 显示本次调用的生效配置、来源及联动说明 |
| `config validate` | 校验配置文件与最终配置；环境变量保留已有解析与回退语义 |
| `config init [--force] [--dry-run]` | 创建带注释的模板；覆盖已有文件必须显式加 `--force` |
| `config set <key> <value> [--dry-run]` | 修改已有文件中的一个字段 |
| `config unset <key> [--dry-run]` | 删除字段；字段不存在时成功 |
| `doctor [--network]` | 默认检查本地配置、路径、数据源归属及可观察的权限条件 |
| `data status` | 观察磁盘中的数据候选、激活代次和备用数据路径 |
| `data verify` | 执行 SQLite、JSON/剧情 ZIP 及已启用本地立绘的完整检查 |
| `data sync [--target game\|images\|all] [--wait-timeout <seconds>]` | 执行一次同步，不启动定时轮询 |
| `serve [--transport http\|stdio] [--host <address>] [--port <number>]` | 显式运行服务器 |
| `completion <bash\|zsh\|powershell>` | 输出补全脚本，由用户自行加载 |

管理命令共享 `--config <path>` 和 `--output text|json`（短写 `-o`），可放在子命令前后。参数名区分大小写，不支持自动缩写；接受 `--name value` 和 `--name=value`。`--` 终止选项解析。

帮助、版本和补全不读取业务配置。默认只读命令不创建服务、下载数据或初始化数据目录。`doctor --network` 才探测 GitHub 数据源与 PRTS Wiki，每项最多等待 5 秒，不下载资产。权限检查不尝试写文件；无法可靠判断时报告 `unknown`。

`data status` 的 `present_unverified` 表示元数据可读取，不表示完整性已验证。`available_backend` 是本次本地观察，不能替代运行中服务器的 `/debug/metrics`。`data verify` 可能读取大量数据并计算摘要；发现错误返回非零状态，SQLite 检查不写入准入缓存。未完成 checkpoint 的 WAL/journal 数据库须先由写入方正常关闭，再执行检查。

`data sync` 默认仅同步游戏数据。`images` 或 `all` 需要 `IMAGES_ENABLED=true` 与 `LOCAL_IMAGE=true`，可能下载 GB 量级资产。自定义只读数据路径不会被覆盖。锁等待预算默认 30 秒，允许 `0..86400` 秒；`0` 表示立即尝试，冲突即失败。预算只计算锁等待，不限制下载时间。网络失败时即使旧数据仍可读，同步也返回失败。Ctrl+C 或 SIGTERM 会停止新的网络工作；已经进入的发布临界区允许安全结束。

## 配置文件

优先级为 **显式参数 > 环境变量 > 配置文件 > 默认值**。`--config` 选择单个文件，不与默认文件叠加。默认文件不存在时继续使用环境变量与默认值；显式文件不存在时报错。

环境变量名称遵循操作系统规则：Windows 不区分大小写，Unix 区分大小写。TOML 字段名称始终区分大小写。

`prtsctl` 自动读取的用户级路径：

- Linux/macOS：`$XDG_CONFIG_HOME/prts-mcp/config.toml`；未设置时为 `~/.config/prts-mcp/config.toml`。
- Windows：`%APPDATA%\prts-mcp\config.toml`；缺失时使用用户目录下的 `AppData\Roaming`。

程序不搜索工作目录配置，不自动加载 `.env`。文件内的相对路径基于文件所在目录；环境变量和命令行中的相对路径保持基于当前目录。

```toml
schema_version = 1

[runtime]
PRTS_TRANSPORT = "http"
HOST = "127.0.0.1"
PORT = 3000
PRTS_AUTO_SYNC_INTERVAL_SECONDS = 3600
LOCAL_IMAGE = false
```

`[runtime]` 字段沿用[环境变量参考](environment-variables.md)的业务变量名称。`config init` 的注释列出全部可编辑字段和类型。操作系统目录发现、容器布局和内部启动桥参数不作为文件字段；代理及自定义 CA 继续通过环境变量提供，`config show -o json` 会列出其配置来源。

文件中的布尔值使用 `true`/`false`，端口和轮询秒数使用整数，会话毫秒数允许有限小数。路径必须是非空字符串。未知字段、非法枚举及冲突配置会被拒绝。不要将所有模板项取消注释：例如显式 `PRTS_DATA_BACKEND = "sqlite"` 会关闭默认 JSON 备用，`GAMEDATA_PATH` 会关闭对应的 JSON 自动同步。

```bash
prtsctl --config ./server.toml config init
prtsctl --config ./server.toml config set PORT 3100
prtsctl --config ./server.toml config set runtime.HOST 127.0.0.1
prtsctl --config ./server.toml config unset PORT
prts-mcp --config ./server.toml
```

编辑保留无关内容和注释，以锁和原子替换避免半写入文件。`--dry-run` 不写文件或锁。若环境变量覆盖了修改结果，输出会提示。编辑不接受符号链接目标；请明确指定实际文件。长期令牌优先通过环境变量提供，`config set` 拒绝 token 字段，手工文件和环境变量中的敏感值在输出中脱敏。配置文件修改仅影响下一次读取它的进程。

## 脚本输出与 Shell

文本默认面向人阅读；`-o json` 输出一个完整 JSON 文档。日志和错误走 stderr，不混入 stdout。CLI 输出格式与 `PRTS_OUTPUT_CHANNEL` 的 MCP 工具输出通道互相独立，`serve` 不接受 `--output`。

对象报告使用稳定英文键；数值和布尔值保留 JSON 类型，集合始终为数组。脚本应忽略未知的新增字段，不依赖对象字段顺序；`schema_version` 为报告结构版本。已有字段的类型和含义受兼容性承诺保护。`config show` 的每个字段包含 `key`、`value`、`input`、`source` 和 `explanation`，其中 `source` 为 `argument`、`environment`、`file` 或 `default`。

```powershell
$raw = prtsctl config show -o json
if ($LASTEXITCODE -ne 0) { throw '读取配置失败' }
$config = $raw | ConvertFrom-Json
$config.fields | Where-Object { $_.source -eq 'environment' }
```

```bash
prtsctl config show -o json | jq '.fields[] | select(.source == "environment")'
```

Windows 当前目录中的原生程序使用 `.\prtsctl.exe`，Bash 使用 `./prtsctl`。含空格的路径须引用。PowerShell 的 `$env:NAME` 与 Bash 的 `NAME=value command` 属于 Shell 语法，不由 CLI 重新解析。命令不会因识别到 Shell 或管道而改变输出格式。

补全脚本示例：`prtsctl completion bash > prtsctl.bash`，在 Bash 中 `source ./prtsctl.bash`；PowerShell 可将 `prtsctl completion powershell` 的输出保存为脚本后显式加载。程序不会自动修改 Shell profile。

| 退出码 | 含义 |
| --- | --- |
| `0` | 操作成功；状态报告可能仍含 warning/unknown |
| `1` | 操作或检查失败 |
| `2` | 参数或配置无效 |
| `3` | 同步锁等待超时 |
| `130` / `143` | 一次性同步被 Ctrl+C / SIGTERM 取消（适用平台） |

这些退出码属于新管理命令；既有服务器入口保留原退出行为。`prtsctl` 一期不提供后台实例启停、热更新和数据删除命令。

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

`prtsctl runtime status --instance main -o json` 查询实际运行状态；`runtime config show` 查看服务器配置快照；`runtime data status` 查看服务器当前数据视图。查询不自动启动实例。此阶段的在线接口只提供查询，服务生命周期和在线写操作由后续增量提供。
