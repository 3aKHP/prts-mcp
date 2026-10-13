# P8-final：Linux 本地 TS/v2.8.1 完整复刻验收报告

日期：2026-10-13。范围：`dev/rust-rewrite`（分支 `rust-local`），oracle = 固定 `ts/v2.8.1`（bun 1.3.14 主运行时 / node 24.18.0 副运行时，commit `e0ba360`）。

## 结论

**Linux 本地环境下 TS/v2.8.1 功能与运行行为复刻完成，批准差异见清单（全部 D-001…D-006 有映射与验证），已具备转正评审所需实现和证据。** 24 个工具全实装（IMAGES_ENABLED=false 为 23），全离线差分 384/384，公开 live 互操作 4/4，生命周期（完整更新→离线恢复→旧卷回读）5/5，本地分发三链（独立目录/npm/双 Docker profile）全绿，225 个依赖许可证全为宽松许可。按 docs/09 边界，本报告不构成"3.x 可正式发布"的声明。

## 工具面与四格矩阵（FINAL-surface / FINAL-matrix）

- 工具面：24/23（`IMAGES_ENABLED` 门控；`registry_24_with_images_23_without` 单测 + 差分全工具面 tools/list 5 例含 images-disabled-23）。
- 四格矩阵（HTTP/stdio × legacy/modern）：**全部 24 个工具在每个格子至少 1 例 tools/call**（`artifacts/p8-matrix.json` 逐工具统计；P8 补齐唯一缺口 `wiki.search.modern`——search_prts 的 http-modern 例，golden 已录）。另有协议级会话生命周期/错误/边界 387 例与 `no_such_tool` 错误例。
- 差分总量：`node tools/verify.mjs --all` **384/384 通过**（goldens 全部经真实 oracle 录制；案例源 `contracts/cases/manifest.json` 387 例含协议例）。

## 网络与数据证据（FINAL-live）

- **公开 live 互操作 4/4**（`--live`，TS vs Rust 同源真实 prts.wiki 精确比较；离线=blocked 不计通过）：search 阿米娅、sections、template CharinfoV2 全量渲染、read 分节。
- **生命周期 5/5**（`tools/verify-p8-lifecycle.mjs`）：全新卷经本地镜像用真实 `datarev-26-10-08-04-51-28-56071834-r2` 完整更新并服务；换死镜像重启后工具照常服务且 `.releases` 数与 `extract_meta.json` 字节不变（无破坏性重同步）；旧卷回读——P2 期 TS 写入的 pair 指针卷与 P6 期 TS `syncImages` 写入的 2802 图卷均被 Rust 正常服务。
- P2/P6 互操作史：跨实现写↔读、锁争用、index/PNG 字节一致（reports/P2、P6）。

## 资源与性能对照（FINAL-performance，artifacts/p8-bench.json）

同一本地镜像（真实 release）、同一宿主、客户端计时、/proc 真值。**结论按实测记录，双向都有占优项。**

| 指标 | TS (bun) | Rust | 备注 |
|---|---|---|---|
| 冷全量同步（excel+levels+story, 58MB） | 8.87s | **4.10s** | 2.2× |
| 热无变化周期 | 3.35s | **2.06s** | 60s 间隔实测差 |
| story 全文搜索 冷（含索引构建） | **1.28s** | 2.03s | TS 冷建更快（P4 已如实记录） |
| story 全文搜索 热 p50 | **6.6ms** | 21.3ms | TS 占优 |
| list_stages | 60.9ms | **2.3ms** | 26× |
| search（operators） | 124.6ms | **2.5ms** | 49× |
| 服务进程 VmHWM（同步后稳态） | 561MB / 535MB RSS | **117MB / 117MB** | ~1/4.8 |
| 图片全量同步（2802 PNG / 1.64GB，P6 实测） | 151.8s / VmHWM 914MB | **116.0s / VmHWM 22MB** | 快 24%，峰值内存 1/41 |

历史分项：协议层 P1、同步峰值 P2（Rust 流式 ~23MB vs TS ~321MB）、冷建索引 P4（Rust 冷慢 0.6s/热查 2.7ms 占优）、图片 P6。统一定位：Rust 在同步吞吐、稳态查询延迟、内存上占优；TS(bun/JSC) 在 story 索引冷建与热扫描上占优。

## 独立重建与许可证（FINAL-portable）

- **运行时独立**：独立安装目录在**空 PATH**（无 Node/Bun/Python）下运行全部本地业务（`tools/verify-p7-local.mjs` 6/6：24 tools + gamedata/story/images 真实数据调用）。生产二进制仅依赖 libc/libm/libgcc（glibc 2.39，ubuntu:24.04 镜像同源）。
- **独立重建**：从 `artifacts/p8.bundle`（含本报告的提交）克隆至独立目录 `cargo build --locked --release` 成功，`skeleton/process_p7/gamedata_cases` 测试子集全绿（详见 `artifacts/p8-rebuild.json`；克隆无 `.reference` oracle，差分属开发期工具，不在重建范围）。
- **许可证审计**（`contracts/dependency-licenses.json` v2）：Cargo.lock 全闭包 **225 包**，全部宽松许可（MIT/Apache-2.0/ISC/BSD/Zlib/Unicode-3.0/BSL-1.0/CDLA-Permissive-2.0/Unlicense 及其 OR 组合）；无 GPL/AGPL 独占项（唯一 LGPL 字样为 r-efi 的 OR 备选，未选择）；rquickjs 内嵌 QuickJS（MIT 系，版权声明保留）；打包产物随附外仓 LICENSE (MIT) + NOTICE（PRTS Wiki CC BY-NC-SA 数据条款等第三方声明）。
- 不依赖外层源码、`.reference`、fixtures 或用户 cwd 运行（P7 双 Dockerfile + 独立目录证据）。

