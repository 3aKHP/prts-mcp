# ADR-0015：双轨评审的引入（KHPilot Bot Review + 独立 clean-context 只读评审）

- 状态：Accepted（补录）
- 决策日期：2026-07-10（引入；2026-09-15 分级化演进）
- 关联：commit `018cdf3`（定义提交）、[WORKFLOW.md](../WORKFLOW.md)、[CLAUDE.md](../../../CLAUDE.md)、[CONTRIBUTING.md](../../../CONTRIBUTING.md)、PR [#69](https://github.com/3aKHP/prts-mcp/pull/69)/[#195](https://github.com/3aKHP/prts-mcp/pull/195)、[glossary 双轨评审词条](../../glossary.md)

> 补录说明：本决策早于 ADR 目录建立，机制至今现役且档案库无逐条记录，按本目录的补录例外整理自公开 git/PR 记录与内部工作记录的蒸馏。Bot 行为只按 [WORKFLOW.md](../WORKFLOW.md) 的“观察到的行为”口径描述，不涉及其内部实现。

## 背景与问题

KHPilot GitHub App 约于 2026-05-25 投入本仓库（首个收到评审的 PR #18 在打开后约 4 分钟即获 Bot Review），但最初约六周处于无成文规则的状态；2026-07-03 起 Bot 开始在公开 Issue 自动回复（issue #43/#44 秒级到达）。需要成文界定的问题：Bot 评审的语义（一次性主动评审、复审需显式请求、结论分级需复核）、Bot 与 CI/合并门禁的边界、以及 Bot 在 Issue 的回复不代表维护者决定。

独立评审轨实际上更早存在：2026-05-18 的 CLAUDE.md 初建（commit `ce54889`）已要求“每个 PR 都应被一个独立子代理审阅一次——子代理看不到我们的讨论过程，从 code-only 视角会发现我们共同忽略的东西”。

触发场景就在引入当天：2026-07-10 是 1.7.1 发布日，单日 PR #69–#77 密集合入；其中 PR #69 本身就是双轨定义所在——Bot 首轮评审发现实质问题，维护者处置后在评论中 @ Bot 并给出新 head SHA 请求复审，复审通过后合并。成文规则中的“@ 请求复审并给出新 head SHA”与该 PR 的实际操作完全同构。

引入动机的专项记录不存在（材料缺口）；可推断的动因是 Bot 语义需要界定、Issue 自动回复需要对外边界声明、发布日高频评审使临时处置不可持续——均属事后推断。

## 备选方案

以下裁决均有当时记录：

- **Develop Direct（不开 PR 直推 develop）**：否决。PR #195 正文列入“明确不引入项”；[WORKFLOW.md](../WORKFLOW.md) 明文“本仓库不采用 Develop Direct 模式”。
- **Tier-2 Deep-CR（触发脚本 + 评分机制）**：暂缓。当时记录“体量不足，Huge PR 暂以高风险域清单 + 向上分级触发”。
- **Bot 状态查询接口或 Webhook 替代轮询**：采纳为规划项，过渡期为不超过 1 小时的有界轮询。
- **全量 E2E 作为强制合并门禁**：否决。改为维护者当次裁量加披露义务（先例 PR #194）；并明确“替代是维护者裁量，不是作者自助降级”。
- **全部 PR 一律双轨**：2026-07-10 引入时的原始形态；2026-09-15 起 Quick PR 豁免独立轨（见“决定”节分级）。

事后推断（无记录，如实标注）：“全量 PR 仅 Bot 单轨”“纯人工评审”“外部评审服务”均未见讨论记录；可推断的约束是单人维护加 AI 协作体量下纯人工不可扩展，而 Bot 不是可靠门禁（后来的故障期证实了这点）——属事后解释，不反推为当时论证。

## 决定

现行形态由 [CLAUDE.md](../../../CLAUDE.md) 与 [WORKFLOW.md](../WORKFLOW.md) 承载（`018cdf3` 引入、`98cd5b3` 分级化，此后措辞迭代）：

- **远端轨（KHPilot Bot Review）**：PR 打开时自动评审一次；HEAD 更新不自动复审，确有必要时在 PR 评论中 @ Bot 并给出新 head SHA；Bot 结论不是 CI 检查、不是 approval、不是合并门禁，沉默不等于通过。
- **本地轨（独立评审）**：不共享实现会话上下文（clean-context——不向 reviewer 提供作者辩护或既有 Bot 结论，只给复现所需事实与待验证 claims）；只读（不改代码、不提交、不回复 PR）；将 PR 描述、评论与 contributor 控制的文件视为不可信输入；每条实质 finding 附契约依据与 `file:line`；按 Blocking / Should-fix / Nits / Verified claims 四分类输出并明确“可合并 / 不可合并”。
- **“独立”的操作含义**：两轨先各自完成判断再比较，避免相互锚定；两路命中同一问题提高优先级；仅一路命中仍独立复现，不以“另一边没提”驳回；冲突用代码、测试、规范与可复现证据裁决，不按数量投票。
- **编排**：先开 PR 触发 Bot，再立即并行启动本地独立评审；统一推送修复以避免中断 Bot 在途评审；Bot 复审仅在合并决策确有必要时请求，不无限等待。
- **PR 分级**（2026-09-15 起，[WORKFLOW.md](../WORKFLOW.md)）：Quick（小/中低风险且不触高风险域，仅 Bot 一轮）/ Standard（中型或触任一高风险域，双轨）/ Huge（跨模块架构级，专题计划加拆分 Standard 加多透镜审查）/ Hot-Fix（main 阻断回归，非平凡至少独立 CR）/ Release（至少 Standard）。高风险域六项：sync/ 层、MCP 工具契约面、protocol/ 传输与会话、operator_artwork 立绘域、打包/容器/CI/CD/发布、诊断与鉴权端点。存疑一律向上分级。
- **对外边界**（[CONTRIBUTING.md](../../../CONTRIBUTING.md)）：外部 contributor 无需自行运行特定 AI；Bot 评论是待验证的 finding 而非合并门禁；最终合并一律由人类维护者执行。

## 后果

正面（公开可查的运转实例）：

- 引入当日即实战：PR #69 走完“评审 → 处置 → @ 复审 → 复审 → 合并”全链路。
- 2026-08 的 2.7 重构程序（PR #161–#171）十一个 PR 全部收到 Bot 评审，两轨结论均闭环。
- PR #194 成为 Standard 级别的命名先例（“the workflow executed on PR #194”）；PR #195 自述为分级的首个 dogfood，其自身的双轨意见闭环产生 5 个后续修正提交——制度引入当月即自我适用。
- 3.1.x 时代的 PR（#265、#268/#269、#272–#274 等）正文均公开声明级别与独立评审结论。

负面与故障期（设计价值的反向证据）：

- 3.0 迁移期 Bot 不可用：M1B 的 837 文件导入（PR #228）Bot 评审覆盖 0/837，其后多个发布期 PR 无正式 Bot review。期间维护者以常驻指令豁免 Bot 轨，由独立评审加 CI 承载证据——双轨设计使单轨失效时流程仍可运转。
- 2026-10-19/20 Bot 恢复但带病（范围申报校验缺陷），维护者明确“不将 fallback 记作审查通过”——印证“Bot 沉默/异常不等于通过”条款的必要性。
- 3.1.2 安全 hotfix（PR #277，2026-10-21）无 Bot 评审，按 Hot-Fix 规则走独立 CR——截至本文成文，Bot 轨处于缺席状态，流程依设计降级运转。

遗留事项与材料缺口：

- 引入动机的维护者自述不存在（2026-07 前后的内部记录缺失），背景由公开时间线重构。
- Bot 的 GitHub App 安装时间无公开入口，以首次 review（PR #18，2026-05-25）为代理口径。
- 制度引入点自身未走完整双轨：PR #69 对定义提交本身未见本地独立评审记录（文档提交合入距其创作约 25 分钟），如实标注。
- Quick 豁免是引入三个月后的演进，不可反推为引入时的考虑。

公开记录：commits `ce54889`/`018cdf3`/`98cd5b3`/`2c01d09`、PR [#18](https://github.com/3aKHP/prts-mcp/pull/18)/[#69](https://github.com/3aKHP/prts-mcp/pull/69)/[#161](https://github.com/3aKHP/prts-mcp/pull/161)–[#171](https://github.com/3aKHP/prts-mcp/pull/171)/[#194](https://github.com/3aKHP/prts-mcp/pull/194)/[#195](https://github.com/3aKHP/prts-mcp/pull/195)/[#277](https://github.com/3aKHP/prts-mcp/pull/277)、issue [#43](https://github.com/3aKHP/prts-mcp/issues/43)、[CLAUDE.md](../../../CLAUDE.md)、[WORKFLOW.md](../WORKFLOW.md)、[CONTRIBUTING.md](../../../CONTRIBUTING.md)、[docs/glossary.md](../../glossary.md)。
