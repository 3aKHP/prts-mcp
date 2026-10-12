# 执行进度

最后更新：2026-10-13（P7 完成）。

| 阶段 | 状态 | 报告 | 下一步 |
|---|---|---|---|
| P0 | complete (tag local/p0-complete) | [reports/P0.md](reports/P0.md)、[reports/P0-audit.md](reports/P0-audit.md) | — |
| P1 | complete (tag local/p1-complete) | [reports/P1.md](reports/P1.md) | — |
| P2 | complete (tag local/p2-complete) | [reports/P2.md](reports/P2.md) | — |
| P3 | complete (tag local/p3-complete) | [reports/P3.md](reports/P3.md) | — |
| P4 | complete (tag local/p4-complete) | [reports/P4.md](reports/P4.md) | — |
| P5 | complete (tag local/p5-complete) | [reports/P5.md](reports/P5.md) | — |
| P6 | complete (tag local/p6-complete) | [reports/P6.md](reports/P6.md) | — |
| P7 | complete | [reports/P7.md](reports/P7.md) | — |
| P8 | not-started | — | 最终全范围验收与转正评估 |

## P1 交付摘要（2026-10-11）

- **选型落定**：rmcp 3.5.1 经 `examples/rmcp_probe.rs` 实证无法复现 oracle wire 指纹（SSE priming/帧、未知会话体、discover 版本集、modern JSON 格式）→ 薄 JSON-RPC 适配（`src/protocol`），rmcp 留 dev-deps 保证据可复现。
- **协议层**：HTTP（SSE 帧、202/404/405/406/415、会话 idle 剩余预算重排、失效 initialize 恢复、legacy 通道会话固定 vs modern 逐请求）+ stdio（时代规则、stdout 纯净、EOF 退 0）。
- **第一条完整链**：真实 `list_stages`（DirectoryStore 读取、UTF-16 排序、Zod 等价校验含 JS 数字语义与多字段错误、oracle 逐字 schema、三通道包装）。
- **语言探针**：QuickJS 正则适配器 49 例语料与 Bun 零差异；UTF-16 排序/切片、浮点整数语义差分；J1 孤立代理对边界实证并登记维护者决策项。
- **验证**：差分 31/31（四格×三通道+会话生命周期+空数据启动）；进程测试（无监听、双会话通道隔离）；fmt/clippy(-D)/test(28)/release 全过；Node 辅助对照 2 案例；性能基线入 `artifacts/p1-bench.json`。
- 工具数 1（阶段契约）；24 工具面 tools/list 差分以 `diff_phase=P8` 推迟（07 明示允许）。
- **维护者 2026-10-11 批准差异**：D-005-input-surrogate-rejection（拒孤立代理码元+明确解析错误）、D-006-unparseable-body-json-error（400+JSON-RPC 解析错误替代 HTML 页）——已登记 baseline.json 并配回归测试；有效代理对/正常 Unicode 由 `stage.list.chapter-astral-pair` 差分与截断单测守护。

## P2 交付摘要（2026-10-11）

- **存储**：Directory/Zip/Fallback 三存储完整读路径（primary 坏 JSON 不静默回退、不安全路径报错传播）+ 代际指针读取器（activatedRoot/activatedPair，realpath 逃逸拒绝）。
- **Release 状态机**：fresh 跳过、离线/no_data 分支、盲下载（仅镜像+无记录版本）、防降级（tuple 比较、记录版本阻止替换、重复身份 fail-closed）、manifest 全错误族校验；`data-release-selection` 9 例共享发布语料通过。
- **锁**：目录 owner 租约协议（心跳 utimes、陈旧隔离、释放前 owner 校验）与 `.gamedata-pair → activation → release` 层级；跨进程（Rust↔真实 TS dist）双向争用验证。
- **成对代际**：双幂等守卫（#152 activationSha 短路、#155 pair 无变化不重写——inode/mtime 级断言）；混合代不发布；Story 原子换包。
- **架构**：TS `config↔activation` 循环按计划消解——RuntimeConfig 静态 + DataState 签名缓存快照，单次工具调用单代一致，缺数据→后台激活→不重启可读（输出与 TS golden 逐字节一致）。
- **调度**：single-flight、30/120/600s 密集重试（仅启动轮）、周期不重叠、interval=0 仅启动；stdio EOF 在重试已武装时 <10s 退 0。
- **互操作**：TS 写↔Rust 读 / Rust 写↔TS 读 / 元数据字节一致 / 锁争用 5 案例全过；差分案例 `stage.list.pair-activated`（TS 同步代码写入的 fixture 卷）33/33。
- **峰值**：3 轮实测（artifacts/p2-bench.json）：Rust 冷同步峰值 RSS ~23MB（流式，不随 60.6MB 包体增长）vs TS ~321MB（整包缓冲）；无变化周期 454ms。
- **门禁**：fmt/clippy(-D)/112 测试/release 全过；P0 自检 29/29、P1 32/32、P2 33/33 差分。
- 工具数 1（阶段契约）。图片完整链（baseline/delta/.images.lock）按计划留 P6；bundle 回退与入口 profiles 留 P7。