## 批准差异清单（FINAL-differences，无未决业务兼容差异）

| 编号 | 差异 | 状态 |
|---|---|---|
| D-001 | 运行时身份：serverInfo.version = `0.1.0+ts2.8.1.local`（不冒充已发布 2.8.1）；差分以 `map-version-d001` 归一比较 | 已映射+全程验证 |
| D-002 | 原生诊断：`prts-mcp.rust.metrics/v1`（/proc RSS 真值、删 V8 堆字段、runtime:"rust"）；cache 域映射含 Rust 专有 `stage.stages_map`（reports/P7.md §诊断映射） | 已实现+进程测试 |
| D-003 | 依赖错误详情：引擎细节差异（正则报错 detail）以 `map-regex-error-detail` 归一；bun 网络/JSON/超时报错文案已逐字复刻故其余差异面为零 | 已映射+差分案例 |
| D-004 | 本地打包身份：`prts-mcp-rust-local`（private）、本地镜像 tag、本地身份版本串；不触碰公开 `prts-mcp-ts`/GHCR 标签 | 已实现+验证 |
| D-005 | HTTP 孤立代理码元请求体：400 + JSON-RPC -32700 明确解析错误（维护者 2026-10-11 批准） | 回归测试守护 |
| D-006 | HTTP 不可解析 JSON：JSON-RPC -32700 替代 oracle 的 Express HTML 页（维护者 2026-10-11 批准） | 回归测试守护 |

另有两项如实登记的非差异观察：容器内 pair 指针随容器层消亡（与旧镜像同构，extract_meta 承载持久）；npm publish 对 `+build` 版本串的自动清洗（本地私有包无发布意图）。

## 验证覆盖汇总

| 套件 | 结果 |
|---|---|
| cargo fmt / clippy(-D) / test --release | 通过 / 0 警告 / 205 |
| 差分 --all | **384/384** |
| 差分 --live（公开上游） | **4/4** |
| 生命周期 verify-p8-lifecycle | 5/5 |
| P7：verify-p7-npm / -local / -docker | 10/10、6/6、11/11 |
| coverage.csv | **全部行 verified，无 not-started** |

复跑入口见 PROGRESS.md 交接节（fixtures → `--all`/`--live` → P7/P8 验证脚本 → benches）。

## 未支持平台与边界

- 平台矩阵仅 **Linux x86_64（glibc ≥2.39；WSL2 + ubuntu:24.04 容器实测）**。未验证：macOS/Windows/ musl/alpine/ 其他架构——不认领（docs/09）。
- Windows LOCALAPPDATA 路径解析为**纯解析 fixture**（单测），非实机验证。
- npm 包为本地私有分发（Node>=18 launcher + linux-x64 二进制）；无公网下载/自更新。
- GHCR 兼容 profile 的 Python 侧仅作旧镜像启动/卷/回滚参照；业务结果一律按 TS 契约。
- E2E 真机全链路（docs/dev/E2E.md 的生产式双实现部署 + 真实 MCP 客户端全工具组）按 WORKFLOW 属维护者逐案裁量项：本阶段以 P7 双镜像 + 真实同步 + 真实上游 live + 生命周期链替代执行，未跑独立 E2E 管线（如实披露）。

## 3.x 转正待决事项（维护者决定，本地实现不自行执行）

| 事项 | 本地已备 | 待决 |
|---|---|---|
| 最终 3.x 技术栈 | 完整复刻+资源证据 | 是否宣布 Rust 为公开主线 |
| 主仓位置与历史迁移 | 本地 Git + bundle（p0…p8） | 迁移方式（subtree/保留历史/评审提交） |
| 版本与命令命名 | 本地身份 + 旧入口 profile 验证 | 外层 3.0 bump、旧 bin 废弃策略 |
| npm/二进制平台矩阵 | Linux 本地 pack/install + 许可清单 | 平台扩展与上传 |
| GHCR 标签与入口 | 配置/卷连续性 + 回读报告 | 更新 latest/2/3 标签 |
| 管理CLI | 无副作用配置解析 + 可复用业务接口 | 3.x CLI 产品范围 |
| 2.x 维护与 Python 归档 | 新旧差异记录 + 回滚方法 | 停止支持时机 |

**用语边界**：可声称"Linux 本地环境下 TS/v2.8.1 功能与运行行为复刻完成（批准差异见清单）"；不可声称"用户换任何平台无感"、"性能必然更好"、"3.x 已发布"。
