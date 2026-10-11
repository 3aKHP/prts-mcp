# 本地工程 Git 与执行交接

## 仓库边界

外层仓库忽略 `/dev/`，本目录有独立 `.git`，集成分支 `rust-local`，无remote。维护者已明确允许执行Agent按可验证小步骤自动本地commit。无需每次请求commit许可；push、正式发布、修改外层tracked文件仍未获授权。

操作前从本目录检查：

```bash
pwd
git rev-parse --show-toplevel
git status --short --branch
git remote -v
git -C ../.. status --short
```

第一条Git root必须为 `.../PRTS-MCP/dev/rust-rewrite`，不是外层。不要 `git add -f dev/`，不要给外层加submodule，不更改外层.gitignore。开发环境若忽略嵌套AGENTS，需要把README和本文件显式交给执行Agent。

允许本地feature分支开发后fast-forward rust-local。简单文档修订可以直接在本地rust-local提交；这项仅本地例外不改变外层禁直推规则。禁止自动hard reset、删除用户文件、重写旧提交。阶段tag采用 `local/pN-complete`，只在对应阶段全部完成后创建，不冒充公开release tag。

## 文件布局与保留

| 目录/文件 | 是否提交 | 用途 |
|---|---|---|
| src、tests、Cargo.toml/lock、rust-toolchain.toml | 是 | 可独立构建的Rust实现 |
| docs、contracts、research、tools、packaging | 是 | 契约、可复现脚本、源清单与分发入口 |
| reports/Pn.md、精简测量CSV/JSON、决策记录 | 是 | 阶段验收与可追溯结论 |
| .reference | 否 | 可从固定tag重建的TS源与依赖 |
| .runtime | 否 | 完整数据包、测试卷、TS/Rust进程运行目录 |
| artifacts | 否 | 原始日志、大量请求响应、二进制、镜像导出等可再生产物 |
| target、node_modules、.env、凭据 | 否 | 编译缓存和本地环境 |

大文件不进入Git不代表可丢失证据：报告记录hash和重建方式；需要长期保留的原始数据由维护者的本地备份保存。Git不是未提交文件和ignored数据的备份。每阶段可生成 `git bundle create artifacts/pN.bundle --all`，记录bundle hash，并提示维护者另存；不自动同步远端。

## P0 基线准备

以下从本目录执行，使用Bash；目录已存在时先核查，不覆盖已有oracle或数据：

```bash
git -C ../.. rev-parse 'ts/v2.8.1^{commit}'
mkdir -p .reference/ts-v2.8.1
git -C ../.. archive e0ba36096cdd46640166b0a5db02902fa9a6a24c | tar -x -C .reference/ts-v2.8.1
bun install --cwd .reference/ts-v2.8.1/ts --frozen-lockfile
npm --prefix .reference/ts-v2.8.1/ts run build
```

对Bun CLI的 `--cwd` 若当前版本不接受，改在该目录执行同一 `bun install --frozen-lockfile`，不可删锁文件解决。Node辅助oracle若需独立npm安装，复制相同archive到另一个reference目录再 `npm ci --ignore-scripts`，记录各自依赖来源，不把两种install混写到同一node_modules后声称验证了两份lock。

固定源副本只用于oracle。数据fixture按manifest拷贝到运行目录，不对reference自带data原地sync。Node/Bun版本与依赖实际结果写P0报告。外层Python环境目前审计提示未同步，不要求为了TS业务复刻先修Python；GHCR回读阶段可以用固定旧镜像，无需维护Python新实现。

本簇已有声明证据重采集命令从**外层根**执行：

```bash
node --import ./ts/node_modules/tsx/dist/loader.mjs dev/rust-rewrite/tools/capture-baseline.mjs
```

该脚本校验外层所有TS源文件字节与固定tag一致才导出，未来develop源码变更时会拒绝。届时不要删掉校验或挪用新源码；用P0冻结oracle的独立采集脚本生成wire证据。当前脚本只采声明、不启动MCP、不跑业务测试。

## 每个执行步骤

1. 读PROGRESS当前阶段、coverage对应行和该领域契约，确认工作树已有改动归属。
2. 用最小案例固定TS行为/状态，确认预期来源；领域内实现Rust可复用模块。
3. 跑相应Rust测试与MCP差分，失败定位到契约，不通过改golden掩盖。
4. 检查没有额外公共配置、测试专用生产接口或外层路径依赖；更新文档中的真实决策。
5. 更新coverage行状态/证据及PROGRESS，提交 `feat(story): ...` / `fix(sync): ...` / `docs(plan): ...` 等本地Conventional Commit。
6. 阶段末按06全量验证、写Pn报告；只有全部完成才tag并推进阶段。

commit不是自动批准public release。授权允许正常本地连续工作，出现已明确列出的契约决策点再询问，不要为常规模块拆分、测试文件名或依赖补丁选择反复停工。

## 状态词和报告模板

coverage状态只允许 `not-started`、`in-progress`、`implemented`、`verified`、`blocked`。`implemented`意味着有实现但证据不齐；`verified`必须链接报告和案例。阶段完成要求所有归属该阶段的必需行verified；跨阶段综合行由最后所属阶段结算。删除行或把required改成optional须解释范围决策。

每份Pn报告包含：阶段与日期；输入TS SHA/Rust SHA/数据manifest/toolchain；完成的契约ID；命令与结果；失败/未执行项；接受的差异编号；性能结果（适用时）；测试取舍；下一步。Rust SHA应指向已实现代码的提交，报告可在下一文档commit引用它，避免自引用当前尚未存在的SHA。

上下文交接最少写明：当前分支/HEAD、工作树未提交改动、最后通过命令、正在处理的case ID、阻塞原因、下一条可执行任务。新Agent先核对这些事实，不从README重新生成一套计划。