## P3 交付摘要（2026-10-11）

- **12 个 GameData 工具全部实现**：operator 档案/语音/basic（basic/skills/stats 三 action）、list/get enemy、stage-enemies、appearances、get_stage_info、list/get item、六 scope 统一 search；list_stages 分支补齐。声明字节取自 oracle tools/list 捕获；注册顺序=oracle 顺序。
- **数值/文本保真内核**：roundHalfAway、JS Number→string（最短往返+指数阈值）、V8 实测 toFixed（精确二进制值半离零、-0）、pythonFloatString/千分位、stripWikitext 六遍（含 oracle 实证的 category 死代码遍）、QuickJS `iu` 正则复用。
- **ICU localeCompare**：stageEnemy 计数并列 tie-break —— 从 oracle 逐对探测导出 95 字符 ASCII 权重表（零传递矛盾），15 探针单测钉死；与 compareIds（UTF-16）按 docs/02 分离实现。
- **Zod 4.3.6 等价校验**：11 条探针文案（enum/boolean/nullish/int/bounds/多字段顺序）单测钉死；协议层 -32602 record 校验复用 P1。
- **每代数据集缓存**：datasetAccess 对应物挂 DataView（成功缓存/失败重试/换代释放）；levelsStore `zh_CN/gamedata/levels` 根与 excelStore null 文案差分钉死。
- **差分 157/157**（P3 124 新例）：四格矩阵 44、S 工具三通道全覆盖、成功/空/缺数据/参数分支齐备；`minimal-gamedata-v2` fixture（13 文件）登记 data-manifest；`map-regex-error-detail` 归一化（引擎详情差异，docs/06 依赖详情规则）。
- **语料单测**：operator-query-cases 16 例、operator-talent-cases 3 例、tool-bounds、trap 同名优先级、同代缓存——语料入库 contracts/cases/。
- **门禁**：fmt/clippy(-D)/136 测试/release；P0 自检 29/29+变异、P1 32/32、P2 33/33 全保持。
- 全规模 GameData 差分与冷/热测量按计划归 P4；`/debug/cache` 映射留 P7。

## P4 交付摘要（2026-10-12）

- **9 个 Story 工具全部实现**（累计 21，`registry_has_21_tools_at_p4` 钉死）：events/list/summary/read/activity/search/memoir/appearances/speakers；T/S 通道与 oracle 摘要覆盖（memoir 自定义 summary）一致。
- **保真内核**：cleanText（`{@nickname}`→博士+去标签）、Decision 标量/数组/对象、sticker content/text、pyRepr、摘要三级回退（summaries 覆盖 storyinfo→storyInfo）、read_activity 分页与坏章跳过、错误分层（未找到裸返回 vs `读取…失败：` 前缀）、发言计数降序+码点并列。
- **supplement 整链**：发现→列表→读取→搜索→角色追踪（roguelike 案例集）；review 碰撞不覆盖、坏 supplement 降级、NONE 非密录不入索引。
- **共享单份索引**：进程级单例按 zip stat descriptor 身份缓存；换包重建恰一次（计数断言）+ 旧索引随末位读者释放（RSS 110.7→104.3MB 证据）+ 4 线程单飞（构建恰一次）；多会话共享（bench wall=1.13× 单建）。
- **差分 275/275**（P4 +118：story 98 + 全规模 20）：四格 36 cell、S 工具三通道、全分支；`full-story-r2`（真实 datarev excel+story zip，hash 入 manifest）全规模搜索顺序与 golden 逐字节一致；P3 遗留的 GameData 全规模代表 8 例一并通过。
- **性能**（artifacts/p4-bench.json）：冷建索引 Rust p50 1828ms/峰值 108MB vs TS(bun) 1216ms/427MB（冷慢 0.6s 如实记录，热查 2.7ms vs 4.0ms 占优）；换包 28ms/1929ms 恰一次。
- **门禁**：fmt/clippy(-D)/140 测试/release；P0 自检 29/29+变异、P1 32/32、P2 33/33、P3 157/157 全保持；`--all` 275/280（5 个 P8 全工具面案例按计划）。

## P5 交付摘要（2026-10-12）

