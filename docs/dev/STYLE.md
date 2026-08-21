# 代码规范与架构 — PRTS-MCP

面向所有协作者（人类与 AI）。本文件记录代码架构硬原则、反模式、CHANGELOG 规则、测试规范以及历史陷阱。

公开贡献流程见 [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md)，跨平台开发环境见 [`ENVIRONMENT.md`](ENVIRONMENT.md)。当前维护者与 AI 的日常工作流见 [`../../CLAUDE.md`](../../CLAUDE.md)；项目现状见 [`../../STATUS.md`](../../STATUS.md)。

---

## 代码规范与架构

**项目维护者对代码架构和模块化解耦要求很高**。上帝文件和面条代码是底线问题，在它们出现之前就要阻止。以下是硬性原则，不是"nice to have"。

### 文件大小与职责

- **单一职责**：一个文件只干一件事。`operator.py` 只负责干员数据读取，不混进搜索逻辑；`sanitizer.py` 只管 wikitext 清洗，不放 API 调用
- **文件长度预警线**：源文件超过 ~300 行就要问"这能不能拆"
- **模块边界**：`data/` 的数据读取模块只做数据读写和格式化，不混进 HTTP 请求；HTTP 传输统一收敛到 `sync/` 层；`api/` 只做 PRTS Wiki API 调用；`server.py` 只做工具注册和启动编排

> **已审健康的大文件（2.7.0 上帝文件审计归档，P5.1）**：预警线以耦合度为准，不是行数。以下单元在 2.7.0 周期审计中按 STYLE 耦合规则逐个判为单一职责/抽取得当（story_reader 为临界），**不要为行数机械拆分**；表中行数是归档时的快照，结论以耦合度为准；"可选辅助"是审计记录的文件内抽取候选，仅在利于测试/复用时再做，不欠账：

| 模块（PY / TS 行数@2026-08） | 审计结论 | 可选辅助（非必须） |
|---|---|---|
| `data/operator`（311 / 402） | 🟢 单一职责（干员数据读+格式化）；TS 大 ~90 行是 JSON-shape interface + per-cache CacheMetrics 的结构不对称，非上帝文件 | `resolve_operator_or_error`（收 3 处重复前置解析） |
| `data/item`（475 / 496） | 🟢 镜像 operator 的 build/render/entry 形态 | `itemLabels`（纯 label 表 + 格式化，无 IO 可单测） |
| `data/stage`（526 / 554） | 🟢 validate→load→filter→paginate→shape 线性管线，最大嵌套 2 | `stage_render`（纯 markdown；`stage_search` 契合 ROADMAP 决策原则 7 的统一 search 入口） |
| `data/story_search`（398 / 356） | 🟢 内聚 | `_validate_search_params`（集中 6 个参数 guard） |
| `data/story_reader`（540 / 561） | 🟡 临界：默认不拆，仅在利于测试时抽取 | `story_types`（纯数据形状）+ `story_format`（payload+markdown） |
| `data/images`（227 / 233） | 🟢 免检：单域、抽取得当（sync 在 `sync/images_sync`、缓存生命周期合惯例） | — |

### 分层纪律

```
server.py/ts          ←  MCP 工具注册、启动同步编排
api/                  ←  PRTS Wiki MediaWiki API 客户端
data/                 ←  干员/剧情/搜索/store 抽象
data/stores           ←  DirectoryStore / ZipStore 底层读写
sync/                 ←  GitHub Release 数据同步（传输：HTTP/镜像/级联 fetch；发现：release 列表）；数据同步 HTTP 归此层（PRTS Wiki HTTP 归 api/）
utils/                ←  跨领域纯函数（wikitext 清洗等）
config.py/ts          ←  路径解析、环境变量
```

**允许的依赖方向**：`server → api, data, sync, config` / `data → stores, utils, config` / `sync → stores, utils, config` / `api → utils`。 **禁止**：`stores` 依赖 `data`；`utils` 依赖 `api` 或 `data`；`config` 依赖任何其他模块；`data` 的数据读取模块直接发 HTTP（数据同步 HTTP 归 `sync/`、PRTS Wiki HTTP 归 `api/`）。

