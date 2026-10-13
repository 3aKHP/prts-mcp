# P0 源码审计产物

冻结基线：`e0ba36096cdd46640166b0a5db02902fa9a6a24c`（ts/v2.8.1）。本文四张表是 07-phases.md P0 要求的首次源码审计输出；证据全部来自 `.reference/ts-v2.8.1/ts/src` 与已下载的数据资产，行号均指冻结副本。

## 1. GAMEDATA_FILES / metadata 完整字段及锁路径表

### 1.1 数据集必要文件（从 `data/sync.ts` GAMEDATA_FILES、`data/datasets.ts` 原样提取）

| 数据集 | 必要文件（ZIP 内路径） | 源头 |
|---|---|---|
| gamedata.excel（zh_CN-excel.zip） | `zh_CN/gamedata/excel/` 下 11 个：character_table、handbook_info_table、charword_table、story_review_table、enemy_handbook_table、stage_table、zone_table、item_table、building_data、skin_table、skill_table（均 `.json`） | `data/sync.ts:37` GAMEDATA_FILES |
| gamedata.levels（zh_CN-levels.zip） | `zh_CN/gamedata/levels/enemydata/enemy_database.json` | `data/datasets.ts:12` LEVELS_REQUIRED_FILES |
| story.zh_CN（zh_CN.zip） | `zh_CN/gamedata/excel/story_review_table.json`、`zh_CN/storyinfo.json`；验证器另遍历 review 表 `infoUnlockDatas[].storyTxt` → `zh_CN/gamedata/story/<key>.json`，可选 `story_supplement.json` 的 `events[].chapters[].key` 也计入 | `data/datasets.ts:5`、`validateStoryjsonZip` |

三个数据集 `verifyManifest: true`（manifest contractVersion=`prts-mcp-data/v1` 必须匹配）。

### 1.2 持久化 metadata 字段表

| 文件（相对位置） | 写入字段 | 读取兼容 | 源头 |
|---|---|---|---|
| `<archives>/release_meta.json`（每个 archive 旁） | `repo`、`branch`（恒 `releases`）、`commit_sha`、`fetched_at`、`files` | 历史 camelCase：`commitSha`/`fetchedAt` 同样接受 | `sync/release.ts:68-99` |
| `<root>/archives/extract_meta.json` | `commit_sha`、`data_root`（相对 root；realpath 不得逃出 root，否则回退 root） | 仅 snake_case | `sync/releaseActivation.ts:59-92`、`config.ts:activatedRoot` |
| `<共同父目录>/.gamedata_pair.json` | `commit_sha`、`excel_data_root`、`levels_data_root`；成对代际的权威发布点 | 仅 snake_case；任一字段缺失/非法 → 整体视为无 pair | `sync/gamedataPair.ts:61-102`、`config.ts:activatedPair` |
| `<storyjson>/release_meta.json` | 同 release_meta（单 zip 独立） | 同上 | `sync/release.ts` |
| `<images>/.images_meta.json` | `schemaVersion`、`baselineVersion`、`currentVersion`、`shardsSynced`、`generation_root`（代内 meta 无 generation_root） | — | 05 契约 + `sync/generationStore.ts` |
| `<images>/.releases/<gen>/index.json` | 上游资产原样：`schemaVersion`（=`akdp-images/v1`）、`currentVersion`、`baselineVersion`、`artworks`、`shards` | — | 已固化样本 `.runtime/data/images-26-10-08-…/index.json` 实测 |
| 上游 Release `manifest.json` | `pipelineVersion`、`publicationRevision`、`contractVersion`（=`prts-mcp-data/v1`）、`source.versionId`、… | 版本/revision 校验消费 | 已固化样本实测（见 data-manifest snapshot） |
| 捆绑样本 `data/gamedata/cache_meta.json` | `repo`（Kengxxiao/ArknightsGameData）、`branch`、`commit_sha`、`fetched_at`、`files` | 历史格式，仅仓库捆绑参考 | 冻结 tag 实测 |
| 激活签名（非文件） | pair 路径 + 两个 extract_meta 的 `[path, ino, size, mtimeMs, ctimeMs]` 元组 JSON 串 | 用于缓存失效判定 | `activation.ts:checkActivationChange` |

### 1.3 锁路径与调用层级表

