# PRTS MCP Server

明日方舟同人创作辅助 MCP Server。通过 [PRTS Wiki](https://prts.wiki) API 和自动同步的干员数据，为 AI Agent 提供泰拉世界观检索与干员资料查询能力。

## Tools

| Tool | 说明 |
|------|------|
| `search_prts(query, limit)` | 关键词搜索 PRTS 维基词条 |
| `read_prts_page(page_title)` | 读取指定词条的纯文本内容 |
| `get_operator_archives(operator_name)` | 获取干员档案资料（中文名） |
| `get_operator_voicelines(operator_name)` | 获取干员语音记录（中文名） |

## 快速开始

### Docker（推荐）

```bash
docker build -t prts-mcp .
docker run -i --rm -v prts-mcp-data:/data/gamedata prts-mcp
```

首次运行时自动从 GitHub 同步干员数据到 volume，之后重启复用缓存，无需重新下载。

如需降低 GitHub 匿名 API 限流风险：

```bash
docker run -i --rm -v prts-mcp-data:/data/gamedata -e GITHUB_TOKEN=ghp_xxx prts-mcp
```

> 如需在构建阶段预置最新数据（作为离线保底），可先执行 `python scripts/fetch_gamedata.py` 再构建镜像。

### 本地运行

```bash
pip install -e .
prts-mcp
```

启动时自动同步干员数据到平台默认目录（Windows: `%LOCALAPPDATA%\prts-mcp\gamedata`，Linux/macOS: `~/.local/share/prts-mcp/gamedata`）。

如需使用自己的本地数据目录（禁用 auto-sync）：

```bash
export GAMEDATA_PATH=/path/to/ArknightsGameData
prts-mcp
```

### 接入 Claude Desktop

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

完整的接入示例（Claude Code、Roo-Cline、OpenAI Codex CLI 等）见 `docs/deployment.md`。

## 数据架构

服务运行时使用两个独立的数据路径：

- **`/data/gamedata`（volume）** — auto-sync 的写入目标，存储 commit hash 和下载的数据文件，挂载 volume 后跨容器重启持久化
- **`/app/data/gamedata`（bundled）** — 构建时预置在镜像内，作为只读离线保底；auto-sync 成功时优先使用 volume 数据

`GAMEDATA_PATH` 被显式设置为其他路径时，auto-sync 自动禁用，服务直接读取该路径下的数据。

## 数据源

- **PRTS Wiki API** (`https://prts.wiki/api.php`) — 世界观词条、阵营设定
- **ArknightsGameData** (`Kengxxiao/ArknightsGameData`) — 干员档案、语音记录、基础信息

## Ubuntu 部署建议

客户端和服务部署在同一台 Ubuntu 机器时，直接拉起即可，不需要暴露端口：

```bash
git clone <your-repo> /opt/prts-mcp
cd /opt/prts-mcp
python3 -m venv .venv && . .venv/bin/activate
pip install -e .
```

客户端配置直接指向仓库内脚本：

```toml
[mcp_servers.prts_wiki]
type = "stdio"
command = "/opt/prts-mcp/scripts/run_prts_mcp.sh"
```

## 依赖

- Python >= 3.10
- [mcp](https://pypi.org/project/mcp/) (FastMCP)
- [httpx](https://www.python-httpx.org/)
- [pydantic](https://docs.pydantic.dev/)

## License

MIT

## Contributing

协作约定见 `CONTRIBUTING.md`。公开仓库默认以 `main` 作为默认分支，提交信息遵循 Conventional Commits。