> 三个注定的例外：① `data/artwork_mediawiki` 是 wiki-backed 数据源，允许**经 `api/` 客户端**取 PRTS 数据（自身仍不发裸 HTTP、不 import sync）；② `data/artwork_local` 对本地图片代际目录的 PNG 直读豁免 store 抽象——`stores` 是 JSON 文本契约，代际目录是绝对宿主路径而非 store root 相对模型，且读取自带 realpath 遏制守卫（#169）；③ `sync/images_sync` 消费 `data/images` 的 AKDP index 契约（`parse_index`/`ImagesIndex`/`SCHEMA_VERSION`）——index 是 sync 写出、data 读入的对接契约，schema 归 data 域持有，反向搬迁会制造更糟的 `data → sync` 边。

### 抽象层

- 所有数据读写经过 `stores.py` / `stores.ts` 的 `DirectoryStore` / `ZipStore`
- 不要直接在工具函数里 `open()` / `readFileSync()` 读 JSON
- 新数据源先加 dataset spec，再实现 reader

### 抽取的触发条件

遇到以下任一情况**立即**抽成独立单元，不要等下次 PR：

- 同一个公式/逻辑在 ≥2 个地方出现
- 一个函数超过 ~50 行或嵌套超过 3 层
- 一段逻辑有明显的"状态 + 更新 + 查询"三要素（→ 独立类/模块）
- 一段逻辑需要单独测试（→ 独立纯函数）

### 模块化 vs 过度抽象

不要为了抽而抽。**单次使用、少于 10 行、语义清晰**的内联代码不需要抽。判断基准："如果我明天给这块代码写单测或者重用它，现在的形状会让我想重写吗？"——会就抽，不会就留着。

### 命名与样式

- 公开 API 必须有 docstring / JSDoc，说明 **what + why**，不说 **how**
- 不写"废话注释"（`# increment i by 1`）；非显而易见的约束必须注释
- 错误消息用中文，面向最终用户（MCP 客户端会直接展示给用户）

### Markdown 文档换行

公开 Markdown 文档（根目录与 `python/`、`ts/` 下的 `*.md`）使用**自然语义换行**：每个段落、列表项、引用段写成一行物理行，**不允许 ~80 列 hard-wrap**。硬折行在渲染时会被软连接为一行，只增加 diff 与 blame 噪音、并制造"同段多行"的伪结构。例外：代码栅栏内容、表格、YAML frontmatter、徽章栈（一行一个）等结构性布局不受此约束。

### 工具描述规范

MCP 工具描述（Python `@mcp.tool()` 的 docstring / TS `server.tool()` 的描述串）是 LLM 选择工具的**主要信号**，也是 128K 级模型的 schema 预算大头。所有工具描述遵循统一模板：

1. **第一行**：一句话用途，动词开头，说清"做什么 + 面向哪类数据"
2. **返回什么 / 输出格式**：结构与大致长度提示（如"每行 `- 编号 名称`"）
3. **何时用 / 何时别用**：必要时给简洁指向（"如需 X 用 Y"），但不堆砌
4. **参数语义**写在参数的 `Field` / `.describe()`，正文不重复

硬约束：

- 中文，面向最终用户；只说 what + why，不说 how（不描述实现）
- 去废话、去过期交叉引用——工具合并/删除后同步清理 `如需…请用…`
- 正文控制在 ~3 短句内；更长的说明拆到参数描述
- 两套实现的同名工具描述保持语义一致

参数命名约定（新工具照此长）：实体解析用 `name`；正则搜索用 `pattern` + `max_results`；可浏览列表分页用 `limit` + `offset`；PRTS 维基关键词搜索用 `query` （语义 ≠ 正则 `pattern`）。

### 错误处理

- 缺失数据：返回人类可读的中文错误消息，不要抛裸异常
- 网络失败：sync 模块负责重试和降级，工具函数不自己重试
- 用户输入错误：在工具函数入口验证，返回明确提示

### 公共 API 约束（1.x 兼容性合约）

- 工具名、必填参数、输出格式在 1.x 期间不得破坏性变更
- 新参数必须有安全默认值（向后兼容）
- 两套实现的工具签名必须一致

### 触及现有坏味道时

遵循"**童子军规则**"：

