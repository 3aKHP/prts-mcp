# PRTS MCP Server — TypeScript 实现

明日方舟同人创作辅助 MCP Server，TypeScript 版本。通过 **Streamable HTTP 传输**（单端点 `/mcp`）对外提供服务，适合部署在个人服务器或云环境，供他人通过 HTTP 接入。

提供 23 个 MCP 工具（2.0）：PRTS 词条检索与页面结构、干员档案/语音/基础信息、剧情活动与台词、角色出场追踪、全文搜索、敌人图鉴、关卡查询、关卡敌人融合，以及物品/材料查询。完整清单见仓库根目录 [`README.md`](../README.md)。

TypeScript 实现正式支持 Node.js 与 Bun 双运行时。默认 `prts-mcp-ts`、`npx`、
npm 全局安装、systemd 部署、默认 Dockerfile 与 npm Trusted Publishing 仍走
Node.js；Bun 作为显式可选运行时提供 `prts-mcp-ts-bun` 入口和
`ts/Dockerfile.bun` 构建路径。

> **2.0 变更**：工具面由 1.x 的 32 个合并为 23 个（详见 [1.x → 2.0 迁移指南](../docs/migration-1.x-to-2.0.md)）；新增可选的 output channel（查询字符串 `?output_channel=` / 请求头 `x-prts-output-channel` / `PRTS_OUTPUT_CHANNEL` 环境变量，默认 `content`，与 1.x 行为一致）。

---

## 快速开始（Docker）

```bash
# 从仓库根目录构建（可选预置 bundled 数据，详见下方）
docker build -f ts/Dockerfile -t prts-mcp-ts .

# 运行（named volume 持久化游戏数据，推荐）
docker run -d -p 3000:3000 -v prts-mcp-ts-data:/data/gamedata -v prts-mcp-ts-levels:/data/gamedata-levels -v prts-mcp-ts-storyjson:/data/storyjson prts-mcp-ts
```

服务启动后 MCP 端点为 `http://<host>:3000/mcp`，健康检查端点为 `http://<host>:3000/health`。

### 接入 MCP 客户端

在客户端配置中选择 **Streamable HTTP** 传输类型，端点填写：

```
http://localhost:3000/mcp
```

---

## 快速试用（npx）

无需克隆仓库，直接运行：

```bash
npx prts-mcp-ts
```

服务启动后 MCP 端点为 `http://localhost:3000/mcp`。

## 本地开发

```bash
cd ts
npm install
npm run dev       # tsx 直接运行，支持热重载
npm run build     # 编译到 dist/
npm start         # 运行编译后的版本
```

### 可选 Bun 运行路径

Bun 是 TypeScript 实现的受支持可选运行时，最低验证版本为 Bun `1.3.14`。
默认开发、npm 全局安装、`npx prts-mcp-ts`、systemd 部署和 npm Trusted Publishing
仍然走 Node/npm；需要 Bun 时请显式调用 Bun 入口。

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
bun run smoke:bun    # 使用临时 fixture 数据启动 Bun server 并跑 HTTP MCP smoke
bun run smoke:bun:package  # npm pack 后用 Bun 安装并验证 prts-mcp-ts-bun
bun run start:bun    # 运行 dist/server-bun.js
```

现阶段 TypeScript 单元测试仍由 Node 的 `node:test` 路径覆盖；Bun 路径使用
`bun run typecheck`、`bun run build:bun`、源码级 HTTP MCP smoke 和安装后 package smoke
验证运行时兼容性。
如调整 `package.json` 或 `package-lock.json` 依赖，请同步运行 `bun install --lockfile-only`
刷新 `bun.lock`。

受支持的 Bun Docker 替代镜像可从仓库根目录构建：

```bash
docker build -f ts/Dockerfile.bun -t prts-mcp-ts-bun .
docker run -d -p 3000:3000 -v prts-mcp-ts-data:/data/gamedata -v prts-mcp-ts-levels:/data/gamedata-levels -v prts-mcp-ts-storyjson:/data/storyjson prts-mcp-ts-bun
```

`ts/Dockerfile.bun` 不替换默认的 `ts/Dockerfile`；是否切换默认 Docker/runtime
路径会在后续兼容性窗口单独决定。

---

## 数据机制

服务器开始监听后会在后台自动同步三类数据：

- **游戏表格数据**（`/data/gamedata` volume）：从 [3aKHP/ArknightsGameData](https://github.com/3aKHP/ArknightsGameData) Release 下载 `zh_CN-excel.zip`，其内容同步自 [Kengxxiao/ArknightsGameData](https://github.com/Kengxxiao/ArknightsGameData)
- **关卡战斗数据**（`/data/gamedata-levels` volume）：从同一 Release 下载 `zh_CN-levels.zip`，用于关卡实际出怪和关卡级敌人数值
- **剧情数据**（`/data/storyjson` volume）：从 [ArknightsStoryJson](https://github.com/3aKHP/ArknightsStoryJson) Releases 下载 `zh_CN.zip`

镜像内置 bundled 数据作为网络不可用时的离线保底。

> 正式发布到 npm 的包会由 CI 预置 bundled 数据；本地 `npm pack` 或手动发布前需先运行下方预置步骤，否则包内只会包含空目录占位。

---

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `GAMEDATA_PATH` | 未设置 | 设置后指向自定义游戏数据目录，**GameData excel/levels auto-sync 被禁用**；若该路径是完整 ArknightsGameData 仓库根目录，`zh_CN/gamedata/levels` 会直接用于关卡战斗数据 |
| `STORYJSON_PATH` | 未设置 | 设置后指向本地 `zh_CN.zip`，**剧情 auto-sync 被禁用** |
| `GITHUB_TOKEN` | 空 | 用于提高 GitHub API 限额，降低限流风险 |
| `GITHUB_MIRRORS` | 空 | 逗号分隔的 ghproxy 风格代理前缀列表（如 `https://ghproxy.net`），依次在直连失败后尝试 |
| `PRTS_OUTPUT_CHANNEL` | `content` | 2.0 输出通道：`content`（默认，仅 markdown，与 1.x 一致）/ `structured`（仅 structuredContent）/ `both`。也可经查询字符串 `?output_channel=` 或请求头 `x-prts-output-channel` 按请求覆盖。仅在客户端确认支持 `structuredContent` 时才用非默认值 |

---

## 预置 bundled 数据（本地构建推荐）

```bash
pip install -e python/
python python/scripts/fetch_gamedata.py --output ts/data/gamedata
mkdir -p ts/data/storyjson
gh release download --repo 3aKHP/ArknightsStoryJson --pattern "zh_CN.zip" --dir ts/data/storyjson/ --clobber
docker build -f ts/Dockerfile -t prts-mcp-ts .
```
