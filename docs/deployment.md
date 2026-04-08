# PRTS MCP Server — Docker 部署指南

> 当前版本默认通过 GitHub 自动同步干员工具所需的最小数据集，不提交真实游戏数据到仓库。你也可以显式挂载自己的本地数据目录来覆盖默认行为。

## 前置条件

- [Docker](https://docs.docker.com/get-docker/) 已安装并正常运行
- （可选）如果你希望覆盖默认 auto-sync 行为，可准备自己的 [ArknightsGameData](https://github.com/Kengxxiao/ArknightsGameData) 目录
- （推荐）如运行环境可能命中 GitHub 匿名限流，可提供 `GITHUB_TOKEN`

> 如果不挂载本地数据，`search_prts` 和 `read_prts_page` 仍可正常使用；干员工具会尝试在启动时自动同步最小数据集。

---

## 1. 构建镜像

```bash
cd /path/to/PRTS-MCP
docker build -t prts-mcp .
```

## 2. 运行容器

### 仅使用 PRTS Wiki 在线查询（无需本地数据）

```bash
docker run -i --rm prts-mcp
```

如果你希望降低 GitHub 匿名 API 限流风险，可追加：

```bash
docker run -i --rm -e GITHUB_TOKEN=ghp_xxx prts-mcp
```

### 挂载本地数据（显式覆盖默认 auto-sync）

将宿主机上的 ArknightsGameData 目录挂载到容器内 `/data/gamedata`：

**Windows (PowerShell)**

```powershell
docker run -i --rm `
  -v "F:\path\to\ArknightsGameData:/data/gamedata:ro" `
  -v "F:\path\to\ArknightsStoryJson:/data/storyjson:ro" `
  prts-mcp
```

**Linux / macOS**

```bash
docker run -i --rm \
  -v /path/to/ArknightsGameData:/data/gamedata:ro \
  -v /path/to/ArknightsStoryJson:/data/storyjson:ro \
  prts-mcp
```

> `:ro` 表示只读挂载，容器不会修改你的本地数据。

这是“自管数据目录”的运行方式，适合你已经有完整数据仓库且希望完全绕过自动同步逻辑的场景。

### 自定义挂载路径

如果挂载点不是默认的 `/data/gamedata`，通过环境变量覆盖：

```bash
docker run -i --rm \
  -v /my/data:/mnt/ak:ro \
  -e GAMEDATA_PATH=/mnt/ak \
  prts-mcp
```

---

## 3. 接入 MCP 客户端

> **重要**: 请使用 `docker run` 而非 `docker compose run`。后者会向输出流写入容器创建进度信息，污染 JSON-RPC stdio 通道，导致客户端报错 `Connection closed`。

以下示例分两类：

- 默认 auto-sync：不写本地挂载，只运行镜像
- 本地目录覆盖：通过 `-v` 明确挂载你自己的数据路径

### Claude Desktop

编辑 `%APPDATA%\Claude\claude_desktop_config.json`：

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

### Claude Code

可先复制仓库内的 `.mcp.example.json` 为 `.mcp.json`，再按需选择“默认 auto-sync”或“本地路径覆盖”配置。`.mcp.json` 建议保持未跟踪状态，因为它通常包含本机路径或本机 token：

```json
{
  "mcpServers": {
    "prts_wiki": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-v", "F:\\path\\to\\ArknightsGameData:/data/gamedata:ro",
        "-v", "F:\\path\\to\\ArknightsStoryJson:/data/storyjson:ro",
        "prts-mcp"
      ]
    }
  }
}
```

### Roo-Cline (VSCode)

编辑 `%APPDATA%\Code\User\globalStorage\rooveterinaryinc.roo-cline\settings\mcp_settings.json`，在 `mcpServers` 中添加：

```json
"prts_wiki": {
    "command": "docker",
    "args": [
        "run", "-i", "--rm",
        "-v", "F:\\path\\to\\ArknightsGameData:/data/gamedata:ro",
        "-v", "F:\\path\\to\\ArknightsStoryJson:/data/storyjson:ro",
        "prts-mcp"
    ],
    "alwaysAllow": [
        "search_prts",
        "read_prts_page",
        "get_operator_archives",
        "get_operator_voicelines"
    ]
}
```

### OpenAI Codex CLI

编辑 `~/.codex/config.toml`，添加：

```toml
[mcp_servers.prts_wiki]
type = "stdio"
command = "docker"
args = ["run", "-i", "--rm", "-v", "F:\\path\\to\\ArknightsGameData:/data/gamedata:ro", "-v", "F:\\path\\to\\ArknightsStoryJson:/data/storyjson:ro", "prts-mcp"]
```

### 其他 MCP 客户端

任何支持 stdio 传输的 MCP 客户端均可接入。最简命令是：

```bash
docker run -i --rm prts-mcp
```

如果要显式挂载本地数据目录，再使用：

```bash
docker run -i --rm \
  -v /path/to/ArknightsGameData:/data/gamedata:ro \
  -v /path/to/ArknightsStoryJson:/data/storyjson:ro \
  prts-mcp
```

## 预热最小数据集

如果你希望在镜像构建前先把最小数据集拉到工作区，可以执行：

```bash
pip install -e .
python scripts/fetch_gamedata.py
```

默认会写入当前项目的 `data/gamedata/`；在非 editable 安装场景下，则会写入平台用户数据目录。

- 这更适合 CI、镜像构建前预热或离线环境准备。
- 如遇 GitHub 匿名限流，建议提供 `GITHUB_TOKEN`。
- 不建议把同步下来的真实数据文件直接提交到公开 Git 仓库。

兼容脚本 `scripts/package_operator_data.py` 仍保留，但已是 deprecated 入口，不再推荐作为主流程。

---

## 4. 验证

启动后可通过 MCP Inspector 测试：

```bash
npx @modelcontextprotocol/inspector docker run -i --rm prts-mcp
```

预期能看到 4 个 Tool：

| Tool | 测试参数 | 依赖 |
|------|---------|------|
| `search_prts` | `query`: `莱茵生命` | 网络 |
| `read_prts_page` | `page_title`: `阿米娅` | 网络 |
| `get_operator_archives` | `operator_name`: `阿米娅` | 本地数据 |
| `get_operator_voicelines` | `operator_name`: `阿米娅` | 本地数据 |

---

## 5. 开发者指南

### 开发环境构建（不使用缓存）

```bash
docker build --no-cache -t prts-mcp .
```

### 挂载源码实现热重载

开发阶段可将 `src/` 挂载进容器，修改代码后重启容器即生效：

```bash
docker run -i --rm \
  -v ./src:/app/src:ro \
  prts-mcp
```

如果你还想同时强制使用宿主机数据目录，再额外挂载 `data/gamedata`。

### 查看容器日志

MCP Server 通过 stdio 通信，诊断信息输出到 stderr：

```bash
docker run -i --rm prts-mcp 2>debug.log
```

### 镜像瘦身参考

当前基于 `python:3.11-slim`，镜像约 200MB。如需进一步压缩可考虑多阶段构建。

---

## 环境变量参考

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `GAMEDATA_PATH` | 平台默认数据目录或显式挂载路径 | 覆盖默认 auto-sync 数据目录 |
| `STORYJSON_PATH` | 平台默认数据目录或显式挂载路径 | 为未来扩展保留 |
| `GITHUB_TOKEN` | 空 | 用于提高 GitHub API 限额，降低冷启动/CI 限流风险 |
| `PRTS_MCP_ROOT` | `/app`（Docker 内） | 指定项目根目录，便于镜像内定位 `data/` |
