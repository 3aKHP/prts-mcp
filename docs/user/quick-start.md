# 客户端接入与快速上手指南

本文面向在本地使用 Claude Desktop、Claude Code、Roo Code / Cline、Cursor、OpenAI Codex CLI、Chatbox 等 MCP 客户端的创作者与普通用户，介绍如何用最少配置接入 PRTS-MCP。

- **第一次接触 Agent 或 MCP？** 建议先花 3 分钟阅读[Agent 与 MCP 零基础入门指南](mcp-and-agent-basics.md)，了解工具调用原理、客户端选型与基本操作。
- 接入后如何高效组合使用 24 个工具，请参阅[工具使用与同人创作工作流指南](tools-guide.md)。
- 如果你需要在服务器、NAS 或 Docker 环境中长期托管独立 HTTP 服务、管理大体积本地立绘或配置代理镜像，请参阅运维文档：[服务端部署与容器运维指南](../admin/deployment.md)。

> **版本说明**：当前公开稳定版为 `2.8.1`，Rust 公开候选版为 `3.0.0-rc.3`。在 3.0.0 正式发布前，安装 3.x 候选版请显式指定 `@3.0.0-rc.3` 或 `@next`。

---

## 1. 选择接入方式

作为客户端用户，你只需从以下两种模式中任选一种：

| 接入模式 | 适用场景 | 推荐启动方式 |
| --- | --- | --- |
| **本地 `stdio` 模式（最省心）** | 在本机桌面客户端中使用，由客户端按需自动拉起并关闭服务，无需手动维护后台进程。 | **Docker 单行命令**、**`npx` 免安装**、**`npm` 全局安装**或**解压预编译归档包**。 |
| **连接 Streamable HTTP 服务** | 连接到本机或局域网/远端服务器已常驻运行的 HTTP 实例（如 `http://127.0.0.1:3000/mcp`），支持多客户端共享同一份数据缓存。 | 客户端直接填写 URL（服务端部署见[服务端部署指南](../admin/deployment.md)）。 |

### 本地运行前置条件

所有公开渠道的安装包均**内置了经过校验的只读备用游戏数据**，首次启动即可立即查询干员、关卡、物品与剧情（同时会在后台静默同步最新数据；PRTS Wiki 词条检索与在线立绘仍需联网）：

