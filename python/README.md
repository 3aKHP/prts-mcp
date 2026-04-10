# PRTS MCP Server — Python 实现

明日方舟同人创作辅助 MCP Server，Python 版本。通过 **stdio 传输**接入 MCP 客户端（Claude Desktop、Claude Code、Chatbox 等），支持 Docker 部署。

提供工具集：`search_prts` / `read_prts_page` / `get_operator_archives` / `get_operator_voicelines`

---

## 快速开始（Docker）

```bash
# 从仓库根目录构建（需先预置数据，详见下方）
docker build -f python/Dockerfile -t prts-mcp .

# 运行（named volume 持久化游戏数据，推荐）
docker run -i --rm -v prts-mcp-data:/data/gamedata prts-mcp
```

### 接入 MCP 客户端

```json
{
  "mcpServers": {
    "prts_wiki": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "-v", "prts-mcp-data:/data/gamedata", "prts-mcp"]
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

服务器启动时自动从 [ArknightsGameData](https://github.com/Kengxxiao/ArknightsGameData) 同步干员数据，结果缓存至挂载的 volume。镜像内置 bundled 数据作为网络不可用时的离线保底。

---

## 详细文档

→ [docs/deployment.md](docs/deployment.md)：完整部署方式、MCP 客户端配置、环境变量参考
