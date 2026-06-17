---
project: "PRTS-MCP"
branch: "main"
---

# CLAUDE.md — AI 协作者说明

PRTS-MCP 是面向明日方舟同人创作的 MCP Server，包含 Python（stdio）和 TypeScript（Streamable HTTP）两套独立实现。 本文件记录**每次会话必读**的工作流。

## 相关文档

| 想看... | 去哪里 |
|---|---|
| 项目现状、版本状态、仓库结构 | [`STATUS.md`](STATUS.md) |
| 代码规范、反模式、已知陷阱 | [`docs/dev/STYLE.md`](docs/dev/STYLE.md) |
| 路线图与未来规划 | [`ROADMAP.md`](ROADMAP.md) |
| 外部贡献者指南 | [`python/CONTRIBUTING.md`](python/CONTRIBUTING.md) |
| Python 实现 | [`python/`](python/) |
| TypeScript 实现 | [`ts/`](ts/) |

动手写代码前先读 `docs/dev/STYLE.md`；不确定项目欠什么时查 `STATUS.md`。

---

## 本机运行时环境（Windows）

本仓库在当前 Windows 主机上的已验证入口：

- Shell：优先使用 `C:\Program Files\PowerShell\7\pwsh.exe`，文本输出按 UTF-8 处理
- Python：使用 `E:\Anaconda3\envs\python311\python.exe`
- Python 本地源码导入：需要 `PYTHONPATH=F:\2026-Spring\PRTS-MCP\python\src`
- TypeScript：使用 Volta 选中的 Node 24.14.0（项目要求 Node >=22）
- PowerShell 下运行 npm 命令时用 `npm.cmd` / `npx.cmd`，不要直接用 `npm` / `npx`

快速检查：

```powershell
.\scripts\check-runtime.ps1
```

完整验证：

```powershell
.\scripts\check-runtime.ps1 -Full
```

当前仓库内的 `python/.venv` 来自 MSYS Python 3.12，且缺少 `mcp` 运行时依赖，不作为本机验证环境使用。

---

## 分支模型

两条长期分支：

| 分支 | 用途 | 版本号后缀 |
|------|------|-----------|
| `main` | 生产代码。每次发布 = `main` 的当前 HEAD | （无，已发布版本如 `1.6.1`） |
| `dev` | 开发集成。所有非紧急改动 PR 到这里 | `.dev0`（下个目标版本如 `1.7.0.dev0`） |

合并方向：

```
feat/fix/refactor/perf/docs/* ──→ dev ──→ main（发布时）
fix/*（hotfix）────────────────→ main ──→ dev（forward merge）
```

不允许反向合并（`dev → feature`、`main → dev` 以外的方向）。

## 启动准则

三条硬规则：

- **需明确指令才 Commit**。对话里讨论到"要提交"不算指令，必须出现"请提交 / 请 commit / 请开 PR"这类明确祈使句
- **不在 main 直接工作（hotfix 除外）**。所有 feat / refactor / perf / 非紧急 fix / docs / chore 都 PR 到 `dev`，`dev` 上的改动累积到下一 minor/patch 发布时一次性合入 `main`。紧急修复（hotfix）从 `main` 拉分支，PR 回 `main`
- **不主动 push**。即使刚 commit 完，也等用户说"请推"

## 分支命名

`<type>/v<version>-<topic>`，type 用 Conventional Commits 的类型。

- PR 到 `dev`：version = 下个目标版本（如 `feat/v1.7.0-character-tracking`）
- PR 到 `main`（hotfix）：version = 即将发布的 patch（如 `fix/v1.6.2-critical-bug`）

例：
- `feat/v1.7.0-character-tracking`
- `refactor/v1.7.0-clean-stores`
- `fix/v1.6.2-critical-bug`

## 单次迭代循环

### 路径 A：普通改动（→ dev）

用于 feat / refactor / perf / 非紧急 fix / docs / chore。

