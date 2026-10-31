# 服务端部署与容器运维指南

本文面向在服务器、NAS、工作站或容器集群中部署与维护 PRTS-MCP 3.x 的系统管理员（Administrator / Operator），涵盖运行环境要求、Docker 容器化部署、原生二进制与 `systemd` 守护进程托管、安全加固以及跨版本升级回滚。

- 如果你只是想在个人电脑的 Claude Desktop / Claude Code 等客户端里接入本工具，请直接阅读用户指南：[客户端接入与快速上手指南](../user/quick-start.md)。
- 关于后台数据同步机制、镜像加速、离线数据源挂载与本地全量立绘（`LOCAL_IMAGE=true`）的存储规划，请参阅[数据同步、离线包与立绘存储管理](data-and-sync.md)。
- 全部运行时配置项字典见[环境变量完整参考](environment-variables.md)；健康检查、`/debug/*` 监控指标与排障见[监控诊断与故障排查手册](diagnostics-and-troubleshooting.md)。

---

## 1. 部署形态与平台要求

PRTS-MCP 3.x 的核心服务为单一原生 Rust 二进制（静态链接 C 正则引擎与 OS 内存统计组件），公开发行的所有产物均内置了一份经过 SHA-256 校验的只读备用游戏数据。管理员可根据基础设施环境选择以下部署形态：

| 部署形态 | 适用场景 | 系统与运行时要求 | 默认传输模式 |
| --- | --- | --- | --- |
| **Docker 容器（推荐生产使用）** | 服务器常驻 HTTP 服务、多容器编排或隔离的 `stdio` 进程 | 支持 Linux `x64`（`amd64`）与 `arm64`；镜像内无语言运行时或编译器，宿主机仅需安装 Docker。 | 默认 `stdio`；传入 `-e PRTS_TRANSPORT=http` 切换为 HTTP。 |
| **预编译原生归档包** | 直接通过 `systemd` 或进程管理器在裸机/虚拟机上托管 | Linux `x64`/`arm64`（需 `glibc >= 2.28`）、Windows `x64`（静态 CRT，无需 VC++ 运行库）、macOS `14.0+`（`arm64`/`x64`）。无需安装任何运行时。 | `prts-mcp` 默认启动 Streamable HTTP（`:3000/mcp`）；设 `PRTS_TRANSPORT=stdio` 切为 stdio。 |
| **npm 全局安装** | 已具备 Node.js 环境的服务器或开发机 | 需 `Node.js >= 22`、`npm >= 10`（作为轻量启动桥拉起同平台的预编译 Rust 二进制，无需 Bun）。 | `prts-mcp` 默认 HTTP；兼容命令 `prts-mcp-ts` / `prts-mcp-ts-bun` 固定 HTTP，`prts-mcp-ts-stdio` 固定 stdio。 |
| **从源码编译** | 自定义构建或不受预编译归档支持的系统 | 需安装 Rust 工具链（`>= 1.89`）与 C 编译器；源码构建不含内置备用数据，依赖启动后自动同步或挂载本地数据。 | 同原生二进制。 |

> **版本标签说明**：当前公开稳定版为 `3.0.0`（npm `latest`，GHCR `:latest` 与 `:3`）。继续使用 2.8.x 的部署可固定 npm `prts-mcp-ts@lts-2.8` 或 GHCR `:2`。生产环境建议始终固定具体版本号（如 `3.0.0`）或镜像 digest。各平台 ABI 审计细节见 [`NATIVE-PLATFORMS.md`](../dev/NATIVE-PLATFORMS.md)。

---

## 2. Docker 容器化部署

### 2.1 拉取镜像

```bash
docker pull ghcr.io/3akhp/prts-mcp:3.0.0
```

容器使用 `tini` 作为 PID 1（`ENTRYPOINT ["tini", "-g", "--", "/app/bin/prts-mcp-ghcr"]`），可正确转发 `SIGTERM` / `SIGINT` 信号并回收子进程，确保 `docker stop` 立即优雅退出。

### 2.2 部署常驻 Streamable HTTP 服务

作为供局域网或多客户端共享的 HTTP 服务运行时，需显式设置 `-e PRTS_TRANSPORT=http` 并挂载 `/data` 持久化卷：

```bash
docker run -d --name prts-mcp --restart unless-stopped -p 127.0.0.1:3000:3000 -v prts-data:/data -e PRTS_TRANSPORT=http ghcr.io/3akhp/prts-mcp:3.0.0
```

- **监听地址与端点**：容器内默认监听 `0.0.0.0:3000`（可通过 `HOST` / `PORT` 调整），MCP 端点为 `/mcp`，健康检查端点为 `/health`。
- **反向代理与网络安全**：上方命令将端口仅绑定在宿主机回环地址 `127.0.0.1:3000`。如需对跨机或公网暴露，建议前置 Nginx / Caddy / Traefik 等反向代理，配置 TLS 与访问控制，并确保反向代理支持流式响应（关闭针对 `/mcp` 的响应缓冲，同时**切勿将 `/debug/*` 路径暴露至公网**）。

