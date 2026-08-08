# 代码规范与架构 — PRTS-MCP

面向所有协作者（人类与 AI）。本文件记录代码架构硬原则、反模式、CHANGELOG 规则、测试规范以及历史陷阱。

公开贡献流程见 [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md)，跨平台开发环境见 [`ENVIRONMENT.md`](ENVIRONMENT.md)。当前维护者与 AI 的日常工作流见 [`../../CLAUDE.md`](../../CLAUDE.md)；项目现状见 [`../../STATUS.md`](../../STATUS.md)。

---

## 代码规范与架构

**项目维护者对代码架构和模块化解耦要求很高**。上帝文件和面条代码是底线问题，在它们出现之前就要阻止。以下是硬性原则，不是"nice to have"。

### 文件大小与职责

- **单一职责**：一个文件只干一件事。`operator.py` 只负责干员数据读取，不混进搜索逻辑；`sanitizer.py` 只管 wikitext 清洗，不放 API 调用
- **文件长度预警线**：源文件超过 ~300 行就要问"这能不能拆"
- **模块边界**：`data/` 只做数据读写和格式化，不混进 HTTP 请求；`api/` 只做 PRTS Wiki API 调用；`server.py` 只做工具注册和启动编排

### 分层纪律

```
server.py/ts          ←  MCP 工具注册、启动同步编排
api/                  ←  PRTS Wiki MediaWiki API 客户端
data/                 ←  干员/剧情/搜索/同步/store 抽象
data/stores           ←  DirectoryStore / ZipStore 底层读写
utils/                ←  跨领域纯函数（wikitext 清洗等）
config.py/ts          ←  路径解析、环境变量
```

**允许的依赖方向**：`server → api, data, config` / `data → stores, utils, config` / `api → utils`。 **禁止**：`stores` 依赖 `data`；`utils` 依赖 `api` 或 `data`；`config` 依赖任何其他模块。

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
- 跨层调用（data 模块里直接发起 HTTP 请求）
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

- 只读数据表用 `@lru_cache(maxsize=1)` 惰性加载
- 数据被 sync 更新后，调用 `clear_operator_caches()` 清缓存
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

// 好：module-level 惰性缓存
let _characterTable: TableCache<Record<string, CharacterEntry>> = null;
```

- 只定义实际使用的字段，不要为整个 JSON 定义完整类型
- `null` = 未加载，`undefined` = 加载失败

### 缓存

- 模块级 `let` 变量 + `clearXxxCaches()` 函数
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
| `data/story.py` | `data/story.ts` | 剧情数据读取和格式化 |
| `data/search.py` | `data/search.ts` | 全文搜索 |
| `data/sync.py` | `data/sync.ts` | GitHub Release 同步 |
| `data/datasets.py` | `data/datasets.ts` | 数据集 spec 定义 |
| `api/prts_wiki.py` | `api/prtsWiki.ts` | PRTS MediaWiki API 客户端 |
| `utils/sanitizer.py` | `utils/sanitizer.ts` | Wikitext 清洗 |

TS 文件头注释应注明对应的 Python 文件：`Mirrors python/src/prts_mcp/data/operator.py.`

---

## 版本号与发布

遵循 [SemVer](https://semver.org/)。预发布用 `-alpha.N` / `-beta.N` / `-rc.N` 后缀。

**`develop` 分支上的版本号**始终带开发后缀，发布时去掉：

| 文件 | develop 分支 | main 分支（发布时） |
|------|---------|-------------------|
| `python/pyproject.toml` | `2.5.0.dev0` | `2.5.0` |
| `python/uv.lock` | `2.5.0.dev0` | `2.5.0` |
| `ts/package.json` | `2.5.0-dev.0` | `2.5.0` |
| `ts/package-lock.json` | `2.5.0-dev.0` | `2.5.0` |

**版本号需要同步更新的地方**：

| 文件 | 内容 |
|------|------|
| `python/pyproject.toml` | `version` 字段（develop 分支带 `.dev0` 后缀） |
| `python/uv.lock` | Python 项目版本和锁定依赖 |
| `ts/package.json` | `version` 字段（develop 分支带 `-dev.0` 后缀） |
| `python/CHANGELOG.md` | 新版本条目 |
| `ts/CHANGELOG.md` | 新版本条目 |
| `ROADMAP.md` | 当前版本号 |
| `STATUS.md` | 当前版本 / 分支状态 |
| `README.md` | 用户可见版本、工具数、工具清单 |

Tag 使用实现级前缀：`python/vX.Y.Z` 和 `ts/vX.Y.Z`。Tag 必须打在 `main` 分支的发布 merge commit 上；1.7.x LTS patch tag 打在 `lts/1.7` 的对应 merge commit 上。

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

- `GITHUB_MIRRORS` 代理 URL 不要带尾部斜杠
- Python `httpx` 和 TS `fetch` 行为不完全一致（重试、超时策略），sync 逻辑不要假设相同
- TS `adm-zip` 和 Python `zipfile` 对损坏 zip 的容错不同，sync 里的完整性检查两边都要有
- GitHub API 匿名请求有严格限速，建议配置 `GITHUB_TOKEN`
