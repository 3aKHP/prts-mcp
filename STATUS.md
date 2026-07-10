# PRTS-MCP 项目状态

_Last updated: 2026-07-10_

## LTS 当前版本

| 实现 | 版本 | 状态 |
|------|------|------|
| Python | 1.7.1 | LTS |
| TypeScript | 1.7.1 | LTS |

- 当前 LTS 发布：32 个 MCP 工具（1.7.1）
- 本维护线最新发布：1.7.1 LTS
- 兼容性合约：1.7.x 期间既有工具名、必填参数、默认输出格式不变；仅接受兼容性、安全性、数据同步和关键缺陷修复

## LTS 分支

- `lts/1.7`：1.7.x 维护线（从 1.7.0 发布提交创建）

1.7.0 是最后一个 1.x 功能版本和 LTS 基线。它将 server.py/server.ts 和 story.py/story.ts 单体文件拆分为聚焦子模块，保留向后兼容垫片（shim），并新增剧情角色追踪工具：`find_character_appearances`、`find_speakers_in`。后续功能开发转向 2.0；1.7.x 仅做兼容性、安全性、数据同步和关键缺陷修复。

## 仓库结构

```
PRTS-MCP/
├── python/                 # Python 实现 (stdio, FastMCP)
│   ├── src/prts_mcp/       # 源码
│   │   ├── server.py       # 入口点 → tools_* 模块
│   │   ├── tools_prts.py   # PRTS Wiki 工具注册（6 工具）
│   │   ├── tools_gamedata.py # GameData 工具注册（16 工具）
│   │   ├── tools_story.py  # 剧情工具注册（8 工具）
│   │   ├── config.py       # 路径解析、环境变量
│   │   ├── startup_sync.py # 后台数据同步编排
│   │   ├── api/            # PRTS Wiki MediaWiki API 客户端
│   │   ├── data/           # 数据抽象层
│   │   │   ├── story.py    # 兼容性垫片 → 子模块重导出
│   │   │   ├── story_reader.py  # 剧情类型、常量、章节解析
│   │   │   ├── story_search.py  # 全文搜索索引
│   │   │   ├── story_memoir.py  # 干员密录发现
│   │   │   ├── story_summary.py # 活动/章节摘要
│   │   │   ├── operators.py     # 干员数据
│   │   │   ├── enemies.py       # 敌人数据
│   │   │   ├── stages.py        # 关卡数据
│   │   │   ├── items.py         # 物品/材料数据
│   │   │   ├── stores.py        # 存储抽象 (Directory/Zip/Fallback)
│   │   │   └── sync.py          # GitHub Release 同步
│   │   └── utils/          # wikitext 清洗等工具
│   ├── tests/              # pytest 测试
│   ├── pyproject.toml      # 包元数据、依赖
│   └── CHANGELOG.md
├── ts/                     # TypeScript 实现 (Streamable HTTP, Express)
│   ├── src/                # 源码，结构对齐 python/
│   │   ├── server.ts       # 入口点 → tools/* 模块
│   │   ├── startupSync.ts  # 后台数据同步编排
│   │   ├── tools/          # 工具注册模块
│   │   │   ├── prtsTools.ts
│   │   │   ├── gamedataTools.ts
│   │   │   └── storyTools.ts
│   │   └── data/           # 数据抽象层（对齐 python/src/prts_mcp/data/）
│   │       ├── story.ts        # 兼容性垫片
│   │       ├── storyReader.ts / storySearch.ts / storyMemoir.ts / storySummary.ts
│   │       ├── operators.ts / enemies.ts / stages.ts / items.ts
│   │       ├── stores.ts / sync.ts
│   │       └── ...
│   ├── tests/              # node --test 测试
│   ├── package.json
│   └── CHANGELOG.md
├── data/                   # 共享数据（gamedata zip 等）
├── docs/                   # 文档
│   ├── dev/                # 开发者文档
│   ├── admin/              # 管理员文档
│   └── user/               # 用户文档
├── dev/                    # 本地开发草稿（.gitignore 排除）
├── .github/workflows/      # CI/CD
│   ├── ci.yml              # 双实现测试
│   ├── cd.yml              # Python PyPI 发布
│   └── cd-ts.yml           # TS npm + Docker 发布
├── CLAUDE.md               # AI 协作说明（本会话必读）
├── ROADMAP.md              # 路线图
├── STATUS.md               # 本文件
└── README.md               # 面向用户的说明
```

## 数据源

