# 运行时环境变量完整参考

本文面向服务端管理员与高级用户，列出 PRTS-MCP 3.x 运行时支持的全部环境变量、默认值与解析规则。

- 容器、systemd 与 npm 服务部署示例见[服务端部署与容器运维指南](deployment.md)。
- 数据同步、离线挂载与立绘存储规划见[数据同步、离线包与立绘存储管理](data-and-sync.md)。
- 1.7 / 2.8 旧版配置请参阅对应 LTS 分支文档。

### 通用解析规则

- **命令入口一致性**：下表中的所有变量对 `prts-mcp` 主命令、`prts-mcp-ts*` 兼容命令以及 Docker 入口 `prts-mcp-ghcr` 背后的 Rust 核心统一生效；仅 `PRTS_TRANSPORT` 与 `PORT` 按入口 profile 存在既定兼容差异。
- **布尔值解析规则**：去除首尾空白并转为小写后，仅 `1`、`true`、`yes`、`on` 视为真（`true`），其余任何非空值均视为假（`false`）；变量未设置时取默认值。（唯一例外：`PRTS_METRICS_ENABLED` 要求严格匹配小写字符串 `true`。）
- **不自动读取 `.env` 文件**：服务端直接读取进程环境变量，不会自动加载工作目录下的 `.env` 文件。请通过 shell、systemd `Environment=`、Docker `-e` / `--env-file` 或 MCP 客户端配置的 `env` 字段传入所需变量（根目录 `.env.example` 可作为模板参考）。

---

