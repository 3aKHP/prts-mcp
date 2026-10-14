# 工具使用与同人创作工作流指南

PRTS-MCP 提供 **24 个 MCP 工具**（当 `IMAGES_ENABLED=false` 时为 23 个），覆盖 PRTS Wiki 词条、干员档案与数值、关卡敌情、物品材料、剧情文本与角色追踪、以及干员立绘六大领域。

本文面向使用 PRTS-MCP 辅助同人创作、考据与设定查询的用户，介绍各工具的设计分工、推荐串联工作流与可直接复制的调用示例。

---

## 1. 五大核心工作流（工具怎么打配合？）

### 工作流一：泰拉世界观与 PRTS Wiki 词条深潜
**适用场景**：考据泰拉国家/阵营设定、专有名词、活动背景，或读取干员/敌人在 Wiki 页面上的特殊排版内容。

1. **先搜标题（`search_prts`）**：用关键词搜索匹配的词条准确标题（默认已过滤 `/spine`、`/data` 等技术子页）。
2. **先看目录，避免整页过载（`prts_page(action="sections")`）**：Wiki 长词条往往动辄数万字。先用 `action="sections"` 查看章节编号（如 `[1]`、`[2]`，或模板嵌入产生的 `[T-1]`）。
3. **按节精读或提取模板（`prts_page(action="read" | "template")`）**：
   - 传入 `action="read"` + `section_index` 只读取目标章节正文；
   - 若想直接获取干员/敌人/物品页面顶层 MediaWiki 模板的结构化字段，使用 `action="template"`；
   - 若想顺藤摸瓜查找关联词条，使用 `action="links"`（支持 `outbound` 出链与 `inbound` 反向入链）或 `action="categories"`。

### 工作流二：干员人设、语音、技能与精准数值考据
**适用场景**：撰写干员同人时核对履历档案、口癖台词、基建技能、战斗技能数值或特定等级面板。

- **基础档案、天赋与基建技能**：调用 `get_operator_basic_info(name="阿米娅")`（默认 `action="basic"`），一次性返回客观履历概要、各精英阶段/潜能档位的天赋效果，以及基建技能名称与效果。
- **战斗技能逐级数值**：调用 `get_operator_basic_info(name="阿米娅", action="skills")`，获取全部技能在 Lv1–7 及专精一至专精三的 SP 消耗、初动、持续时间与黑板数值替换后的完整描述。
- **属性面板与指定等级插值**：调用 `get_operator_basic_info(name="阿米娅", action="stats")` 查看各精英阶段 Lv1/满级面板及满信赖、潜能加成；若同时传入 `phase` 与 `level`（如 `phase=2, level=40`），服务端会按游戏内线性插值公式算出该精确等级的面板数值。
- **完整个人档案与全语音**：
  - `get_operator_archives(name="阿米娅")`：获取干员客观履历、临床诊断、档案资料一至四及晋升记录全文。
  - `get_operator_voicelines(name="阿米娅")`：获取日常交谈、信赖提升、作战、晋升等全部触发条件下的台词原文。

### 工作流三：剧情阅读、角色轨迹追踪与台词检索
**适用场景**：梳理某个角色在全剧情中的登场脉络、统计活动戏份、查找特定名场面台词或阅读干员密录。

1. **找某个角色在哪些剧情里出现过（`find_character_appearances`）**：
   - 传入角色名（如 `name="黍"` 或 `name="博士"`），工具会跨全量主线、活动、肉鸽和密录，返回该角色**开口说话（`speaks`）**或**被他人/旁白提及（`mentioned`）**的所有章节 `story_key`。
2. **看某个活动里谁戏份最多（`find_speakers_in`）**：
   - 传入 `event_id`（如 `"act31side"`），按台词句数从高到低列出该活动的所有发言角色。
3. **浏览活动脉络与单章梗概（`list_story_events` → `list_stories` → `get_story_summary`）**：
   - 先用 `list_story_events(category="main" | "activities" | "roguelike")` 找到活动的 `event_id`；
   - 再用 `list_stories(event_id="act31side", include_summaries=true)` 一次性查看活动总览与每一章的一句话梗概；
   - 需要某章详细摘要时调用 `get_story_summary(story_key=...)`。
