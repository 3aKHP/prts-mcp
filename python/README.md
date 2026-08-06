# PRTS MCP Server — Python 实现

明日方舟同人创作辅助 MCP Server，Python 版本。支持 **stdio** 与
**Streamable HTTP**，可接入本地 MCP 客户端或作为 HTTP 服务部署。

提供 23 个 MCP 工具（2.0）：PRTS 词条检索与页面结构、干员档案/语音/基础信息、剧情活动与台词、角色出场追踪、全文搜索、敌人图鉴、关卡查询、关卡敌人融合，以及物品/材料查询。完整清单见仓库根目录 [`README.md`](../README.md)。

> **2.0 变更**：工具面由 1.x 的 32 个合并为 23 个（详见 [1.x → 2.0 迁移指南](../docs/migration-1.x-to-2.0.md)）；新增可选的 output channel（`PRTS_OUTPUT_CHANNEL` 环境变量，默认 `content`，与 1.x 行为一致）。

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

## 不使用 Docker

仓库开发推荐使用 uv：

```bash
uv sync --directory python --locked

# GAMEDATA_PATH 设置后会禁用 auto-sync
GAMEDATA_PATH=/path/to/ArknightsGameData uv run --directory python --locked prts-mcp
```

安装正式发布包时仍支持 pip：

```bash
pip install prts-mcp

GAMEDATA_PATH=/path/to/ArknightsGameData prts-mcp
```

---

## 数据机制

服务器启动时会立即在后台同步三类数据，此后默认每小时检查一次新 Release，无需重启进程：

- **游戏表格数据**（`gamedata` volume）：从 [3aKHP/arknights-data-pipeline](https://github.com/3aKHP/arknights-data-pipeline) Release 下载 `zh_CN-excel.zip` 和 `zh_CN-levels.zip`
- **关卡战斗数据**（`gamedata-levels` volume）：从同一 Release 下载 `zh_CN-levels.zip`，用于关卡实际出怪和关卡级敌人数值
- **剧情数据**（`storyjson` volume）：从同一 Release 下载 `zh_CN.zip`（含剧情 JSON 和 LLM 摘要）

镜像内置 bundled 数据作为网络不可用时的离线保底。

自建数据工厂的新 Release 附带 manifest（`prts-mcp-data/v1`、源 versionId、包大小和
SHA-256）；Python 实现会在原子激活前校验它。没有 manifest 的历史 Release 仍兼容读取。

周期可通过 `PRTS_AUTO_SYNC_INTERVAL_SECONDS` 调整（`60..604800` 秒）；设为 `0` 时只执行启动同步。

> PyPI 包本身不内置 bundled 数据；直接 `pip install prts-mcp` 时会在启动时自动同步，或使用 `GAMEDATA_PATH` / `STORYJSON_PATH` 指向你自己的本地数据。若 `GAMEDATA_PATH` 指向完整 ArknightsGameData 仓库根目录，内含的 `zh_CN/gamedata/levels` 会直接用于关卡战斗数据；否则默认在其相邻目录维护 `gamedata-levels`。正式 Docker 镜像会由 CI 预置兜底数据。

---

## 详细文档

→ [docs/deployment.md](docs/deployment.md)：完整部署方式、MCP 客户端配置、环境变量参考
