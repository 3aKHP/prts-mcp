# PRTS MCP Server

明日方舟同人创作辅助 MCP Server。通过 [PRTS Wiki](https://prts.wiki) API 和 GitHub-backed 的干员数据同步能力，为 AI Agent 提供泰拉世界观检索与干员资料查询能力。

## 仓库边界

本仓库的公开版本默认只包含代码、文档和空的 `data/` 占位目录，不提交真实游戏数据。运行时优先使用 GitHub 自动同步所需的最小数据集；你也可以显式覆盖为自己的本地数据目录。

- 公开仓库 / 可发行源码版：默认走 GitHub-backed auto-sync，首次启动时拉取干员工具所需的最小数据集。
- 显式覆盖 / 自管数据版：通过环境变量或 Docker 挂载接入你自己的本地数据目录。
- 兼容脚本：`scripts/package_operator_data.py` 仍保留，但已是 deprecated 兼容入口，不再是推荐主流程。

仓库内提供的是示例文件：`.mcp.example.json`、`docker-compose.override.example.yml`。如果你需要本机路径覆盖，请复制为被 `.gitignore` 忽略的本地文件后再填写真实路径。

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

# 可选：为 GitHub API 提供 token，降低匿名限流风险
export GITHUB_TOKEN=ghp_xxx

# 可选：如果你想强制使用自己的本地数据目录，而不是 auto-sync
export GAMEDATA_PATH=/path/to/ArknightsGameData

# 启动
prts-mcp
# 或
python -m prts_mcp.server
```

默认情况下，服务会在启动时检查上游版本，并将干员工具所需的最小数据同步到默认数据目录。同步失败时，如果本地已有缓存，会回退到缓存继续运行。

### Docker

```bash
docker build -t prts-mcp .
docker run -i --rm prts-mcp
```

镜像默认会在运行时自动同步最小数据集；如果你想强制使用宿主机上的完整数据目录，也可以通过 `-v /path/to/ArknightsGameData:/data/gamedata:ro` 挂载覆盖。

如果需要在构建阶段预热最小数据集，可先执行：

```bash
python scripts/fetch_gamedata.py
docker build -t prts-mcp .
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
- **ArknightsGameData** (`Kengxxiao/ArknightsGameData`) — 干员档案、语音记录、基础信息；当前版本通过 GitHub 自动同步最小子集，或使用你显式指定的本地目录

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
type = “stdio”
command = “/opt/prts-mcp/scripts/run_prts_mcp.sh”
```

如需提前预热最小数据集，可执行 `python scripts/fetch_gamedata.py`；更完整的部署说明见 `docs/deployment.md`。

## 依赖

- Python >= 3.10
- [mcp](https://pypi.org/project/mcp/) (FastMCP)
- [httpx](https://www.python-httpx.org/)
- [pydantic](https://docs.pydantic.dev/)

## License

MIT

## Contributing

协作约定见 `CONTRIBUTING.md`。公开仓库默认以 `main` 作为默认分支，提交信息遵循 Conventional Commits。
