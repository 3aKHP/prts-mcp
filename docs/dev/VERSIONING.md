# 版本号约定与兼容性承诺

本文件是 PRTS-MCP 版本语义与向后兼容性承诺的单一事实源，面向下游部署者与项目协作者。

- 分支管理、PR 分级与发布操作流程见 [`WORKFLOW.md`](WORKFLOW.md) 与 [`CLAUDE.md`](../../CLAUDE.md)
- `lts/1.7` 与 `lts/2.8` 两条长期支持线的专门规则见 [`LTS.md`](LTS.md)

> **Core promise (EN):** PRTS-MCP follows SemVer-shaped versioning with a closed, enumerated set of deviations declared in this document — not open-ended maintainer discretion. For every Patch and Minor release within a Major line, the default goal is a zero-config upgrade (`npm install -g`, native archive replacement, or Docker image update; plus `pip install -U` on legacy lines) without breaking existing configurations or client workflows.

---

## 1. “向后兼容”的统一定义

在同一 Major 版本线内，**Patch** 与 **Minor** 共享同一个默认目标——**无感升级**，即同时满足：

1. **部署者无感**：下游部署者直接更新安装包或容器镜像，无需修改环境变量、部署脚本或客户端配置即可维持既有功能；
2. **终端调用方无感**：MCP 客户端与上层 AI Agent 可以完全沿用先前的调用方式继续使用所有既有功能。

**纯增量变更均视为兼容**：包括新增工具、为既有工具新增带默认值的可选参数、新增输出内容类型（如 2.5.0 新增立绘输出）、新增带安全默认值的环境变量，以及新增可选协议路径或端点。

**兼容承诺的边界**：承诺覆盖下表列出的工具、环境变量、部署与数据读取契约，内部 Rust 模块 API 不属于向后兼容承诺范围。`contracts/baseline.json` 中的 `D-001`–`D-007` 是 TS/v2.8.1 → Rust 3.0 迁移时已批准的实现差异；3.x 后续变更仍须遵循本文件的兼容性承诺与例外规则。

---

## 2. 兼容性承诺矩阵与例外白名单

### 承诺矩阵

| 契约面 | Patch（`X.Y.Z`） | Minor（`X.Y.0`） | Major（`X.0.0`） |
|---|---|---|---|
| 工具名 / 必填参数 / 输出格式 | 保持兼容（仅限下方三类 Patch 白名单例外） | 同 Patch + 允许第四类受控契约调整（附强制披露义务） | 允许破坏性重构（附迁移指南） |
| 环境变量语义与默认值 | 同上 | 同上 | 允许调整 |
| 部署与传输契约（默认端口、路径、`/health`、`/debug/*`） | 同上 | 同上 | 允许调整 |
| 数据文件读取契约（AKDP 数据集、缓存元数据） | 格式变更须优雅降级兼容旧卷 | 同 Patch + 第四类受控调整 | 允许调整 |
| 内部代码模块 API | 无兼容承诺 | 无兼容承诺 | 无兼容承诺 |

### 封闭枚举的例外集

除以下明确列出的例外情形外，Patch 与 Minor 严禁引入破坏性变更：

1. **Patch 白名单（仅限三类，封闭枚举）**：
   - **a. 修正实现偏离文档的 Bug**：当实际代码行为与公开文档承诺不符时，修复代码使其对齐文档（例如 #193 修复会话空闲超时实际耗时约为文档承诺值 2 倍的问题）；
   - **b. 安全漏洞修复**：修复安全隐患所必需的行为收紧；
   - **c. 上游数据源或外部依赖的强制变更**：应对 PRTS Wiki 或游戏数据结构变化所必需的适配。
   > 即便命中 Patch 白名单，也必须在所有可行方案中优先选择破坏最小的实现，并在 `CHANGELOG` 中明确标注影响面。

2. **Minor 第四类例外（主题必需的受控契约调整）**：
   - 若某次 Minor 版本的核心主题确需调整既有契约，必须同时履行**三项强制义务**：
     1. 在 `CHANGELOG` 该版本段落开头醒目列出升级注意事项；
     2. 编写迁移说明（影响面较大时提供独立的 `docs/migration-X.Y-to-X.Z.md`）；
     3. 技术上可行时，先将旧参数/别名标记为 `Deprecated` 并保留至少一个过渡 Minor 版本，再行移除。

