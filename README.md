# PRTS MCP Server

明日方舟同人创作辅助 MCP Server。通过 [PRTS Wiki](https://prts.wiki) API 和本地 [ArknightsGameData](https://github.com/Kengxxiao/ArknightsGameData) 仓库，为 AI Agent 提供泰拉世界观检索与干员资料查询能力。

## Tools

| Tool | 说明 |
|------|------|
| `search_prts(query, limit)` | 关键词搜索 PRTS 维基词条 |
| `read_prts_page(page_title)` | 读取指定词条的纯文本内容 |
| `get_operator_archives(operator_name)` | 获取干员档案资料（中文名） |
| `get_operator_voicelines(operator_name)` | 获取干员语音记录（中文名） |

## 快速开始

### 本地运行

```bash
# 安装
pip install -e .

# 配置数据路径（二选一）
# 方式 1: 环境变量
export GAMEDATA_PATH=/path/to/ArknightsGameData
# 方式 2: 项目根目录已有 local_repo.jsonc

# 启动
prts-mcp
# 或
python -m prts_mcp.server
```

### Docker

```bash
docker build -t prts-mcp .
docker run -i --rm prts-mcp
```

### 接入 Claude Desktop

```json
{
  "mcpServers": {
    "prts_wiki": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "prts-mcp"]
    }
  }
}
```

## 数据源

- **PRTS Wiki API** (`https://prts.wiki/api.php`) — 世界观词条、阵营设定
- **ArknightsGameData** (本地 JSON) — 干员档案、语音记录、基础信息

## 依赖

- Python >= 3.10
- [mcp](https://pypi.org/project/mcp/) (FastMCP)
- [httpx](https://www.python-httpx.org/)
- [pydantic](https://docs.pydantic.dev/)

## License

MIT