- **离开比到来时更干净一点**。改一个函数顺手把它的命名、缩进、局部变量换掉
- **不做"顺便大重构"**：看到面条不代表可以在 bugfix PR 里顺手拆。**专门开一个 `refactor` PR**，说明动机、范围、验证方式
- **拆一个坏文件的 PR，不要再顺便加新功能**。保持重构 PR 的 diff 尽量只在移动代码

### 常见反模式（见到就阻止）

这些不要在本仓库出现：

- 千行以上的单文件
- 工具函数里直接读文件（绕过 store 抽象）
- `Utils.py` / `helpers.ts` 杂物堆——按主题拆专用模块
- 同一份常量在多个文件散落（必须走 config 或顶层常量）
- 跨层调用（data 数据读取模块里直接发起 HTTP 请求；HTTP 传输只归 `sync/` 层）
- 两套实现的行为不一致（工具名、参数、输出格式）
- 为每个新数据域机械复制 `list_X` / `get_X` / `search_X` 三件套——优先扩 `search(scope)` 等统一入口的 enum（见 ROADMAP 决策原则 7）

### 何时是重构 PR 的好时机

- 准备在某个模块加新功能，发现"得先清理才能干净地加"——**先开一个 refactor PR，merge 后再开 feature PR**
- 连续两轮独立 code review 指出同一类坏味道
- 文件大小、嵌套深度跨过预警线

---

## Python 规范

### 风格

- 遵守 PEP 8；最大行宽 88 字符（与 black 默认一致）
- 类型注解：所有公开函数签名必须有类型注解，内部函数酌情
- 使用 `from __future__ import annotations` 延迟注解求值
- 字符串：单引号或双引号均可，同一文件内保持一致
- 导入顺序：标准库 → 第三方 → 本地模块，用空行分隔

### 类型

```python
# 好：用 dict[str, Any] 而非 Dict[str, Any]（3.10+）
def _load_json(filename: str) -> dict[str, Any]: ...

# 好：Optional 用 X | None
def get_operator(name: str | None) -> dict[str, Any] | None: ...
```

### 缓存

- gamedata 域模块经 `data/dataset_access`（TS `data/datasetAccess.ts`）声明缓存：`define_dataset(spec)` 返回 access 对象，loader 默认 `onError: "throw"`（异常传播、下次重试——保住"进程中途数据出现"语义）；缺数据当空/None 由 load 函数自行返回
- 缓存引擎仍是 activation-aware（generation key），代际变更经各模块唯一一条 `register_activation_listener(clearX_caches)` 触发清除；operator 的清除会经 `on_clear` rider 级联清 search
- 注意失效机制的不对称：Python 的 generation-key 缓存即使忘注册 listener 也会自愈；TS 的契约层不注册 listener，失效完全依赖各模块的 `registerActivationListener(clearXCaches)`——迁移新域时这条注册不可省
- 不要缓存 `Config`，它需要反映 sync 后的路径变化

### MCP 工具注册

```python
# server.py 中的模式：本地函数用 _ 前缀，MCP 工具是薄包装
from prts_mcp.data.operator import get_operator_archives as _get_archives

@mcp.tool()
async def get_operator_archives(
    name: Annotated[str, Field(description="干员中文名，如「阿米娅」。")],
) -> str:
    """获取干员的档案资料。"""
    return _get_archives(name)
```

- 工具函数是薄包装：参数验证 + 委托给 data/api 模块
- `description` 用中文，面向最终用户
- 不要在工具函数里做业务逻辑

### 测试

- 测试文件：`python/tests/test_<module>.py`
- 使用 pytest fixtures，共享 fixture 放 `conftest.py`
- 大型测试数据（zip 文件）通过 `story_zip` fixture 按需 skip
- 运行：`uv run --directory python --locked python -m pytest tests/ -v`

---

## TypeScript 规范

### 风格

- 遵守 ESLint recommended rules
- 使用 ESM (`"type": "module"`)
- 文件名：`camelCase.ts`（与 Python 的 `snake_case.py` 对应）
- 类型：优先 `interface` 定义数据形状，`type` 用于联合/交叉类型
- 导入：使用 `.js` 扩展名（ESM 要求）

### 类型

```typescript
// 好：interface 定义 JSON 结构
interface CharacterEntry {
  name?: string;
  appellation?: string;
  rarity?: string;
  // ...
}

```