4. **读取完整台词或检索特定句子（`read_story` / `read_activity` / `search_stories`）**：
   - 读单章用 `read_story(story_key=...)`（可设 `include_narration=false` 只看对话）；读整篇活动用 `read_activity(event_id=..., page=1)`；
   - 读干员密录时，先调 `get_operator_memoirs(name="能天使")` 拿到密录的 `story_key`，再传给 `read_story`；
   - 想搜某句台词或某个角色说过的话，用 `search_stories(pattern="...", character="...", line_type="dialog")`。

### 工作流四：关卡敌情、物品材料与跨干员技能反查
**适用场景**：编写作战描写时核对某关实际出场的敌人配置，或反查“哪些干员拥有某类战斗/基建技能效果”。

- **正查关卡与出场敌人**：`list_stages` → `get_stage_info(stage_id="main_00-01")` 查看关卡描述与掉落；再调 `get_stage_enemies(stage_id="main_00-01")` 查看该关卡**实际刷出**的敌人及其在该关卡等级覆盖后的真实战斗数值。
- **反查敌人图鉴与登场关卡**：`get_enemy_info(name="源石虫", stage_id="main_00-01")` 查看敌方能力与关卡级属性；`get_enemy_appearances(name="源石虫")` 反查该敌人在哪些关卡中实际登场。
- **物品与材料考据**：`list_items(category="MATERIAL")` 浏览分类列表，`get_item_info(name="固源岩")` 获取物品背景描述、用途、掉落关卡与基建配方。
- **六域全文正则反查（`search`）**：
  - `scope` 支持 `operators`、`enemies`、`stages`、`items`、`building_skills`、`skills` 六个数据域；
  - 例如想找“哪些干员的战斗技能带有‘脆弱’或‘停顿’效果”，可直接调用 `search(scope="skills", pattern="脆弱|停顿")`；想找“制造站源石碎片加成”，可调用 `search(scope="building_skills", pattern="源石碎片")`。

### 工作流五：查看干员立绘与时装（`operator_artwork`）
**适用场景**：查看干员精英化立绘、升变形态或时装皮肤，获取皮肤系列、简介与图片。

1. **第一步必调 `action="list"`**：`operator_artwork(operator_name="阿米娅", action="list")`，获取该干员所有立绘与时装的元数据及不透明令牌 `artwork_id`（请勿自行拼造 `artwork_id`）。
2. **第二步调 `action="get"`**：将上一步返回的 `artwork_id` 原样传入 `operator_artwork(operator_name="阿米娅", action="get", artwork_id="...", variant="large")` 获取图片（默认 `large` 最大 1024px，`preview` 最大 256px）。

---

## 2. 全部 24 个工具参数示例速查表

下表提供每个工具及主要 `action` 分支的标准 JSON 调用参数，可直接用于测试或参考（完整 JSON Schema 见仓库 [`contracts/tool-declarations.json`](../../contracts/tool-declarations.json)）：

