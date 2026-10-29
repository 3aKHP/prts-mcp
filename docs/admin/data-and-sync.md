# 数据同步、离线包与立绘存储管理

本文面向服务端管理员，深入说明 PRTS-MCP 3.x 的游戏数据与立绘资产目录结构、内置备用数据与用户数据的优先级、后台自动同步机制、镜像与代理配置、离线自定义数据源挂载，以及数据卷的备份与恢复。

- 容器与守护进程部署步骤见[服务端部署与容器运维指南](deployment.md)。
- 全部环境变量的默认值与解析规则见[环境变量完整参考](environment-variables.md)。

---

3.1 增加实验性 SQLite 后端，默认仍使用下文的 JSON/ZIP 路径与同步规则。设置 `PRTS_DATA_BACKEND=sqlite` 后只同步 AKDP 的 `zh_CN.sqlite.gz`，使用独立的 `database/` 目录；也可用 `PRTS_DATA_DB` 指定只读离线 DB。3.1 发行包仍只内置 JSON 备用数据，SQLite 首次使用需要联网或预置 DB。切回 `PRTS_DATA_BACKEND=json` 并重启即可继续使用保留的旧卷；两套游戏数据不会同时同步。变量优先级见[环境变量参考](environment-variables.md)。

SQLite 的 `PRTS_VALIDATION_MODE` 默认值为 `normal`。新同步产物在激活前校验整文件摘要、结构和外键。通常模式在进程重启后重新比对摘要，再复用匹配的结构验收记录；`strict` 会重新执行完整结构和外键检查。受管理 DB 旁的 `.verified.json` 是可重建缓存，缺失或失效时补做检查，无须重新下载健康 DB；无法写入记录也不影响已验收数据的使用。自定义只读 DB 不自动写入该记录，通常模式保留快速检查。

计划在 3.2 调整普通默认值，3.x 继续支持显式 JSON 后端及已有自定义 JSON 路径。SQLite 容器持久化 `/data/database`（整卷挂载 `/data` 无须新增挂载）；旧分卷配置在选择 JSON 时保持不变。DB 原子切换、当前/上一代及更新暂存需要额外磁盘空间，切换后不自动删除另一后端的数据。

## 1. 数据集组成与目录结构

