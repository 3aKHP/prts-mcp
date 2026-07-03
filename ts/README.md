# PRTS MCP Server — TypeScript 实现

明日方舟同人创作辅助 MCP Server，TypeScript 版本。通过 **Streamable HTTP 传输**（单端点 `/mcp`）对外提供服务，适合部署在个人服务器或云环境，供他人通过 HTTP 接入。

提供 23 个 MCP 工具（2.0）：PRTS 词条检索与页面结构、干员档案/语音/基础信息、剧情活动与台词、角色出场追踪、全文搜索、敌人图鉴、关卡查询、关卡敌人融合，以及物品/材料查询。完整清单见仓库根目录 [`README.md`](../README.md)。

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
