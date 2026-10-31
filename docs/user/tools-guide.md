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

---

## 4. 工具输出的信任边界（面向 MCP 客户端集成者）

PRTS-MCP 的工具输出大多直接转述上游数据源的内容，包括 Wiki 词条、游戏表格、剧情台词与立绘信息。服务端只做格式整理，不识别也不过滤其中可能出现的指令性文本。接入 PRTS-MCP 的客户端应把工具返回内容当作不可信数据处理，即使其中的文字看起来像一条指令。

### 4.1 输出内容来自哪里

| 工具或数据 | 来源 | 联网时机 |
| --- | --- | --- |
| `search_prts`、`prts_page` | PRTS Wiki MediaWiki API（`https://prts.wiki/api.php`） | 每次调用时实时请求 |
| `operator_artwork`（`LOCAL_IMAGE=false`，默认） | PRTS Wiki 图片资源 | 取图时按需拉取并缓存 |
| `operator_artwork`（`LOCAL_IMAGE=true`） | 数据源仓库的 GitHub Release 图片包 | 后台同步 |
| 干员、关卡、物品与剧情类工具 | 数据源仓库的 GitHub Release 数据包，默认为 AKDP，可通过 `PRTS_DATA_SOURCE_REPO` 改为自定义仓库 | 后台同步，工具调用时只读取本地数据 |
| 内置备用数据 | 原生归档包、npm 包与 Docker 镜像内置的只读数据 | 不联网 |

### 4.2 现有校验能证明什么

- 连接 PRTS Wiki 与 GitHub 时，服务端使用程序内嵌的根证书库（`webpki-roots`）校验 TLS 证书。设置 `NODE_EXTRA_CA_CERTS` 后，Wiki 客户端还会信任该文件中的根证书，请只指向你信任的 CA。
- 同步的数据包按 manifest 校验 SHA-256，可以发现传输损坏和不完整的下载。manifest 与数据包来自同一个 Release；直连失败后改走 `GITHUB_MIRRORS` 镜像时，两者都经由镜像获取。因此 SHA-256 校验不能证明内容由数据源仓库发布，所配置的镜像与自定义数据源仓库都属于部署者自行信任的范围。
- 即使上述校验全部通过，上游站点或数据源仓库本身被篡改时，工具输出仍可能包含恶意文本。

### 4.3 客户端侧建议

1. **隔离展示**：把工具输出与系统指令分开呈现，不要让其中的文本被当作指令解析或自动执行。
2. **敏感操作前人工确认**：写文件、发起外部请求、执行命令和修改配置之前保留人工确认，不要让模型仅凭工具输出自动放行。
3. **不把工具输出拼进高权限指令**：不要把词条正文、剧情台词等内容原样拼进系统提示、shell 命令或携带凭据的请求模板。
4. **收紧同一客户端里的其他权限**：如果客户端同时连接了能写文件、执行命令或访问账号的其他 MCP 服务器，模型可能在工具输出的诱导下调用它们。只为当前任务开放必要的服务器与权限。
5. **保留工具调用记录**：遇到可疑内容时，先查看客户端记录的工具调用参数与返回原文，再判断问题出在上游内容还是数据链路。
