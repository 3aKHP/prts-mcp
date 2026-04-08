# PRTS MCP Server — Docker 部署指南

> 服务器启动时会自动从 GitHub 同步干员数据到挂载的 volume（或容器内部），无需手动下载或配置数据文件。镜像内置了构建时预置的 bundled 数据作为离线保底。

## 前置条件

- [Docker](https://docs.docker.com/get-docker/) 已安装并正常运行
- （推荐）如运行环境可能命中 GitHub 匿名限流，可提供 `GITHUB_TOKEN`

---

## 1. 构建镜像

```bash
cd /path/to/PRTS-MCP
docker build -t prts-mcp .
```

> 本地构建的镜像不含 bundled 数据（游戏数据文件已从 git 历史中排除）。首次运行时 auto-sync 会自动下载，需要网络连接。如需包含 bundled 数据，先运行 `python scripts/fetch_gamedata.py` 再构建。

---

## 2. 运行容器

### 推荐方式：挂载持久化 volume

将数据目录持久化到宿主机，重启容器后无需重新同步：

**使用 Docker named volume（最简单）**

```bash
docker run -i --rm -v prts-mcp-data:/data/gamedata prts-mcp
```

**使用宿主机目录（Windows PowerShell）**

```powershell
docker run -i --rm -v "$env:USERPROFILE\.prts-mcp\gamedata:/data/gamedata" prts-mcp
```

**使用宿主机目录（Linux / macOS）**

```bash
docker run -i --rm -v "$HOME/.local/share/prts-mcp/gamedata:/data/gamedata" prts-mcp
```

首次运行时 auto-sync 会将数据下载到 volume；此后每次启动在 TTL（1小时）内跳过网络检查，超出后做 commit hash 校验，有更新才重新下载。

> 如需降低 GitHub 匿名 API 限流风险，可追加 `-e GITHUB_TOKEN=ghp_xxx`。

### 无持久化方式（简单场景）

```bash
docker run -i --rm prts-mcp
```

数据写入容器内部，容器删除后丢失，下次启动重新同步。镜像内置 bundled 数据作为 sync 失败时的保底。

### 使用自定义数据目录（禁用 auto-sync）

如果你有自己管理的 ArknightsGameData 目录，可通过 `GAMEDATA_PATH` 指定，此时 **auto-sync 被完全禁用**：

**Windows (PowerShell)**

```powershell
docker run -i --rm `
  -v "F:\path\to\ArknightsGameData:/data/custom:ro" `
  -e GAMEDATA_PATH=/data/custom `
  prts-mcp
```

**Linux / macOS**

```bash
docker run -i --rm \
  -v /path/to/ArknightsGameData:/data/custom:ro \
  -e GAMEDATA_PATH=/data/custom \
  prts-mcp
```

> **注意**：`-v` 的本地路径应指向 ArknightsGameData 的**仓库根目录**（包含 `zh_CN/` 子目录的那一层），服务器会在其下查找 `zh_CN/gamedata/excel/*.json`。

---

## 3. 接入 MCP 客户端

> **重要**: 请使用 `docker run` 而非 `docker compose run`。后者会向输出流写入容器创建进度信息，污染 JSON-RPC stdio 通道，导致客户端报错 `Connection closed`。

### Claude Desktop

编辑 `%APPDATA%\Claude\claude_desktop_config.json`：

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

### Claude Code

可先复制仓库内的 `.mcp.example.json` 为 `.mcp.json`（`.mcp.json` 建议保持未跟踪状态）：

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

### Roo-Cline (VSCode)

编辑 `%APPDATA%\Code\User\globalStorage\rooveterinaryinc.roo-cline\settings\mcp_settings.json`，在 `mcpServers` 中添加：

```json
"prts_wiki": {
    "command": "docker",
    "args": ["run", "-i", "--rm", "-v", "prts-mcp-data:/data/gamedata", "prts-mcp"],
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
args = ["run", "-i", "--rm", "-v", "prts-mcp-data:/data/gamedata", "prts-mcp"]
```

### 其他 MCP 客户端

任何支持 stdio 传输的 MCP 客户端均可接入，最简命令：

```bash
docker run -i --rm -v prts-mcp-data:/data/gamedata prts-mcp
```

---

## 4. 验证

启动后可通过 MCP Inspector 测试：

```bash
npx @modelcontextprotocol/inspector docker run -i --rm -v prts-mcp-data:/data/gamedata prts-mcp
```

预期能看到 4 个 Tool：

| Tool | 测试参数 | 依赖 |
|------|---------|------|
| `search_prts` | `query`: `莱茵生命` | 网络 |
| `read_prts_page` | `page_title`: `阿米娅` | 网络 |
| `get_operator_archives` | `operator_name`: `阿米娅` | 数据（auto-sync 或 bundled） |
| `get_operator_voicelines` | `operator_name`: `阿米娅` | 数据（auto-sync 或 bundled） |

---

## 5. 开发者指南

### 预置 bundled 数据（本地构建推荐）

```bash
pip install -e .
python scripts/fetch_gamedata.py
docker build -t prts-mcp .
```

### 查看容器日志

MCP Server 通过 stdio 通信，诊断信息输出到 stderr：

```bash
docker run -i --rm -v prts-mcp-data:/data/gamedata prts-mcp 2>debug.log
```

### 强制重新同步

删除 volume 中的 `cache_meta.json` 即可触发下次启动时重新下载：

```bash
# named volume 场景
docker run --rm -v prts-mcp-data:/data/gamedata alpine rm /data/gamedata/cache_meta.json

# 宿主机目录场景（Windows）
Remove-Item "$env:USERPROFILE\.prts-mcp\gamedata\cache_meta.json"
```

---

## 环境变量参考

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `GAMEDATA_PATH` | 未设置（使用 `/data/gamedata`） | 设置后指向自定义数据目录，**auto-sync 被禁用** |
| `STORYJSON_PATH` | 未设置 | 为未来扩展保留 |
| `GITHUB_TOKEN` | 空 | 用于提高 GitHub API 限额，降低限流风险 |
| `PRTS_MCP_ROOT` | `/app`（Docker 内） | 标识 Docker 环境，供 config.py 选择正确的默认路径 |