- 只定义实际使用的字段，不要为整个 JSON 定义完整类型

### 缓存

- gamedata 域经 `data/datasetAccess.ts` 的 `defineDataset` 声明缓存（loader 状态机），不再手搓模块级 `let` + `checkActivationChange()` 脚手架；每个域保留恰好一条 `registerActivationListener(clearXCaches)`
- 不要用 `Map` 做简单缓存（除非需要 LRU 或多 key）
- Config 不缓存：`loadConfig()` 每次调用重新读取

### MCP 工具注册

```typescript
// server.ts 中的模式
import { getOperatorArchives as _getArchives } from "./data/operator.js";

server.tool(
  "get_operator_archives",
  "获取干员的档案资料。",
  { name: z.string().describe("干员中文名，如「阿米娅」。") },
  async ({ name }) => ({ content: [{ type: "text", text: _getArchives(name) }] }),
);
```

### 测试

- 测试文件：`ts/tests/<module>.test.ts`
- 使用 Node.js 内置 `node:test` + `node:assert`
- 共享 fixture 放 `ts/tests/fixtures/`
- 运行：`npm --prefix ts run build && npm --prefix ts test`

---

## 两套实现的对应关系

Python 和 TypeScript 不是翻译关系，但文件结构和模块职责应保持对齐：

| Python | TypeScript | 职责 |
|--------|-----------|------|
| `server.py` | `server.ts` | MCP 工具注册、启动同步 |
| `config.py` | `config.ts` | 路径解析、环境变量 |
| `data/stores.py` | `data/stores.ts` | DirectoryStore / ZipStore 抽象 |
| `data/operator.py` | `data/operator.ts` | 干员数据读取和格式化 |
| `data/enemy.py` | `data/enemy.ts` | 敌人图鉴/数据库读取编排 + payload/render（消费下方纯模块） |
| `data/enemy_database.py` | `data/enemyDatabase.ts` | enemy_database.json 归一化 + level0_index 投影（纯） |
| `data/enemy_stats.py` | `data/enemyStats.ts` | 战斗属性抽取 + m_defined 覆盖合并（纯；TS 侧另持 pythonFloatString/formatNumber 格式化 shim，无 PY 对应） |
| `data/enemy_render.py` | `data/enemyRender.ts` | 敌人图鉴卡片 + 战斗属性块渲染（首个 render 模块范式：纯 dict → markdown lines） |
| `data/level_parser.py` | `data/levelParser.ts` | zh_CN-levels 关卡 JSON 纯解析（level_path/spawn_counts/enemy_refs/parse_level） |
| `data/stage.py` | `data/stage.ts` | 关卡数据读取和格式化（导出共享 load_stage_table/getStageTable） |
| `data/stage_enemy.py` | `data/stageEnemy.ts` | 关卡×敌人融合编排（消费 enemy/stage 共享访问器，own dataset 仅 enemy_appearance_index） |
| `data/artwork_local.py` | `data/artworkLocal.ts` | 本地 AKDP 立绘后端（char-id 别名解析、index 加载、受守卫 PNG 读取；接收已解析 gen_dir，不 import sync/api/output） |
| `data/artwork_mediawiki.py` | `data/artworkMediawiki.ts` | MediaWiki 立绘后端（list/get 编排 + LRU + label/ownership；经 api 客户端取数） |
| `data/artwork_format.py` | `data/artworkFormat.ts` | artwork 结果形状（ListOutcome/GetOutcome）+ 共享列表 markdown 渲染 |
| `data/building.py` | `data/building.ts` | 基建技能读取（building_data.json：按 buff 槽位取最高相位 + building_skills 搜索记录。与 operator 存在受控回边：PY 在记录构建函数内 lazy import operator 的 `_build_name_to_id`，TS 为静态 import 但仅在函数体内使用其绑定——两种形式都保证环引用不在模块求值期触碰对方绑定；operator/search 单向消费本模块的其余部分） |
| `data/story.py` | `data/story.ts` | 剧情数据读取和格式化 |
| `data/search.py` | `data/search.ts` | 全文搜索 |
| `data/sync.py` | `data/sync.ts` | re-export barrel（全 sync 状态机已迁入 `sync/`） |
| `sync/transport.py` | `sync/transport.ts` | GitHub Release HTTP 传输（镜像/级联 fetch） |
| `sync/release_discovery.py` | `sync/releaseDiscovery.ts` | Release 发现（list/latest-by-prefix/asset_url/check_latest） |
| `sync/_types.py` | `sync/types.ts` | 共享 spec/result 类型（RepoSpec/ReleaseArchiveSpec/SyncResult） |
| `sync/gamedata_pair.py` | `sync/gamedataPair.ts` | GameData pair 状态机（archive 激活 + pair 协调，含 #152 幂等双守卫） |
| `sync/images_sync.py` | `sync/imagesSync.ts` | AKDP 图片资产同步状态机（shard/delta 下载 + 代际激活） |
| `sync/generation_store.py` | `sync/generationStore.ts` | 图片代际文件系统 store（.images_meta 指针 + active 代际解析 + prune） |
| `sync/primitives.py` | `sync/primitives.ts` | sync 层共享原语（atomic_write_json + prune_old_trees） |
| `sync/release_activation.py` | `sync/releaseActivation.ts` | 跨进程锁 + 代际树 + staging + extract-meta + zip 校验/解压 |
| `sync/release.py` | `sync/release.ts` | Release 下载 + manifest 校验 + sync_release 状态机 |
| `data/datasets.py` | `data/datasets.ts` | 数据集 spec 定义 |
| `data/dataset_access.py` | `data/datasetAccess.ts` | DatasetAccess 契约（define_dataset/defineDataset 工厂 + 具名注册表 + excel/levels store 工厂） |
| `data/gamedata_attrs.py` | `data/gamedataAttrs.ts` | 共享 gamedata 属性 unwrap（m_value/mValue） |
| `data/messages.py` | `data/messages.ts` | canonical 缺数据/边界校验/正则错误文案（两侧符号 1:1） |
| `api/prts_wiki.py` | `api/prtsWiki.ts` | PRTS MediaWiki API 客户端 |
| `utils/sanitizer.py` | `utils/sanitizer.ts` | Wikitext 清洗 |

