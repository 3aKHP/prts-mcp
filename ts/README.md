# PRTS MCP Server — TypeScript 实现

明日方舟同人创作辅助 MCP Server，TypeScript 版本。支持 **Streamable HTTP** （单端点 `/mcp`）与 **stdio**，既可部署为 HTTP 服务，也可接入本地 MCP 客户端。

提供 24 个 MCP 工具（2.x）：PRTS 词条检索与页面结构、干员档案/语音/基础信息、剧情活动与台词、角色出场追踪、全文搜索、敌人图鉴、关卡查询、关卡敌人融合、物品/材料查询，以及干员立绘。完整清单见仓库根目录 [`README.md`](../README.md)。

TypeScript 实现正式支持 Bun 与 Node.js 双运行时。自 2.2.0 起 **Bun 是默认生产运行时**：默认 `ts/Dockerfile`、CI 主验证链与推荐 Docker 部署均在 Bun 下运行（最低验证版本 Bun `1.3.14`）。Node.js 保留为受支持的 legacy/可选运行时，通过 `prts-mcp-ts` npm bin、`npx prts-mcp-ts` 与 `ts/Dockerfile.node` 构建路径提供。npm 发布路径仍走 npm CLI （`npm publish --provenance`，与运行时无关）。

> **2.0 变更**：工具面由 1.x 的 32 个合并为 23 个（详见 [1.x → 2.0 迁移指南](../docs/migration-1.x-to-2.0.md)）；新增可选的 output channel（查询字符串 `?output_channel=` / 请求头 `x-prts-output-channel` / `PRTS_OUTPUT_CHANNEL` 环境变量，默认 `content`，与 1.x 行为一致）。

---

## 快速开始（Docker）

自 2.2.0 起默认镜像在 Bun 下运行（行为与 Node 镜像一致，仅基础镜像和入口不同）：

```bash
# 从仓库根目录构建默认 Bun 镜像（可选预置 bundled 数据，详见下方）
docker build -f ts/Dockerfile -t prts-mcp-ts .

# 运行（named volume 持久化游戏数据，推荐）
docker run -d -p 3000:3000 -v prts-mcp-ts-data:/data/gamedata -v prts-mcp-ts-levels:/data/gamedata-levels -v prts-mcp-ts-storyjson:/data/storyjson prts-mcp-ts

# 本地全量立绘（~1.5 GB AKDP 资产；默认 MediaWiki 按需模式不需要 images 卷）
docker run -d -p 3000:3000 -v prts-mcp-ts-data:/data/gamedata -v prts-mcp-ts-levels:/data/gamedata-levels -v prts-mcp-ts-storyjson:/data/storyjson -v prts-mcp-ts-images:/data/images -e LOCAL_IMAGE=true prts-mcp-ts
```

需要 Node.js 镜像时改用 legacy 构建路径：

```bash
docker build -f ts/Dockerfile.node -t prts-mcp-ts-node .
```

服务启动后 MCP 端点为 `http://<host>:3000/mcp`，健康检查端点为 `http://<host>:3000/health`。部署诊断可在显式启用后使用仅聚合的 `/debug/metrics`；不要经公网代理该路径。

### 接入 MCP 客户端

在客户端配置中选择 **Streamable HTTP** 传输类型，端点填写：

```
http://localhost:3000/mcp
```

---

## 快速试用（npx）

无需克隆仓库，直接运行（Node.js 入口，最低试用门槛，无需额外安装运行时）：

```bash
npx prts-mcp-ts
```

需要 Bun 运行时试用：

```bash
bunx --bun -p prts-mcp-ts prts-mcp-ts-bun
```

服务启动后 MCP 端点为 `http://localhost:3000/mcp`。

## 本地开发

```bash
cd ts
npm install
npm run dev       # tsx 直接运行（Node），支持热重载
npm run build     # 编译到 dist/
npm start         # 运行编译后的版本（自 2.2.0 起默认走 Bun 入口）
```

需要 Bun 原生开发体验：

```bash
cd ts
bun install --frozen-lockfile
bun run dev:bun    # bun 直接运行源码
bun run start      # 运行 dist/server-bun.js
```

### 默认 Bun 运行路径

自 2.2.0 起 Bun 是 TypeScript 实现的默认生产运行时，最低验证版本为 Bun `1.3.14`。默认 `ts/Dockerfile`、CI 主验证链与推荐 Docker 部署均在 Bun 下运行。

无需克隆仓库的一次性运行：

```bash
bunx --bun -p prts-mcp-ts prts-mcp-ts-bun
```

全局安装后运行：

```bash
bun add -g prts-mcp-ts
prts-mcp-ts-bun
```

本地开发验证：

```bash
cd ts
bun install --frozen-lockfile
bun run build:bun
bun run smoke:bun          # 使用临时 fixture 数据启动 Bun server 并跑 HTTP MCP smoke
bun run smoke:bun:package  # npm pack 后用 Bun 安装并验证 prts-mcp-ts-bun
bun run start              # 运行 dist/server-bun.js（自 2.2.0 起 npm start 默认走 Bun）
```

TypeScript 单元测试仍由 Node 的 `node:test` 路径覆盖（见下方 Node legacy 路径）；Bun 路径使用 `bun run typecheck`、`bun run build:bun`、源码级 HTTP MCP smoke 和安装后 package smoke 验证运行时兼容性。如调整 `package.json` 或 `package-lock.json` 依赖，请同步运行 `bun install --lockfile-only` 刷新 `bun.lock`。

