# Rust Docker 分发说明

本文面向构建与维护 Docker 镜像的协作者，说明 PRTS-MCP 3.x 容器镜像的构建流程、运行时契约、权限模型与数据卷兼容设计。

- 容器生产部署与挂载示例见[服务端部署与容器运维指南](../admin/deployment.md#2-docker-容器化部署)
- 原生平台二进制构建见 [`NATIVE-PLATFORMS.md`](NATIVE-PLATFORMS.md)
- 候选版汇总与多架构发布流程见 [`RELEASE-CANDIDATES.md`](RELEASE-CANDIDATES.md)

---

## 1. 镜像架构与运行契约

公开发布的 3.x 镜像（`ghcr.io/3akhp/prts-mcp`）支持 **`linux/amd64`（`linux-x64`）与 `linux/arm64`（`linux-arm64`）** 双原生架构：

- **精简运行时**：基于固定 digest 的 Ubuntu 24.04 基础镜像，仅安装 `ca-certificates` 与 `tini`，内置预编译 Rust 二进制（`/app/bin/prts-mcp-ghcr`）与经过校验的只读备用游戏数据（`/app/data`），不包含 Node.js、Bun、Python 或任何编译工具链。
- **PID 1 与信号处理**：容器 `ENTRYPOINT` 为 `tini -g -- /app/bin/prts-mcp-ghcr`。由 `tini` 作为 PID 1 负责转发 `SIGTERM` / `SIGINT` 并回收子进程，确保 `docker stop` 时服务能够立即优雅退出，而不会卡死等待超时强杀。
- **延续 2.x 容器默认行为**：
  - 默认以 **`stdio` 模式**启动（便于 MCP 客户端直接通过 `docker run -i --rm` 调用）；
  - 传入 `-e PRTS_TRANSPORT=http` 时切换为 **Streamable HTTP 模式**，默认监听容器内 `0.0.0.0:3000`；
  - 默认运行用户保持 `root`（`0:0`），同时支持通过 `--user <uid>:<gid>` 以非 root 身份运行。

---

## 2. 本地构建与探测验证

仓库提供两套 Dockerfile，分别面向**正式发行打包**与**本地源码快速调试**：

### 方式 A：正式发行镜像构建与探测（含内置备用数据）

在匹配目标架构的 Linux 主机（`linux-x64` 或 `linux-arm64`）上依次执行：

```bash
node tools/native/build.mjs linux-x64
node tools/native/pack.mjs linux-x64
node tools/npm/prepare-data.mjs
node tools/docker/build.mjs linux-x64
node tools/prepare-validation.mjs --minimal
node tools/docker/probe.mjs linux-x64
```

- **`tools/docker/build.mjs`**：校验同版本原生二进制与备用数据的完整文件哈希和许可证清单，组装独立的构建上下文并调用根目录 [`Dockerfile`](../../Dockerfile)，在 `artifacts/docker/<platform>/` 下输出可离线导入的 `.docker.tar.gz` 镜像归档、`image.json` 与 `.sha256` 校验文件。
- **`tools/docker/probe.mjs`**：加载构建好的镜像，在隔离的容器网络中配合本地固定数据镜像源，自动验证以下场景：
  1. 容器内全部二进制、内置数据哈希与第三方许可证完整性，且不存在 JS/Python 运行时或编译器；
  2. 默认 `stdio` 握手、工具调用与 EOF 退出；
  3. 显式 `PRTS_TRANSPORT=http` 下的 legacy 与 modern 双协议时代调用、非法 `PORT` 报错退出，以及 `tini` 信号停机行为；
  4. `--user` 非 root 运行与 `--read-only` 只读根文件系统模式；
  5. `/data` 整卷挂载、2.x 遗留的四子目录分卷挂载、已有用户数据优先于 `/app/data` 内置备用数据，以及与 TS/v2.8.1 旧数据卷的读写兼容。

### 方式 B：源码开发镜像（不含内置备用数据）

日常开发若只需从当前工作树直接编译并构建测试镜像，可使用 [`packaging/docker/Dockerfile.source`](../../packaging/docker/Dockerfile.source)：

```bash
docker build -f packaging/docker/Dockerfile.source -t prts-mcp:source-dev .
```

该镜像在多阶段构建中直接编译 Rust 源码，不包含 `/app/data` 备用数据，启动后通过后台自动同步或挂载的自定义数据路径获取数据。

---

## 3. 数据卷布局与非 root / 只读根文件系统

容器将 `/app/data` 作为只读内置备用数据源，将 `/data` 作为可写的用户数据根目录（包含 `/data/gamedata`、`/data/gamedata-levels`、`/data/storyjson`、`/data/images` 及根配对指针 `/data/.gamedata_pair.json`）：

- **整卷挂载（推荐）**：
  ```bash
  docker run --rm -i -v prts-data:/data ghcr.io/3akhp/prts-mcp:3.0.0
  ```
- **兼容 2.x 分卷挂载**：原有的 3 个或 4 个独立子目录命名卷无需迁移格式即可直接挂载使用。
- **非 root 与只读根文件系统（`--read-only`）**：
  若以非 root UID/GID 配合 `--read-only` 运行，请确保宿主机挂载目录已赋权给该 UID/GID，并挂载 `/tmp` 临时文件系统：
  ```bash
  docker run --rm -i --user "$(id -u):$(id -g)" --read-only --tmpfs /tmp:rw,nosuid,nodev,mode=1777 -v "$PWD/host-data:/data" ghcr.io/3akhp/prts-mcp:3.0.0
  ```
  > 若在 `--read-only` 模式下仍使用 4 个独立子目录分卷挂载（而非挂载整个 `/data`），需额外加上 `--tmpfs /data:rw,nosuid,nodev,mode=1777`，以便父目录 `/data` 能够写入跨进程同步锁与 `.gamedata_pair.json` 配对指针。
