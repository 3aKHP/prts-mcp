# 监控诊断与故障排查手册

本文面向服务端管理员，说明如何对 PRTS-MCP 3.x 执行健康探活、启用并解读 `/debug/cache` 与 `/debug/metrics` 诊断端点、收集运行日志，以及排查各类部署与同步故障。

- 部署与容器配置见[服务端部署与容器运维指南](deployment.md)。
- 数据目录与同步机制见[数据同步、离线包与立绘存储管理](data-and-sync.md)。

---

## 1. 健康探活（`/health`）

在 Streamable HTTP 模式下，服务端提供免鉴权的探活端点 `/health`：

```bash
curl -fsS http://127.0.0.1:3000/health
# 正常响应（HTTP 200）：{"status":"ok"}
```

> **注意“服务已监听”与“数据已同步”的区别**：
> 服务端启动后会立即绑定端口并响应 `/health`，随后在后台异步执行首次数据同步。
> - 对于官方原生归档包、npm 包与 Docker 镜像，由于内置了只读备用数据，服务一启动即可正常响应工具查询；
> - 对于不含内置备用数据的源码构建版本，`/health` 返回 `ok` 时首次后台同步可能仍在进行中，需结合 `stderr` 日志或 `/debug/cache` 观察同步状态。

---

## 2. 内部诊断与指标端点（`/debug/cache` 与 `/debug/metrics`）

出于安全考虑，诊断端点默认**完全关闭**（未配置 Token 或 Token 不匹配时直接返回 `404 Not Found`，不暴露端点存在）。

### 2.1 启用与请求方式

1. **`/debug/cache`（缓存与模块状态诊断）**：
   - 启用条件：设置非空的环境变量 `PRTS_DEBUG_TOKEN=<your-secret-token>`。
2. **`/debug/metrics`（聚合请求与进程内存指标）**：
   - 启用条件：同时设置非空的 `PRTS_DEBUG_TOKEN` **且** `PRTS_METRICS_ENABLED=true`（必须为精确的小写字符串 `true`）。

通过 `Authorization: Bearer <token>` 请求头访问：

```bash
curl -fsS -H "Authorization: Bearer $PRTS_DEBUG_TOKEN" http://127.0.0.1:3000/debug/cache
curl -fsS -H "Authorization: Bearer $PRTS_DEBUG_TOKEN" http://127.0.0.1:3000/debug/metrics
```

> **安全红线**：请在反向代理层屏蔽 `/debug/*` 路径，仅允许在宿主机回环地址（`127.0.0.1`）或受控内网管理网段访问，切勿将 `PRTS_DEBUG_TOKEN` 提交到公开配置仓库。

### 2.2 解读诊断响应结构（Rust `D-001` / `D-002`）

在 3.x Rust 实现中，诊断与指标端点遵循 [`contracts/baseline.json`](../../contracts/baseline.json) 中登记的 `D-001` 与 `D-002` Schema：

- **`/debug/cache` 关键字段**：
  - 顶层按 `operator`、`enemy`、`stage`、`stage_enemy`、`item`、`search`、`building`、`skill`、`story_search`、`images`、`artwork_mediawiki` 共 11 个领域分组；
  - 各缓存项包含 `loaded`、`count`、`hits`、`misses`、`clears`，分别表示是否已加载、条目数、命中次数、未命中次数与清理次数；MediaWiki 图片缓存还会在占用非零时返回 `bytes`。
- **`/debug/metrics` 关键字段**：
  - `schema_version`: 固定为 `"prts-mcp.rust.metrics/v1"`；`server` 包含服务版本 `version` 与运行时长 `uptime_ms`；
  - `process`: 包含 `runtime: "rust"`、`rss_bytes`（当前常驻内存 RSS / Working Set）与 `rss_high_water_bytes`（指标采样中观察到的最高 RSS），不再输出 V8/Python 堆字段；
  - `sessions`: 包含当前活跃的 HTTP Legacy 会话数、累计创建/关闭/超时驱逐计数、配置的 `idle_timeout_ms`、最长会话存续时间 `oldest_age_ms` 与最长空闲时间 `max_idle_age_ms`；
  - `requests` / `tool_calls`: 分别提供 HTTP 请求的聚合计数、错误数与耗时，以及工具调用的聚合计数与 `by_name` 分组耗时统计；不记录用户的具体查询词、响应内容或会话 ID。

---

## 3. 日志收集与脱敏

PRTS-MCP 严格分离标准输出与标准错误流：
- **`stdout`**：专用于 `stdio` 模式的 MCP JSON-RPC 协议通信；
- **`stderr`**：输出所有启动信息、后台数据同步进度、警告与错误日志。

```bash
# 查看常驻 Docker 容器日志
docker logs --tail 100 -f prts-mcp

# 查看 systemd 服务日志
sudo journalctl -u prts-mcp -f

# 调试一次性 stdio 容器时，仅将 stderr 重定向到文件（切勿使用 2>&1）
docker run -i --rm -v prts-data:/data ghcr.io/3akhp/prts-mcp:3.0.0-rc.2 2>prts-stderr.log
```