PRTS-MCP 运行依赖两类外部数据源：
1. **PRTS Wiki MediaWiki API**（`https://prts.wiki/api.php`）：实时查询世界观词条、页面章节与模板（在线请求，不在本地落盘全量词条库）。
2. **`arknights-data-pipeline`（AKDP）GitHub Releases**（[`3aKHP/arknights-data-pipeline`](https://github.com/3aKHP/arknights-data-pipeline)）：定时发布结构化游戏数据包与干员立绘分片，由服务端在后台自动同步并落盘。

### 默认可写数据根目录

| 运行环境 | 默认数据根目录 | 控制环境变量 |
| --- | --- | --- |
| **Docker 容器** | `/data` | 容器内预设 `PRTS_MCP_ROOT=/app`（非容器环境切勿设置 `PRTS_MCP_ROOT`） |
| **Linux / macOS** | `${XDG_DATA_HOME:-~/.local/share}/prts-mcp` | `XDG_DATA_HOME` |
| **Windows** | `%LOCALAPPDATA%\prts-mcp`（回退 `~\AppData\Local\prts-mcp`） | `LOCALAPPDATA` |

在数据根目录下，各子目录与元数据文件的职责如下：

```text
<数据根目录>/
├── .gamedata_pair.json          ← 记录当前成对激活的 gamedata 与 gamedata-levels 版本身份
├── gamedata/                    ← 游戏数据表（来自 zh_CN-excel.zip）
│   ├── archives/                ← 下载的压缩包缓存与 extract_meta.json / release_meta.json
│   └── .releases/<generation>/zh_CN/gamedata/excel/  ← 解压后的 character_table.json、skill_table.json 等核心表格
├── gamedata-levels/             ← 关卡战斗与刷怪数据（来自 zh_CN-levels.zip）
│   ├── archives/
│   └── .releases/<generation>/zh_CN/gamedata/levels/ ← 各关卡波次 JSON，敌人数据库位于 enemydata/enemy_database.json
├── storyjson/                   ← 剧情对话与梗概数据
│   ├── zh_CN.zip                ← 服务端直接从该 ZIP 按需流式读取剧情与索引，无需全量解压
│   └── release_meta.json
└── images/                      ← 仅在 LOCAL_IMAGE=true 时同步的本地立绘资产（可通过 PRTS_IMAGE_DIR 单独指定路径）
    ├── .images_meta.json        ← 当前激活的立绘代际（generation）指针
    ├── .releases/<generation>/  ← 包含该代际的 index.json
    └── ...                      ← 实际 PNG 立绘与皮肤文件
```

自动同步将游戏表与关卡数据解压至各自的 `.releases/<generation>/` 目录，活动目录由 `archives/extract_meta.json` 与根 `.gamedata_pair.json` 记录。旧版数据卷或手动挂载的数据也可能直接存放在 `gamedata/zh_CN/`、`gamedata-levels/zh_CN/` 下。

### 自定义 GitHub 数据源

设置 `PRTS_DATA_SOURCE_REPO=owner/repo` 可让游戏表、关卡、剧情、SQLite 和本地图片同步使用指定仓库。源仓库须提供相应的兼容 Release、manifest 与图片 index；所选后端及各数据集的同步开关继续生效。变量未设置、为空或显式填写默认仓库时，目录和同步行为保持原样。

自定义源的默认目录为原数据根下的 `sources/<owner>/<repo>/`，仓库名转为小写。例如 Linux 的 `team/assets` 源位于 `$XDG_DATA_HOME/prts-mcp/sources/team/assets/`，Docker 中位于 `/data/sources/team/assets/`。该目录内仍使用 `gamedata/`、`gamedata-levels/`、`storyjson/`、`database/` 和 `images/` 布局。切回默认源会重新使用原数据目录，不删除自定义源的缓存。为保证跨平台目录身份一致，Windows 设备名（如 `con`、`com1.zip`）及以点结尾的组件，在所有平台均编码为 `~` 加小写 ASCII 十六进制。

显式路径变量仍优先于默认路径。参与自动同步的自定义源目录首次使用必须为空；程序会写入来源标记，后续启动只允许同一源使用。目录内已有未标记数据、来源不匹配或标记损坏时，启动失败并提示另选目录，不自动迁移或覆盖旧数据。若空目录在进程启动后被另一个源绑定，原进程会拒绝后续同步和数据读取。不要通过删除来源标记复用旧卷。`GAMEDATA_PATH`、非空 `STORYJSON_PATH` 和 `PRTS_DATA_DB` 所指定的本地只读输入仍按原规则关闭相应同步，不要求绑定来源。

自定义源是部署者显式选择的信任来源。当前校验仍使用 TLS 和产物 SHA-256，来源标记只防止本地缓存混用，不认证发布者。`GITHUB_TOKEN` 与 `GITHUB_MIRRORS` 保持原有语义，镜像仍只在直连失败后尝试。网络失败时沿用该源目录内的缓存；内置备用数据机制仍有效，首次同步前可能读取发行包内置的默认源 JSON 快照，不会自动读取另一个源目录的缓存。

---

## 2. 内置只读备用数据 vs. 用户数据优先级

公开发布的 3.x 原生归档包（`bin/../data`）、npm 包（`@3akhp/prts-mcp-data`）与 Docker 镜像（`/app/data`）均内置了一份经过完整校验的只读备用数据（涵盖 `gamedata`、`gamedata-levels` 与 `storyjson`）。

服务端在读取数据时遵循严格的**优先级与只读隔离原则**：
1. **用户数据优先**：只要可写数据根目录（如 `/data`）中存在完整且校验通过的用户数据，服务端始终优先读取用户数据。
2. **无缝离线兜底**：当首次启动尚未完成后台同步，或处于完全无外网的离线环境且用户数据目录为空时，服务端自动回退读取安装包内置的备用数据，确保 24 个工具中的本地数据工具立即可用。
3. **只读隔离**：后台自动同步始终只写入可写的用户数据目录，绝不会修改安装目录或容器镜像内的 `/app/data`。
4. **源码编译例外**：直接通过 `cargo build` 或 `cargo package` 构建的二进制不包含内置备用数据，首次启动需完成自动同步或显式挂载本地数据目录后方可查询。

---

## 3. 后台自动同步与原子代际切换

- **启动与周期轮询**：服务启动监听端口后，会立即在后台发起一次非阻塞的同步检查；随后默认每隔 **3600 秒（1 小时）** 检查一次上游 Release。
  - 可通过 `PRTS_AUTO_SYNC_INTERVAL_SECONDS` 在 `60..604800`（1 分钟至 7 天）之间调整轮询间隔；
  - 设为 **`0`** 时仅在服务启动时执行一次同步检查，关闭后续定时轮询。
- **Manifest 校验与成对激活**：
  - 上游 AKDP Release 包含 `manifest.json`（`prts-mcp-data/v1` 契约），记录源端 `versionId`（及 `datarev-<versionId>-r<N>` 修订号）与每个 ZIP 的字节大小和 SHA-256。
  - `gamedata`（`zh_CN-excel.zip`）与 `gamedata-levels`（`zh_CN-levels.zip`）采用**原子成对发布（Paired Activation）**：只有当两个包都下载、校验、解压通过且包含全部必需表格时，才会一起切换激活指针并使旧内存缓存失效。
  - 若下载中断、哈希不匹配或压缩包损坏，新文件会在激活前被拒绝，线上继续使用上一代已激活的数据，查询零中断。
- **跨进程共享锁**：
  - 当多个容器或进程挂载同一个数据卷时，同步器通过带有随机 UUID `owner` 与心跳续租（lease）的锁文件协调写入。即使某进程被 `SIGKILL` 强杀遗留了锁文件，后续进程也会在租约过期后自动安全接管，**运维人员切勿在服务运行期间手动删除活跃卷上的 `.lock` 或指针文件**。

---

## 4. 网络限流、GitHub 镜像与代理配置

在服务器或国内网络环境下，可通过以下变量优化同步稳定性：

| 配置项 | 作用与配置建议 |
| --- | --- |
| `GITHUB_TOKEN` | 填入 GitHub Personal Access Token（无需特殊仓库写权限，普通只读公开访问即可），可将 GitHub API 限额从匿名 IP 的 60 次/小时提升至 5000 次/小时。Token 不会输出到日志。 |
| `GITHUB_MIRRORS` | 逗号分隔的 GitHub Release 下载回退镜像前缀（例如 `https://ghproxy.net,https://mirror.example.com`）。**注意**：服务端会先尝试直连 GitHub 原地址，直连失败后才按顺序拼接 `<mirror>/<original_url>` 重试；无论是否走镜像，都会严格执行 manifest 与 SHA-256 校验。 |
| `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` | 标准的出站代理与免代理主机列表（同时支持小写环境变量），对 GitHub 同步与 PRTS Wiki 请求均生效。 |
| `NODE_EXTRA_CA_CERTS` | 若 PRTS Wiki 请求经过企业内网 TLS 拦截网关或使用自签名根证书，可将该变量指向自定义 CA 的 PEM 证书文件路径；仅对 Wiki HTTP 客户端生效。 |

---

## 5. 挂载自定义离线数据源（禁用自动同步）

如果你在宿主机上自己维护了 `ArknightsGameData` 仓库克隆或离线 `zh_CN.zip` 剧情包，可通过 `GAMEDATA_PATH` 与 `STORYJSON_PATH` 指向本地路径：

```bash
docker run -d --name prts-mcp -p 127.0.0.1:3000:3000 -e PRTS_TRANSPORT=http -v /srv/ArknightsGameData:/data/custom:ro -e GAMEDATA_PATH=/data/custom -v prts-data:/data ghcr.io/3akhp/prts-mcp:3.0.0
```

**管理员必须注意的三条路径规则**：
1. **`GAMEDATA_PATH` 存在即停用同步**：只要进程环境变量中定义了 `GAMEDATA_PATH`（**哪怕赋值为空字符串 `GAMEDATA_PATH=`**），游戏表与关卡战斗数据的后台自动同步就会立即关闭。若使用默认自动同步，请保持该变量**未设置（unset）**。
2. **`STORYJSON_PATH` 非空停用剧情同步**：当 `STORYJSON_PATH` 设为非空路径（指向本地 `zh_CN.zip`）时，剧情后台自动同步关闭。
3. **相邻路径推导陷阱**：如果只设置了 `GAMEDATA_PATH`，而未显式设置 `STORYJSON_PATH` 或 `PRTS_IMAGE_DIR`，服务端会默认从 `GAMEDATA_PATH` 的**父目录**推导相邻的 `storyjson/zh_CN.zip` 与 `images/` 路径。因此，使用自定义 `GAMEDATA_PATH` 时，强烈建议把 `STORYJSON_PATH` 和 `PRTS_IMAGE_DIR` 也显式配齐。

---

## 6. 立绘资产（`operator_artwork`）的两种存储模式

`operator_artwork` 工具默认开启（可通过 `IMAGES_ENABLED=false` 完全关闭该工具），并提供两种截然不同的存储与网络模式：

### 模式一：在线按需模式（`LOCAL_IMAGE=false`，默认推荐）
- **工作原理**：不预先下载全量立绘包（磁盘占用为 0）。当用户调用工具请求某张干员立绘时，服务端实时从 PRTS MediaWiki 拉取对应图片，并放入内存 LRU 缓存（`PRTS_IMAGE_CACHE=true`，默认上限 **256 MiB**）。
- **适用场景**：绝大多数个人用户与轻量级服务器部署。

### 模式二：本地全量资产镜像（`LOCAL_IMAGE=true`）
- **工作原理**：后台同步器从 AKDP 下载全量干员立绘与时装 PNG 资产包（基线分片 `baseline` + 增量分片 `delta`），解压存储在 `PRTS_IMAGE_DIR`（Docker 下默认为 `/data/images`），并提供包含皮肤系列、获取途径等扩展元数据的列表。
- **原图分片开关（`ORIGINAL_IMAGE`）**：
  - `ORIGINAL_IMAGE=false`（默认）：仅同步 `large`（最大 1024px）与 `preview`（最大 256px）两个常用分辨率变体；
  - `ORIGINAL_IMAGE=true`：额外同步未缩放的原始分辨率分片（`original`）。
- **容量与流量规划**：开启 `LOCAL_IMAGE=true` 会下载并解压 **数 GB 级别**的 PNG 资产（再开启 `ORIGINAL_IMAGE=true` 会进一步成倍增加体积）。请务必在宿主机磁盘空间充裕、且网络不按高昂流量计费的环境下开启。

---

## 7. 数据卷备份、迁移与故障恢复

1. **完整备份要求**：
   - 备份 `/data`（或本地数据根目录）前，请先停止服务容器或进程，确保没有正在进行的后台解压任务。
   - **必须连同隐藏文件一起备份**：包括根目录下的 `.gamedata_pair.json`、各子目录下的 `archives/extract_meta.json`、`release_meta.json` 与完整的 `.releases/` 目录，以及 `images/` 下的 `.images_meta.json` 和 `.releases/<generation>/index.json`。只拷贝散落的 JSON 或 PNG 而丢弃元数据文件会导致服务端无法识别已激活代际而重新全量下载。
2. **从分卷迁移到单卷 `/data`**：
   - 若希望将 2.x 遗留的 `prts-mcp-data`、`prts-mcp-levels`、`prts-mcp-storyjson` 三个命名卷合并为单个 `prts-data` 卷，只需在停机状态下将三个旧卷的内容分别复制到新卷的 `/data/gamedata`、`/data/gamedata-levels`、`/data/storyjson` 子目录下，启动后服务会自动根据各子目录的 `extract_meta.json` 重建根 `.gamedata_pair.json`。
3. **损坏数据目录恢复**：
   - 若宿主机意外断电或人为删改导致某个数据子目录损坏，可先停止服务并备份现场，然后清空对应子目录（或删除其 `extract_meta.json` / `.images_meta.json`），重启服务后即会自动回退至内置备用数据并在后台重新拉取完整数据包。