- **使用 Docker**：只需本机已安装 Docker，无需安装 Node.js、Python 或任何编译工具。
- **使用 npm / npx**：需本机已安装 `Node.js >= 22` 与 `npm >= 10`（自动拉起内置的预编译 Rust 二进制，无需安装 Bun 或编译器）。
- **使用预编译原生归档包**：从 [3.0.0-rc.3 Release](https://github.com/3aKHP/prts-mcp/releases/tag/v3.0.0-rc.3) 下载对应系统的压缩包（支持 Linux `x64`/`arm64` `glibc >= 2.28`、Windows `x64`、macOS `14.0+` `arm64`/`x64`），解压后即可直接运行（请完整保留解压目录内的 `bin/` 与 `data/` 结构）。

---

## 2. 主流 MCP 客户端配置

### Claude Desktop

打开 Claude Desktop 配置文件：
- **Windows**：`%APPDATA%\Claude\claude_desktop_config.json`
- **macOS**：`~/Library/Application Support/Claude/claude_desktop_config.json`

在 `mcpServers` 中选择以下任一配置写入并重启客户端：

#### 方案 A：使用 Docker（推荐，自动持久化数据卷）
```json
{
  "mcpServers": {
    "prts_wiki": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "-v", "prts-data:/data", "ghcr.io/3akhp/prts-mcp:3.0.0-rc.3"]
    }
  }
}
```
> 注意：`docker run` 必须带 `-i` 且**不要加 `-t`**，以保证标准输出流（`stdout`）只传输纯净的 MCP 协议消息。

#### 方案 B：使用 `npx`（需 `Node.js >= 22`）
```json
{
  "mcpServers": {
    "prts_wiki": {
      "command": "npx",
      "args": ["-y", "--package=prts-mcp-ts@3.0.0-rc.3", "prts-mcp-ts-stdio"]
    }
  }
}
```

#### 方案 C：使用预编译原生二进制（或全局安装的 `prts-mcp`）
```json
{
  "mcpServers": {
    "prts_wiki": {
      "command": "/absolute/path/to/bin/prts-mcp",
      "args": [],
      "env": {
        "PRTS_TRANSPORT": "stdio"
      }
    }
  }
}
```
> `prts-mcp` 主命令默认启动 HTTP，因此本地客户端以子进程拉起时必须在 `env` 中设置 `"PRTS_TRANSPORT": "stdio"`（Windows 请将 `command` 替换为 `D:/prts-mcp/bin/prts-mcp.exe` 等实际绝对路径）。

---

### Claude Code

可直接参考仓库根目录的 `.mcp.example.json` 在项目下创建 `.mcp.json`，或直接通过命令行添加（任选其一）：

```bash
# 方式 1：通过 npx 启动本地 stdio 进程
claude mcp add --transport stdio prts_wiki -- npx -y --package=prts-mcp-ts@3.0.0-rc.3 prts-mcp-ts-stdio

# 方式 2：通过 Docker 启动本地 stdio 进程
claude mcp add --transport stdio prts_wiki -- docker run -i --rm -v prts-data:/data ghcr.io/3akhp/prts-mcp:3.0.0-rc.3

# 方式 3：连接已启动的 Streamable HTTP 服务
claude mcp add --transport http prts_wiki http://127.0.0.1:3000/mcp
```

如需在团队项目中共享配置，可附加 `--scope project`。详见 [Claude Code MCP 官方文档](https://code.claude.com/docs/en/mcp)。

---

### Roo Code / Cline / Cursor 等编辑器扩展

- **本地 `stdio` 模式**：在扩展的 MCP 配置文件中直接沿用上文 Claude Desktop 的 `command` / `args` / `env` 配置。
- **连接 Streamable HTTP 服务**：
  ```json
  {
    "mcpServers": {
      "prts_wiki": {
        "type": "streamable-http",
        "url": "http://127.0.0.1:3000/mcp",
        "disabled": false
      }
    }
  }
  ```

---

### OpenAI Codex CLI

可通过命令行一键添加（stdio 与 HTTP 二选一）：

```bash
# 启动本地原生二进制（stdio 模式）
codex mcp add prts_wiki --env PRTS_TRANSPORT=stdio -- /absolute/path/to/bin/prts-mcp

# 或连接已启动的 HTTP 服务
codex mcp add prts_wiki --url http://127.0.0.1:3000/mcp
```

也可直接编辑 `~/.codex/config.toml`：

```toml
[mcp_servers.prts_wiki]
command = "/absolute/path/to/bin/prts-mcp"
args = []

[mcp_servers.prts_wiki.env]
PRTS_TRANSPORT = "stdio"
```

---

### Chatbox 及其他通用 MCP 客户端

- **HTTP 接入**：传输类型请选择 **Streamable HTTP**，端点地址填写 `http://127.0.0.1:3000/mcp`（请勿选择旧版独立 SSE 模式）。
- **stdio 接入**：填入上述 Docker、`npx` 或原生二进制的启动命令与环境变量。

---

## 3. 两代 MCP 协议无感自适应与客户端可选设置

### 3.1 新旧两代 MCP 协议：零配置无感自适应

MCP 生态目前并存两代协议通信方式：
- **传统有状态会话协议（Legacy，`2024-11-05` / `2025-03-26` / `2025-06-18`）**：客户端先发送 `initialize` 握手，在 HTTP 模式下获取并复用 `Mcp-Session-Id` 会话头；
- **现代无状态信封协议（Modern，`2026-07-28`）**：无需预先握手或维护会话 ID，每条请求直接在 `_meta` 中携带协议信封（`server/discover`、`tools/list`、`tools/call`）。

**你无需在服务端或客户端配置任何“协议版本切换开关”**：
- **自动识别**：无论是 `stdio` 还是 Streamable HTTP，PRTS-MCP 都会根据客户端发来的请求格式**自动识别并适配**对应的协议时代。
- **多客户端并发混连（HTTP 模式）**：同一个常驻 HTTP 服务端（`/mcp`）支持**多个不同协议世代、不同输出通道偏好的客户端同时连接**（例如 Claude Code、Chatbox 与自定义 Agent 同时接入同一实例，互不干扰）。
- **`stdio` 单进程锁定**：在 `stdio` 子进程模式下，连接建立后的第一条请求即决定该子进程的协议世代（如需在测试中切换协议模式，重启客户端子进程即可）。关于 `2026-07-28` 协议的更多背景可参阅 [2.5 → 2.6 迁移指南](../migration-2.5-to-2.6.md)。

### 3.2 客户端常用可选设置

绝大多数情况下保持默认配置即可。如有特殊需求，可在客户端配置的 `env`（或 HTTP 请求参数）中调整以下选项：

| 设置项 | 默认行为 | 何时调整 |
| --- | --- | --- |
| **隐藏立绘工具（`IMAGES_ENABLED`）** | `true`（加载全部 24 个工具） | 若你的客户端或模型不支持查看图片，或希望节省 1 个工具 Schema 上下文，可在 `env` 中设 `"IMAGES_ENABLED": "false"`（工具数变为 23 个）。 |
| **结构化输出通道（`PRTS_OUTPUT_CHANNEL`）** | `content`（返回高密度 Markdown 文本，最省 Prompt Token） | 若客户端专门消费 MCP 原生 `structuredContent` JSON，可设为 `structured` 或 `both`；HTTP 客户端也可直接在 URL 后追加 `?output_channel=structured` 或传请求头 `x-prts-output-channel`（不同客户端连接可各自独立指定）。 |

完整的服务端环境变量列表请参阅运维文档：[环境变量完整参考](../admin/environment-variables.md)。

---

## 4. 快速自检与常见问题

配置完成后，你可以在客户端中向 AI 提问进行测试：
- *“帮我用 PRTS 工具查一下阿米娅的精英二 40 级面板数值和二技能专三效果。”*
- *“帮我查一下活动 `act31side`（怀黍离）有哪些章节，并看看‘黍’在这个活动里说了多少句台词。”*

如果在接入或使用过程中遇到问题，请对照下表快速排查：

| 现象 | 原因与解决办法 |
| --- | --- |
| **HTTP 模式下提示 `MCP session lost`（错误码 `-32002`）** | 在传统有状态协议（Legacy）下，当远端 HTTP 服务容器重启、或连接连续空闲超过 **24 小时**被服务端自动清理后，客户端缓存的旧 `Mcp-Session-Id` 会失效。<br>**解决办法**：若客户端未自动重新发起 `initialize`，只需在客户端设置中**将该 MCP 连接开关关闭再重新打开**（或重启客户端应用），即可立即建立新会话。 |
| **客户端报错 `Connection closed` 或连接立即断开** | 1. 若使用 `prts-mcp` 原生二进制或新主包，请检查是否在 `env` 中配置了 `"PRTS_TRANSPORT": "stdio"`（未设置时它会按默认的 HTTP 模式启动）。<br>2. 若使用 Docker，请确认参数中有 `-i` 且没有加 `-t`。 |
| **Windows 下 `npx` 或 `npm` 命令无法启动** | 部分桌面客户端在 Windows 下直接拉起进程时不解析 `.ps1`，请将 `command` 改为 `"npx.cmd"`，或先执行 `npm.cmd install -g prts-mcp-ts@3.0.0-rc.3` 再将 `command` 设为 `"prts-mcp-ts-stdio.cmd"`。 |
| **提示缺少平台二进制包** | 执行 `npm install` 时请勿添加 `--omit=optional` 参数；重新执行正常安装即可拉取平台二进制。 |
| **干员/剧情能查到，但 `search_prts` 维基检索失败** | 干员与剧情拥有本地/内置备用数据，而 `search_prts` / `prts_page` 需要实时请求 `https://prts.wiki`，请检查本机网络或代理设置。 |

更深入的日志排查与服务端诊断见[监控诊断与故障排查手册](../admin/diagnostics-and-troubleshooting.md)。
