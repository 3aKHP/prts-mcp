# 全量 E2E 真机测试流程（production-simulation pass）

面向维护者的**最高层级验证**：把两套实现按生产方式部署（打包 → 全局安装 / uv → systemd 常驻），用真实 MCP Client 走完整数据同步与全部工具组，重点覆盖图像工具的两条数据源路径。单测 / parity fixtures / `check-runtime.sh` 都替代不了它——它们验证的是代码形状，这里验证的是**实际可用性**。

## 触发条件（必须执行）

**大规模、高风险、跨模块改动合入后必须跑一次完整流程**，包括但不限于：

- 程序级重构（如 2.7 上帝文件重构程序收尾后）
- `sync/` 层（传输 / 镜像 / 激活 / 代际 / 锁）或 `api/` 层的行为改动
- artwork / images 域（两条数据源的缝合处历来是回归重灾区）
- MCP 传输层（stdio / Streamable HTTP）或会话管理改动
- 发布前里程碑（release 分支开口时建议复跑一轮）

普通单模块 PR 不需要本流程——验证矩阵的常规行已覆盖。

## 隔离原则（先读，勿跳）

- **不要设置 `GAMEDATA_PATH` / `STORYJSON_PATH`**：`GAMEDATA_PATH` 会置 `is_custom_gamedata` 关掉 gamedata auto-sync，`STORYJSON_PATH` 有独立的同效门——而本流程的核心观察项之一就是 auto-sync。用 `XDG_DATA_HOME=<测试目录>` 重定向默认数据根——两侧实现都支持，既保 sync 又保隔离。`PRTS_IMAGE_DIR` 不受该语义影响，可直接设。
- `HOST=127.0.0.1` + 独立端口（如 39171/39172）+ `PRTS_DEBUG_TOKEN` 方便 `/debug/cache` / `/debug/metrics` 检查。
- 测试目录建议 `~/prts-e2e/`，一轮结束后按需清空。

## 阶段 1 — TS：打包 → bun 全局装 → systemd 注册

```bash
cd ts && npm run build && npm pack          # 产出 prts-mcp-ts-<ver>.tgz
bun add -g <tarball 路径>                    # 全局安装（bin: prts-mcp-ts / -bun / -stdio）
```

systemd **user** 单元（`~/.config/systemd/user/prts-e2e-ts.service`）：

```ini
[Unit]
Description=PRTS-MCP TS E2E (LOCAL_IMAGE=false)
# user 单元的 After=network-online.target 实际不等待系统网络就绪，仅作标记；启动失败由 Restart 兜底
After=network-online.target

[Service]
Environment=HOST=127.0.0.1
Environment=PORT=39171
Environment=XDG_DATA_HOME=/home/<user>/prts-e2e/data-ts/xdg
Environment=IMAGES_ENABLED=true
Environment=LOCAL_IMAGE=false
Environment=PRTS_IMAGE_CACHE=true
Environment=PRTS_DEBUG_TOKEN=e2e-debug-token
Environment=PATH=/home/<user>/.bun/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/home/<user>/.bun/bin/bun /home/<user>/.bun/install/global/node_modules/prts-mcp-ts/dist/server-bun.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

已知坑：

- bun shim 的 `#!/usr/bin/env bun` 在 systemd 的 PATH 之外 → `ExecStart` 用**绝对 bun 路径**直接跑 `dist/server-bun.js`（上面的写法）。
- `prts-mcp-ts --help` 不存在且会**真启动服务**（占用真实默认数据目录）——勿试。

```bash
systemctl --user daemon-reload && systemctl --user start prts-e2e-ts
curl -s http://127.0.0.1:39171/health        # {"status":"ok"}
```

## 阶段 2 — LOCAL_IMAGE=false：观察 auto-sync

```bash
journalctl --user -u prts-e2e-ts -f
du -sh ~/prts-e2e/data-ts/xdg/prts-mcp/*
```

预期：storyjson（~33M）+ gamedata excel（~108M）+ levels（~384M）三路从 `arknights-data-pipeline` Release 同步完成并各自打 `updated` 日志；`LOCAL_IMAGE=false` 下**不**触发图片同步；随后 `Next auto-sync check in 3600s`。

## 阶段 3 — MCP Client 全工具组调用

最小可用 client（initialize → session → tools/list → tools/call），保存为 `~/prts-e2e/mcp-client.mjs`：

```javascript
// mcp-client.mjs <url> list | call <tool> <json-args> [--out file]
// 完整实现见本文件配套产物；核心：POST /mcp，accept: application/json, text/event-stream，
// 从响应头取 mcp-session-id 回传，notifications/initialized 后即可 tools/*。
// call 结果汇总：isError / image 块 mime+bytes+PNG magic / structuredKeys / textPreview。
```