| 工具名 | 示例 JSON 参数 | 数据源与说明 |
| --- | --- | --- |
| `search_prts` | `{"query": "莱茵生命", "limit": 5}` | PRTS Wiki（需联网）：关键词搜索词条标题 |
| `prts_page` | `{"page_title": "阿米娅", "action": "sections"}` | PRTS Wiki（需联网）：获取词条章节目录（含 `T-` 模板节） |
| `prts_page` | `{"page_title": "阿米娅", "action": "read", "section_index": 1}` | PRTS Wiki（需联网）：按章节编号读取正文 |
| `prts_page` | `{"page_title": "阿米娅", "action": "template"}` | PRTS Wiki（需联网）：提取顶层模板的结构化字段 |
| `get_operator_archives` | `{"name": "阿米娅"}` | 本地游戏表：干员客观履历与个人档案全文 |
| `get_operator_voicelines` | `{"name": "阿米娅"}` | 本地游戏表：干员全语音台词记录 |
| `get_operator_basic_info` | `{"name": "阿米娅"}` | 本地游戏表：基础信息、逐档天赋与基建技能（默认 `action="basic"`） |
| `get_operator_basic_info` | `{"name": "阿米娅", "action": "skills"}` | 本地游戏表：战斗技能 Lv1–7 与专精各级效果 |
| `get_operator_basic_info` | `{"name": "阿米娅", "action": "stats", "phase": 2, "level": 40}` | 本地游戏表：指定精英阶段与等级的精确插值面板（省略 `phase`/`level` 则返回各阶段关键帧总览） |
| `list_enemies` | `{"threat_level": "boss", "limit": 20}` | 本地游戏表：按威胁等级（`boss`/`elite`/`normal`）列出敌方图鉴 |
| `get_enemy_info` | `{"name": "源石虫"}` | 本地游戏表：敌方图鉴详情（传入可选 `stage_id` 时返回关卡级属性） |
| `get_stage_enemies` | `{"stage_id": "main_00-01"}` | 本地关卡表：指定关卡实际刷出的敌人及关卡级数值 |
| `get_enemy_appearances` | `{"name": "源石虫", "limit": 20}` | 本地关卡表：反查指定敌人实际出场的关卡列表 |
| `list_stages` | `{"type": "MAIN", "limit": 20}` | 本地游戏表：按类型（`MAIN`/`ACTIVITY`/`ROGUELIKE` 等）或章节过滤关卡 |
| `get_stage_info` | `{"stage_id": "main_00-01"}` | 本地游戏表：关卡编号、难度、理智消耗、描述与掉落奖励 |
| `list_items` | `{"category": "MATERIAL", "limit": 20}` | 本地游戏表：按分类列出物品/材料 |
| `get_item_info` | `{"name": "固源岩"}` | 本地游戏表：物品详情、用途、掉落关卡与基建产出 |
| `get_operator_memoirs` | `{"name": "阿米娅"}` | 本地剧情包：查询干员密录章节的 `story_key` |
| `find_character_appearances` | `{"name": "阿米娅", "max_events": 10}` | 本地剧情包：查找角色在哪些章节发言（`speaks`）或被提及（`mentioned`） |
| `find_speakers_in` | `{"event_id": "act31side"}` | 本地剧情包：列出活动内所有发言角色及台词行数统计 |
| `list_story_events` | `{"category": "activities"}` | 本地剧情包：列出剧情活动（支持 `main`、`activities`、`roguelike`） |
| `list_stories` | `{"event_id": "act31side", "include_summaries": true}` | 本地剧情包：按官方顺序排列活动章节，并附活动级与章节级梗概 |
| `get_story_summary` | `{"story_key": "activities/act31side/level_act31side_01_beg"}` | 本地剧情包：获取单章剧情长摘要或官方简介 |
| `read_story` | `{"story_key": "activities/act31side/level_act31side_01_beg"}` | 本地剧情包：读取单章完整对话、旁白与分支选项 |
| `read_activity` | `{"event_id": "act31side", "page": 1, "page_size": 5}` | 本地剧情包：分页读取整个活动的完整剧情台词 |
| `search` | `{"scope": "skills", "pattern": "脆弱", "max_results": 20}` | 本地游戏表：在 `operators`/`enemies`/`stages`/`items`/`building_skills`/`skills` 中执行正则搜索 |
| `search_stories` | `{"pattern": "黍", "event_id": "act31side", "context_lines": 1}` | 本地剧情包：在剧情台词中执行正则搜索（支持按 `character` 与 `line_type` 过滤） |
| `operator_artwork` | `{"operator_name": "阿米娅", "action": "list"}` | MediaWiki 或本地立绘：列出立绘/时装及 `artwork_id`，随后传给 `action="get"` |

---

## 3. 使用小贴士（避免常见误区）

1. **`query` 与 `pattern` 的区别**：
   - `search_prts(query=...)` 是 MediaWiki 关键词搜索，传入普通词语即可；
   - `search(pattern=...)` 与 `search_stories(pattern=...)` 是 **ECMAScript 正则表达式**（大小写不敏感），支持 `A|B` 多词或匹配、正向/反向断言等语法；如果搜索文本本身含有括号 `()`、`[]`、`+` 等正则元字符，请注意转义。
2. **干员名称请使用游戏内标准中文名**：
   - 如 `"阿米娅"`、`"能天使"`、`"假日威龙陈"`。查询阿米娅的升变形态立绘时，`operator_artwork` 支持近卫 `"阿米娅(近卫)"`、医疗 `"阿米娅(医疗)"` 等别名；干员档案、技能与数值查询仍使用游戏表中的标准名称。
3. **控制单次输出长度**：
   - 读取大型活动剧情时，优先使用 `list_stories(include_summaries=true)` 定位目标章节，再对关键章节调用 `read_story`，比直接调用 `read_activity` 拉取全活动数万字台词更节省上下文窗口。