### Node legacy 运行路径

Node.js 仍是受支持的运行时，但自 2.2.0 起降级为 legacy/可选路径。npm bin `prts-mcp-ts` 保持 Node 入口（`npx prts-mcp-ts` 仍零额外运行时依赖）。

```bash
# npm 入口（Node）
npx prts-mcp-ts
# 或本地编译后运行
npm run start:node    # node dist/server.js
npm run smoke:http:fixture:node
```

legacy Node Docker 镜像：

```bash
docker build -f ts/Dockerfile.node -t prts-mcp-ts-node .
docker run -d -p 3000:3000 -v prts-mcp-ts-data:/data/gamedata -v prts-mcp-ts-levels:/data/gamedata-levels -v prts-mcp-ts-storyjson:/data/storyjson prts-mcp-ts-node
```

---

## 数据机制

服务器开始监听后会立即在后台同步三类数据，此后默认每小时检查一次新 Release，无需重启进程：

- **游戏表格数据**（`/data/gamedata` volume）：从 [3aKHP/arknights-data-pipeline](https://github.com/3aKHP/arknights-data-pipeline) Release 下载 `zh_CN-excel.zip`
- **关卡战斗数据**（`/data/gamedata-levels` volume）：从同一 Release 下载 `zh_CN-levels.zip`，用于关卡实际出怪和关卡级敌人数值
- **剧情数据**（`/data/storyjson` volume）：从同一 Release 下载 `zh_CN.zip`（含剧情 JSON 和 LLM 摘要）

立绘图片默认走 PRTS MediaWiki 按需获取（零下载）。设置 `LOCAL_IMAGE=true` 时额外同步 AKDP 本地 PNG 资产到 `/data/images`（~1.5 GB）；环境变量详见 [环境变量参考](../docs/user/environment-variables.md)。

镜像内置 bundled 数据作为网络不可用时的离线保底。

自建数据工厂的新 Release 附带 manifest（`prts-mcp-data/v1`、源 versionId、包大小和 SHA-256）；TypeScript 实现会在原子激活前校验它。没有 manifest 的历史 Release 仍兼容读取。

周期可通过 `PRTS_AUTO_SYNC_INTERVAL_SECONDS` 调整（`60..604800` 秒）；设为 `0` 时只执行启动同步。

> 正式发布到 npm 的包会由 CI 预置 bundled 数据；本地 `npm pack` 或手动发布前需先运行下方预置步骤，否则包内只会包含空目录占位。

---

## 环境变量

常用项快表；完整清单与语义以 [docs/user/environment-variables.md](../docs/user/environment-variables.md) 为单一来源。

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | HTTP 模式监听端口与地址 |
| `GAMEDATA_PATH` | 未设置 | 指向自定义游戏数据目录，**GameData excel/levels auto-sync 被禁用** |
| `STORYJSON_PATH` | 未设置 | 指向本地 `zh_CN.zip`，**剧情 auto-sync 被禁用** |
| `GITHUB_TOKEN` / `GITHUB_MIRRORS` | 空 | GitHub API 限额 / 代理前缀列表 |
| `PRTS_AUTO_SYNC_INTERVAL_SECONDS` | `3600` | Release 周期检查间隔（秒）；`0` 表示只执行启动同步 |
| `PRTS_OUTPUT_CHANNEL` | `content` | 2.0 输出通道；也可经查询字符串 `?output_channel=` 或请求头 `x-prts-output-channel` 覆盖 |
| `PRTS_DEBUG_TOKEN` | 未设置 | `/debug/cache` 和 `/debug/metrics` 的必需 Bearer token；未设置或不匹配时返回 404。不要公开反代这两个路径 |
| `PRTS_METRICS_ENABLED` | `false` | 设为严格的 `true` 才启用 `/debug/metrics`（仅 TS）；仍需有效 token |
| `SESSION_IDLE_TIMEOUT_MS` | `86400000` | HTTP 会话空闲超时（毫秒，仅 TS）；非正数禁用 |

需要验证重复负载与并发会话时，只能在隔离的本机实例上执行 `PRTS_BENCH_ISOLATED=true PRTS_BENCH_ORIGIN=http://127.0.0.1:<port> PRTS_DEBUG_TOKEN=... npm run bench:memory`。脚本要求指标端点、有效诊断 token 和可读剧情/本地图片数据均已启用：它会先发现一个活动、章节和阿米娅立绘，然后以 **6 个并发会话** 执行档案、基础资料、数据搜索、剧情搜索、单章、活动分页和实际图片 get。除重复负载不能新增 cache miss 外，它还要求并发后至少 7 个会话仍在、请求已静止、RSS 不超过 1 GiB、相对冷缓存增长不超过 256 MiB（可用 `PRTS_BENCH_MAX_RSS_BYTES` / `PRTS_BENCH_MAX_RSS_GROWTH_BYTES` 调整）。它拒绝非 loopback 目标，不得在生产正式服务执行。

---

## 预置 bundled 数据（本地构建推荐）

```bash
uv sync --directory python --locked
uv run --directory python --locked python scripts/fetch_gamedata.py --output ../ts/data/gamedata
mkdir -p ts/data/storyjson
gh release download --repo 3aKHP/arknights-data-pipeline --pattern "zh_CN.zip" --dir ts/data/storyjson/ --clobber
docker build -f ts/Dockerfile -t prts-mcp-ts .
```
