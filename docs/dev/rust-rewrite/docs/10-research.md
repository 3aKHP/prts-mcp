# 调研证据与迁移风险

## 调研范围与结论

本次检查固定TS/v2.8.1的工具声明、输出、server/config、存储/激活、sync、图片、Wiki、GameData/Story职责与相关测试，并核对Rust依赖的官方文档。发布源码59文件12650物理行，测试42文件10578行，共享JSON fixtures55文件1338行。数量来自 [source-inventory.json](../research/source-inventory.json)，包括注释与空行，不是业务SLOC或工作量估算。

现有结构与测试足以支撑迁移开工；风险集中于协议SDK默认值、JS文本语义、持久化状态机和资源生命周期。完整复刻的主要工作不只是注册24工具。P1/P2优先消除跨语言和同步风险，之后逐域补齐；中途每阶段仍生产可用代码，避免把整个工作做成最终丢弃的探针工程。

原有 [统一技术栈评估](../../docs/working/3.x-unified-stack-assessment.md) 的阶段B是选型最小切片；本次维护者已把本地终点扩大为完整TS2.8.1复刻，本簇在执行范围上取代该最小切片建议，但不改变原文未公开承诺3.x的状态。[管理CLI评估](../../docs/working/3.x-management-cli-assessment.md) 仍是另一个主题。

## 源码职责映射

下表路径相对固定发布树；完整路径及hash由inventory拥有。执行阅读时用 `.reference/ts-v2.8.1/`，不是移动develop。

| TS源组 | Rust责任及需读的证据 |
|---|---|
| server.ts、server-core.ts、server-stdio.ts、server-bun.ts | app/protocol，入口、era、session、server身份；e2e/e2eStdio/sessionIdleTimeout/serverOutputChannel/serverStartup |
| config.ts、activation.ts | RuntimeConfig/DataView，启动与动态数据分离；config/autoSync测试 |
| output.ts、tools/registerTool.ts、tools四注册文件 | schema、validation、结果包装；toolSurface/output/storyOutputChannel/prtsTools |
| startupSync.ts | single-flight、retry、周期调度；autoSync及serverStartup |
| cacheStats.ts、metrics.ts、data/cacheMetrics.ts | Rust诊断投影；metrics/metricsSampler，以及bench-memory脚本 |
| data/stores.ts、datasets.ts、datasetAccess.ts、sync.ts | 存储与共享contract；stores/datasets/datasetAccess/zipCache |
| sync/types.ts、primitives.ts、transport.ts | 类型、文件原语、镜像/代理；sync测试 |
| sync/releaseDiscovery.ts、release.ts、releaseActivation.ts、gamedataPair.ts | 发现→校验→发布；sync/autoSync及共享data-release-selection |
| sync/imagesSync.ts、generationStore.ts | 图片链与代际；imagesSync/generationStore |
| data/operator.ts、operatorStats.ts、skill.ts、building.ts | 干员身份/面板/技能/基建；同名测试及operatorQuery |
| data/enemy.ts、enemyDatabase.ts、enemyStats.ts、enemyRender.ts | 敌人归一化、覆盖、输出；enemy/enemyStats |
| data/stage.ts、stageEnemy.ts、levelParser.ts | 关卡列表/详情/出怪/倒查；stage/stageEnemy |
| data/item.ts、search.ts、gamedataAttrs.ts、messages.ts | 物品/统一搜索/属性/错误文案；item/search/datasetAccess |
| data/story.ts、storyReader.ts、storySearch.ts、storySummary.ts、storyMemoir.ts、storyCharacter.ts | 9剧情工具和ZIP身份；story/storyCharacter/storySupplement/zipCache |
| data/images.ts、artworkFormat.ts、artworkLocal.ts、artworkMediawiki.ts | 图片schema/两后端/皮肤元数据；images/artworkLocal/artworkMediawiki |
| api/prtsWiki.ts、api/templateRenderer.ts、utils/sanitizer.ts | Wiki网络/文本与模板；prtsTools/templateRenderer/artworkMediawiki |
| data/sort.ts、utils/numbers.ts | JS排序和既有数值格式；sort/operatorStats/skill |

## 已发现且必须处理的事实