**公开提交 Issue 前的日志脱敏检查**：虽然服务端自身不会将 `GITHUB_TOKEN` 或 `PRTS_DEBUG_TOKEN` 打印到日志中，但在贴出启动命令、环境变量列表或系统报错前，请务必手动隐去私有 Token、内部代理地址与个人敏感路径。

---

## 4. 常见故障排查矩阵

| 故障类别 | 现象描述 | 排查步骤与解决方案 |
| --- | --- | --- |
| **启动失败** | npm 报缺少平台二进制包（missing optional platform package） | 安装时使用了 `--omit=optional` 或被全局 `.npmrc` 禁用了可选依赖。去掉该选项重新执行 `npm install`。 |
| **启动失败** | Linux 下原生二进制报 `GLIBC_2.28 not found` 或动态链接错误 | 宿主机 `glibc` 低于 2.28，或属于 Alpine（`musl`）系统。请改用官方 Docker 镜像运行。 |
| **启动失败** | HTTP 模式下报端口占用（`Address already in use`）或非法 `PORT` | 检查是否有旧实例或僵尸进程占用了 `3000` 端口；通过 `PORT=<新端口>` 更换端口，并确保 `PORT` 为合法的 `1..65535` 整数。 |
| **协议连接** | `stdio` 客户端启动后立刻报 `Connection closed` 或 JSON 解析错误 | 1. 若直接调用 `prts-mcp` 主命令，检查是否漏设了 `PRTS_TRANSPORT=stdio`（未设置时默认启动 HTTP 监听）。<br>2. 若使用 Docker，确认命令包含 `-i` 且**未包含 `-t`**（TTY 会混入控制字符破坏 JSON-RPC）。 |
| **HTTP 会话** | 客户端报 HTTP `404` / JSON-RPC `-32002: MCP session lost` | 发生在 Legacy 有状态协议下：服务端进程/容器曾重启，或该会话连续空闲超过 `SESSION_IDLE_TIMEOUT_MS`（默认 24 小时）已被驱逐（`stderr` 日志可见 `Session <id> idle for ...s — evicting.`）。<br>**恢复方式**：客户端直接重发 `initialize`（服务端支持带旧 `Mcp-Session-Id` 直接重初始化），或让用户在客户端设置中关闭再重开 MCP 连接开关。 |
| **HTTP 协议** | 客户端报 HTTP `400` / `-32000: Bad Request: Server not initialized` | Legacy 客户端在未执行 `initialize` 握手且未携带 `Mcp-Session-Id` 的情况下直接调用了 `tools/list` 或 `tools/call`。请确认客户端按标准 MCP Streamable HTTP 流程先完成 `initialize`，或改用携带 `_meta` 信封的 `2026-07-28` 现代无状态模式。 |
| **HTTP 协议** | 客户端报 HTTP `400` / `-32602`（缺少 `_meta`）或 `-32020`（缺少 `Mcp-Method`） | 客户端发送了 `2026-07-28` 现代协议请求头（`MCP-Protocol-Version`）或现代信封，但请求头与请求体信封不完整。请核对客户端是否完整遵循 `2026-07-28` 规范（详见 [2.5 → 2.6 迁移指南](../migration-2.5-to-2.6.md)）。 |
| **数据同步** | 日志未见自动同步，或新干员/新活动未更新 | 1. 检查是否误设了环境变量 `GAMEDATA_PATH`（**哪怕设为空值 `GAMEDATA_PATH=` 也会禁用自动同步**）或 `STORYJSON_PATH`。<br>2. 检查 `stderr` 是否提示 GitHub API `403 rate limit exceeded`，若是请配置 `GITHUB_TOKEN`。<br>3. 若 GitHub Release 下载超时，请配置 `GITHUB_MIRRORS` 或 `HTTPS_PROXY`。 |
| **数据查询** | 干员与剧情查询正常，但 `search_prts` / `prts_page` 报错 | 本地游戏数据可走内置备用包或已同步缓存，而 Wiki 工具必须实时访问 `https://prts.wiki/api.php`。请检查容器/宿主机的外网 DNS、代理或自定义 CA 证书（`NODE_EXTRA_CA_CERTS`）。 |
| **立绘工具** | 请求 `variant="original"` 原图报错，但 `large` / `preview` 正常 | 本地立绘模式（`LOCAL_IMAGE=true`）下默认 `ORIGINAL_IMAGE=false`，不下载原图分片。若确需原图，请开启 `ORIGINAL_IMAGE=true` 并等待原图分片同步完成。 |
| **容器权限** | 使用 `--user` 或 `--read-only` 时报 `Permission denied` / `Read-only file system` | 1. 确认宿主机挂载目录 `/data` 的 UID/GID 与 `--user` 一致且可写。<br>2. `--read-only` 模式下必须添加 `--tmpfs /tmp:rw,nosuid,nodev,mode=1777`（若为 4 子卷分卷挂载，还需添加 `--tmpfs /data:rw,nosuid,nodev,mode=1777`）。 |
