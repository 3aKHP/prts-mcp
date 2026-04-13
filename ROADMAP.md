# ROADMAP

## 待办：工具描述补全（Glama 全 A 冲刺）

**背景**：2026-04-13 评分后，剧情四件套已全部达到 A 级（3.5~4.2），
干员三件套及 Wiki 两件套停留在 B 级（3.1~3.4）。
差距在于后者缺少"返回格式具象化"和"边界情况说明"。

**需要补充的内容（同时修改 Python `server.py` 和 TS `server.ts`）：**

### `search_prts`
- 补充：返回格式为 Markdown 列表，标题加粗，附简短摘要
- 补充：若未匹配到任何内容，返回空结果提示

### `read_prts_page`
- 补充：返回格式为较长的纯文本（已清洗 Wikitext）
- 补充：若 `page_title` 不存在，返回"页面未找到"提示

### `get_operator_archives`
- 补充：返回格式为结构化 Markdown 文本
- 补充：若干员名称拼写错误或不存在，返回错误提示

### `get_operator_voicelines`
- 补充：返回格式（触发条件 + 台词文本的列表形式）
- 补充：若干员不存在，返回错误提示

### `get_operator_basic_info`
- 补充：返回格式（结构化字段列表）
- 补充：若干员不存在，返回错误提示

**参考**：`dev/reports/reportsFromGemini_04130955.md`
