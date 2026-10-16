# 全量 E2E 真机测试流程（Rust）

本文面向项目维护者，说明如何使用公开发行的原生归档包、npm 包与 Docker 镜像，配合真实 MCP 客户端和完整数据/立绘链路开展生产级端到端（E2E）验收。

> **何时需要执行本流程？**
> 由于全量 E2E 涉及大体积游戏数据与立绘资产同步，耗时与网络流量开销较大，因此**不作为日常 PR 或常规发版的强制门禁**。
> 当变更涉及以下高风险领域时，强烈建议按影响范围执行全部或部分阶段：
> - 跨模块大型架构重构；
> - `sync/` 层（传输、镜像回退、manifest/ZIP 校验、代际激活、跨进程锁）；
> - PRTS Wiki 解析或 `operator_artwork` 双数据源衔接逻辑；
> - `protocol/` 传输层（stdio / Streamable HTTP）或会话生命周期管理。
>
> 具体执行全量流程还是定向轻量化真机验证，由维护者根据 [`WORKFLOW.md`](WORKFLOW.md) 当次裁量，并在 PR 或验收记录中如实说明已验证范围与未执行项。

---

## 1. 环境隔离与流量控制原则（必读）

1. **目录与端口严格隔离**：
   - 测试自动同步时，**请勿设置 `GAMEDATA_PATH` 或 `STORYJSON_PATH`**（设置后会禁用对应数据集的自动同步）。
   - 在 Linux / macOS 下通过独立的 `XDG_DATA_HOME`，在 Windows 下通过独立的 `LOCALAPPDATA` 将测试数据重定向到专用临时目录（如 `/tmp/prts-e2e/data`）。
   - 使用 `HOST=127.0.0.1`、独立的非默认端口（如 `39171`）与临时诊断 Token，切勿影响本机正在运行的生产服务或真实用户数据卷。
2. **数据卷备份**：
   - 测试旧版本升级与回滚前，必须先停止写入进程，并完整拷贝一份数据目录或 Docker 卷副本（包含 `.gamedata_pair.json`、`archives/`、`.releases/` 等隐藏元数据与 PNG 文件），在副本上执行升级与回读。
3. **大体积资产与代理流量控制**：
   - 若本机处于按流量计费的网络或全局/TUN 代理环境中，开始前请先盘点本地是否已有缓存好的候选安装包、Docker 镜像、上游数据 ZIP 与立绘分片。
   - **重要提示**：`GITHUB_MIRRORS` 是“直连原地址失败后的回退列表”，而非“强制仅走镜像”。若需在离线或本地回放环境下测试镜像回退链路，可将 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`（含小写）指向本机未监听的回环端口，并将 `NO_PROXY` 设为 `127.0.0.1,localhost`，使公网直连快速失败后自动切入本地回环镜像服务。

---

## 2. 阶段一：安装发行物并启动服务

请直接使用待验收的公开发行物（原生归档包、精确版本 npm 包或已构建的 Docker 镜像），不要用临时 `cargo build` 产物代替发行物。

### 方式 A：直接前台启动原生二进制

```bash
XDG_DATA_HOME=/tmp/prts-e2e/data-rust HOST=127.0.0.1 PORT=39171 PRTS_AUTO_SYNC_INTERVAL_SECONDS=0 /absolute/path/to/candidate/bin/prts-mcp
```

### 方式 B：通过 systemd 用户单元常驻运行（Linux）

创建 `~/.config/systemd/user/prts-e2e-rust.service`（请将路径替换为实际测试路径）：

```ini
[Unit]
Description=PRTS-MCP Rust E2E Test Instance
After=network-online.target

[Service]
Environment=HOST=127.0.0.1
Environment=PORT=39171
Environment=XDG_DATA_HOME=/tmp/prts-e2e/data-rust
Environment=IMAGES_ENABLED=true
Environment=LOCAL_IMAGE=false
Environment=PRTS_AUTO_SYNC_INTERVAL_SECONDS=0
ExecStart=/absolute/path/to/candidate/bin/prts-mcp
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

启动并检查监听状态：

```bash
systemctl --user daemon-reload
systemctl --user start prts-e2e-rust
curl -fsS http://127.0.0.1:39171/health
# 预期返回：{"status":"ok"}
```

**入口与信号核对点**：
- 验证 `prts-mcp` 默认启动 HTTP、传入 `PRTS_TRANSPORT=stdio` 启动 stdio；
- 验证 `prts-mcp-ts` / `prts-mcp-ts-bun`（固定 HTTP）、`prts-mcp-ts-stdio`（固定 stdio）以及 Docker `prts-mcp-ghcr`（默认 stdio，`-e PRTS_TRANSPORT=http` 切 HTTP）；
- 验证 stdio 模式下 `stdout` 仅输出纯净 JSON-RPC 协议帧，关闭 `stdin`（EOF）后进程以状态码 `0` 正常退出。

---

## 3. 阶段二：观察首次自动同步（`LOCAL_IMAGE=false`）

通过日志观察后台同步进度，并检查数据目录落盘情况：

```bash
journalctl --user -u prts-e2e-rust -f
du -sh /tmp/prts-e2e/data-rust/prts-mcp/*
```

**核对要点**：
1. **备用数据与用户数据切换**：在后台同步完成前，自带备用数据的发行包即可正常响应本地查询；同步完成后，查询自动切换至新激活的用户数据（`gamedata` 与 `gamedata-levels` 成对激活，`.gamedata_pair.json` 与各目录 `extract_meta.json` 一致）。
2. **失败保持上一代**：若模拟网络中断或坏包，服务应拒绝激活损坏代际，继续使用上一代可用数据或内置备用数据。
3. **轮询开关**：`PRTS_AUTO_SYNC_INTERVAL_SECONDS=0` 在完成启动时的首次同步检查后不再安排后续周期轮询；默认 `3600` 则每小时检查一次。

