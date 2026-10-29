# ADR-0012：RC 阶段已知问题的分级裁量

- 状态：Accepted（补录）
- 决策日期：2026-10-15
- 关联：GitHub Release [`v3.0.0-rc.1`](https://github.com/3aKHP/prts-mcp/releases/tag/v3.0.0-rc.1)/[`rc.2`](https://github.com/3aKHP/prts-mcp/releases/tag/v3.0.0-rc.2)/[`rc.3`](https://github.com/3aKHP/prts-mcp/releases/tag/v3.0.0-rc.3)、PR [#245](https://github.com/3aKHP/prts-mcp/pull/245)/[#246](https://github.com/3aKHP/prts-mcp/pull/246)/[#254](https://github.com/3aKHP/prts-mcp/pull/254)、[CHANGELOG 3.0.0](../../../CHANGELOG.zh-CN.md)、[WORKFLOW.md](../WORKFLOW.md)、[RELEASE-CANDIDATES.md](../RELEASE-CANDIDATES.md)

> 补录说明：本裁量口径作出于 ADR 目录建立之前，且**从未单独成文**——本文是从 2026-10-15 一天内三个案例的处置记录反向蒸馏的首次书面化，按本目录的补录例外标注；素材为同期内部工作记录与公开 Release/PR 页面。

## 背景与问题

3.0 采用“发布分支 + 审查型候选 PR（不合入 develop）+ tag 触发全渠道发布”的候选流程（见 [RELEASE-CANDIDATES.md](../RELEASE-CANDIDATES.md)；候选 PR #245/#246 均保持 CLOSED 未合并）。正式版放行的当时条件是维护者设定的：RC 须在生产服务器完成全生命周期观测与专项压测，“没有阻断问题即可发布”，且明确该条件仅用于本轮、不扩展为常设门禁。

2026-10-15 一天内出现三个案例，合起来构成完整裁量口径：

1. **协议头误判（rc.1，事后发现）**：rc.1 发布后，生产验收发现携带 2024/2025 `MCP-Protocol-Version` 头的旧协议 HTTP 客户端被误判为现代协议并返回 `-32602`，真实客户端（公开说明点名 Codex 等）全面失败；根因是协议分类偏离冻结的 TS/v2.8.1 基线。注意：rc.1 发布时并无“已知”问题，本案例的裁量是事后的“不撤回、加披露、修复进下一候选”。
2. **敌人反查首查超时（rc.2，发布后已知）**：rc.2 生产验收发现并发负载期间 `get_enemy_appearances` 首查服务端耗时 34.25 秒并致客户端超时，同进程随后两次合计约 0.46 ms；受控重启后首查约 5.1 秒（OS 页缓存仍热，非完全冷机口径）。
3. **RSS 落差（rc.2 同期，反例）**：混合使用后常驻内存 616.18 MiB（内部记录的生产服务器采样口径），与此前形成的内存收益预期明显不符，且已确认存在非必要的实现冗余。

裁量要回答：哪些问题阻断、已发布候选如何处置、如何公开披露、修复在哪里收口。

## 备选方案

以下裁决除标注外均有当时书面记录：

- **覆盖或重打 rc.1 的 tag 与字节**：否决。记录原文“rc.1 字节与 tag 不覆盖”；PR #246 正文明文 “rc.1 history and published artifacts remain immutable”。
- **为冷查询问题重发一个 RC**：放弃。维护者授权在“重发 rc.3”与“排入 3.0.1”之间选择，执行方选定 3.0.1；明确不为此重发候选、不设为 3.0 阻断。（后注：实际的 rc.3 因 RSS 阻断修复而发布，与冷查询无关。）
- **把 RSS 问题援引冷查询先例一并延期**：否决。记录原文“这一历史决定不等于允许 RSS 问题一起延期”——单项非阻断裁定不构成“同类问题均可延期”的先例，逐项由维护者裁定。
- **修复后全量重跑验证**：未采纳；采纳的流程口径是“修复并发布新 RC，只复验受影响部分及必要的交互影响”。

事后推断（无书面记录，如实标注）：撤回或删除 rc.1 的 GitHub Release、npm unpublish 均未见任何讨论记录，只能从“发行物不可变”的既有惯例推断其不在考虑范围；3.0.0 正式版说明最终未保留冷查询已知问题（与内部验收记录“正式版整理时继续保留”的要求不一致），是遗漏还是认定已缓解，无记录。

## 决定

1. **发行物不可变**：已发布候选的 tag、字节与历史一律不覆盖；缺陷经新候选收口，旧候选保留并在其 Release 页面补披露。
2. **阻断与非阻断由维护者逐项裁定，不设可推广先例**：协议分类错误（真实客户端全面失败 + 冻结契约偏离）→ 立即修复并发 rc.2；RSS 落差（幅度未定量但已确认非必要冗余且偏离预期）→ 裁定阻断正式版，解除条件为补齐同负载对照、完成归因与处置复测（2026-10-16 以 rc.3 收口后放行 3.0.0）；冷查询首查超时（有缓存兜底、重试即恢复、影响面为首次调用）→ 非阻断，排入后续版本。
3. **披露义务**：在受影响的 Release 页面以最小中英文双语注记披露——rc.1 页面顶部追加 blockquote（指向 rc.2 并提示候选验收改用 rc.2），rc.2 页面正文内嵌 “Known performance issue (planned for 3.0.1)”。披露载体是 GitHub Release 页面，不进 CHANGELOG 条目。
4. **收口安排**：非阻断问题排入后续版本并预立定位计划（先拆分读取/解析/聚合耗时，不以提高客户端超时或强制预热代替定位；复用既有测试与 CI，不新增发布门禁）。
5. **拍板归属**：全部裁定由维护者作出；冷查询一项为两级结构——维护者划定可选项（重发候选或排入后续版本），执行方在授权内选定。

## 后果

正面：

- rc.2 修复协议分类后，此前失败的真实 legacy 客户端查询恢复且与 TS 基线结果一致（PR #246 正文可证）；rc.1 的披露头至今保留在 Release 页面。
- RSS 修复经 rc.3 收口后，维护者于 2026-10-16 裁定放行 3.0.0（PR #254）；正式版代码与 rc.3 一致，[CHANGELOG 3.0.0](../../../CHANGELOG.zh-CN.md) 记载“混合查询负载下常驻内存低于 2.8.1”。

后续实际走向（如实记录与裁定的偏离）：

- 冷查询的“排入 3.0.1”未以该版本落地——3.0.1 从未发布（tag 序列 v3.0.0 之后为 v3.1.0）。3.0.0 正式版已含字段投影等部分缓解；结构性缓解随 3.1.0 的可选 SQLite 后端到来（见 [ADR-0001](ADR-0001-sqlite-data-backend.md)）。JSON 默认路径的首建慢是否仍为已知问题，无公开结论；“3.0.1 收口”计划无关闭记录。

材料缺口：

- 阻断与非阻断的判定阈值无成文标准，只能从案例归纳；[WORKFLOW.md](../WORKFLOW.md) 的“阻断性生产回归”定义面向 Hot-Fix 流程，与本裁量相邻而非同一文本。
- 三次裁定的决策对话无原始记录（内部报告为结论性转述，两处措辞略有差异，拍板归属的精确边界不可考）。
- Release 页面的披露编辑无公开审计（仅 `updated_at` 时间戳可考：rc.1 的披露头在 rc.2 公开后数分钟内补加）。

公开记录：Release [`v3.0.0-rc.1`](https://github.com/3aKHP/prts-mcp/releases/tag/v3.0.0-rc.1)（顶部双语已知问题头）、[`v3.0.0-rc.2`](https://github.com/3aKHP/prts-mcp/releases/tag/v3.0.0-rc.2)（正文已知性能问题注记）、[`v3.0.0-rc.3`](https://github.com/3aKHP/prts-mcp/releases/tag/v3.0.0-rc.3)、[CHANGELOG](../../../CHANGELOG.zh-CN.md) 3.0.0-rc.2/rc.3/3.0.0 条目、PR [#245](https://github.com/3aKHP/prts-mcp/pull/245)/[#246](https://github.com/3aKHP/prts-mcp/pull/246)（CLOSED 未合并的审查型候选 PR）与 [#254](https://github.com/3aKHP/prts-mcp/pull/254)、[WORKFLOW.md](../WORKFLOW.md)、[VERSIONING.md](../VERSIONING.md)、[RELEASE-CANDIDATES.md](../RELEASE-CANDIDATES.md)。
