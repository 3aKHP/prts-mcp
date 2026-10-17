# 变更分级、评审与验证工作流

本文件定义 PRTS-MCP 中“一次变更需要什么级别的评审与验证”，涵盖变更分级、高风险域识别、双轨 Code Review 机制（含 KHPilot 行为特征）、评审意见处置与最小验证矩阵。

- 具体分支命名与迭代路径（A–F）见 [`CLAUDE.md`](../../CLAUDE.md)
- 版本语义与兼容性承诺见 [`VERSIONING.md`](VERSIONING.md)
- 本地构建与测试命令见 [`ENVIRONMENT.md`](ENVIRONMENT.md)
- 全量 E2E 真机测试流程见 [`E2E.md`](E2E.md)

---

## 1. 核心硬规则

- **一切改动必须经由 PR**：禁止直接向 `main`、`develop`、`lts/1.7` 或 `lts/2.8` 推送提交（本仓库不采用 Develop Direct 模式）。
- **单一意图原则**：每个分支或 PR 只承载一个主要意图；跨模块的大型改动须先拆分为多个独立 PR。
- **文档同改原则**：当改动影响工具行为、配置项、协议、部署契约或用户可见说明时，必须在同一 PR 中同步更新拥有该事实的文档。
- **存疑向上分级**：难以判断某次变更属于哪一等级时，一律**向上分级**。
- **如实披露验证边界**：因环境或条件限制未能执行的验证项，必须在 PR 描述或交接记录中明确标注为“未验证”，严禁当作已通过。
- **CI 触发与成本控制**：PR 仅在目标分支为 `main` 或带有 `ci:full` 标签时运行全量五平台矩阵，其余 PR 运行普通 Linux CI。添加或移除标签、修改合并目标及更新 PR HEAD 时均重新判断，并自动取消同一 PR 的在途旧运行。短分支日常 push 不单独运行 CI；`main` / `develop` 的 push 运行普通 CI。原生矩阵保留手动运行入口，`v3.*` tag 的发布工作流继续构建和验证完整候选产物。
- **普通 CI 验证范围**：保留 fmt、clippy、全量 Rust 单元与集成测试、384 项冻结差分、进程生命周期、扩展正则、源码包和发布策略校验。普通 CI 额外运行 `package_data` 辅助程序测试，并行执行 Rust `1.89.0` 的 `--bins --example package_data` 检查。热缓存耗时以约 5 分钟为目标，冷构建和排队时间单独记录；完整数据打包、跨平台 npm 安装、Docker 与候选聚合由全量 CI 执行。
- **CI 合并门禁**：`CI gate` 要求本次运行选中的全部检查成功，失败、取消或意外跳过均不能通过。`main` 还须要求 `Full CI gate`；普通 CI 不生成这个检查名。启用相应分支保护前，须先将新工作流部署到该目标分支；手动运行的检查不替代 PR 事件产生的合并门禁。

---

## 2. 变更分级与高风险域

### 变更分级表

| 等级 | 适用范围 | 评审要求 | 合并条件 |
|---|---|---|---|
| **Quick PR** | 小/中型、低风险、未触及高风险域 | KHPilot Bot Review 一轮 | Bot 无 Blocking 项后，由维护者人工合并 |
| **Standard PR** | 中型改动，或触及任一高风险域 | 本地独立 CR + Bot Review **并行**（“双轨 CR”） | 全部 Blocking / Should-fix 项闭环后，由维护者人工合并 |
| **Huge PR** | 大型、跨模块、架构级高风险改动 | 事前专题计划 + 拆分为多个 Standard PR + 整体多透镜审查（强烈建议全量 E2E，非硬门禁） | 多透镜审查结论全部闭环后，由维护者人工合并 |
| **Hot-Fix** | `main` 或已发布稳定版 tag 的阻断性回归 | 非平凡变更至少完成独立 CR | PR 合并至 `main` 并打补丁 tag 后，按需同步/移植至维护线与 `develop` |
| **Release** | 公开发布（含 Patch / Minor / 预发布版本） | 至少按 Standard PR 执行；命中 Huge 条件时按 Huge 执行 | 完成版本/CHANGELOG/产物校验与评审后合并发布 |