| 数据源 | 用途 | 同步方式 |
|--------|------|----------|
| [ArknightsGameData](https://github.com/3aKHP/ArknightsGameData) | 干员/敌人/关卡/物品表格 | GitHub Release `zh_CN-excel.zip` |
| [ArknightsGameData](https://github.com/3aKHP/ArknightsGameData) | 关卡实际出怪与关卡级敌人数值 | GitHub Release `zh_CN-levels.zip` |
| [ArknightsStoryJson](https://github.com/3aKHP/ArknightsStoryJson) | 剧情台词 | GitHub Release `zh_CN.zip` |
| [PRTS Wiki API](https://prts.wiki/api.php) | 世界观词条/阵营设定 | 实时 HTTP 请求 |

## 工具清单 (32, current branch)

| # | 工具 | 数据源 | 版本 |
|---|------|--------|------|
| 1 | `search_prts` | PRTS Wiki | 0.1.0 |
| 2 | `read_prts_page` | PRTS Wiki | 0.1.0 |
| 3 | `get_operator_archives` | GameData | 0.1.0 |
| 4 | `get_operator_voicelines` | GameData | 0.1.0 |
| 5 | `get_operator_basic_info` | GameData | 0.1.0 |
| 6 | `list_story_events` | StoryJson | 0.3.0 |
| 7 | `list_stories` | StoryJson | 0.3.0 |
| 8 | `read_story` | StoryJson | 0.3.0 |
| 9 | `read_activity` | StoryJson | 0.3.0 |
| 10 | `list_search_scopes` | 混合 | 1.1.0 |
| 11 | `search_data` | GameData | 1.1.0 |
| 12 | `search_stories` | StoryJson | 1.1.0 |
| 13 | `get_event_summary` | StoryJson | 1.2.0 |
| 14 | `get_story_summary` | StoryJson | 1.2.0 |
| 15 | `list_prts_sections` | PRTS Wiki | 1.3.0 |
| 16 | `get_prts_categories` | PRTS Wiki | 1.3.0 |
| 17 | `get_prts_links` | PRTS Wiki | 1.3.0 |
| 18 | `get_prts_template` | PRTS Wiki | 1.4.0 |
| 19 | `list_enemies` | GameData | 1.4.0 |
| 20 | `get_enemy_info` | GameData | 1.4.0 |
| 21 | `search_enemies` | GameData | 1.4.0 |
| 22 | `get_stage_enemies` | GameData levels | 1.6.0 |
| 23 | `get_enemy_appearances` | GameData levels | 1.6.0 |
| 24 | `list_stages` | GameData | 1.5.0 |
| 25 | `get_stage_info` | GameData | 1.5.0 |
| 26 | `search_stages` | GameData | 1.5.0 |
| 27 | `list_items` | GameData | 1.6.0 |
| 28 | `get_item_info` | GameData | 1.6.0 |
| 29 | `search_items` | GameData | 1.6.0 |
| 30 | `get_operator_memoirs` | StoryJson | 1.6.1 |
| 31 | `find_character_appearances` | StoryJson | 1.7.0 |
| 32 | `find_speakers_in` | StoryJson | 1.7.0 |

## 最近发布

| 版本 | 日期 | 亮点 |
|------|------|------|
| 1.7.1 | 2026-07-10 | LTS：PRTS 搜索重定向与技术页过滤修复、Docker 离线归档回退、TS 生产依赖安全更新 |
| 1.7.0 | 2026-07-02 | 1.7 LTS：剧情角色追踪 + 模块拆分（32 工具） |
| 1.6.1 | 2026-06-03 | 干员密录发现 + 搜索缓存优化（30 工具） |
| 1.6.0 | 2026-05-28 | 关卡敌人融合 + 物品/材料域（29 工具） |
| 1.5.0 | 2026-05-25 | 关卡数据域：list_stages、get_stage_info、search_stages（24 工具） |
| 1.4.2 | 2026-05-25 | 修复 Streamable HTTP session pool 400 错误 |
| 1.4.1 | 2026-05-19 | 生产修复：ZipStore 缓存、session 泄漏、httpx 复用、审计 parity |
| 1.4.0 | 2026-05-19 | 模板提取工具 + 敌人图鉴（含战斗属性） |
| 1.3.1 | 2026-05-19 | 修复 trap/token 同名干员 ID 碰撞 |
| 1.3.0 | 2026-05-18 | PRTS 深度集成：章节列表、分类标签、链接遍历 |
| 1.2.0 | 2026-05-14 | 剧情摘要工具 + LLM 管线 |
| 1.1.1 | 2026-05-14 | PRTS API 修复（parse 替代 extracts） |
| 1.1.0 | 2026-05-14 | 全文搜索工具 |
| 1.0.0 | 2026-05-13 | 稳定版，工具面冻结 |
