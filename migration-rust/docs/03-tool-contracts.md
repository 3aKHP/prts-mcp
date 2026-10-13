# 工具和数据域契约

## 声明与输出总则

24 个工具的精确名称、描述和输入声明在 [tool-declarations.json](../contracts/tool-declarations.json)。它由固定发布源码字节核对后经 Zod `io=input` 导出，保留原中文描述；P0 还须采集实际 MCP `tools/list`，因为 SDK 的 schema 投影和参数处理可能不同。Rust 宏产生的 schema 不能未经比较直接作为最终契约。

17 个结构化工具、6 个纯文字工具、1 个图片工具。下表 S 表示三种 output channel 均适用；T 表示所有通道仍纯文字；I 表示图片工具特殊规则。所有工具完整成功/空结果/缺数据/错误行为均在迁移范围内。

| 工具 | 类型 | 必须覆盖的分支与边界 | 主阶段 |
|---|---|---|---|
| `search_prts` | S | text/title、limit 1..20 默认5、技术页过滤、重定向查询失败保留原条目 | P5 |
| `prts_page` | T | read/sections/categories/links/template；出入链、分页提示、模板渲染失败 | P5 |
| `get_operator_archives` | T | 中文名/别名实际解析、档案顺序、文本清洗、未解锁/缺文件 | P3 |
| `get_operator_voicelines` | T | 台词顺序、标题、角色解析与缺失 | P3 |
| `get_operator_basic_info` | S | basic/skills/stats；phase/level 成对、省略/null、阶段上限、天赋各档、基建 | P3 |
| `list_enemies` | S | threat_level、full=true 忽略 limit/offset、隐藏条目、分页 | P3 |
| `get_enemy_info` | S | 普通 level0；stage_id 给定时的覆盖与多变体 | P3 |
| `get_stage_enemies` | S | waves/fragments/spawn 数、等级/覆盖组合、显示排序 | P3 |
| `get_enemy_appearances` | S | 名称/ID、反向索引、limit/offset、空页 | P3 |
| `list_stages` | S | chapter/type、隐藏/过滤、limit/offset、顺序、空页 | P1 打通，P3 补齐 |
| `get_stage_info` | S | zone、消耗、掉落、解锁、动态字段、ID 回显 | P3 |
| `list_items` | S | category/别名、隐藏条目、sortId 与 ID tie-break、分页 | P3 |
| `get_item_info` | S | 中文名/ID、来源、合成/关联数据的现有形态 | P3 |
| `search` | S | 六 scope：operators/enemies/stages/items/building_skills/skills；pattern、max_results | P3 |
| `list_story_events` | S | 全部/main/activities/memoirs/roguelike、非法 category、缺包 | P4 |
| `list_stories` | S | include_summaries 默认 false；true 时活动长摘要及章节短摘要、空活动 | P4 |
| `get_story_summary` | T | 长摘要→官方短摘要→章节 storyInfo 的回退、无摘要 | P4 |
| `read_story` | T | narration 开关、dialog/choice/场景、替换博士、空章/缺章 | P4 |
| `read_activity` | T | page 省略返回全部；页码从1、page_size 默认5 最大20、超界提示 | P4 |
| `search_stories` | S | regex、character、line_type、context_lines 0..5、event_id、顺序与上限 | P4 |
| `get_operator_memoirs` | S | chardict/干员映射、密录活动与章节、无记录 | P4 |
| `find_character_appearances` | S | speaks 精确角色匹配、mentioned 文本子串、scope、max_events 实际限制章节数 | P4 |
| `find_speakers_in` | S | dialog 发言计数、同计数排序、空活动 | P4 |
| `operator_artwork` | I | list/get × MediaWiki/local × original/large/preview，形态与 token 所属 | P6 |

默认 `IMAGES_ENABLED=true` 注册24个；false 只移除 artwork，剩23个。不能根据数据是否已下载临时隐藏工具。阶段中只注册已实现工具，不注册返回“尚未实现”的假工具；阶段末数量按 07，最终必须满足24/23。

## 参数边界

工具层处理 Zod 等价的 JSON 类型、required/default 和 bounds；领域层处理跨字段/业务规则。不要重复实现同一范围检查，除非函数确实有不经过工具层的公共调用方。