1. **对齐计划**：动手前用 1-2 段话描述打算做什么、拆成几个 commit、可能的风险。等用户点头
2. **拉分支**：从 `dev` 拉，按上面的命名约定
3. **动手**：按 commit 主题分批提交，每个中间 commit 都能独立编译（bisect-friendly）
4. **本地验证**：
   - Windows 本机一键验证：`.\scripts\check-runtime.ps1 -Full`
   - Python: `cd python && E:\Anaconda3\envs\python311\python.exe -m pytest tests -q`
   - TypeScript: `cd ts && npm.cmd test && npm.cmd run typecheck`
   - 双实现同步改动时两边都要跑
5. **推分支 + 开 PR**：PR 目标为 `dev`，PR body 包含 Summary / Test plan / 未尽事宜三段
6. **独立 CR**：spawn 子代理做独立 review（见下文）
7. **应对 CR**：blocking 和 should-fix 处理掉，推到同分支；nits 酌情
8. **人类 merge**：Claude 不做 merge，等用户确认合并到 `dev`
9. **本地清扫**：`git checkout dev && git pull && git branch -d <branch> && git remote prune origin`

### 路径 B：紧急修复（→ main，hotfix）

1. **从 `main` 拉分支**：`fix/vX.Y.Z-<topic>`
2. **动手 + commit + 本地验证**（同路径 A）
3. **推分支 + 开 PR**：PR 目标为 `main`
4. **独立 CR** → **应对 CR** → **人类 merge** 到 `main`
5. **打 tag**：`git tag python/vX.Y.Z && git tag ts/vX.Y.Z && git push origin --tags`
6. **forward merge**：`git checkout dev && git merge main`（把 fix 同步回 dev）
7. **本地清扫**：`git checkout dev && git pull && git branch -d <branch> && git remote prune origin`

### 路径 C：dev 发布（dev → main）

dev 上改动累积到发布时机时：

1. 确认 dev 上 `[Unreleased]` 段内容齐全
2. 去掉版本号 `-dev` 后缀（`pyproject.toml` + `package.json`）
3. CHANGELOG：`[Unreleased]` → `[X.Y.Z] - YYYY-MM-DD`，上方插入新的空 `[Unreleased]`
4. PR：`dev` → `main`（纯合并 PR）
5. **独立 CR** → **应对 CR** → **人类 merge**
6. 打 tag：`git tag python/vX.Y.Z && git tag ts/vX.Y.Z && git push origin --tags`
7. `git checkout dev && git merge main`
8. 在 dev 上 bump 版本到下一目标 + 加回 `-dev` 后缀，commit
9. `git push origin dev main --tags`
10. **本地清扫**：`git checkout dev && git pull`

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
- 版本一致性：`pyproject.toml` / `package.json` / `CHANGELOG.md` 是否同步更新
- 公共 API：工具参数是否向后兼容（1.x 兼容性合约）

**CR 返回后的处理**：
- Blocking 必修；Should-fix 原则上都做，除非有充分理由推迟
- 修完推到同分支，给评论者明确回复
- 涉及架构决策的分歧先同步用户再动

## 版本同步清单

每次版本号变更时，需同步更新以下文件：

| 文件 | 内容 |
|------|------|
| `python/pyproject.toml` | `version` 字段（dev 分支带 `.dev0` 后缀） |
| `ts/package.json` | `version` 字段（dev 分支带 `-dev.0` 后缀） |
| `python/CHANGELOG.md` | 新版本条目 |
| `ts/CHANGELOG.md` | 新版本条目 |
| `ROADMAP.md` | 当前版本号 |

涉及用户可见行为变化时，顺手更新 `README.md`。

**打 tag 时使用实现级前缀**，CI 的 CD workflow 按前缀分发。Tag 必须打在 `main` 分支的 merge commit 上（不在 `dev` 打 tag）：

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
- 公共工具名、必填参数、输出格式在两套实现间必须一致（CI 有 tool surface 测试）
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