（该脚本的完整版本随 2.7.0 E2E 存档于维护者 `~/prts-e2e/mcp-client.mjs`；同一协议在仓内已有实现可参照：`ts/tests/e2e.test.ts` 与 `python/tests/test_e2e_http.py`，按上述协议 ~60 行即可重写。）

冒烟清单——**24 个工具全部调用**，每组至少一个代表：

| 组 | 代表调用 | 验证点 |
|---|---|---|
| wiki | `search_prts`、`prts_page(action=sections)` | 真实 MediaWiki 命中 |
| 干员 | basic_info / archives / voicelines / memoirs | 中文渲染、缺数据优雅降级 |
| gamedata | list/get × items/enemies/stages/stage_enemies/appearances、`search` | 数字格式、structuredContent |
| 剧情 | events → stories → summary → read_story → read_activity → search_stories → appearances → speakers | key 链路可串联 |
| 图像 | `operator_artwork` list + get（MediaWiki 真图） | PNG magic、字节数、二次调用 LRU 命中 |

图像工具重点：`--out` 落盘后 `file` 验证真 PNG；`/debug/cache` 的 `artwork_mediawiki.image_cache` 出现 `hits`（**仅 TS**——TS 带 hits/misses/clears 计数器，PY 的 cache_stats 只有 `{loaded, count, bytes}`，这是已知的 debug 载荷分歧，勿当作 Python 回归）。

## 阶段 4 — LOCAL_IMAGE=true：观察图片 auto-sync

改单元 `Environment=LOCAL_IMAGE=true`（**不设 ORIGINAL_IMAGE**）→ `daemon-reload` + `restart`。预期：

- `Images synced: baseline=… current=… (N artworks)` 完成日志，~1.5GB 量级落盘（large+preview 四个 shard； artworks 数与字节数随 release 漂移，核量级即可）。
- 慢链路中段停滞是正常的——30-min 预算会吸收后自恢复，勿急着重启。
- 重启一次验证 tag 快捷：`Images are up to date` 秒级返回、不重新下载。

## 阶段 5 — 本地模式图像工具

- list（不透明 token + 变体清单）→ get large/preview（真 PNG，尺寸与变体一致）。
- `variant=original`（未同步）→ `图片文件缺失：…` 优雅拒绝。
- 表单别名 `阿米娅(近卫)` 独立解析；跨 form token → `不属于` 拒绝。
- `/debug/cache` 九模块齐全（Bearer debug token）。

## 阶段 6 — 清空缓存后复测 Python

```bash
rm -rf ~/prts-e2e/data-ts        # 按需保留产物
```

Python 单元差异：`ExecStart=<uv 绝对路径> run --directory <repo>/python --locked python -m prts_mcp.server`（**uv 同样不在 systemd PATH 内，须绝对路径**），另加 `Environment=PRTS_TRANSPORT=http`，`XDG_DATA_HOME` 指向 `data-py/xdg`。然后**重复阶段 2–5**。注意 Python 的 sync 日志措辞与 TS 不同（如 `Data is up to date (…)` 而非 `Images are up to date`），核对状态而非逐字 grep。重点对拍：

- 三路 sync 数据量与 TS 同量级（快照时点 108M/384M/33M）
- MediaWiki artwork 载荷与 TS **逐字节一致**（同一 artwork_id 的 base64）
- 24 工具输出与 TS 侧抽查一致（文案漂移按 D2 台账记录）

## 已知正常行为（勿误报为 bug）

- 网络抖动下：TS 图片同步可能长时间停滞再自恢复；Python storyjson 停滞会走 httpx 120s 超时 → 30s/120s/600s 重试梯。
- 进程被杀遗留 `.release.lock`：新进程 120s 锁等待超时 + 30-min staleness 自动回收；测试中可手动删孤儿锁加速——**活性判断看 `owner` 文件的 mtime**（持锁者会心跳续期；注意 `owner` 内容是 UUID 不是 pid，不能按 pid 查）或直接确认没有存活的 prts 进程。
- `ls` 空列表不等于卡死——大 shard 下载期间 staging 目录可能数分钟无新文件。

## 收尾

- `systemctl --user stop/disable prts-e2e-*`；测试数据目录按需清空；产物（真 PNG、client 脚本）可留档。
- 发现的 PY/TS 文案 / 行为漂移：小的一并开 `fix(parity)` PR，大的记 D2 台账。