## 1. 数据目录与自定义路径

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PRTS_DATA_BACKEND` | `sqlite`（3.2） | 选择 `json` 或 `sqlite`；去除首尾空白，空值视为未设置，其他值启动失败。未显式选择且无自定义 JSON 路径时，没有有效 DB 就使用 JSON 备用；后台 DB 就绪后新请求自动切换。显式 SQLite 不回落。只同步所选后端。 |
| `PRTS_VALIDATION_MODE` | `normal` | 启动时选择 `normal` 或 `strict`；去除首尾空白，空值视为未设置，非法值启动失败。通常模式对已验收的受管理 SQLite 文件重新比对整文件 SHA，并复用有效的结构验收记录；严格模式每个新进程重新检查结构和外键。新同步产物始终完整验收。自定义 DB 在通常模式执行快速检查，严格模式执行完整结构和外键检查。路径、鉴权、资源限制、锁和原子发布始终启用。 |
| `PRTS_DATA_DIR` | 数据根下的 `database/` | SQLite 的可写同步目录；设置 `GAMEDATA_PATH` 时默认为其下的 `database/`。单独设置不改变后端选择，也不会关闭同步。Docker 默认路径为 `/data/database`。空值忽略。 |
| `PRTS_DATA_DB` | 未设置 | 单个只读预编译 DB；后端未设置时选择 SQLite，并关闭游戏数据同步。与显式 `PRTS_DATA_BACKEND=json` 冲突。缺失或无效时报告缺数据，不读取原始 JSON。空值忽略。 |
| `GAMEDATA_PATH` | 未设置 | JSON 后端的自定义游戏数据目录路径。**只要该环境变量存在（哪怕赋值为空字符串 `GAMEDATA_PATH=`），即会禁用游戏表与关卡战斗数据的后台自动同步。** 若指向含 `zh_CN/gamedata/levels/enemydata/enemy_database.json` 的完整 `ArknightsGameData` 根目录，关卡数据直接从该目录读取；否则使用相邻的 `gamedata-levels` 目录。 |
| `STORYJSON_PATH` | 未设置 | JSON 后端的自定义本地剧情数据压缩包（`zh_CN.zip`）路径。**设为非空值时会禁用剧情后台自动同步**；切勿将其设为空字符串占位。 |
| `XDG_DATA_HOME` | `~/.local/share` | Linux 与 macOS 下的默认数据根目录。非 Docker 运行时，`gamedata`、`gamedata-levels`、`storyjson` 与 `images` 默认存放在 `$XDG_DATA_HOME/prts-mcp/` 下。 |
| `LOCALAPPDATA` | `~/AppData/Local` | Windows 下的默认数据根目录，数据默认存放在 `%LOCALAPPDATA%\prts-mcp` 下。 |
| `PRTS_MCP_ROOT` | 容器内预设为 `/app` | 用于标识官方 Docker 容器环境，将默认可写数据根目录切换至 `/data`（如 `/data/gamedata`）。**非容器环境下请勿设置此变量。** |
| `PRTS_IMAGE_DIR` | Docker 下为 `/data/images`；本地为数据根下的 `images/` | `LOCAL_IMAGE=true` 时，AKDP 本地立绘资产的同步存储目录。 |

显式 SQLite 模式不读取或同步原始游戏 JSON/ZIP；默认 SQLite 策略允许在 DB 缺失时读取 JSON 备用，但只同步 SQLite。发行包内置较小的 JSON 备用数据，显式离线 SQLite 须预置 DB。未设置后端时，自定义 JSON 路径继续选择 JSON；显式 `PRTS_DATA_DB` 优先选择 SQLite。切换时已有请求保留原数据快照。图片行为不变。

> **路径推导与空值注意事项**：
> 1. 当设置了 `GAMEDATA_PATH` 但未显式设置 `STORYJSON_PATH` 或 `PRTS_IMAGE_DIR` 时，默认剧情与立绘路径会从 `GAMEDATA_PATH` 的父目录相邻推导。因此，使用自定义 `GAMEDATA_PATH` 时，建议将 `STORYJSON_PATH` 与 `PRTS_IMAGE_DIR` 也显式配齐。
> 2. 请勿将 `.env.example` 中注释掉的 `GAMEDATA_PATH=` 或 `STORYJSON_PATH=` 取消注释后以空值导出——要使用默认路径与自动同步，请直接保持变量**未设置（unset）**。

---

## 2. 数据同步与网络代理

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PRTS_DATA_SOURCE_REPO` | `3aKHP/arknights-data-pipeline` | 数据与图片自动同步的 GitHub 源仓库，格式为 `owner/repo`。去除首尾空白，空值按默认源处理；非法格式启动失败。仓库身份不区分大小写。自定义源使用独立数据目录，已有显式同步目录须为空或已绑定同一源；详见[自定义数据源](data-and-sync.md#自定义-github-数据源)。 |
| `GITHUB_TOKEN` | 空 | GitHub Personal Access Token，用于提升 GitHub API 请求限额，避免高频检查 Release 时触发匿名限流。 |
| `GITHUB_MIRRORS` | 空 | 逗号分隔的 GitHub 下载镜像前缀列表（例如 `https://ghproxy.net`）。直连原地址失败后会按顺序尝试 `<mirror>/<original_url>`（首尾空白与末尾斜杠会自动归一化）。 |
| `PRTS_AUTO_SYNC_INTERVAL_SECONDS` | `3600` | 后台轮询检查 GitHub Release 更新的间隔秒数。有效范围为 `60..604800`（1 分钟至 7 天）；设为 `0` 时仅在服务启动时执行一次同步检查，关闭后续周期轮询；超出范围或非法值回退为默认值 `3600`。 |
| `HTTP_PROXY` / `HTTPS_PROXY` | 未设置 | 数据同步与 PRTS Wiki 请求使用的 HTTP(S) 代理（同时支持小写 `http_proxy` / `https_proxy`）。 |
| `ALL_PROXY` / `NO_PROXY` | 未设置 | 通用回退代理与免代理主机列表（同时支持小写形式）。注意：环境变量代理设置不会改变操作系统内核级路由或 TUN 虚拟网卡行为。 |
| `NODE_EXTRA_CA_CERTS` | 未设置 | 指向自定义根证书 PEM 文件的路径；配置后 Wiki HTTP 客户端会尝试加载该证书，以便在企业内网或自定义 CA 环境下访问 Wiki。 |

---

## 3. 立绘工具（`operator_artwork`）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `IMAGES_ENABLED` | `true` | 立绘工具总开关。设为 `false` 时隐藏 `operator_artwork`（注册工具数从 24 变为 23）。 |
| `LOCAL_IMAGE` | `false` | 数据源模式开关：`false`（默认）按需从 PRTS MediaWiki 实时获取立绘（不预先同步全量包，但调用工具取图时仍会产生网络下载）；`true` 在后台同步 AKDP 全量本地 PNG 资产包（GB 量级，请预留充足磁盘空间）。 |
| `ORIGINAL_IMAGE` | `false` | 设为 `true` 时额外同步未缩放的原图分辨率分片（进一步增加磁盘与流量消耗）；仅在 `LOCAL_IMAGE=true` 时生效。 |
| `PRTS_IMAGE_CACHE` | `true` | 为 MediaWiki 模式（`LOCAL_IMAGE=false`）开启上限 256 MiB 的内存 LRU 图片缓存。 |

---

## 4. 输出通道与传输协议

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PRTS_OUTPUT_CHANNEL` | `content` | MCP 工具默认输出通道：`content`（默认，输出 Markdown 文本）、`structured`（输出 `structuredContent`，`content` 保留简短摘要）或 `both`（结构化数据与完整文本）；非法值回退为 `content`。没有结构化结果时仍返回完整文本，各通道均保留图片内容。HTTP 模式下还可通过 `?output_channel=` 查询参数或 `x-prts-output-channel` 请求头覆盖。 |
| `PRTS_TRANSPORT` | 原生/npm 主命令为 `http`；Docker 为 `stdio` | 选择 MCP 传输模式。对 `prts-mcp` 主命令，设为 `stdio`（大小写不敏感）切换到 stdio，其余值保持 HTTP；对 Docker 入口（`prts-mcp-ghcr`），设为 `http` 切换到 HTTP，其余值保持 stdio。`prts-mcp-ts` / `prts-mcp-ts-bun` / `prts-mcp-ts-stdio` 三个兼容命令忽略此变量，始终保持各自固定的传输模式。 |
| `HOST` | `0.0.0.0` | HTTP 模式的监听地址。 |
| `PORT` | `3000` | HTTP 模式的监听端口（MCP 端点为 `/mcp`，健康检查为 `/health`；stdio 模式下不解析此变量）。`prts-mcp` 与 `prts-mcp-ts*` 沿用 TypeScript `Number()` 解析语义，Docker 入口 `prts-mcp-ghcr` 沿用 Python `int()` 解析语义。 |

---

## 5. 会话管理与诊断端点

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SESSION_IDLE_TIMEOUT_MS` | `86400000`（24 小时） | HTTP 有状态会话（legacy 模式）的最大空闲超时毫秒数；设为 `<= 0` 或非法值时禁用空闲会话自动清理。 |
| `PRTS_DEBUG_TOKEN` | 未设置 | 访问 `/debug/cache` 与 `/debug/metrics` 诊断端点的必需 Bearer Token。未设置或请求头令牌不匹配时直接返回 `404 Not Found`（即默认关闭）。请勿将诊断端点暴露至公网，也不要将 Token 写入共享日志或客户端配置。 |
| `PRTS_METRICS_ENABLED` | `false` | 必须设为精确的小写字符串 `true`（且已配置 `PRTS_DEBUG_TOKEN`）才会开启 `/debug/metrics`。返回的 JSON 遵循 Rust 指标结构（批准差异 `D-002`），仅包含聚合计数与内存指标，不记录用户查询参数、响应正文或会话 ID。 |

---

## 附录：开发与测试专用变量

仓库 `tools/` 下的基准测试、契约采集与发行打包脚本所使用的内部环境变量不属于用户运行时配置，详见 [`ENVIRONMENT.md`](../dev/ENVIRONMENT.md) 与 [`NPM-DISTRIBUTION.md`](../dev/NPM-DISTRIBUTION.md)。
