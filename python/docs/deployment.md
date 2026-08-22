# PRTS MCP Server — Docker 部署指南

> 服务器启动时会自动从 GitHub Release 同步游戏表格、关卡战斗和剧情数据到挂载的 volume（或容器内部），无需手动下载或配置数据文件。镜像内置了构建时预置的 bundled 数据作为离线保底。

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

正式发布的 Docker 镜像由 CI 在构建前预置 `data/gamedata`、`data/gamedata-levels` 与 `data/storyjson/zh_CN.zip`，可作为网络不可用时的兜底。PyPI wheel/sdist 不内置这些数据文件。

---

## 2. 运行容器

### 推荐方式：Docker named volume

```bash
docker run -i --rm -v prts-mcp-data:/data/gamedata -v prts-mcp-levels:/data/gamedata-levels -v prts-mcp-storyjson:/data/storyjson prts-mcp
```

Named volume 由 Docker 自动管理，无需关心宿主机路径，**在所有平台和所有 MCP 客户端配置里都能直接使用**。首次运行时 auto-sync 自动从 `3aKHP/arknights-data-pipeline` 下载 `zh_CN-excel.zip` 到 `/data/gamedata`、`zh_CN-levels.zip` 到 `/data/gamedata-levels`，以及剧情 `zh_CN.zip` 到 `/data/storyjson`；此后默认每小时检查一次 Release tag，有更新才重新下载、解压并清除进程内数据缓存，无需重启服务。

> 如需降低 GitHub 匿名 API 限流风险，可追加 `-e GITHUB_TOKEN=ghp_xxx`。

### Streamable HTTP 模式（作为 HTTP 服务部署）

以上方式均为默认的 stdio 传输（MCP 客户端直接拉起容器进程）。如需作为独立 HTTP 服务长期运行、供远程 MCP 客户端接入，设置 `PRTS_TRANSPORT=http` 并发布端口：

```bash
docker run -d --name prts-mcp \
  -p 3000:3000 \
  -v prts-mcp-data:/data/gamedata \
  -v prts-mcp-levels:/data/gamedata-levels \
  -v prts-mcp-storyjson:/data/storyjson \
  -e PRTS_TRANSPORT=http \
  prts-mcp
```

- HTTP 端点为 `http://<host>:3000/mcp`，探活端点为 `/health`；监听地址与端口可用 `HOST` / `PORT` 调整（默认 `0.0.0.0:3000`）。
- HTTP 模式不需要 `-i`（无 stdio 交互），用 `-d` 常驻；数据卷挂法与 stdio 模式完全一致。
- 非 Docker 运行同样适用：`PRTS_TRANSPORT=http prts-mcp`。
- 诊断端点 `/debug/cache` 需要 `PRTS_DEBUG_TOKEN` 的 Bearer 令牌，未设置时恒返回 404（等于默认关闭）；不要公开反代该路径。完整变量说明见[环境变量参考](../../docs/user/environment-variables.md)。

### 本地全量立绘模式（LOCAL_IMAGE=true）

默认的 MediaWiki 按需模式不需要 images 卷。如需使用 AKDP 本地全量立绘资产（~1.5 GB），追加 images 卷和相关环境变量：

```bash
docker run -i --rm \
  -v prts-mcp-data:/data/gamedata \
  -v prts-mcp-levels:/data/gamedata-levels \
  -v prts-mcp-storyjson:/data/storyjson \
  -v prts-mcp-images:/data/images \
  -e LOCAL_IMAGE=true \
  -e ORIGINAL_IMAGE=true \
  prts-mcp
```

> `--rm` 不会删除 named volume；`docker compose down -v` 会。`/data/images` 内必须整体保留（`.images_meta.json`、`.releases/<generation>/index.json` 和解压后的 PNG）；同步完成后 ZIP 分片会被删除，单独保留下载包不能被运行时复用。

### 使用宿主机目录（仅命令行直接运行，不适用于 MCP 客户端配置）

MCP 客户端（Chatbox、Claude Desktop 等）直接调用 Docker 进程，不经过 shell，因此环境变量（`$HOME`、`$env:USERPROFILE`）不会被展开。**如需绑定宿主机目录，必须写硬编码的绝对路径，且只能在命令行手动运行时使用。**

**Linux / macOS**

```bash
docker run -i --rm -v /home/yourname/.local/share/prts-mcp/gamedata:/data/gamedata -v /home/yourname/.local/share/prts-mcp/gamedata-levels:/data/gamedata-levels prts-mcp
```

**Windows (PowerShell)**

```powershell
docker run -i --rm -v "C:\Users\yourname\.prts-mcp\gamedata:/data/gamedata" -v "C:\Users\yourname\.prts-mcp\gamedata-levels:/data/gamedata-levels" prts-mcp
```

### 无持久化方式

```bash
docker run -i --rm prts-mcp
```

数据写入容器内部，容器删除后丢失，下次启动重新同步。镜像内置 bundled 数据作为 sync 失败时的保底。

### 使用自定义数据目录（禁用 auto-sync）