### 2.3 多客户端并发混连与两代 MCP 协议自适应（Legacy & Modern）

常驻 Streamable HTTP 服务端（`/mcp`）原生支持**多客户端并发接入**与**两代 MCP 协议无感混连**，无需任何服务端模式开关：

1. **按请求自动分流两代协议**：
   - **传统有状态会话客户端（Legacy，`2024-11-05` / `2025-03-26` / `2025-06-18`）**：客户端通过 `POST /mcp` 发送 `initialize` 创建会话，服务端分配唯一 UUID 并通过响应头 `Mcp-Session-Id` 返回；后续请求携带该 Header 即可复用独立会话状态与输出通道设置。
   - **现代无状态客户端（Modern，`2026-07-28`）**：客户端不发送 `Mcp-Session-Id`，而是在每条 JSON-RPC 请求的 `_meta` 中携带现代协议信封（及 `MCP-Protocol-Version` / `Mcp-Method` 请求头），服务端直接以无状态模式处理并返回 JSON。
   - **并发隔离**：任意数量的 Legacy 客户端与 Modern 客户端可**同时连接同一个 `/mcp` 端点**，各自还可通过 `?output_channel=` 查询参数或 `x-prts-output-channel` 请求头独立指定返回 `content`、`structured` 或 `both`。
   - **严格的协议边界防呆**：若请求声明了 `MCP-Protocol-Version` 等现代协议头却遗漏了必需的 `_meta` 信封（或未带 `Mcp-Method`），服务端会明确返回 `400 Bad Request`（错误码 `-32602` / `-32020`），而不会静默误路由到 Legacy 分支。

2. **Legacy 会话生命周期、空闲驱逐与重连恢复**：
   - **空闲超时驱逐（`SESSION_IDLE_TIMEOUT_MS`）**：为防止断开后未发送 `DELETE /mcp` 的 Legacy 客户端无限占用内存，服务端对每个 Legacy 会话启动独立的空闲看门狗。默认空闲满 **24 小时（`86400000` 毫秒）** 无任何请求即自动驱逐该会话；每次收到合法请求都会刷新最后活跃时间并按剩余预算重设局部定时器。若需调整超时时间，可配置 `SESSION_IDLE_TIMEOUT_MS`（设为 `<= 0` 或非数值则禁用空闲驱逐）。
   - **会话丢失时的客户端行为与自动重初始化**：
     - 当容器重启或会话因空闲超时被驱逐后，旧的 `Mcp-Session-Id` 失效。
     - 若客户端携带已失效的 `Mcp-Session-Id` 发起普通调用（如 `tools/call`），服务端会返回 **HTTP `404 Not Found`（JSON-RPC `-32002`）**，并在错误消息中提示客户端/用户重连。
     - 若客户端携带失效的 `Mcp-Session-Id` 重新发送 `initialize` 握手，服务端会**自动放行重初始化**并签发全新的 `Mcp-Session-Id`；对于不会自动重发 `initialize` 的客户端，用户在客户端设置中关闭再打开 MCP 开关即可恢复。

### 2.4 数据卷挂载策略（整卷 vs. 兼容 2.x 分卷）

容器内将 `/app/data` 作为只读内置备用数据源，将 `/data` 作为可写数据根目录：

1. **单卷挂载 `/data`（新部署强烈推荐）**：
   - 使用 `-v prts-data:/data` 将单个命名卷或宿主机目录挂载到 `/data`。
   - 优势：同时持久化 `/data/gamedata`、`/data/gamedata-levels`、`/data/storyjson`、`/data/images`、默认 SQLite 后端使用的 `/data/database`，以及根目录下的成对激活指针 `/data/.gamedata_pair.json`。
2. **兼容 2.x 的多子卷挂载**：
   - 若从 2.x 升级且原有部署使用了 3 个或 4 个独立子目录命名卷，无需迁移数据，原挂载命令可直接沿用：
     ```bash
     docker run -d --name prts-mcp -p 127.0.0.1:3000:3000 -e PRTS_TRANSPORT=http -v prts-mcp-data:/data/gamedata -v prts-mcp-levels:/data/gamedata-levels -v prts-mcp-storyjson:/data/storyjson ghcr.io/3akhp/prts-mcp:3.0.0
     ```
   - 在分卷挂载下，容器重建后会根据各子卷内的 `archives/extract_meta.json` 自动恢复激活状态。
   - 3.2 起默认使用 SQLite 后端，DB 写入 `/data/database`。沿用上面的分卷命令时，该目录不在任何卷中，每次重建容器都要重新下载约 106 MiB 的 DB，下载完成前服务使用 JSON 备用数据。二选一处理：
     - 增加一个卷：`-v prts-mcp-database:/data/database`；
     - 或设置 `-e PRTS_DATA_BACKEND=json`，继续使用原有三个子卷中的 JSON 数据。