| 锁文件 | 位置 | 保护对象 | 获取顺序（不得反向） | 源头 |
|---|---|---|---|---|
| `.gamedata_pair.lock` | excel/levels 共同父目录 | pair 元数据协调 | 第 1 层：pair → excel activation → excel release；释放 excel 后 levels activation → levels release | `sync/gamedataPair.ts:331`、05 契约 |
| `.activation.lock` | 各自 `archives/` 目录 | 代际树发布/staging | 第 2 层（per-archive） | `sync/releaseActivation.ts:200` |
| `.release.lock` | 各自 `archives/` 目录 | Release 下载 | 第 3 层（activation 内部） | `sync/release.ts:376` |
| `.release.lock` | storyjson zip 旁 | story 独立换包 | 独立链 | `sync/release.ts` |
| `.images.lock` | images 根 | 图片代际 | 独立链 | `sync/imagesSync.ts:61` |

锁协议参数（05）：等待 120s、ownerless 宽限 10s、陈旧 30min、心跳 60s、轮询 50ms、代际保留 24h；owner 目录 + `owner` 文件、续租、陈旧先改名隔离（`<lock>.stale-<uuid>`）。`releaseActivation.ts:238` 证实陈旧改名隔离实现。

## 2. 测试取舍表（旧案例 → 保护的契约 → 处置 → 理由）

按 06 的四列格式，覆盖 42 个 TS 测试文件的分组归类：

| 旧测试（冻结 tag） | 保护的契约 | 处置 | 理由 |
|---|---|---|---|
| e2e.test.ts、e2eStdio.test.ts | 四格协议握手/list/call、session 持久、modern stateless、stdio 无 listener | **替代**：cases manifest 差分案例（proto.\*、stage.list.\*） | 进程级差分覆盖同一行为且双实现可跑；比单侧断言更强 |
| sessionIdleTimeout.test.ts | 剩余预算重排、失效 404/-32002、initialize 恢复 | **保留**（P1 Rust 进程级测试 + cases） | 04 明列的会话生命周期契约 |
| serverOutputChannel.test.ts、storyOutputChannel.test.ts | 通道优先级、legacy 会话固定、T 工具纯文本 | **保留**（P1 cases：channel-\* 系列） | 已有 golden 化差分案例承接 |
| serverStartup.test.ts | 启动顺序、stdiou200b无 listener、auto-sync 不阻塞启动 | **保留**（P1/P2 进程测试） | 资源生命周期契约 |
| output.test.ts | renderResult/summarize/图片包装 | **合并**进 P1 output 模块单测 | 纯函数高价值案例 |
| config.test.ts、autoSync.test.ts | 路径/环境变量/interval 解析边界 | **保留**（P1/P2 表驱动单测） | 04 配置清单必须验证的边界 |
| toolSurface.test.ts | 工具面完整（正则扫描 registerTool 字面量）、7 处 RegExp 源码存在 | **不移植**：以实际 tools/list wire 快照 + 搜索语料差分替代 | 06 明示取舍；语言内部断言无用户可见契约 |
| Zod safeParse/手工强转类断言（散见于域测试） | 输入实际接受/拒绝 | **替代**：参数边界差分案例（limit-schema-reject 类） | 保留行为不保留框架内部 |
| registry 重复注册、cacheBust 模块隔离、`__reset*ForTesting`（datasetAccess.test.ts 等） | 多实例隔离、代际失效 | **替代**：Rust 构造器注入 AppState + 代际变化测试 | 06 明示不移植；Rust 无模块重载语义 |
| stores.test.ts | Directory/Zip/Fallback 路径归一化、越界拒绝 | **保留**（P2 存储单测） | 真实防御边界 |
| zipCache.test.ts | ZIP 缓存身份与换包失效 | **保留**（P2/P4） | 换包重新读取契约 |
| sync.test.ts（故障/manifest/锁续租/pair 幂等/防降级） | Release 状态机完整性 | **保留**（P2 全量） | 对应真实历史故障，05 明示不可删 |
| imagesSync.test.ts、generationStore.test.ts | 完整 delta 链、缺中间包不激活 | **保留**（P6） | 同上 |
| 域计算测试：operator/operatorStats/skill/building/enemy\*/stage\*/item/search/sort | 共享 JSON 预期、数值插值、覆盖合并、排序 | **保留行为意图**：复用 tests/parity-fixtures + operator-query-cases 等（P3） | 03 指定的迁移输入 |
| story/storyCharacter/storySupplement/storySummary 测试 | 补充目录链、摘要回退、清洗 | **保留行为意图**（P4） | 2.8.1 新增补充目录契约 |
| prtsTools.test.ts、templateRenderer.test.ts | Wiki 参数映射、模板提取渲染、错误形态 | **保留**（P5 固定响应差分） | 05 网络契约 |
| artworkLocal/artworkMediawiki/images 测试 | 归属、变体、LRU、路径守卫 | **保留**（P6） | 图片安全边界 |
| metrics.test.ts、metricsSampler.test.ts | 计数口径、schema、无敏感字段 | **保留行为意图**：按 D-002 新 schema（P7） | 字段名映射后验证 |
| mock fetch 返回预设字符串的薄包装案例 | 参数映射/错误包装 | **仅按需保留** | 06：避免重复测试 mock 本身 |
| live E2E（E2E_PRTS_API 门控） | 公网互操作 | **保留 blocked 语义**：默认 skip 不计通过 | 06 明示 |

