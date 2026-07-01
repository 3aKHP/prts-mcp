# PRTS MCP Server — Python 实现

明日方舟同人创作辅助 MCP Server，Python 版本。通过 **stdio 传输**接入 MCP 客户端（Claude Desktop、Claude Code、Chatbox 等），支持 Docker 部署。

提供 32 个 MCP 工具：PRTS 词条检索与页面结构、干员档案/语音/基础信息、剧情活动与台词、角色出场追踪、全文搜索、敌人图鉴、关卡查询、关卡敌人融合，以及物品/材料查询。完整清单见仓库根目录 [`README.md`](../README.md)。

---

## 快速开始（Docker）

```bash
# 从仓库根目录构建（可选预置 bundled 数据，详见下方）
docker build -f python/Dockerfile -t prts-mcp .

# 运行（named volume 持久化游戏数据，推荐）
docker run -i --rm -v prts-mcp-data:/data/gamedata -v prts-mcp-levels:/data/gamedata-levels -v prts-mcp-storyjson:/data/storyjson prts-mcp
```

### 接入 MCP 客户端

```json
{
  "mcpServers": {
    "prts_wiki": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "-v", "prts-mcp-data:/data/gamedata", "-v", "prts-mcp-levels:/data/gamedata-levels", "-v", "prts-mcp-storyjson:/data/storyjson", "prts-mcp"]
    }
  }
}
```

> 请使用 `docker run` 而非 `docker compose run`。后者会向 stdio 流写入进度信息，污染 JSON-RPC 通道。

---

## 不使用 Docker（pip install）

```bash
pip install -e .

# 需指定游戏数据目录（GAMEDATA_PATH 设置后禁用 auto-sync）
GAMEDATA_PATH=/path/to/ArknightsGameData prts-mcp
```

---

## 数据机制

服务器启动时自动同步三类数据：

- **游戏表格数据**（`gamedata` volume）：从 [3aKHP/ArknightsGameData](https://github.com/3aKHP/ArknightsGameData) Release 下载 `zh_CN-excel.zip`，其内容同步自 [Kengxxiao/ArknightsGameData](https://github.com/Kengxxiao/ArknightsGameData)
- **关卡战斗数据**（`gamedata-levels` volume）：从同一 Release 下载 `zh_CN-levels.zip`，用于关卡实际出怪和关卡级敌人数值
- **剧情数据**（`storyjson` volume）：从 [ArknightsStoryJson](https://github.com/3aKHP/ArknightsStoryJson) Releases 下载 `zh_CN.zip`

镜像内置 bundled 数据作为网络不可用时的离线保底。

> PyPI 包本身不内置 bundled 数据；直接 `pip install prts-mcp` 时会在启动时自动同步，或使用 `GAMEDATA_PATH` / `STORYJSON_PATH` 指向你自己的本地数据。若 `GAMEDATA_PATH` 指向完整 ArknightsGameData 仓库根目录，内含的 `zh_CN/gamedata/levels` 会直接用于关卡战斗数据；否则默认在其相邻目录维护 `gamedata-levels`。正式 Docker 镜像会由 CI 预置兜底数据。

---

## 详细文档

→ [docs/deployment.md](docs/deployment.md)：完整部署方式、MCP 客户端配置、环境变量参考
