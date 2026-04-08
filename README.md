# PRTS MCP Server

明日方舟同人创作辅助 MCP Server。通过 [PRTS Wiki](https://prts.wiki) API 和本地 [ArknightsGameData](https://github.com/Kengxxiao/ArknightsGameData) 仓库，为 AI Agent 提供泰拉世界观检索与干员资料查询能力。

## 仓库边界

本仓库的公开版本默认只包含代码、文档和空的 `data/` 占位目录，不附带任何打包后的游戏数据。

- 公开仓库 / 可发行源码版：通过环境变量、`local_repo.jsonc` 或 Docker 挂载接入你自己的本地数据。
- 本地自用 / 私有部署版：你可以在本机执行 `scripts/package_operator_data.py` 打包最小数据集，用于私有镜像或私有目录部署，但当前版本不建议将这些数据文件直接提交到公开 Git 仓库。

仓库内提供的是示例文件：`local_repo.example.jsonc`、`.mcp.example.json`、`docker-compose.override.example.yml`。实际本机配置请复制为被 `.gitignore` 忽略的本地文件后再填写真实路径。

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

# 配置数据路径（三选一）
# 方式 1: 环境变量
export GAMEDATA_PATH=/path/to/ArknightsGameData
# 方式 2: 复制 local_repo.example.jsonc -> local_repo.jsonc
# 方式 3: 本地打包最小数据到 data/gamedata/（不建议直接提交到公开仓库）

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

镜像默认不内置游戏数据；完整功能请通过 `-v /path/to/ArknightsGameData:/data/gamedata:ro` 挂载宿主机数据。
如果需要私有部署版，可以先在本机把最小数据包写入 `data/gamedata/` 后再构建镜像，但不建议把这些数据文件直接提交到公开仓库。

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

如需在不挂载本地数据的情况下使用干员工具，可先打包最小数据集，详见 `docs/deployment.md`。

## 依赖

- Python >= 3.10
- [mcp](https://pypi.org/project/mcp/) (FastMCP)
- [httpx](https://www.python-httpx.org/)
- [pydantic](https://docs.pydantic.dev/)

## License

MIT

## Contributing

协作约定见 `CONTRIBUTING.md`。公开仓库默认以 `main` 作为默认分支，提交信息遵循 Conventional Commits。
