# PRTS MCP Server — TypeScript 实现

明日方舟同人创作辅助 MCP Server，TypeScript 版本。通过 **Streamable HTTP 传输**（单端点 `/mcp`）对外提供服务，适合部署在个人服务器或云环境，供他人通过 HTTP 接入。

提供工具集：`search_prts` / `read_prts_page` / `get_operator_archives` / `get_operator_voicelines`

---

## 快速开始（Docker）

```bash
# 从仓库根目录构建（需先预置数据，详见下方）
docker build -f ts/Dockerfile -t prts-mcp-ts .

# 运行（named volume 持久化游戏数据，推荐）
docker run -d -p 3000:3000 -v prts-mcp-ts-data:/data/gamedata prts-mcp-ts
```

服务启动后 MCP 端点为 `http://<host>:3000/mcp`，健康检查端点为 `http://<host>:3000/health`。

### 接入 MCP 客户端

在客户端配置中选择 **Streamable HTTP** 传输类型，端点填写：

```
http://localhost:3000/mcp
```

---

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

服务器启动时自动从 [ArknightsGameData](https://github.com/Kengxxiao/ArknightsGameData) 同步干员数据，结果缓存至挂载的 volume（`/data/gamedata`）。镜像内置 bundled 数据作为网络不可用时的离线保底。

---

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `GAMEDATA_PATH` | 未设置 | 设置后指向自定义数据目录，**auto-sync 被禁用** |
| `GITHUB_TOKEN` | 空 | 用于提高 GitHub API 限额，降低限流风险 |

---

## 预置 bundled 数据（本地构建推荐）

```bash
pip install -e python/
python python/scripts/fetch_gamedata.py
docker build -f ts/Dockerfile -t prts-mcp-ts .
```