处置动词对齐 06：保留=同语义重写；合并=并入更小单元；替代=更强形态覆盖；不移植=语言/框架内部。

## 3. 跨语言风险案例（正则/排序/浮点/JSON）

P1 探针的具体输入，全部以 Bun 为主 oracle、Node 差异单列：

### 3.1 正则（`new RegExp(pattern, "iu")`，QuickJS 差分）

| # | pattern | 目标文本 | 验证点 | 已知风险 |
|---|---|---|---|---|
| R1 | `""`（空） | 任意 | 空模式匹配一切 | 引擎对空模式处理 |
| R2 | `amiya` | `阿米娅 Amiya` | `i` 大小写折叠 | Rust regex 默认大小写不敏感规则不同 |
| R3 | `\w+` | `罗德岛RhodesIsland` | 中文不在 `\w`、拉丁在内 | Unicode 语义差异 |
| R4 | `\d` | `２０００`（全角） | 全角数字不匹配（JS `\d`=[0-9]） | Rust `\d` Unicode 十进制 |
| R5 | `\s` | 含 `\u3000` 全角空格 | JS `\s` 含全角空白 | 引擎空白类差异 |
| R6 | `\bamiya\b` | `xamiyay amiya.` | 词边界 | Unicode 边界语义 |
| R7 | `^.$` | `𠮷`（astral） | `.` 匹配代理对整体 | UTF-16 vs 码点 |
| R8 | `\p{Script=Han}+` | `龙门近卫局` | Unicode property | regress 明示缺口；QuickJS 待验 |
| R9 | `amiya(?=塔)` | `阿米娅塔` | lookahead | Rust regex 无 |
| R10 | `(?<=阿米)娅` | `阿米娅` | lookbehind | 同上 |
| R11 | `(?<name>阿米娅)\k<name>` | `阿米娅阿米娅` | 命名反向引用 | 同上 |
| R12 | `(a)(b)?\2` | `ab`、`a` | 未参与组反向引用 | 引擎细节 |
| R13 | `(?i)AMIYA` vs `iu` 标志 | — | 内联标志与 `u` 交互 | QuickJS 支持面 |
| R14 | `ſtrasse`（长 s） | `Strasse` | Unicode case folding（`i`+`u`） | 折叠表差异 |
| R15 | `e\u0301`（组合） | `é`（预组合） | `u` 下不自动等价 | — |
| R16 | `[`、`(`、`*` | — | 非法模式拒绝 + 错误文案前缀 | D-003 详情归一化 |
| R17 | `^牙$` | 多行文本含换行 | 锚点与换行（无 m 标志） | — |

### 3.2 排序/切片（UTF-16 语义）

| # | 输入 | 契约 | 源头 |
|---|---|---|---|
| S1 | `["AP_GAMEPLAY","ap_item_1"]` | `compareIds` 是 JS `<`（UTF-16 码元）：大写在前 | `data/sort.ts` 注释明示反例 |
| S2 | `["1.png","1+.png"]` | `1+`(0x2B) < `.`(0x2E) → `1+.png` 在前；localeCompare 相反 | 同上 |
| S3 | `["main_00-01","main_00-01#f#"]` | 前缀相同短串在前（JS `<`）；golden 已固化顺序 `main_00-01` → `main_00-01#f#` | stage.list.default golden |
| S4 | astral ID 混排 | 码元序 ≠ 码点序（仅 astral 段） | `compareIds` 注释 |
| S5 | `stageEnemy` 的 `localeCompare` 案例 | 抓取碰撞输入分别验证 | 10-research 已登记 |
| S6 | `text.slice(0,120)` 描述截断 | UTF-16 码元切片（可能切在代理对中间） | `stage.ts` renderStageSearch |

### 3.3 浮点/数值