评审意见统一按四级分类处置：
- **Blocking**：合并前必须修复；
- **Should-fix**：原则上在当前 PR 修复，若确需延后须在 PR 中写明理由与后续跟踪方式；
- **Nits**：细节打磨建议，酌情处理；
- **Verified claims**：已核实通过的结论，可记录于 PR 或合并说明中。

### 高风险域清单

触及以下任一领域的改动，**最低按 Standard PR（双轨 CR）执行**：

1. `sync/` 层（Release 发现、下载传输、镜像回退、manifest/ZIP 校验、代际激活与跨进程锁）；
2. MCP 工具契约面（工具名、参数 Schema、输出格式与 TS/v2.8.1 对齐基线）；
3. `protocol/` 传输层（stdio / Streamable HTTP、协议时代切换与会话生命周期管理）；
4. `operator_artwork` 立绘域（MediaWiki 在线模式与 AKDP 本地资产模式的衔接与校验）；
5. 打包、容器、CI/CD 与发布工作流（`packaging/`、`tools/`、`.github/workflows/`、`Dockerfile`）；
6. 诊断与鉴权端点（`/debug/cache`、`/debug/metrics`、`PRTS_DEBUG_TOKEN`）。

> **关于全量 E2E 真机测试的裁量规则**：
> 上述第 1–4 项及程序级重构同时属于 [`E2E.md`](E2E.md) 建议执行真机验证的场景。由于全量 E2E 涉及多路数据与大体积立绘同步、真实客户端调用，时间与流量成本较高，因此**任何变更等级均不将其设为强制合并门禁**。命中建议场景时，是否执行全量 E2E，或以针对改动范围的轻量化真机验证替代，由维护者按当次改动的风险与成本决定；若采用轻量化验证替代，必须在 PR 描述中明确说明实际验证范围与未执行的重型环节。

---

## 3. 各等级执行细则

### Quick PR
适用于不触及高风险域的低风险改动或纯文档修正。流程：创建短分支 → 实现并完成本地验证 → 打开 PR → 等待 KHPilot Bot Review 一轮并处理反馈 → 无 Blocking 项后交由维护者人工合并。

### Standard PR（双轨 CR）
适用于中型改动或触及高风险域的变更。流程：创建短分支 → 实现并完成本地验证 → **先打开 PR**（触发远端 KHPilot Bot）→ **立即并行启动本地独立 CR** → 汇总两轨结论并按四级分类闭环 → 维护者人工合并。

**本地独立 CR（Tier 1）要求**：
- 由未参与当前实现会话的干净上下文 Reviewer（通常为只读 SubAgent）执行，不直接修改代码；
- 每条实质问题（finding）必须附带契约依据与具体的 `file:line` 代码位置；
- 最终按四级分类输出审查报告，并明确给出“可合并 / 不可合并”结论（详细指令见 [`CLAUDE.md`](../../CLAUDE.md)）。

### Huge PR
适用于跨多个子系统的大型特性或架构迁移：
1. 动手前先编写专题设计计划（明确目标、验收条件、涉及模块、失败模式与拆分方案）；
2. 将实现拆分为多个单一意图的 Standard PR，逐个通过双轨 CR；
3. 对整体变更开展多透镜审查（按数据同步、工具契约对齐、传输与会话、立绘双源、打包与配置五个维度逐一核查）。

### Hot-Fix
仅用于修复 `main` 或已发布稳定版上的**阻断性生产回归**（如服务无法启动、工具全面报错、数据卷损坏或凭据泄露）；非阻断的日常修复一律走 `develop`。流程：从 `main` 创建 `fix/vX.Y.Z-<topic>` → 最小化修复与回归测试 → 更新 CHANGELOG → 打开 PR 至 `main` 并完成审查 → 合并打 tag → 将适用修复同步至维护线与 `develop`（版本号衔接规则见 [`VERSIONING.md`](VERSIONING.md)）。

