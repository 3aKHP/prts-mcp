# 环境变量参考

本文档是 3.x Rust 运行时环境变量的**单一来源**。旧线请阅读对应 LTS 分支文档。各 README 与部署指南只保留常用项快表并链接到此页；新增或修改变量时请先更新本页。

- “入口”列表示 Rust 主命令或兼容 profile；它们共用 Rust 业务核心。
- 布尔变量的合法真值为 `1` / `true` / `yes` / `on`（大小写不敏感），其余值视为假；未设置时取默认值。Rust 保留冻结 TS 的解析规则。
- 标注“HTTP 模式”的变量仅在 HTTP 运行时生效；原生主命令默认 HTTP，GHCR 兼容入口默认 stdio。

## 数据路径

| 变量 | 默认值 | 入口 | 说明 |
|------|--------|------|------|
| `GAMEDATA_PATH` | 未设置 | Rust | 指向自定义游戏数据目录。**设置后 GameData excel/levels 的 auto-sync 被禁用**。若指向完整 ArknightsGameData 仓库根目录，其内 `zh_CN/gamedata/levels` 直接用作关卡战斗数据；否则在相邻目录维护 `gamedata-levels` |
| `STORYJSON_PATH` | 未设置 | Rust | 指向本地 `zh_CN.zip`（剧情数据）。**设置后剧情 auto-sync 被禁用** |
| `XDG_DATA_HOME` | `~/.local/share` | Rust | Linux/macOS 的默认数据根；非 Docker 安装时 gamedata、storyjson、images 依次落在 `$XDG_DATA_HOME/prts-mcp/` 下 |
| `LOCALAPPDATA` | `~/AppData/Local` | Rust | Windows 的默认数据根，作用同上（`%LOCALAPPDATA%\prts-mcp\`） |
| `PRTS_MCP_ROOT` | 镜像内置 `/app` | Rust | 标识 Docker 环境，使默认路径切到固定卷挂载点（`/data/gamedata` 等）。**不要在容器外设置** |
| `PRTS_IMAGE_DIR` | `/data/images`（Docker）/ 数据根下 `images/` | Rust | AKDP 立绘资产同步目标；仅 `LOCAL_IMAGE=true` 时生效 |

## 数据同步

| 变量 | 默认值 | 入口 | 说明 |
|------|--------|------|------|
| `GITHUB_TOKEN` | 空 | Rust | 提高 GitHub API 限额，降低 Release 检查被限流的风险 |
| `GITHUB_MIRRORS` | 空 | Rust | 逗号分隔的 ghproxy 风格代理前缀列表（如 `https://ghproxy.net`），直连失败后依次尝试；首尾空白与尾部斜杠自动归一化 |
| `PRTS_AUTO_SYNC_INTERVAL_SECONDS` | `3600` | Rust | GitHub Release 周期检查间隔（秒）；有效范围 `60..604800`（7 天），`0` 表示只执行启动同步；非法值回落默认值 |
| `HTTP_PROXY` / `HTTPS_PROXY` | 未设置 | Rust | 同步与 Wiki 请求的 HTTP 代理（大小写形式均支持，`NO_PROXY` 排除列表两实现均生效）。TS 侧由 sync 传输显式读取；Python 侧由 httpx 默认 `trust_env` 隐式支持 |

## 立绘（`operator_artwork`）

| 变量 | 默认值 | 入口 | 说明 |
|------|--------|------|------|
| `IMAGES_ENABLED` | `true` | Rust | 立绘工具主开关；`false` 时不注册 `operator_artwork`（工具面 24 → 23） |
| `LOCAL_IMAGE` | `false` | Rust | `true` = 同步 AKDP 本地 PNG 资产（~1.5 GB，需挂载/预留 `PRTS_IMAGE_DIR`）；`false` = 从 PRTS MediaWiki 按需获取（零下载） |
| `ORIGINAL_IMAGE` | `false` | Rust | 额外同步原图分辨率分片（总量 ~3 GB）；仅 `LOCAL_IMAGE=true` 时生效 |
| `PRTS_IMAGE_CACHE` | `true` | Rust | MediaWiki 图片的内存 LRU 缓存（256 MiB）；仅 `LOCAL_IMAGE=false` 时生效 |

## 输出与传输

| 变量 | 默认值 | 入口 | 说明 |
|------|--------|------|------|
| `PRTS_OUTPUT_CHANNEL` | `content` | Rust | 结构化输出通道：`content`（默认，与 1.x 行为一致）/ `structured` / `both`；非法值回退 `content`。Rust 支持查询字符串 `?output_channel=` 与请求头 `x-prts-output-channel` 覆盖 |
| `PRTS_TRANSPORT` | 主命令 `http`；GHCR `stdio` | 按 profile | 主命令：trim/小写后仅 `stdio` 选择 stdio，空或非法值保持 HTTP。GHCR：仅 `http` 选择 HTTP，其余 stdio。三个旧 TS 命令忽略此变量，保持原默认传输。 |
| `HOST` | `0.0.0.0` | Rust | HTTP 模式监听地址 |
| `PORT` | `3000` | Rust | HTTP 模式监听端口；主命令/旧 TS profile 保留 TS Number() 语义，GHCR 保留旧 Python int() 语义。stdio 不解析 PORT。HTTP 端点为 `/mcp`，探活为 `/health` |

## 诊断端点

| 变量 | 默认值 | 入口 | 说明 |
|------|--------|------|------|
| `PRTS_DEBUG_TOKEN` | 未设置 | Rust | `/debug/cache`（及 `/debug/metrics`）的必需 Bearer 令牌；未设置或不匹配时返回 404（等于默认关闭）。不要公开反代这些路径，也不要把令牌写入日志或客户端配置 |
| `PRTS_METRICS_ENABLED` | `false` | Rust | 设为严格的 `true` 才启用 `/debug/metrics`；响应使用 Rust 指标 schema（批准差异 D-002），只含聚合指标，不含 MCP 参数、结果或会话 ID |
| `SESSION_IDLE_TIMEOUT_MS` | `86400000`（24h） | Rust | HTTP 会话空闲超时（毫秒）；非法值或 ≤0 表示禁用空闲清理 |

## 附录：非运行时变量（bench / 测试）

以下变量不属于运行时配置，仅供本机隔离环境使用，**不得用于生产服务**：

| 变量 | 用途 |
|------|------|
| `PRTS_BENCH_ISOLATED` | TS 内存 bench 的隔离确认开关（`bench:memory`） |
| `PRTS_BENCH_ORIGIN` | bench 目标地址，仅接受 loopback |
| `PRTS_BENCH_MAX_RSS_BYTES` / `PRTS_BENCH_MAX_RSS_GROWTH_BYTES` | bench 的 RSS 上限与相对增长上限 |
| `E2E_PRTS_API` | E2E 测试 opt-in 开关：设为 `1` 时启用依赖真实 PRTS API 的网络用例（不是 URL 基址覆盖） |