---

## 4. 阶段三：真实 MCP 客户端全工具组调用

使用真实 MCP 客户端（如 Claude Code、Claude Desktop 或 Codex）及协议测试套件接入服务，核对 `tools/list`（默认 24 个工具）并按数据域执行调用验证（具体示例参数可参考[工具使用指南](../user/tools-guide.md#2-全部-24-个工具参数示例速查表)）：

| 工具域 | 代表性调用链路 | 关键验证点 |
| --- | --- | --- |
| **PRTS Wiki** | `search_prts` → `prts_page(action="sections" / "read" / "template")` | 词条搜索、章节目录（含 `T-` 模板节）、正文清洗与顶层模板结构化渲染正常。 |
| **干员资料** | `get_operator_basic_info(action="basic" / "skills" / "stats")`、`archives`、`voicelines`、`memoirs` | 基础档案、技能专精逐级数值、指定精英阶段/等级面板插值、语音与密录 `story_key` 解析正常。 |
| **关卡与物品** | `list_stages` / `get_stage_info`、`list_enemies` / `get_enemy_info`、`get_stage_enemies`、`get_enemy_appearances`、`list_items` / `get_item_info`、`search` | 分页过滤、关卡级敌方数值覆盖、跨干员基建/战斗技能反查与结构化输出正常。 |
| **剧情检索** | `list_story_events` → `list_stories` → `get_story_summary` / `read_story` / `read_activity` / `search_stories` / `find_character_appearances` / `find_speakers_in` | 主线、活动与集成战略（`roguelike`）剧情目录完整，角色出场统计与正则上下文搜索准确。 |
| **干员立绘** | `operator_artwork(action="list")` → `operator_artwork(action="get")` | 在线 MediaWiki 模式下返回有效 `artwork_id`，`get` 返回真实可解码的 base64 PNG 图像，二次请求命中内存缓存。 |

同时抽查 `PRTS_OUTPUT_CHANNEL`（`content` / `structured` / `both`）、HTTP 请求头/查询参数覆盖，以及 legacy 有状态会话与 `2026-07-28` 无状态现代信封的协议行为。

---

## 5. 阶段四与阶段五：本地全量立绘同步与读取（`LOCAL_IMAGE=true`）

在确认磁盘空间充足或已配置好本地镜像回放源后，将隔离测试实例切换为 `LOCAL_IMAGE=true`：

1. **基线与增量同步（Baseline & Delta）**：
   - 观察首次基线分片（baseline shards）下载、SHA-256 校验、解压与 `.releases/<generation>/index.json`、`.images_meta.json` 原子激活。
   - 重启服务，确认已处于最新代际时直接命中 `up-to-date` 快捷路径，不会重复下载基线包。
   - 若有增量包（delta），验证增量合并后新代际正常激活且旧代际缓存自动失效。
2. **本地立绘工具验证**：
   - `operator_artwork(action="list")` 返回包含皮肤系列与获取方式元数据的立绘列表；
   - `action="get"` 获取 `large`（最大 1024px）与 `preview`（最大 256px）变体，解码验证 PNG 魔法字节与实际宽高；
   - 当 `ORIGINAL_IMAGE=false` 时，请求 `variant="original"` 应返回清晰的中文提示而非崩溃；
   - 验证阿米娅升变形态及跨干员伪造 `artwork_id` 时的归属校验拒绝。
3. **诊断端点检查（可选）**：
   - 配置 `PRTS_DEBUG_TOKEN` 与 `PRTS_METRICS_ENABLED=true`，验证未带 Bearer Token 时 `/debug/cache` 与 `/debug/metrics` 返回 `404 Not Found`，带正确 Token 时返回符合 Rust 诊断 Schema（`D-001` / `D-002`）的 JSON。

---

## 6. 阶段六：旧版数据卷升级与回滚验证

1. 使用 2.8.1 稳定版（如 `prts-mcp-ts@2.8.1` 或 `ghcr.io/3akhp/prts-mcp:2.8.1`）在独立测试数据卷上完成初始化与代表性查询，停止服务并完整备份该数据卷。
2. 将 3.x 候选版指向该数据卷副本启动，确认无需重拉全量数据即可直接读取既有 `gamedata`、`gamedata-levels`、`storyjson` 与 `images`，并可正常执行增量更新。
3. 停止 3.x 候选版，切回 2.8.1 稳定版重新挂载同一数据卷，验证旧版对升级后的数据卷仍可正常回读与查询。

---

## 7. 已知正常现象（勿误判为缺陷）

- **先监听后同步**：服务启动后立即监听端口（`/health` 返回 200），后台同步异步执行；源码构建在首次同步完成前提示数据暂不可用属于正常现象。
- **跨进程锁残留与自动接管**：进程被强制杀死（`SIGKILL`）后可能遗留 `.lock` 文件；锁内记录的 `owner` 是随机 UUID 而非 PID，新进程会在租约（lease）过期后自动安全接管，无需手动删锁。
- **自定义路径自动停用同步**：设置了 `GAMEDATA_PATH` 或非空 `STORYJSON_PATH` 时，日志提示对应 auto-sync 已禁用属于预期设计。

## 8. 清理与收尾

测试完成后，停止并移除测试专用的 systemd 单元、容器、临时网络与客户端测试配置；清理临时目录前请再次确认路径，切勿误删真实用户数据卷或复用的测试资产缓存。