- **2 个 Wiki 工具全部实现**（累计 23，注册顺序=oracle 实测 tools/list 顺序：prts → gamedata → story → artwork(P6)）：`search_prts`（S 三通道）与 `prts_page`（T 全通道纯文本，5 action）。工具层 dispatch 升级为 boxed-future 异步插槽（TS handler 异步对应物），21 个既有同步 dispatcher 经宏包装零改动。
- **Wiki 客户端**：进程级 1.5s 节流（先占槽后等待，并发各自独立槽位——并发单测断言最小间隔）、每请求 15s 超时、`PRTS API error: HTTP <n>`；代理与 CA 走环境（bun 小写 `https_proxy`+`NODE_EXTRA_CA_CERTS` 对应 reqwest system-proxy + 同名 CA 钩子）；bun 1.3.14 的网络/JSON/超时报错文案逐条探针钉死（Unable to connect… / Failed to parse JSON / The operation timed out.）。
- **文本管线 = QuickJS 内嵌 oracle 原文**：unescapeHTMLEntities（命名表+数值/十六进制、未知保留）、cleanSnippet、stripHtml（CSS/JS/RLQ/style/script 块 + 标签 + 实体 + 空白折叠）、isTechnicalPage、isRedirectLike —— TS 正则源码原样运行于 QuickJS（与 regex_compat 同一安全姿势），探针单测钉死。
- **模板链完整**：FXP 行为等价的宽容 XML 解析器（错配闭合接受/EOF 自动闭合/`<<<<` 抛错——三条行为均对 FXP 实测）；parsetree→wikitext 重建（template `{{…}}`、tplarg **三开二闭 oracle 实证怪癖**、link、comment 元素）；needsRender 判定（`<comment>` 元素在跳过表——实证）；PRTSMCP uuid marker 批量单 POST 渲染+顺序/唯一/边界五重校验+切片；`_positional`/`_comment`/空值跳过；TemplateRenderError 与裸错误双层（工具层固定建议文案）。
- **MITM 回放差分装置**（tools/wiki-replay.mjs）：本地 CA+SAN 证书（openssl）、CONNECT 隧道 TLS 终结（ALPN http/1.1——rustls 需要）、固定脚本 `contracts/wiki-replay/*.json`；GET 规则**精确参数集匹配**（把请求形状本身钉进 golden——"不用 extracts" 由 prop=text 规则反证）；POST 子集匹配 + render_segments 按请求 marker 动态回显（乱序/缺标记/空渲染注错）；死代理/HTTP500/坏JSON/15.5s 延迟超时全注入。
- **差分 P5 337/337**（+62 wiki 用例，goldens 全经真实 HTTP/TLS 录制）：search 22（text/title/技术页过滤/limit 夹取/redirect 三链/边界与类型错误/三通道/四类网络失败）、page 24（read/sections/categories/links 出入链/enum 缺失新文案/action 非法/section_index=null 拒绝）、template 17（解析重建/批量渲染/五类渲染失败/两通道）。
- **公开 live 互操作 4/4**（`--live` 首次实装：TS vs Rust 同源真实数据精确比较，离线=blocked 不计通过）：search 阿米娅、sections、**template 阿米娅 CharinfoV2 全量渲染**、read 分节——两实现字节一致。
- **门禁**：fmt/clippy 0 警告/165 测试/release；P0 29/29+变异、P1 32/32、P2 33/33、P3 157/157、P4 275/275 全保持；`--all` 337/342（5 个全工具面 tools/list 案例仅剩 数量24≠23 一项差异，P6 落地 artwork 后转绿）。

## P6 交付摘要（2026-10-13）