| # | 输入 | 契约 | 源头 |
|---|---|---|---|
| F1 | 属性插值 half-away-from-zero | 与 TS `Math.round` 对齐（-0.5 → -0） | operatorStats |
| F2 | `-0` 归一化 | 输出不得出现 `-0` | operatorStats 既有规则 |
| F3 | `pythonFloatString` 格式器 | 沿用 TS 现行为（名称历史遗留） | enemyStats.ts |
| F4 | JSON 大整数（>2^53） | 解析后数值等价比较；安全整数案例不得用容差 | 06 比较规则 |
| F5 | `1` vs `1.0` 文本渲染 | 文本中区别保留（精确字符串比较） | 06 |

### 3.4 JSON/输入边界

| # | 输入 | 契约 | 源头 |
|---|---|---|---|
| J1 | 孤立 UTF-16 代理对（`\ud83d` 单独） | 不无记录丢弃；探针报告 Rust String/serde 差异 | 02 明示 P1 探针 |
| J2 | Zod 未知字段 | extra 字段是否拒绝（实测 tools/call 传未知参数） | 03 参数边界 |
| J3 | `phase:null`/`level:null` vs 缺省 | nullish 语义 | 03 |
| J4 | 整数参数传 `1.0`/`1.5` | Zod `int()` 拒绝 `1.5`；`1.0` 接受？实测固定 | 03 |
| J5 | Object.entries 整数键顺序 | 渲染前顺序语义 | 02 |
| J6 | 顶层非对象 JSON-RPC params（数组/null） | 错误层级与 code | 04 |

## 4. TS source → coverage 映射

以 `research/source-inventory.json` 的 59 个发布源文件为行，映射到 coverage.csv 归属行（状态仍由 coverage.csv 拥有）：

| TS 源组（相对 `ts/src/`） | coverage 行 | 主阶段 |
|---|---|---|
| server.ts、server-core.ts、server-stdio.ts、server-bun.ts | PROTO-http-legacy / PROTO-http-modern / PROTO-stdio-legacy / PROTO-stdio-modern / PROTO-session / OUTPUT-channels | P1 |
| config.ts、activation.ts | CONFIG-all（P7 完整）；P1 仅启动所需子集 | P1/P7 |
| output.ts、tools/registerTool.ts、tools/{gamedata,story,prts,artwork}Tools.ts | OUTPUT-channels + 各 TOOL-\* 行的 schema/包装部分 | P1 起逐阶段 |
| startupSync.ts | SYNC-scheduler | P2 |
| cacheStats.ts、metrics.ts、data/cacheMetrics.ts | DEBUG-native | P7 |
| data/stores.ts | STORE-layout | P2 |
| data/datasets.ts、data/sync.ts、sync/{types,primitives,transport}.ts | SYNC-release / SYNC-integrity | P2 |
| sync/releaseDiscovery.ts、release.ts | SYNC-release | P2 |
| sync/releaseActivation.ts、gamedataPair.ts | SYNC-pair / SYNC-lock / SYNC-recovery | P2 |
| sync/imagesSync.ts、generationStore.ts | IMAGE-chain | P6 |
| data/operator.ts、operatorStats.ts、skill.ts、building.ts | DATA-game-boundaries + TOOL-get_operator_\* | P3 |
| data/enemy.ts、enemyDatabase.ts、enemyStats.ts、enemyRender.ts | DATA-game-boundaries + TOOL-list_enemies/get_enemy_info | P3 |
| data/stage.ts | SLICE-list-stages（P1 纵切）+ TOOL-list_stages/get_stage_info（P3 全分支） | P1/P3 |
| data/levelParser.ts、stageEnemy.ts | TOOL-get_stage_enemies/get_enemy_appearances | P3 |
| data/item.ts、search.ts、gamedataAttrs.ts、messages.ts、sort.ts | TOOL-list_items/get_item_info/search；TEXT-js 归属 sort.ts | P3 |
| data/story.ts、storyReader.ts、storySearch.ts、storySummary.ts、storyMemoir.ts、storyCharacter.ts | TOOL-story 9 件 + STORY-index | P4 |
| data/images.ts、artworkFormat.ts、artworkLocal.ts、artworkMediawiki.ts | IMAGE-local / IMAGE-wiki | P6 |
| api/prtsWiki.ts、api/templateRenderer.ts、utils/sanitizer.ts | TOOL-search_prts/prts_page + WIKI-replay/WIKI-live | P5 |
| （无 TS 对应）data/datasetAccess.ts | 各域缓存行为并入 DATA-\*/STORY-index 测试 | — |

覆盖核对：59 源文件全部落入上表分组（inventory 分组：server 4、config 2、output/registerTool 6、startupSync 1、diagnostics 3、stores/datasets/datasetAccess/sync-barrel 4、sync 8、域 24、api/utils 3——合计与 source-inventory 一致）。`utils/` 其余纯工具并入所属域行。