3. **挂载宿主机目录（Bind Mount）**：
   - 请始终使用宿主机**完整绝对路径**（例如 Linux/macOS 下 `-v /srv/prts-data:/data`，Windows PowerShell 下 `-v 'D:\prts-data:/data'`）。

### 2.5 容器权限加固（非 root 与只读根文件系统）

镜像默认以 `root`（`0:0`）运行以兼容既有命名卷权限。如需在生产环境中以非特权用户及只读根文件系统（`--read-only`）运行：

1. 先在宿主机创建数据目录并赋权给目标非 root UID/GID；
2. 挂载 `/tmp` 为可写 `tmpfs`（供临时解压使用）：

```bash
mkdir -p /srv/prts-data
chown -R 10001:10001 /srv/prts-data

docker run -d --name prts-mcp --user 10001:10001 --read-only --tmpfs /tmp:rw,nosuid,nodev,mode=1777 -p 127.0.0.1:3000:3000 -e PRTS_TRANSPORT=http -v /srv/prts-data:/data ghcr.io/3akhp/prts-mcp:3.0.0
```

> **注意**：若在 `--read-only` 模式下使用 4 个独立子目录分卷挂载（而非整卷挂载 `/data`），还需额外添加 `--tmpfs /data:rw,nosuid,nodev,mode=1777`，以便父目录 `/data` 能够写入跨进程同步锁与 `.gamedata_pair.json`。这种情况下默认 SQLite 后端会把 DB（约 289 MiB）写进 tmpfs，占用内存且重启即丢失，请同时为 `/data/database` 挂载一个卷，或设置 `PRTS_DATA_BACKEND=json`。

---

## 3. 原生归档包与 `systemd` 守护进程部署

### 3.1 解压与目录结构要求

从 [3.0.0 Release](https://github.com/3aKHP/prts-mcp/releases/tag/v3.0.0) 下载对应平台的归档包与 `SHA256SUMS` 校验清单：

```bash
sha256sum --ignore-missing -c SHA256SUMS
sudo mkdir -p /opt/prts-mcp
sudo tar -xzf prts-mcp-3.0.0-linux-x64.tar.gz -C /opt/prts-mcp
```

> **切勿破坏目录相对结构**：`/opt/prts-mcp/bin/prts-mcp` 启动时会自动从相邻的 `../data`（即 `/opt/prts-mcp/data`）定位内置只读备用数据。如果只把 `bin/prts-mcp` 单独复制到 `/usr/local/bin`，程序将无法找到内置备用数据。

### 3.2 配置 `systemd` 常驻服务（Linux）

创建专用系统用户与可写数据目录：

```bash
sudo useradd --system --home-dir /var/lib/prts-mcp --create-home --shell /usr/sbin/nologin prts-mcp
```

创建 `/etc/systemd/system/prts-mcp.service`：

```ini
[Unit]
Description=PRTS MCP Server (Rust)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=prts-mcp
Group=prts-mcp
Environment=HOST=127.0.0.1
Environment=PORT=3000
Environment=XDG_DATA_HOME=/var/lib/prts-mcp
Environment=PRTS_AUTO_SYNC_INTERVAL_SECONDS=3600
ExecStart=/opt/prts-mcp/bin/prts-mcp
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

启用并启动服务：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now prts-mcp
curl -fsS http://127.0.0.1:3000/health
```

---

## 4. 通过 npm 部署常驻服务

在已安装 `Node.js >= 22` 与 `npm >= 10` 的机器上：

```bash
# 安装 3.x 主包（提供 prts-mcp 命令，默认启动 HTTP）
npm install -g prts-mcp@3.0.0
prts-mcp

# 若需保留 2.x 旧启动脚本中的命令名，可同时或单独安装兼容包：
npm install -g prts-mcp-ts@3.0.0
```

- **切勿使用 `--omit=optional`**：平台对应的预编译 Rust 二进制通过 `optionalDependencies` 分发，禁用可选依赖会导致启动失败。
- **进程管理与信号**：在 Linux/macOS 下，Node 启动桥会将 `SIGINT`、`SIGTERM`、`SIGHUP` 转发给 Rust 子进程；在 Windows 下，Rust 子进程通过 OS 句柄监测外层 Node 启动桥，父进程被终止时 Rust 进程会自动退出，不会遗留端口占用。

---

## 5. 版本升级与回滚

- **从 2.x 升级到 3.0**：3.x 完全兼容 2.8.1 的数据目录结构与环境变量。升级前请先停止旧实例并完整备份数据目录/卷，随后直接切换为 3.x 镜像、原生包或 npm 包即可。详细渠道对照与注意事项请参阅 [2.x → 3.0 迁移指南](../migration-2.x-to-3.0.md)。
- **安全回滚**：若需回退至 2.8.1，停止 3.x 实例，切回固定的 2.8.1 镜像或安装包及原启动命令，挂载备份卷（或现有数据卷）重启即可。
