# ADR-0009：2.0.2 `search_prts` 搜索质量裁决（重定向解析与技术页过滤）

- 状态：Accepted（补录）
- 决策日期：2026-07-06（实现与发布于 2026-07-07，随 2.0.2 生效）
- 关联：[CHANGELOG 2.0.2](../../../CHANGELOG.zh-CN.md)、commit `f97c9aa`、PR [#51](https://github.com/3aKHP/prts-mcp/pull/51)/[#52](https://github.com/3aKHP/prts-mcp/pull/52)、[contracts/wiki-replay/search.json](../../../contracts/wiki-replay/search.json)、[src/wiki/search.rs](../../../src/wiki/search.rs)

> 补录说明：本决策作出于 ADR 目录建立之前（2.0.x 时代，Python/TypeScript 双实现期），因其语义至今被 3.x Rust 实现逐条继承且档案库无逐条记录，按本目录的补录例外整理自 2026-07-06 的内部实施计划与公开 git 历史（tag `python/v2.0.1`、`python/v2.0.2`、`ts/v2.0.2`）。

## 背景与问题

2.0.1 时代 STATUS 的“遗留 TODO”公开记录了两条搜索质量缺陷（可以 `git show python/v2.0.1:STATUS.md` 查证）：

1. “PRTS 搜索结果中 redirect 页面自动解析（MediaWiki API 限制）”；
2. “PRTS 搜索结果中 /spine、/data 等技术页面的更精确过滤”。

用户可感知的现象：

- （当时记录）重定向页命中不解析：搜索常见别名或错拼（如“阿米亚”）时，结果标题停留在重定向页本身，snippet 只有剥离标记后的残留文本（如 `#REDIRECT [[阿米娅]]` 清洗后仅剩“阿米娅”），调用方拿不到规范页名去链式调用 `prts_page`。
- （当时记录）技术页污染：wiki 实现类页面（`/spine`、`/data`、`/db`、`/lua`、`/json` 子页与 `Widget:`、`Template:` 命名空间）混入搜索结果。
- （依修复前后代码差推断）旧过滤器是大小写敏感的子串匹配（7 个字面量加 `in` 判断），因此 `阿米娅/Spine`（大写 S）这类页面会漏过滤；`Module:`、`MediaWiki:`、`模块:`、`模板:` 命名空间与 `.json`/`.lua` 后缀页、子路径 `/module` 均不在过滤范围。
- （依契约夹具推断）`totalhits` 语义在修复前未被测试钉死：过滤后可见条数小于 `totalhits` 是合法状态，但无回归保障。

## 备选方案

重定向处理：

- **先做 live API spike 选定字段**：采纳并执行，结论落在 `srprop=snippet|redirecttitle`（spike 本身的请求/响应记录未见存档，属材料缺口）。
- **直接元数据优先**：采纳。搜索响应已带 `redirecttitle` 时，不再发起任何额外请求。
- **有界 follow-up 查询**：采纳。仅对“疑似重定向”命中（snippet 匹配 `#\s*(?:重定向|REDIRECT)`，忽略大小写）追加一次 `action=query&redirects=1&titles=<原标题>`，按 `from` 等于原标题取 `to`。
- **失败回退（fail-open）**：采纳。follow-up 失败（HTTP 错误或异常）时保留原始标题与结果，不报错。
- **不做重定向处理**：否决。两条 TODO 被明确列为 2.0.2 的目标。
- **对每个命中都发 follow-up、无界批量解析**：否决。“仅对疑似重定向的命中做有界 follow-up”的排除式措辞构成当时记录；否决理由（节省请求数、避免每次搜索多次 API 往返）未形诸文字，属事后推断。

技术页过滤：

- **扩展既有过滤为带边界语义、忽略大小写的正则集合**：采纳。计划只记录“以观察到的噪声模式扩展既有过滤”，具体正则形态只有代码 diff 可查。
- **保留逃生门 `filter_technical=false`**：采纳。用户可显式关闭过滤，原样保留全部命中。
- **保持 `totalhits` 为上游原值**：采纳并钉死。过滤只影响可见条数，不回改 `totalhits`。
- **为补偿过滤而超额拉取（`srlimit = limit*2`）**：沿用。该参数在 2.0.2 之前已存在，非本次新决策（依 `python/v2.0.1` 源码 diff 考证）。

边界约束（当时记录的否决项）：不新增公开工具、不新增必填参数、不改默认输出通道；输出形状保持 `title`+`snippet` 两字段，“任何额外结构化字段须经 parity review 方可加入”（构成对“顺手加 redirect 字段”的否决）；Python 与 TypeScript 必须在同一 PR 集内同步修改并配平测试。

## 决定

以 commit `f97c9aa`（Python 与 TypeScript 双侧同构）落地：

- 搜索请求新增 `srprop=snippet|redirecttitle`，其余参数不变（`srlimit` 仍为过滤开启时 `limit*2`）。
- 重定向解析：对每条命中，若无 `redirecttitle` 字段且 snippet 匹配重定向标记（忽略大小写），追加一次有界 follow-up 查询，取 `redirects[]` 中 `from` 等于原标题的 `to` 替换展示标题；follow-up 任何失败均保留原标题。有 `redirecttitle` 时完全不发 follow-up，且标题保持原样——实现把“`redirecttitle` 存在”当作“无需 follow-up”的信号，并不据此改写标题；此细节由 2.8.1 oracle 录制的冻结契约（`wiki.search.redirecttitle-present`）定格，如实记录，不作美化。
- 过滤顺序：先重定向解析、再技术页过滤、再 `limit` 截断——解析后的目标标题参与技术页判定。
- 技术页过滤替换为三条忽略大小写、带段边界的正则：`/(?:spine|data|db|lua|json|module)(?:$|[/:._-])`、`\.(?:json|lua)$`、`^(?:Widget|Template|Module|MediaWiki|模块|模板):`。
- `totalhits` 恒为上游 `searchinfo.totalhits` 原值；过滤后可见条数可以更小。
- snippet 清洗的重定向标记剥离扩展为同一忽略大小写正则，顺带覆盖 `# 重定向` 带空格写法。
- 空结果：过滤后零命中是合法结构化空（`{"totalhits": N, "results": []}`），content 通道输出 `未找到与 '<query>' 相关的词条。`，不作错误处理；真正的 API 错误仍是 content-only 错误（此语义在 2.0.0 已立，2.0.2 补测试钉死）。

## 后果

正面：

- [CHANGELOG 2.0.2](../../../CHANGELOG.zh-CN.md) 记录：重定向解析加 fail-open、技术页过滤更精确、`totalhits`/`totalHits` 稳定；修复经 PR #51 合入 main、PR #52 回合 develop，发布成对 tag `python/v2.0.2`、`ts/v2.0.2`；2026-07-10 同一修复回移至 1.7 LTS 线（CHANGELOG 1.7.1）。
- 当时测试：Python 侧新增 5 个测试（+181 行），TypeScript 侧同构 5 个（+134 行）；2.0.2 的 STATUS 将两条 TODO 勾选完成。
- 语义延续至今：[contracts/wiki-replay/search.json](../../../contracts/wiki-replay/search.json) 覆盖三条重定向场景（无 `redirecttitle` 加 follow-up 成功、follow-up 返回 HTTP 500、自带 `redirecttitle`）与技术页/`totalhits` 场景；384 项冻结差分中的 `wiki.search.*` 系列（`redirect-follow`、`redirect-fail-open`、`redirecttitle-present`、`default`、`no-filter`、`limit-clamp` 等，见 [contracts/cases/manifest.json](../../../contracts/cases/manifest.json)）逐条钉死行为；当前 Rust 实现 [src/wiki/search.rs](../../../src/wiki/search.rs) 与 [src/wiki/text_ops.rs](../../../src/wiki/text_ops.rs) 逐条继承该语义，单元测试复刻全部场景。

口径注意：golden 用例的 `recorded_with` 为 `server_version: 2.8.1`、`runtime: bun 1.3.14`——它们是从 2.8.1 TS oracle 录制的事后冻结证据，证明 2.0.2 语义原样延续到 2.8.1，而非 2.0.2 当时录制的证据。

负面与代价：疑似重定向的命中最多带来一次额外 API 往返；行为依赖 MediaWiki 上游的 `redirecttitle` 字段语义，该假设在当时无文字解释（材料缺口）。

遗留事项与材料缺口：

- 无独立评审 PR：修复直接落在 `release/v2.0.2` 分支，随 PR #51 整体合入，无单独的 PR 讨论记录可引用。
- live API spike 无存档，选用 `redirecttitle` 的结论只能从 commit diff 反推。
- 过滤正则的逐条来历（各自由哪些真实噪声页触发）无清单。
- 当时无量化指标（如过滤前后命中率/噪声率）；唯一可量化的行为参数是既有的 `srlimit=limit*2` 超额拉取。

公开记录：[CHANGELOG 2.0.2 与 1.7.1](../../../CHANGELOG.zh-CN.md)、commit `f97c9aa`/`c162d0f`/`38ccab3`、PR [#51](https://github.com/3aKHP/prts-mcp/pull/51)/[#52](https://github.com/3aKHP/prts-mcp/pull/52)、tag `python/v2.0.2` 与 `ts/v2.0.2`、[contracts/wiki-replay/search.json](../../../contracts/wiki-replay/search.json)、[contracts/cases/golden/](../../../contracts/cases/golden/) 的 `wiki.search.*` 系列、[src/wiki/search.rs](../../../src/wiki/search.rs)、[src/wiki/text_ops.rs](../../../src/wiki/text_ops.rs)。
