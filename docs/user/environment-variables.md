# 环境变量参考

本文档是 PRTS-MCP 双实现（Python / TypeScript）环境变量的**单一来源**。各 README 与部署指南只保留常用项快表并链接到此页；新增或修改变量时请先更新本页。

- "实现"列标注变量在哪些实现中生效：**双实现** / **仅 Python** / **仅 TS**。
- 布尔变量的合法真值为 `1` / `true` / `yes` / `on`（大小写不敏感），其余值视为假；未设置时取默认值。两实现解析规则一致。
- 标注"HTTP 模式"的变量仅在以 Streamable HTTP 运行时生效（Python：`PRTS_TRANSPORT=http`；TS：`prts-mcp-ts` / `prts-mcp-ts-bun` bin）。

## 数据路径

| 变量 | 默认值 | 实现 | 说明 |
|------|--------|------|------|
| `GAMEDATA_PATH` | 未设置 | 双实现 | 指向自定义游戏数据目录。**设置后 GameData excel/levels 的 auto-sync 被禁用**。若指向完整 ArknightsGameData 仓库根目录，其内 `zh_CN/gamedata/levels` 直接用作关卡战斗数据；否则在相邻目录维护 `gamedata-levels` |
| `STORYJSON_PATH` | 未设置 | 双实现 | 指向本地 `zh_CN.zip`（剧情数据）。**设置后剧情 auto-sync 被禁用** |
| `XDG_DATA_HOME` | `~/.local/share` | 双实现 | Linux/macOS 的默认数据根；非 Docker 安装时 gamedata、storyjson、images 依次落在 `$XDG_DATA_HOME/prts-mcp/` 下 |
| `LOCALAPPDATA` | `~/AppData/Local` | 双实现 | Windows 的默认数据根，作用同上（`%LOCALAPPDATA%\prts-mcp\`） |
| `PRTS_MCP_ROOT` | 镜像内置 `/app` | 双实现 | 标识 Docker 环境，使默认路径切到固定卷挂载点（`/data/gamedata` 等）。**不要在容器外设置** |
| `PRTS_IMAGE_DIR` | `/data/images`（Docker）/ 数据根下 `images/` | 双实现 | AKDP 立绘资产同步目标；仅 `LOCAL_IMAGE=true` 时生效 |

## 数据同步

| 变量 | 默认值 | 实现 | 说明 |
|------|--------|------|------|
| `GITHUB_TOKEN` | 空 | 双实现 | 提高 GitHub API 限额，降低 Release 检查被限流的风险 |
| `GITHUB_MIRRORS` | 空 | 双实现 | 逗号分隔的 ghproxy 风格代理前缀列表（如 `https://ghproxy.net`），直连失败后依次尝试；首尾空白与尾部斜杠自动归一化 |
| `PRTS_AUTO_SYNC_INTERVAL_SECONDS` | `3600` | 双实现 | GitHub Release 周期检查间隔（秒）；有效范围 `60..604800`（7 天），`0` 表示只执行启动同步；非法值回落默认值 |
| `HTTP_PROXY` / `HTTPS_PROXY` | 未设置 | 双实现 | 同步与 Wiki 请求的 HTTP 代理。TS 侧显式读取；Python 侧由 httpx 默认 `trust_env` 隐式支持（含 `NO_PROXY`） |

## 立绘（`operator_artwork`）

| 变量 | 默认值 | 实现 | 说明 |
|------|--------|------|------|
| `IMAGES_ENABLED` | `true` | 双实现 | 立绘工具主开关；`false` 时不注册 `operator_artwork`（工具面 24 → 23） |
| `LOCAL_IMAGE` | `false` | 双实现 | `true` = 同步 AKDP 本地 PNG 资产（~1.5 GB，需挂载/预留 `PRTS_IMAGE_DIR`）；`false` = 从 PRTS MediaWiki 按需获取（零下载） |
| `ORIGINAL_IMAGE` | `false` | 双实现 | 额外同步原图分辨率分片（总量 ~3 GB）；仅 `LOCAL_IMAGE=true` 时生效 |
| `PRTS_IMAGE_CACHE` | `true` | 双实现 | MediaWiki 图片的内存 LRU 缓存（256 MiB）；仅 `LOCAL_IMAGE=false` 时生效 |

## 输出与传输

| 变量 | 默认值 | 实现 | 说明 |
|------|--------|------|------|
| `PRTS_OUTPUT_CHANNEL` | `content` | 双实现 | 结构化输出通道：`content`（默认，与 1.x 行为一致）/ `structured` / `both`；非法值回退 `content`。TS 另支持查询字符串 `?output_channel=` 与请求头 `x-prts-output-channel` 按连接覆盖 |
| `PRTS_TRANSPORT` | `stdio` | 仅 Python | 传输选择：`stdio`（默认）/ `http`。TS 无此变量，经 bin 选择（`prts-mcp-ts`[-bun] = HTTP，`prts-mcp-ts-stdio` = stdio） |
| `HOST` | `0.0.0.0` | 双实现 | HTTP 模式监听地址 |
| `PORT` | `3000` | 双实现 | HTTP 模式监听端口；非数字值报错退出。HTTP 端点为 `/mcp`，探活为 `/health` |

## 诊断端点

| 变量 | 默认值 | 实现 | 说明 |
|------|--------|------|------|
| `PRTS_DEBUG_TOKEN` | 未设置 | 双实现 | `/debug/cache`（及 TS 的 `/debug/metrics`）的必需 Bearer 令牌；未设置或不匹配时返回 404（等于默认关闭）。不要公开反代这些路径，也不要把令牌写入日志或客户端配置 |
| `PRTS_METRICS_ENABLED` | `false` | 仅 TS | 设为严格的 `true` 才启用 `/debug/metrics`；响应只含聚合指标，不含 MCP 参数、结果或会话 ID |
| `SESSION_IDLE_TIMEOUT_MS` | `86400000`（24h） | 仅 TS | HTTP 会话空闲超时（毫秒）；非法值或 ≤0 表示禁用空闲清理 |

## 附录：非运行时变量（bench / 测试）

以下变量不属于运行时配置，仅供本机隔离环境使用，**不得用于生产服务**：

| 变量 | 用途 |
|------|------|
| `PRTS_BENCH_ISOLATED` | TS 内存 bench 的隔离确认开关（`bench:memory`） |
| `PRTS_BENCH_ORIGIN` | bench 目标地址，仅接受 loopback |
| `PRTS_BENCH_MAX_RSS_BYTES` / `PRTS_BENCH_MAX_RSS_GROWTH_BYTES` | bench 的 RSS 上限与相对增长上限 |
| `E2E_PRTS_API` | E2E 测试覆盖 PRTS API 基址 |