### Release 与 3.0 过渡期预发布
- **正式版发布（Release）**：按 `CLAUDE.md` 路径 D 执行，至少完成 Standard PR 级别的双轨审查与发布产物核对，合并至 `main` 打 tag 后原分支回灌 `develop`。
- **3.0 过渡期预发布（M5 前）**：在 `main` 仍为 2.8.1 期间，Rust 候选版（`3.0.0-alpha.N` / `beta.N` / `rc.N`）从已审查的 `develop` 快照拉出 `release/v3.x.y-...` 短分支，完成独立审查与完整 CI 后直接在该远端发布分支的提交上打 `v3.*` tag 触发 [`release-rust.yml`](../../.github/workflows/release-rust.yml)，过渡期内不提前合并进 `main`，也不改变 `develop` 的 `-dev.0` 版本号。

---

## 4. KHPilot Bot Review 协同机制

KHPilot 是仓库配置的自动代码评审 GitHub App，具有以下运行特征：

1. **仅在 PR 打开时自动触发一次**：后续向同一 PR 推送新提交时，Bot **不会自动复审**。为避免主 Agent 与 Bot 陷入无限复审循环，**仅当修复了重大问题且维护者合并决策确需 Bot 复核时**，才在 PR 评论中通过 `@khpilot`（或 `@khpilot[bot]`）手动请求复审。
2. **评审耗时**：视 Diff 规模通常需要 **3–5 分钟至近 1 小时**。
3. **在途中断**：若 Bot 正在评审时向 PR 推送了新提交（HEAD 移动），该次在途评审会立即中断。因此推荐**先开 PR 触发 Bot，同时在本地跑独立 CR**，待两轨都完成后再统一推送修复提交。

等待 Bot 评审到达时，可使用以下后台轮询脚本（每 3 分钟检查一次，上限 60 分钟）：

```bash
pr=123  # 替换为实际 PR 编号
for i in $(seq 1 20); do
  gh pr view "$pr" --json reviews --jq '[.reviews[].author.login] | any(startswith("khpilot"))' 2>/dev/null | grep -q true && break
  sleep 180
done
gh pr view "$pr" --json reviews --jq '[.reviews[] | select(.author.login | startswith("khpilot"))] | last | {state, submittedAt}'
```

---

## 5. 最小验证矩阵

根据改动风险选择对应的本地验证层级（具体命令见 [`ENVIRONMENT.md`](ENVIRONMENT.md)）：

| 改动类型 | 最小本地验证要求 |
|---|---|
| **仅文档改动** | 核对技术事实、示例语法与本地相对链接；打开 PR 后通过 CI 检查。 |
| **局部低风险 Rust 代码** | `cargo fmt --all -- --check`、`cargo clippy --locked --all-targets -- -D warnings` 及对应模块的 `cargo test --locked`；若触及公共输出再补跑差分测试。 |
| **工具面 / 数据解析 / 同步运行时** | 全量 Rust 测试 + `./scripts/check-runtime.sh --full`（含 384 个冻结 TS 对照用例与生命周期测试）。 |
| **高风险域改动** | 上述全量验证（`./scripts/check-runtime.sh --full`）；强烈建议按维护者裁量执行真机 E2E 或定向真机验证（并在 PR 中披露验证范围）。 |
| **Huge PR** | 全量验证 + 整体多透镜审查 + 维护者裁量的 E2E 验证。 |
| **Release 发布** | 全量验证 + 版本号 / CHANGELOG / STATUS 一致性核对 + 发行产物与校验和核对。 |

## 6. 其他协作约定

- **Issue 关联语法**：PR 完整解决某个 Issue 时，在描述中单独成行写 `Closes #<issue>`；若仅部分关联或提供前置铺垫，写 `Refs #<issue>`。
- **合并权限与历史**：所有 PR 一律由人类维护者合并（保留 merge commit 历史，不 squash）。
