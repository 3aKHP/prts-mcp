# 分阶段执行计划

## 顺序与完成规则

主顺序为 P0→P1→P2→P3→P4→P5→P6→P7→P8。每阶段若发现独立任务可并行推进，仍须遵守依赖，不能跳过未通过的对应gate。阶段内允许多个小提交；不是每阶段只能一个大commit。下面工具数指无禁用开关的已实现工具，不含占位注册。

“完成”要求实现、验证、报告、coverage和PROGRESS均一致，并有本地commit可追溯。没有Rust实现前所有阶段保持not-started。计划编写与声明提取不等于P0已完成。

## P0 固定基线和验证入口

输入：本簇、外层固定tag和现有runtime。任务：归档TS源码；按固定lock安装/构建oracle；固定数据manifest和最小fixture；提取真实四格协议请求/响应与tools/list；建立差分runner、预期文件和比较规则；创建Rust最小package、toolchain/lock；记录选用依赖和许可证。只需无业务副作用的可启动骨架，不注册24个空壳。

首次源码审计还要输出：GAMEDATA_FILES/metadata完整字段及锁路径表、测试取舍表、跨语言风险案例（正则/排序/浮点/JSON）、TS source-map到coverage。已有tool-declarations与inventory用于加速，不代替这些执行产物。

完成条件：oracle可重复启动且没有污染真实数据根；固定提交/依赖/数据hash已记录；runner能对同一TS运行两次得到无非预期差异，并能通过人工修改一份捕获结果证明差分失败有效；Rust骨架可构建。该一次runner自检只验证工具可信度，不建立庞大的测试框架自测。

交付：`contracts/wire/`、`contracts/cases/`、`contracts/data-manifest.json`、`reports/P0.md`、Cargo工程。工具数0。

## P1 协议和语言兼容的第一条完整链

输入：P0。任务：实现thin MCP适配、HTTP/stdio、legacy/modern、基本配置及output包装；DirectoryStore最小读取；真实 `list_stages`；session idle和失效initialize恢复；QuickJS正则差分探针；UTF-16排序/切片、浮点/JSON边界探针。提前选择可用SDK/正则，避免大部分业务完成后才发现无法兼容。

完成条件：list_stages四格协议与三通道成功；23/24最终schema尚不要求全部注册，但P0全声明已固定；空数据服务仍启动；modern坏信封不降级；stdio无listener及stdout污染；regex指定语料无未解释匹配差异。不能把单个hello-world当完成。

交付：可真实调用的1工具Rust程序、`reports/P1.md`、锁定正则/SDK选型证据。P1探针若阻塞仅其依赖任务暂停，不授权减少最终功能。

## P2 数据基础和同步恢复

输入：P1协议骨架，P0数据格式。任务：完整Directory/ZIP/fallback；RuntimeConfig/DataView分离；GameData成对代际与缓存身份；Release发现/版本/manifest/流式下载/解压/锁；Story换包；后台调度；TS/Rust隔离共享卷互操作。图片只搭可共用的文件发布原语和index解析最小案例，完整链留P6。

完成条件：05列出的GameData/Story关键失败、恢复、防降级、未变化幂等、并发锁案例通过；list_stages跨更新仍同代；缺数据→后台出现数据不重启可读；阶段sync峰值已测，不能保持整包多份缓冲而声称完成内存优化。性能优化本身可继续迭代，但正确性不能延期。

交付：`reports/P2.md`（含锁/metadata格式表和故障状态证据），工具仍1个。

## P3 完整 GameData 工具域

输入：P2存储/激活，P1文本兼容。任务按可独立验证顺序：operator身份/档案/台词/basic；building/skill/stats；enemy/level parser/stageEnemy；stage/item；统一search六scope。补齐P1 list_stages全部分支。

完成条件：12个GameData工具全部实现，basic/skills/stats和六scope无缺项；共享结果、数值案例、排序/分页/空结果/缺数据通过；每个工具默认调用四格协议；所有S工具三通道。没有新领域、额外参数或“更合理”的排序。