如果你有自己管理的 ArknightsGameData 目录，可通过 `GAMEDATA_PATH` 指定，此时 **auto-sync 被完全禁用**。同样只适合命令行直接运行，需填写硬编码绝对路径：

**Linux / macOS**

```bash
docker run -i --rm \
  -v /path/to/ArknightsGameData:/data/custom:ro \
  -e GAMEDATA_PATH=/data/custom \
  prts-mcp
```

**Windows (PowerShell)**

```powershell
docker run -i --rm `
  -v "C:\path\to\ArknightsGameData:/data/custom:ro" `
  -e GAMEDATA_PATH=/data/custom `
  prts-mcp
```

> **注意**：`-v` 的本地路径应指向 ArknightsGameData 的**仓库根目录**（包含 `zh_CN/` 子目录的那一层），服务器会在其下查找 `zh_CN/gamedata/excel/*.json`。如果该根目录也包含 `zh_CN/gamedata/levels`，关卡敌人融合工具会直接使用它；否则需要另行提供与 `GAMEDATA_PATH` 相邻的 `gamedata-levels` 数据目录。设置 `GAMEDATA_PATH` 后，GameData excel/levels auto-sync 都会禁用。

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
      "args": ["run", "-i", "--rm", "-v", "prts-mcp-data:/data/gamedata", "-v", "prts-mcp-levels:/data/gamedata-levels", "-v", "prts-mcp-storyjson:/data/storyjson", "prts-mcp"]
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
      "args": ["run", "-i", "--rm", "-v", "prts-mcp-data:/data/gamedata", "-v", "prts-mcp-levels:/data/gamedata-levels", "-v", "prts-mcp-storyjson:/data/storyjson", "prts-mcp"]
    }
  }
}
```

### Roo-Cline (VSCode)

编辑 `%APPDATA%\Code\User\globalStorage\rooveterinaryinc.roo-cline\settings\mcp_settings.json`，在 `mcpServers` 中添加：

```json
"prts_wiki": {
    "command": "docker",
    "args": ["run", "-i", "--rm", "-v", "prts-mcp-data:/data/gamedata", "-v", "prts-mcp-levels:/data/gamedata-levels", "-v", "prts-mcp-storyjson:/data/storyjson", "prts-mcp"],
    "alwaysAllow": [
        "search_prts",
        "prts_page",
        "get_operator_archives",
        "get_operator_voicelines",
        "get_operator_basic_info",
        "list_enemies",
        "get_enemy_info",
        "get_stage_enemies",
        "get_enemy_appearances",
        "list_stages",
        "get_stage_info",
        "list_items",
        "get_item_info",
        "list_story_events",
        "list_stories",
        "get_story_summary",
        "read_story",
        "read_activity",
        "search",
        "search_stories"
    ]
}
```

### OpenAI Codex CLI

编辑 `~/.codex/config.toml`，添加：

```toml
[mcp_servers.prts_wiki]
type = "stdio"
command = "docker"
args = ["run", "-i", "--rm", "-v", "prts-mcp-data:/data/gamedata", "-v", "prts-mcp-levels:/data/gamedata-levels", "-v", "prts-mcp-storyjson:/data/storyjson", "prts-mcp"]
```

### 其他 MCP 客户端

任何支持 stdio 传输的 MCP 客户端均可接入，最简命令：

```bash
docker run -i --rm -v prts-mcp-data:/data/gamedata -v prts-mcp-levels:/data/gamedata-levels -v prts-mcp-storyjson:/data/storyjson prts-mcp
```

---

## 4. 验证

启动后可通过 MCP Inspector 测试：

```bash
npx @modelcontextprotocol/inspector docker run -i --rm -v prts-mcp-data:/data/gamedata -v prts-mcp-levels:/data/gamedata-levels -v prts-mcp-storyjson:/data/storyjson prts-mcp
```

预期能看到 24 个 Tool（`IMAGES_ENABLED=false` 时 23 个），以下是按数据域挑选的 smoke 参数：

| Tool | 测试参数 | 依赖 |
|------|---------|------|
| `search_prts` | `query`: `莱茵生命` | 网络 |
| `prts_page` | `page_title`: `阿米娅`, `action`: `sections` | 网络 |
| `prts_page` | `page_title`: `阿米娅`, `action`: `read`, `section_index`: `1` | 网络 |
| `get_operator_archives` | `name`: `阿米娅` | 干员数据 |
| `get_operator_voicelines` | `name`: `阿米娅` | 干员数据 |
| `get_operator_basic_info` | `name`: `阿米娅` | 干员数据 |
| `list_enemies` | `threat_level`: `boss` | 干员数据 |
| `get_enemy_info` | `name`: `源石虫` | 干员数据 |
| `get_enemy_info` | `name`: `源石虫`, `stage_id`: `main_00-01` | 关卡战斗数据 |
| `get_stage_enemies` | `stage_id`: `main_00-01` | 关卡战斗数据 |
| `get_enemy_appearances` | `name`: `源石虫` | 关卡战斗数据 |
| `list_stages` | `type`: `MAIN` | 干员数据 |
| `get_stage_info` | `stage_id`: `main_00-01` | 干员数据 |
| `list_items` | `category`: `MATERIAL` | 干员数据 |
| `get_item_info` | `name`: `固源岩` | 干员数据 |
| `get_operator_memoirs` | `name`: `阿米娅` | 剧情数据 |
| `find_character_appearances` | `name`: `阿米娅`, `max_events`: `5` | 剧情数据 |
| `find_speakers_in` | `event_id`: `act31side` | 剧情数据 |
| `list_story_events` | `category`: `activities` | 剧情数据 |
| `list_stories` | `event_id`: `act31side`, `include_summaries`: `true` | 剧情数据 |
| `get_story_summary` | `story_key`: `activities/act31side/level_act31side_01_beg` | 剧情数据 |
| `read_story` | `story_key`: `activities/act31side/level_act31side_01_beg` | 剧情数据 |
| `read_activity` | `event_id`: `act31side`, `page`: `1` | 剧情数据 |
| `search` | `scope`: `operators`, `pattern`: `阿米娅` | 干员数据 |
| `search_stories` | `pattern`: `博士`, `event_id`: `act31side` | 剧情数据 |
| `operator_artwork` | `operator_name`: `阿米娅`, `action`: `list` | 网络 |

Streamable HTTP 模式下可先做一次不依赖 MCP 客户端的探活：

```bash
curl -s http://127.0.0.1:3000/health   # 期望返回 {"status":"ok"}
```

---

## 5. 开发者指南

### 预置 bundled 数据（本地构建推荐）

```bash
pip install -e .
python scripts/fetch_gamedata.py
mkdir -p ../data/storyjson
gh release download --repo 3aKHP/arknights-data-pipeline --pattern "zh_CN.zip" --dir ../data/storyjson/ --clobber
docker build -t prts-mcp .
```

### 查看容器日志

MCP Server 通过 stdio 通信，诊断信息输出到 stderr：

```bash
docker run -i --rm -v prts-mcp-data:/data/gamedata -v prts-mcp-levels:/data/gamedata-levels -v prts-mcp-storyjson:/data/storyjson prts-mcp 2>debug.log
```

### 强制重新同步

删除 volume 中的 `archives/release_meta.json` 即可触发下一轮检查时重新下载。只需重新解压当前归档时，可删除同目录的 `extract_meta.json`：

```bash
# named volume 场景
docker run --rm -v prts-mcp-data:/data/gamedata alpine rm /data/gamedata/archives/release_meta.json
docker run --rm -v prts-mcp-levels:/data/gamedata-levels alpine rm /data/gamedata-levels/archives/release_meta.json
# 仅重新解压当前归档
docker run --rm -v prts-mcp-data:/data/gamedata alpine rm /data/gamedata/archives/extract_meta.json
docker run --rm -v prts-mcp-levels:/data/gamedata-levels alpine rm /data/gamedata-levels/archives/extract_meta.json

# 宿主机目录场景（Windows）
Remove-Item "$env:LOCALAPPDATA\prts-mcp\gamedata\archives\release_meta.json"
Remove-Item "$env:LOCALAPPDATA\prts-mcp\gamedata-levels\archives\release_meta.json"
Remove-Item "$env:LOCALAPPDATA\prts-mcp\gamedata\archives\extract_meta.json"
Remove-Item "$env:LOCALAPPDATA\prts-mcp\gamedata-levels\archives\extract_meta.json"
```

---

## 环境变量参考

完整清单与语义以 [docs/user/environment-variables.md](../../docs/user/environment-variables.md) 为单一来源（双实现共用）。Docker 部署最常用：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `GAMEDATA_PATH` | 未设置 | 自有 gamedata 目录；**设置后 GameData excel/levels auto-sync 被禁用** |
| `STORYJSON_PATH` | 未设置 | 本地剧情 `zh_CN.zip`；**设置后剧情 auto-sync 被禁用** |
| `PRTS_TRANSPORT` | `stdio` | `http` = Streamable HTTP 模式（见上方「Streamable HTTP 模式」） |
| `HOST` / `PORT` | `0.0.0.0` / `3000` | HTTP 模式监听地址与端口 |
| `GITHUB_TOKEN` | 空 | 提高 GitHub API 限额，降低限流风险 |
| `GITHUB_MIRRORS` | 空 | 代理前缀列表，直连失败后依次尝试 |
| `PRTS_AUTO_SYNC_INTERVAL_SECONDS` | `3600` | Release 周期检查间隔（秒）；`0` 表示只执行启动同步 |
| `IMAGES_ENABLED` | `true` | `false` 隐藏 `operator_artwork` |
| `LOCAL_IMAGE` | `false` | `true` = 同步 AKDP 本地立绘资产（~1.5 GB，需 images 卷） |
| `ORIGINAL_IMAGE` | `false` | 额外同步原图分辨率分片（~3 GB）；仅 `LOCAL_IMAGE=true` 时生效 |