| 发现 | 证据 | 对执行的影响 |
|---|---|---|
| 发布tag精确SHA已确认 | git rev-parse，baseline.json | 不以2.8.2-dev包身份作为最终oracle |
| list_stories默认摘要开关为false | tools/storyTools.ts | 纠正旧叙事文档的true，不改源码基准 |
| legacy output channel会话固定 | server.ts创建server时resolveOutputChannel | 区分modern每请求语义，加入串会话测试 |
| schema可能先于领域逻辑拒绝输入 | registerTool.ts、Zod object | MCP端到端验收不能只测内部函数 |
| JS/Python正则有已知分歧 | toolSurface.test.ts的Unicode案例注释 | 只对齐JS，不取两端并集 |
| UTF-16切片/比较与localeCompare共存 | sort.ts、item/stage/enemy、stageEnemy.ts | 逐调用语义固定，不全局换一个“更合理排序” |
| config与activation循环；building与operator回边 | 相应源码与STYLE例外 | Rust显式状态/身份catalog可消债，但保持动态更新 |
| registry有为重导入服务的逻辑 | datasetAccess.ts及其tests | 不复制cacheBust和运行时内部类型防守 |
| release下载后整包缓冲，hash再readFile | sync/release.ts | 有流式优化机会，收益需实测，校验/发布语义不变 |
| pair no-op幂等和images多delta已有回归 | sync.test.ts、imagesSync.test.ts | 不把这些故障测试当成垃圾删掉 |
| 可选story目录的读与同步校验不同 | storyReader.loadEventTable、datasets.validateStoryjsonZip | 区分旧包兼容与新包完整性 |
| JS专属诊断不能假装Rust也有 | metrics.ts | 维护者已批准D-002显式schema适配 |

## Rust依赖查证

查证日期2026-10-11。只使用官方仓库和crate维护者文档；没有在本轮编译Rust探针，因此“可用候选”与“PRTS兼容通过”分开。

| 来源 | 核对事实 | 计划落点 |
|---|---|---|
| [官方Rust SDK](https://github.com/modelcontextprotocol/rust-sdk)、[rmcp 3.5.1发布](https://github.com/modelcontextprotocol/rust-sdk/releases/tag/rmcp-v3.5.1)、[crate文档](https://docs.rs/rmcp/3.5.1/rmcp/) | 官方Tokio SDK；有stdio/Streamable HTTP，文档描述新旧生命周期 | P1固定3.5.1，验证实际项目矩阵，不能凭SDK宣称省略验收 |
| [regex](https://docs.rs/regex/latest/regex/) | 不支持look-around和反向引用 | 不作为用户pattern唯一引擎 |
| [regress 0.12.0](https://docs.rs/regress/0.12.0/regress/) | 目标ECMAScript，有回溯特性；文档列Unicode property escapes缺口 | 不因“ECMAScript”名字就认定全兼容 |
| [rquickjs 0.14.0](https://docs.rs/rquickjs/0.14.0/rquickjs/)、[QuickJS](https://bellard.org/quickjs/) | 嵌入式JS绑定；Runtime/Context有锁和线程约束 | 窄正则组件，P1测兼容和跨线程使用，禁止直接持锁跨异步业务 |
| [reqwest ClientBuilder](https://docs.rs/reqwest/latest/reqwest/struct.ClientBuilder.html) | 默认超时/代理/redirect策略不等于TS | 显式设置并按TS测试；不采用库默认值作契约 |
| [zip ZipFile](https://docs.rs/zip/latest/zip/read/struct.ZipFile.html) | 原始成员名不安全；enclosed_name检查与mangled_name改写不同 | 拒绝不安全路径，不通过改写路径“修复”包内容 |

crate文档是选型证据，具体版本和API以P0的Cargo解析/源码为准；引用latest的条目不是依赖锁。P0保存精确版本、features、license和对应文档URL。嵌入C库、TLS链接、二进制大小和cross-compile影响列入依赖记录；此项目要求Rust业务实现，不要求所有依赖必须pure Rust。

## 风险与阻塞动作

| 风险 | 首次解决阶段 | 不满足时动作 |
|---|---|---|
| rmcp无法保持legacy/modern边界 | P1 | 最小复现，评估薄适配；大幅私有协议栈需要维护者决策 |
| 正则匹配/Unicode无法对齐 | P1 | 不缩语法；提交引擎/版本差异方案，阻塞依赖的搜索验收 |
| JSON/UTF-16/排序改变结果 | P1/P3 | 实现必要窄兼容函数；无法对齐输入集需显式决策 |
| 并发查询跨代、旧卷不可回读 | P2 | 修快照与发布顺序，不能用“暂不支持更新”豁免 |
| 开放上游JSON被Rust强类型过度拒绝 | P2/P3/P4 | 边界宽容解析为实际消费类型，保留已有容错 |
| 图片只测最新delta遗漏中间链 | P6 | 固定多代输入与失败案例，全链通过前不验收 |
| npm/GHCR入口被统一默认值破坏 | P7 | 使用独立薄profile，业务状态仍共享同一实现 |
| 本地通过但依赖外层路径 | P7/P8 | 独立目录重建、无Node/Python原生运行验证 |

不预估重写只需几天，也不预设Rust性能胜出。P1/P2的复杂度与P3按域移植速度是后续估时依据。发现关键问题可调整阶段内部任务顺序，但完整复刻的最终必需清单不自动缩减。