交付：`reports/P3.md`，累计12工具。

## P4 完整 Story 工具域

输入：P2 ZIP/身份，P1正则。任务：9个story工具、摘要链、Decision/文本清洗、密录/角色追踪、肉鸽supplement整条链；共享单份剧情索引与缓存更新。先用最小fixture实现，再同阶段跑完整规模。

完成条件：9工具全部分支通过；include_summaries默认false；旧包无补充目录、新包及坏可选目录行为明确；全规模搜索结果与顺序对齐；换包重新构建一次并可释放旧索引；冷/热测量与多会话共享证据已记录。

交付：`reports/P4.md`，累计21工具。

## P5 Wiki 和模板

输入：P1 HTTP/output，P0网络fixture。任务：search_prts与prts_page全部5action、请求节流/代理、redirect/filter、HTML清洗、模板提取与批量渲染。优先做固定响应差分，再少量公开live互操作。

完成条件：两工具所有action/搜索模式/出入链/空页面/异常通过；template仍纯text；节流真实并发不超预约间隔；不改用extracts；实际公开Wiki读取成功或明确live阻塞。live阻塞可继续P6离线工作，但最终不计通过。

交付：`reports/P5.md`，累计23工具。

## P6 图片完整实现

输入：P2发布原语、P3干员身份/skin元数据、P5 Wiki客户端。任务：local/Wiki两后端、form/token、3variants、LRU；完整baseline/delta下载/校验/激活；original开关；旧图片卷互操作。

完成条件：list→get成功及跨形态拒绝；固定图片字节hash一致；Wiki大小/MIME/host/magic边界；完整delta-chain、缺中间包不激活、离线恢复；IMAGES_ENABLED=false为23工具；完整规模图片同步测量。不得只实现list或只接Wiki。

交付：`reports/P6.md`，累计24工具。

## P7 配置 诊断和部署闭环

输入：全部业务域。任务：补齐04全部环境变量及入口profiles；Rust metrics/cache映射；native发布目录、两种Docker profile（TS HTTP与GHCR默认stdio）、私有npm薄包装3bin；信号/EOF/退出；bundle fallback和相对路径；独立安装目录无外层依赖。

完成条件：仅Rust binary即可跑全部本地业务；npm包本地pack/install后3入口语义正确、stdio透传和信号/退出码；两个镜像默认值正确；4卷及既有GHCR配置副本可用；Rust写后旧TS与旧GHCR读取成功；debug错误认证404且无敏感字段；diagnostics mapping完整。镜像仅本地tag，npm包private，不推公开registry。

交付：`reports/P7.md`、打包脚本与本地安装证据、诊断迁移映射。仍24工具。

## P8 完整复刻收口与转正就绪评估

输入：P0–P7各阶段证据。任务：coverage逐行清零；全离线合集；全工具四格协议；完整数据与网络live；一次完整更新/离线恢复/旧卷回读；统一性能对照；从独立目录重建；文档/许可证/依赖清单审计。

完成条件：必需验收行全部verified且证据与最终commit关联；无未决业务兼容差异；D-001至D-004均有映射/验证；live未执行必须显示未完成；Rust程序不依赖参考TS源码或JS/Python业务进程。性能结论按实际结果写，不制造语言优势。

交付：`reports/P8-final.md`包含完整复刻结论、偏差清单、验证覆盖及未支持平台、资源对照、3.x转正待决事项。只有此阶段可写“Linux本地TS/v2.8.1完整复刻已验收”，不能写“3.x已可正式发布”。

## 跨阶段任务拆分原则

一次提交一个可审阅意图，例如“skill占位符渲染及对应oracle案例”，不要每个文件单独提交，也不要24工具同一大提交。先完成能工作的纵向链，再扩同类工具。重构和行为差异分别记录；纯内部重构通过同一契约测试即可，不要求新增镜像测试。

阶段回归失败立即定位到契约行，修复后跑相关集合，再阶段全量。不因延期把必需行移出coverage，不追逐新的2.x功能。估时依据P1/P2/P3实际移植速度更新，当前不承诺总天数。
