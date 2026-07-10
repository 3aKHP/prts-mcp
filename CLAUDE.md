---
project: "PRTS-MCP"
branch: "main"
---

# CLAUDE.md — AI 协作者说明

PRTS-MCP 是面向明日方舟同人创作的 MCP Server，包含 Python 和 TypeScript
两套独立实现；两端均支持 stdio 与 Streamable HTTP。本文件记录**每次会话必读**的工作流。

## 相关文档

| 想看... | 去哪里 |
|---|---|
| 项目现状、版本状态、仓库结构 | [`STATUS.md`](STATUS.md) |
| 代码规范、反模式、已知陷阱 | [`docs/dev/STYLE.md`](docs/dev/STYLE.md) |
| 路线图与未来规划 | [`ROADMAP.md`](ROADMAP.md) |
| 1.x → 2.0 迁移（破坏性变更） | [`docs/migration-1.x-to-2.0.md`](docs/migration-1.x-to-2.0.md) |
| 1.7 LTS 维护规则 | [`docs/dev/LTS.md`](docs/dev/LTS.md) |
| 外部贡献者指南 | [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| Python 实现 | [`python/`](python/) |
| TypeScript 实现 | [`ts/`](ts/) |

动手写代码前先读 `docs/dev/STYLE.md`；不确定项目欠什么时查 `STATUS.md`。

---

## 本机运行时环境（WSL2）

本仓库在当前 WSL2 主机上的已验证入口：

- Shell：交互使用当前 POSIX shell；仓库的 Linux 脚本以 Bash 为执行环境
- Python：由 `uv` 管理 `python/` 项目环境，初始化运行
  `uv sync --directory python --locked`
- Python 命令统一经 `uv run --directory python ...` 执行，不直接调用
  `python/.venv`，也不依赖 ambient `python`
- TypeScript：Node.js 要求 >=22，首选 `ts/package.json` 中的 Volta 版本；
  默认生产运行时为 Bun >=1.3.14
- WSL 下直接使用 `npm` / `npx`

快速检查：

```bash
./scripts/check-runtime.sh
```

完整验证：

```bash
./scripts/check-runtime.sh --full
```

`python/uv.lock` 是可复现环境的来源。uv 仍会在项目内维护隔离环境，但协作者不直接管理其路径。

---

## 分支模型

1.7.0 LTS 发布后三条长期分支：

| 分支 | 用途 | 版本号后缀 |
|------|------|-----------|
| `main` | 最新稳定发布。当前为 2.3.0 | （无） |
| `lts/1.7` | 1.7.x 长期维护线，从 1.7.0 发布提交创建 | （无） |
| `develop` | 开发集成线。所有非 LTS 改动 PR 到这里 | `.dev0`（当前目标为 `2.4.0.dev0`） |

合并方向：

```
feat/refactor/perf/docs/* ───────→ develop
release/* ───────────────────────→ main + develop
fix/docs/*（1.7 LTS）────────────→ lts/1.7 ──→ develop（适用时 cherry-pick）
fix/*（最新稳定 hotfix）────────→ main ──→ develop（forward merge / cherry-pick）
```

不允许反向合并。允许的同步方向只有：`release/* → main`、`release/* → develop`、`main → develop`（hotfix forward merge）和 `lts/1.7 → develop`（适用时 cherry-pick / reimplement）。

## 启动准则

三条硬规则：

- **需明确指令才 Commit**。对话里讨论到"要提交"不算指令，必须出现"请提交 / 请 commit / 请开 PR"这类明确祈使句
- **不在长期分支直接工作**。所有非 LTS feat / refactor / perf / 非紧急 fix / docs / chore 都 PR 到 `develop`；1.7.x 兼容性、安全性、数据同步和关键缺陷修复 PR 到 `lts/1.7`；最新稳定 hotfix 才 PR 到 `main`
- **不主动 push**。即使刚 commit 完，也等用户说"请推"

## 分支命名

`<type>/v<version>-<topic>`，type 用 Conventional Commits 的类型。

- PR 到 `develop`：version = 下个目标版本（如 `feat/v2.4.0-new-domain`）
- PR 到 `lts/1.7`：version = 即将发布的 1.7 patch（如 `fix/v1.7.1-sync-schema`）
- PR 到 `main`（最新稳定 hotfix）：version = 即将发布的 patch（如 `fix/v2.3.1-critical-bug`）

例：
- `feat/v2.4.0-new-domain`
- `refactor/v2.4.0-search-index`
- `fix/v1.7.1-sync-schema`

## 单次迭代循环

### 路径 A：普通改动（→ develop）

用于 feat / refactor / perf / 非紧急 fix / docs / chore。

1. **对齐计划**：动手前用 1-2 段话描述打算做什么、拆成几个 commit、可能的风险。等用户点头
2. **拉分支**：从 `develop` 拉，按上面的命名约定
3. **动手**：按 commit 主题分批提交，每个中间 commit 都能独立编译（bisect-friendly）
4. **本地验证**：
   - WSL 一键验证：`./scripts/check-runtime.sh --full`
   - Python: `uv run --directory python --locked python -m pytest tests -q`
   - TypeScript: `cd ts && npm run build && npm test && npm run typecheck`
   - 双实现同步改动时两边都要跑
5. **推分支 + 开 PR**：PR 目标为 `develop`，PR body 包含 Summary / Test plan / 未尽事宜三段
6. **独立 CR**：spawn 子代理做独立 review（见下文）
7. **应对 CR**：blocking 和 should-fix 处理掉，推到同分支；nits 酌情
8. **人类 merge**：Claude 不做 merge，等用户确认合并到 `develop`
9. **本地清扫**：`git checkout develop && git pull && git branch -d <branch> && git remote prune origin`

### 路径 B：1.7 LTS 修复（→ lts/1.7）

用于 1.7.x 兼容性、安全性、数据同步、关键缺陷和文档修复。先读 [`docs/dev/LTS.md`](docs/dev/LTS.md)。

1. **从 `lts/1.7` 拉分支**：`fix/v1.7.x-<topic>` 或 `docs/v1.7.x-<topic>`
2. **动手 + commit + 本地验证**（运行范围同路径 A；运行时敏感改动跑 `./scripts/check-runtime.sh --full`）
3. **推分支 + 开 PR**：PR 目标为 `lts/1.7`
4. **独立 CR** → **应对 CR** → **人类 merge** 到 `lts/1.7`
5. **打 tag**：`git tag python/v1.7.x && git tag ts/v1.7.x && git push origin python/v1.7.x ts/v1.7.x`
6. **同步到开发线**：如果修复也适用于当前开发版，cherry-pick 或重做到 `develop`
7. **本地清扫**：`git checkout lts/1.7 && git pull && git branch -d <branch> && git remote prune origin`

### 路径 C：最新稳定紧急修复（→ main，hotfix）

1. **从 `main` 拉分支**：`fix/vX.Y.Z-<topic>`
2. **动手 + commit + 本地验证**（同路径 A）
3. **推分支 + 开 PR**：PR 目标为 `main`
4. **独立 CR** → **应对 CR** → **人类 merge** 到 `main`
5. **打 tag**：`git tag python/vX.Y.Z && git tag ts/vX.Y.Z && git push origin --tags`
6. **同步回开发线**：开 back-merge PR（`main` → `develop`，或从 `develop` 拉临时分支 merge `main` 后 PR 到 `develop`）
7. **本地清扫**：`git checkout develop && git pull && git branch -d <branch> && git remote prune origin`

### 路径 D：标准 GitFlow 发布（release/* → main + develop）

`develop` 上改动累积到发布时机时：

1. 从 `develop` 拉 `release/vX.Y.Z`
2. 在 release 分支确认 `[Unreleased]` 段内容齐全
3. 去掉版本号 `-dev` 后缀（更新 `python/pyproject.toml` 后运行 `uv lock --directory python`，并同步 `ts/package.json` + `ts/package-lock.json`）
4. CHANGELOG：`[Unreleased]` → `[X.Y.Z] - YYYY-MM-DD`，release PR 到 `main` 时不保留空 `[Unreleased]`
5. 同步 `STATUS.md` / `ROADMAP.md` / `ROADMAP.zh-CN.md` / `README.md` 的当前稳定版本口径
6. 跑 `./scripts/check-runtime.sh --full`
7. PR：`release/vX.Y.Z` → `main`
8. **独立 CR** → **应对 CR** → **人类 merge** 到 `main`
9. 在 `main` 的 merge commit 上打 tag：`git tag python/vX.Y.Z && git tag ts/vX.Y.Z && git push origin python/vX.Y.Z ts/vX.Y.Z`
10. PR：同一个 `release/vX.Y.Z` → `develop`（不要 squash，保留 release merge 语义）
11. 从更新后的 `develop` 拉 `chore/vNext-open-development`，bump 到下一目标版本 + 加回 `-dev` / `.dev0` 后缀，并重新打开空 `[Unreleased]` 段
12. PR：`chore/vNext-open-development` → `develop`
13. **本地清扫**：`git checkout develop && git pull && git branch -d release/vX.Y.Z chore/vNext-open-development && git remote prune origin`

### 路径 E：1.7.0 LTS 发布

1. 从 `develop` 拉 `release/v1.7.0-lts`
2. 去掉版本号 `-dev` 后缀（`pyproject.toml` + `package.json` + `package-lock.json`）
3. CHANGELOG：`[Unreleased]` → `[1.7.0] - YYYY-MM-DD`，声明 1.7 LTS 基线
4. 同步 `STATUS.md` / `ROADMAP.md` / `ROADMAP.zh-CN.md` / `README.md` / `docs/dev/LTS.md`
5. 跑 `./scripts/check-runtime.sh --full`
6. PR：`release/v1.7.0-lts` → `main`
7. **独立 CR** → **应对 CR** → **人类 merge**
8. 在 `main` merge commit 上打 tag：`python/v1.7.0` 和 `ts/v1.7.0`
9. 从同一个 merge commit 创建并推送 `lts/1.7`
10. 将同一个 release 分支 merge 回 `develop`，然后 bump 到 `2.0.0.dev0` 并重新打开空 `[Unreleased]`

## Commit 规范

严格遵守 [Conventional Commits](https://www.conventionalcommits.org/)。

格式：`<type>(<scope>): <subject>`

- **type**：`feat` / `fix` / `refactor` / `docs` / `chore` / `test` / `style` / `perf`
- **scope** 常用：`python` / `ts` / `sync` / `wiki` / `operator` / `story` / `search` / `ci` / `docker`
- **subject** 小写、祈使、≤72 字符、无句号

多行 body 用 HEREDOC：

```bash
git commit -m "$(cat <<'EOF'
feat(wiki): add template data extraction via prop=parsetree

Detailed explanation...
EOF
)"
```

不使用 `--amend`（除非用户明确要求）；pre-commit hook 失败时不加 `--no-verify`。

## 独立 CR 规范

**每个 PR 都应被一个独立子代理审阅一次**——子代理看不到我们的讨论过程，从 code-only 视角会发现我们共同忽略的东西。

**调用方式**：spawn 一个 `general-purpose` 子代理，prompt 要点：
- 明确说明审阅者视角独立、要 critical
- 提供 PR URL、分支名、基于的主线
- 列出 PR 自述（代理不看 PR 描述会默认相信提交信息）
- 给具体的审查清单（见下方）
- 要求结构化输出：**Blocking / Should-fix / Nits / Verified claims**

**审查清单**：
- 实现一致性：Python 和 TS 两套实现是否行为一致（工具名、参数、输出格式）
- 数据流：新增数据源是否经过 store 抽象层，sync 路径是否正确
- 错误处理：缺失数据/网络失败时是否有优雅降级
- 测试覆盖：新功能是否有对应测试
- 版本一致性：`pyproject.toml` / `uv.lock` / `package.json` / `CHANGELOG.md` 是否同步更新
- 公共 API：工具参数是否向后兼容（1.x 兼容性合约）

**CR 返回后的处理**：
- Blocking 必修；Should-fix 原则上都做，除非有充分理由推迟
- 修完推到同分支，给评论者明确回复
- 涉及架构决策的分歧先同步用户再动

## 版本同步清单

每次版本号变更时，需同步更新以下文件：

| 文件 | 内容 |
|------|------|
| `python/pyproject.toml` | `version` 字段（develop 分支带 `.dev0` 后缀） |
| `python/uv.lock` | Python 项目版本和锁定依赖 |
| `ts/package.json` | `version` 字段（develop 分支带 `-dev.0` 后缀） |
| `python/CHANGELOG.md` | 新版本条目 |
| `ts/CHANGELOG.md` | 新版本条目 |
| `ts/package-lock.json` | npm lockfile 顶层版本 |
| `ROADMAP.md` | 当前版本号 |
| `ROADMAP.zh-CN.md` | 当前版本号（与 `ROADMAP.md` 成对同步，勿漏） |

涉及用户可见行为变化时，顺手更新 `README.md`。

**打 tag 时使用实现级前缀**，CI 的 CD workflow 按前缀分发。Tag 必须打在 `main` 分支的 merge commit 上（不在 `develop` 打 tag）：

```bash
git tag python/v1.3.1 && git tag ts/v1.3.1
git push origin python/v1.3.1 ts/v1.3.1
```

- `python/v*` → PyPI 发布
- `ts/v*` → npm + Docker 发布
- 不要打裸 `v*` tag（不会触发任何 CD）

## 双实现开发规则

本项目 Python 和 TypeScript 是**独立实现**，不是翻译关系。规则：

- 改了一个实现的工具行为，**必须检查**另一个实现是否有对应改动
- 公共工具名、必填参数、输出格式（含 `structuredContent` 载荷）在两套实现间必须一致（CI 有 tool surface / output-channel parity 测试）
- 新工具建议先在一个实现中完成，验证后再移植到另一个
- 两套实现各有独立的 CHANGELOG，版本号尽量同步

## 已知陷阱

- PRTS Wiki `action=query&prop=extracts` 会丢失模板渲染内容，必须用 `action=parse&prop=text`
- MediaWiki 搜索默认扫描所有 namespace，需加 `srnamespace=0`
- PRTS 的 `/spine`、`/data` 等技术页面在主命名空间，需客户端过滤
- story_review_table.json 顶层直接是 `{event_id: entry}`，不是嵌套在某个 key 下
- ArknightsStoryJson zip 内所有路径以 `zh_CN/` 为前缀
- `GITHUB_MIRRORS` 配置的代理 URL 不要带尾部斜杠
- Python 的 `httpx` 和 TS 的 `fetch` 行为不完全一致（重试、超时），sync 逻辑不要假设相同
