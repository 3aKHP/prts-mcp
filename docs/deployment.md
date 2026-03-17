# PRTS MCP Server — Docker 部署指南

## 前置条件

- [Docker](https://docs.docker.com/get-docker/) 已安装并正常运行
- （可选）本地已克隆 [ArknightsGameData](https://github.com/Kengxxiao/ArknightsGameData) 仓库，用于干员档案/语音查询

> 如果不挂载本地数据，`search_prts` 和 `read_prts_page` 两个在线工具仍可正常使用。

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

### 挂载本地数据（完整功能）

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

以下示例均假设数据已挂载，请将路径替换为你的实际路径。

### Claude Desktop

编辑 `%APPDATA%\Claude\claude_desktop_config.json`：

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

### Claude Code

在项目根目录创建 `.mcp.json`（建议加入 `.gitignore`，因为包含本机路径）：

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

任何支持 stdio 传输的 MCP 客户端均可接入，核心命令相同：

```bash
docker run -i --rm \
  -v /path/to/ArknightsGameData:/data/gamedata:ro \
  -v /path/to/ArknightsStoryJson:/data/storyjson:ro \
  prts-mcp
```

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
  -v /path/to/ArknightsGameData:/data/gamedata:ro \
  prts-mcp
```

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
| `GAMEDATA_PATH` | `/data/gamedata` | ArknightsGameData 仓库根目录 |
| `STORYJSON_PATH` | `/data/storyjson` | ArknightsStoryJson 仓库根目录 |