- **operator_artwork 落地，24/23 工具面收口**：`registry_for(images_enabled)` 与 TS 同门（IMAGES_ENABLED=false 仅摘 artwork=23）；`--all` 383/383 全绿，P0 起延迟的 5 个全工具面 tools/list 案例转绿（oracle 顺序 prts→gamedata→story→artwork）。
- **local 后端**：AKDP index 解析复用 P2 `parse_index`；阿米娅(近卫)/(医疗) 表单别名（全/半角括号归一）；label 三级（displaySkin.skinName→theme 占位→#N 程序化）；skin_table 经每代 dataset 缓存；get 的 realpath 双解析包含守卫（symlink 逃逸拒绝单测）；变体缺失/归属错误/未知 token/无代目录全分支。
- **MediaWiki 后端**：allimages 分页(≤50页 continue 合并)+CharinfoV2 标签 join（list）+imageinfo（get）+download_image_safe（HTTPS+media.prts.wiki+重定向终 URL 复查+MIME 三类+**HTTP body 字节 1MiB 上限**+PNG/JPEG/WebP magic）；256MiB LRU（PRTS_IMAGE_CACHE 开关）；文件名解析（skinN→时装N名称、Nb 建筑小人剔除、(形态)后缀）。
- **图片块输出**：ToolOutcome 携 image block——所有通道 text 后附 image；structured 摘要文本+structuredContent；base64 标准 RFC4648（含 0..255 全字节向量单测）。
- **完整同步链**（src/sync/images_sync.rs）：tag 隔离发现（latest images- 前缀排除 baseline）、index 权威 currentVersion 对账（漂移 fail-closed）、delta 链枚举（定宽字典序、重复 fail-closed、>100 release 翻页覆盖链首）、缺 delta 资产 **在 baseline 下载前** 快速失败、baseline 4/6 分片（original 开关）或 fast path 复制前代+仅增量 delta、逐文件 sha256 校验（缺失即失配）、权威 index.json 字节直写、原子激活、.images.lock 复用 P2 租约协议、24h 清理。
- **状态机 8 场景单测** + **TS↔Rust 互操作**（真 TS syncImages 经本地镜像写卷→Rust 工具读；Rust 写→TS activeGenerationSync+全 PNG hash 读回；index.json/PNG 字节跨实现一致）。
- **差分 P6 378/378（+41 例）**：local/MW 双后端全分支、图片 base64 逐字节、边界注入（host/MIME/magic/gzip 解码后 1MiB 超限）、通道矩阵、参数面、IMAGES_ENABLED=false=23；单测 189 全绿、clippy 0、fmt 干净。
- **完整规模真实同步测量**：见 artifacts/p6-images-bench.json（TS 与 Rust 双实现、真实上游、时长/内存/文件数字节）。

## P7 交付摘要（2026-10-13）

- **入口 profiles + PORT 语义**：4 类入口按 docs/04 落地；PORT 按 profile 分裂——TS profile 完整 JS Number 语义（hex/科学计数/Infinity/NaN/0/-1，bun 实测钉死：NaN/0/-1 绑临时端口、3000.5 截断、70000→65535、日志逐字回显）；GHCR profile python int() 语义（非法退出 1+原文案、stdio 不解析）。
- **诊断 D-002**：/debug/cache（11 域真实缓存计数，含 Rust 专有 stage.stages_map 映射说明）+ /debug/metrics（prts-mcp.rust.metrics/v1，/proc RSS 真值、无 V8 堆字段）；Bearer 常量时间认证、错误一律 404 "Not Found"；PRTS_METRICS_ENABLED 严格 true。
- **信号/EOF**：不装 handler（与 oracle 一致）——SIGTERM/SIGINT 即时信号终止（下载不阻塞）、stdio EOF=0；进程测试钉死。
- **Bundle fallback**：--bundle-root > Docker /app/data > bin/../data 三级解析；TS BUNDLED_* 语义复刻（pair→extract_meta→完整性门）；独立目录进程测试双路验证。
- **本地分发**：package-native.mjs 产出独立目录 + npm tarball + 双 Docker context；npm 薄包装 3bin（launcher 传 bundle root、argv/stdio/信号/退出码全透传，private:true）；两 Docker profile（TS=HTTP:3000 / GHCR=stdio+PRTS_TRANSPORT）本地构建验证；容器内经本地镜像真实同步 4 卷，旧 TS（bun dist）与旧 GHCR（python）读 Rust 卷成功。
- **验证**：205 单测/进程测试（+16）、差分 383/383 保持、verify-p7-npm 10/10、verify-p7-local 6/6（空 PATH 纯 native 全本地业务）、verify-p7-docker 11/11；coverage P7 7/7 verified。

## 交接入口

- 分支 `rust-local`；HEAD 见 `git log -1`（tag local/p4-complete）；工作树干净。
- 阶段 bundle：`artifacts/p0.bundle` … `artifacts/p4.bundle`（hash 以最终文件为准；请维护者另存备份并自行记录）。
- 差分重跑：`node tools/verify.mjs --phase P6`（Rust 需 `cargo build --locked --release`；fixture `node tools/make-fixtures.mjs && node tools/make-fullscale.mjs && node tools/make-images-fixture.mjs`）；live `node tools/verify.mjs --live`；性能 `node tools/bench-p4.mjs`、图片全规模 `node tools/bench-p6-images.mjs`。
- P8 输入：coverage 仅剩 FINAL-* 6 行；差分 --all 383/383 与 live 4/4 可直接复跑；性能对照需统一口径重测（docs/06）；独立重建从 build/package 复制目录或 `package-native.mjs --skip-build` 重新产出；许可证审计基于 contracts/dependency-licenses.json + 打包产物 LICENSE/NOTICE。