- `phase`/`level` 是 nullish：允许缺失及 null，其他大多数 optional 字符串不自动接受 null。
- `prts_page.action`、`search.scope`、`operator_artwork.action` 必填；`get_operator_basic_info.action` 默认 basic。
- `prts_page.section_index` 当前是 optional integer，不能因返回目录可含 `T-N` 就改成字符串；此设计矛盾属于未来候选变化。
- `category`、`threat_level`、`line_type`、`scope`（角色追踪）有的是 string 后领域校验，不要全部升级成 schema enum。
- `list_enemies.full` 即使忽略分页，SDK 仍先校验传入参数；用实际 oracle 固定错误优先级。
- 缺省、显式 null、空字符串、错误类型、小数整数参数、额外字段都要在 P0 抽样确认。Zod object 的未知字段处理不能凭 `additionalProperties` 推断；Rust 默认 serde 行为也不是契约证据。
- 不给已有无上限参数随意加上限。不为了 Rust `usize` 转换接受负数或把溢出截断。

## GameData 迁移清单

按 `operator/operatorStats/skill/building/enemyDatabase/enemyStats/enemyRender/levelParser/stageEnemy/stage/item/search` 的职责迁移，不按文件一对一复制。完整字段和文案以 source inventory 中对应源码、返回 fixture 与 oracle 结果固定。

必须保留：干员与 trap/token 同名冲突优先级；稀有度/职业/定位的 raw/label 配对；天赋槽与候选；基建技能按槽位选择已实现的最高条件；技能每等级、专精标签、blackboard 占位符/取反/百分比/未知格式；属性关键帧插值、half-away-from-zero、负零归一化、信赖与潜能；enemy m_defined/m_value/mValue 合并和 level0 投影；关卡覆盖、不同变体、掉落及物品排序。

`enemyStats.pythonFloatString` 名称来自历史 Python parity，但产生的文本现在已是 TS 基准行为，不能以“去 Python 化”为由删掉格式规则。重命名为领域格式器即可。

建议先移纯解析/数值/渲染，再接缓存与工具。直接复用共享 JSON 预期，核对构造输入是否齐全；不是每个 JSON 文件都构成独立可运行测试。特殊案例来自 `operator-query-cases.json`、`operator-talent-cases.json`、`tool-bounds.json`。

## Story 迁移清单

主要文件：`zh_CN/gamedata/excel/story_review_table.json`、`zh_CN/storyinfo.json`、`zh_CN/gamedata/story/<key>.json`；可选 `story_supplement.json`、`summaries.json`、`event_summaries.json`、`chardict.json`。

2.8.1 肉鸽补充目录必须覆盖发现→列表→读取→搜索→角色追踪整条链，不能只做 list。与主 review 表相同 event_id 时主表优先。旧包无 supplement 仍工作；reader 对坏 supplement 降级，与 sync 验证器拒绝引用缺章的损坏新包是两种不同职责，不得合并为“全部忽略错误”。

剧情 Decision 的标量/数组兼容、dialog/narration/choice、rich text 清洗、nickname 替换、摘要字符串/数组容错、章节排序与 ID 必须保留。搜索缓存身份覆盖 ZIP 替换和数据更新，避免只凭 store 对象或一个路径永久缓存；同一内容不同容器身份的处理用现有 `storySupplement`、`zipCache` 案例核对。

不要将所有 JSON 全量深拷贝进多个会话缓存；索引属于数据集，不属于会话。早期 P4 即用真实规模测首次索引和更新释放。

## Wiki 迁移清单

普通 API 节流间隔1.5秒，每请求15秒超时；使用 API parse 正文而非 extracts。保留搜索 namespace、技术页模式、redirect follow-up 的 fail-open、HTML entity/text 清洗及可见格式。不要因为换 XML/HTML 库就改变清洗结果。

`prts_page(template)` 的返回是包含 JSON 字符串的 text content，不是 structuredContent；其顶层模板提取、嵌套字段批量渲染、标记对应、错误形态在 `templateRenderer.ts` 与相应 tests 中。随机渲染标记不应泄漏到最终文本；测试记录请求时按标记绑定归一化，不能删除最终正文差异。

网络 fixture 使用固定公开响应，验证正确请求参数与实际转换。少量真实 Wiki 调用用于互操作，不拿实时变化页面作精确 golden。

## 结果包装

统一包装行为由 `output.ts` 确定：content 只含完整 Markdown；both 同时包含完整 Markdown 与 structuredContent；structured 的 content 保留短摘要，另含 structuredContent。无结构化结果的错误/叙事始终只含 text。图片 get 在各通道均保留 image block；不能在 structured 模式丢图片或把图片放到非标准字段。基线未提供 `isError` 时不要为了习惯补 `true`。

所有工具描述保留，不在复刻期间顺手润色。Rust 中文代码注释和内部命名可改善，不影响发布给 LLM 的描述。