TS 文件头注释应注明对应的 Python 文件：`Mirrors python/src/prts_mcp/data/operator.py.`

---

## 版本号与发布

遵循 [SemVer](https://semver.org/)。预发布用 `-alpha.N` / `-beta.N` / `-rc.N` 后缀。

**`develop` 分支上的版本号**始终带开发后缀，发布时去掉：

| 文件 | develop 分支 | main 分支（发布时） |
|------|---------|-------------------|
| `python/pyproject.toml` | `2.8.0.dev0` | `2.8.0` |
| `python/uv.lock` | `2.8.0.dev0` | `2.8.0` |
| `ts/package.json` | `2.8.0-dev.0` | `2.8.0` |
| `ts/package-lock.json` | `2.8.0-dev.0` | `2.8.0` |

**版本号需要同步更新的地方**：

| 文件 | 内容 |
|------|------|
| `python/pyproject.toml` | `version` 字段（develop 分支带 `.dev0` 后缀） |
| `python/uv.lock` | Python 项目版本和锁定依赖 |
| `ts/package.json` | `version` 字段（develop 分支带 `-dev.0` 后缀） |
| `python/CHANGELOG.md` | 新版本条目 |
| `ts/CHANGELOG.md` | 新版本条目 |
| `ts/package-lock.json` | npm lockfile 顶层版本 |
| `ROADMAP.md` | 当前版本号 |
| `ROADMAP.zh-CN.md` | 当前版本号（与 `ROADMAP.md` 成对同步） |
| `STATUS.md` | 当前版本 / 分支状态 |
| `CLAUDE.md` / `AGENTS.md` | 分支模型表的当前版本口径（成对同步） |
| `README.md` | 用户可见版本、工具数、工具清单 |

Tag 使用实现级前缀：`python/vX.Y.Z` 和 `ts/vX.Y.Z`。稳定版 tag 必须打在 `main` 分支的发布 merge commit 上；1.7.x LTS patch tag 打在 `lts/1.7` 的对应 merge commit 上。预发布 tag（`-alpha` / `-beta` / `-rc` 后缀）打在 `develop` 的 merge commit 上；CD 的 verify job 会校验稳定版 tag 目标在 `main`、预发布 tag 目标在 `develop`，不匹配则拒绝发布（预发布完整流程见 CLAUDE.md 路径 F）。

---

## CHANGELOG 规则

遵循 [Keep a Changelog](https://keepachangelog.com/) 规范。**英文撰写**。

**核心原则：面向用户描述变更，不记 commit 细节（不写哈希、不抄 commit message）。**

变更分类（仅列出有内容的分类）：**Added** / **Changed** / **Deprecated** / **Removed** / **Fixed** / **Security**。

### 日常开发

在 `develop` 分支上，每个模块级改动（feat / fix / refactor）在 `## [Unreleased]` 段落对应分类下追加一行。小型 chore / docs / style 无需改 CHANGELOG。

`main` 分支上不应出现 `[Unreleased]` 段——main 的 CHANGELOG 只包含已发布版本。

### 准备发版（release/* → main + develop 发布时）

1. 从 `develop` 拉 `release/vX.Y.Z`
2. 在 release 分支将 `## [Unreleased]` 改为 `## [X.Y.Z] - YYYY-MM-DD`
3. release PR 到 `main` 时不保留空 `## [Unreleased]` 段
4. 版本号去掉 `-dev` 后缀后通过 PR 合并到 `main`，在 `main` 的 merge commit 上打 tag
5. 将同一个 release 分支通过 PR merge 回 `develop`（不要 squash）
6. 从更新后的 `develop` 拉 chore 分支，bump 到下个开发版本后，再打开新的空 `## [Unreleased]` 段并 PR 回 `develop`

---

## 测试与构建

### 常用命令

```bash
# Python
uv run --directory python --locked python -m pytest tests/ -v             # 全量单测
uv run --directory python --locked python -m pytest tests/ -v -k test_xxx # 单个测试

# TypeScript
npm --prefix ts run build                           # 先生成 stdio e2e 所需 dist
npm --prefix ts test                                # 全量单测
npm --prefix ts run typecheck                       # 类型检查
```

### 测试规范

- 新增的数据处理逻辑**必须**带单测
- Python 用 pytest，位于 `python/tests/`
- TS 用 Node.js 内置 `node:test`，位于 `ts/tests/`
- 大型 fixture（zip 文件）通过环境变量或 skip 机制按需启用
- 涉及 PRTS Wiki API 的测试用 mock/fixture，不要在 CI 中打真实 API

### 双实现验证

改动一个实现时，**必须检查**另一个实现是否有对应改动：

- 工具名、参数名、输出格式
- 错误消息内容
- 数据处理逻辑（如 wikitext 清洗规则、搜索过滤条件）

---

## 已知陷阱（踩过的坑）

避免重复踩，按主题记录。

### PRTS Wiki API

- `action=query&prop=extracts` 丢失模板内容，**必须**用 `action=parse&prop=text`
- MediaWiki 搜索需 `srnamespace=0`，否则技术页面污染结果
- PRTS `/spine`、`/data` 页面在主命名空间（ns=0），需客户端 `filter_technical` 过滤
- `action=parse&prop=sections` 返回的 `index` 可能是 `T-N` 格式（模板转译），不只是纯数字
- Free-text snippets 从 MediaWiki 搜索索引提取，天然不精确；唯一可靠方式是 `action=parse` 获取完整渲染内容

### 数据格式

- `story_review_table.json` 顶层直接是 `{event_id: entry}`，不是嵌套在某个 key 下
- ArknightsStoryJson zip 内所有路径以 `zh_CN/` 为前缀
- `character_table.json` 用干员 ID（如 `char_002_amiya`）作 key，不是中文名

### 网络与同步

- `GITHUB_MIRRORS` 条目的首尾空白与尾部斜杠已由双实现一致地自动归一化，无需用户手动处理
- Python `httpx` 和 TS `fetch` 行为不完全一致（重试、超时策略），sync 逻辑不要假设相同
- TS `adm-zip` 和 Python `zipfile` 对损坏 zip 的容错不同，sync 里的完整性检查两边都要有
- GitHub API 匿名请求有严格限速，建议配置 `GITHUB_TOKEN`