3. **Major 大版本升级**：
   - 允许对公共契约或运行架构做不兼容调整，并须提供迁移指南（例如 2.0 将 32 个工具收敛为 23 个；3.0 将双语言实现统一为原生 Rust 并移除 PyPI 发布渠道）。

> **版本编排惯例**：虽然新增工具属于纯增量兼容变更（在 Patch 中发布亦不违背承诺），但由于 `README.md` 与测试套件均锚定了工具总数，新增公共工具通常优先安排在 **Minor** 版本发布。

---

## 3. 版本号格式与分支流转规则

### 版本号格式

- **三段式 SemVer**：`Major.Minor.Patch`（例如 `3.0.0`）。
- **预发布后缀**：Git tag、`Cargo.toml` 与 `package.json` 统一使用连字符形式：`-alpha.N`、`-beta.N`、`-rc.N`（例如 `3.0.0-alpha.3`）。
  - *注：在 `lts/1.7` 与 `lts/2.8` 旧线中，`python/pyproject.toml` 遵循 PEP 440 格式（如 `2.6.0a1`），旧线 CD 会自动将 tag 中的 `-alpha.` 归一化为 `a` 后比对。*
- **3.x 单一版本源**：在 3.x Rust 工程中，`Cargo.toml` 是唯一版本源，`Cargo.lock`、9 个 npm 包、Docker 镜像与 MCP `serverInfo.version` 必须严格一致。3.x 发布使用裸版本 tag（`v3.x.y` 或 `v3.x.y-alpha.N`）；旧线继续使用成对前缀 tag（`python/v2.8.x` + `ts/v2.8.x`）。
- **开发分支版本后缀**：`develop` 分支上的版本号始终设为**下一计划发布的目标版本 + `-dev.0`**（当前为 `3.0.0-dev.0`；旧线 Python 对应 `.dev0`）。
- **Patch 是日常累积更新的常规载体**：非紧急的缺陷修复、性能优化和小型兼容增补一律合入 `develop` 累积，随常规 Patch 版本发布；只有命中 [`WORKFLOW.md`](WORKFLOW.md) 阻断性回归标准的紧急修复才走直通 `main` 的 Hot-Fix 流程。

### 发布回灌后的 `develop` 版本号推进规则

每次正式版本（或 Hot-Fix）发布并回灌 `develop` 后，`develop` 默认进入当前 Minor 系列的下一个 Patch 开发版本（`-dev.0`）；仅当明确开启新 Minor 主题并在 `ROADMAP` 登记时，才推进至下一 Minor 的 `-dev.0`：

| 发布场景 | 回灌后 `develop` 的版本号 |
|---|---|
| `develop` 完成 `3.0.0` 正式发布，继续 3.0 系列日常维护 | 推进为 `3.0.1-dev.0` |
| `develop` 正在开发 `3.1.0-dev.0`，期间 `main` 发布了 `3.0.1` Hot-Fix | 保持 `3.1.0-dev.0` 不变 |
| `develop` 处于 `3.0.1-dev.0`，期间 `main` 紧急发布了 `3.0.1` Hot-Fix | 顺延推进为 `3.0.2-dev.0` |

> **3.0 过渡期特别说明**：在 3.0.0 正式发布（M5）前，`main` 仍停留在 `2.8.1`。若期间 2.x 发生 Hot-Fix，修复合并至 `main` 与 `lts/2.8` 后，适用部分在 `develop` 的 Rust 代码中单独移植实现，绝不将 2.x 分支直接 merge 进 `develop`。

---

## 4. 明确不引入的机制

为保持工程精简，以下机制经评估后**明确不采纳**：
- 递增式开发构建号（即不使用 `dev.1`、`dev.2`，固定使用 `-dev.0`）；
- 碎片化的本地 CHANGELOG 草稿文件目录（直接维护 `CHANGELOG.md` 与 `CHANGELOG.zh-CN.md` 的 `Unreleased` 段落）；
- 免 PR 直推集成分支（Develop Direct）。
