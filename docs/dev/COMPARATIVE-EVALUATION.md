# 可复用对照实验

本指南面向需要用量化证据评估变更的贡献者。比较对象可以是完整服务、PoC、函数、工具描述或配置；指标可以是时间、内存、正确率、任务完成率、调用次数或其他可量化结果。执行器不定义通用总分，也不替 benchmark 决定业务价值。

## 1. 三份契约与两种信息边界

| 文件 | 职责 | 保存位置 |
| --- | --- | --- |
| Benchmark pack | 固定任务、输入、评分器、指标定义、结果等价规则与适配器 | 可公开的版本化 pack 进入仓库；敏感任务集放私有位置 |
| Experiment plan | 假设、比较对象、版本与产物、轮次顺序、预算、验收门槛 | 可公开的计划进入仓库；本地路径计划留在私有位置 |
| Environment profile + operations | 选择驱动、拓扑、资源限制，以及环境所有者的操作规范 | 本地忽略目录或仓库之外；不提交真实拓扑和凭据 |

JSON Schema 是字段契约的单一事实源：[benchmark](../../tools/experiments/schemas/benchmark.schema.json)、[plan](../../tools/experiments/schemas/plan.schema.json)、[environment](../../tools/experiments/schemas/environment.schema.json)、[response](../../tools/experiments/schemas/response.schema.json)。工具内置验证器仅实现这些文件实际使用的 Schema 子集，不是通用 JSON Schema 引擎。

公开指南、模板与执行器不依赖维护者的服务器。私有 profile 通过 `operations` 指向自己的操作手册；`preview` 展示解析后的路径、命令参数来源、指标门槛和操作手册，Agent 使用时应读取并遵循选中的手册。`ready=true` 只表示配置已填写，不代表拥有环境访问权，也不增加当前任务的授权范围。

## 2. 从干净 fork 开始

执行器只需 Python 3.6+ 标准库；这不是 Rust 服务运行时依赖。在仓库根目录运行：

```bash
python3 tools/experiments/experiment.py init --directory dev/experiments/private/demo
python3 tools/experiments/experiment.py validate --plan dev/experiments/private/demo/plan.json
python3 tools/experiments/experiment.py preview --plan dev/experiments/private/demo/plan.json
python3 tools/experiments/experiment.py doctor --plan dev/experiments/private/demo/plan.json
python3 tools/experiments/experiment.py run --plan dev/experiments/private/demo/plan.json
```

`init` 同时生成 `plan.json`、`environment.json` 和 `operations.md`，拒绝覆盖已有文件。默认本地示例比较插入排序与内置排序；不访问外网，不需要 SSH、Docker 或维护者账号。命令输出 `private_run`，后续命令的 `RUN` 指该完整目录。

另一个可直接运行的例子比较三种工具描述，指标为参数说明覆盖率、必填字段声明和描述长度：

```bash
python3 tools/experiments/experiment.py init --directory dev/experiments/private/schema-demo --example description-coverage
python3 tools/experiments/experiment.py run --plan dev/experiments/private/schema-demo/plan.json
```

这是离线字段覆盖率演示，不测模型理解或任务完成率，不能当作论文 benchmark 或真实 Agent 效果评测。

配置发现顺序为 `--profile` > `EXPERIMENT_PROFILE` > plan 的 `environment`。CLI 和环境变量中的相对路径以当前工作目录为基准；plan 中的文件路径相对 plan，profile 的 `operations` 与本地 `work_root` 相对 profile，pack 的文件路径相对 pack。显式指定绝对 profile 路径可以跨 worktree 复用同一私有环境：

```bash
python3 tools/experiments/experiment.py doctor --plan /path/to/plan.json --profile /path/to/private/environment.json
```

本仓库忽略 `dev/`。保存到其他目录时自行确认 Git 忽略规则；提交前用 `git status --short` 检查。`init` 生成的私有计划含当前 checkout 的绝对路径，换 checkout 后需重新初始化或调整路径。

## 3. 配置自己的独立环境

```bash
python3 tools/experiments/experiment.py init --directory dev/experiments/private/remote --driver ssh
python3 tools/experiments/experiment.py init --directory dev/experiments/private/container --driver container
```

SSH、容器模板初始为 `ready=false`。填写 profile 和生成的操作手册，说明环境归属、允许的工作目录、共享负载、网络和凭据策略、磁盘余量、资源预算、保留与清理要求，再启用配置。模板见 [远程配置](../../tools/experiments/examples/ssh.json)、[容器配置](../../tools/experiments/examples/container.json) 和 [操作手册](../../tools/experiments/templates/OPERATIONS.example.md)。不要把私有主机名、IP、SSH 别名、用户名、绝对路径、代理或令牌填入公开模板。

| 驱动 | 执行方式 | 实际隔离边界 |
| --- | --- | --- |
| `local` | 本地 Python 子进程和独立 run 目录 | 工作目录与进程组；不是 OS 沙箱 |
| `ssh` | 既有 SSH 配置别名，BatchMode | 独立主机或 VM 上的目录与进程组；没有自动配置 cgroup 或网络隔离 |
| `container` | Docker，可选附加 `ssh` 作为宿主传输 | 独立容器、内存/CPU/PID 限制、可选 `network=none` |

所有执行主机需要 Python 3.6+。SSH 还需要客户端与已有认证；容器宿主需要 Docker 和已下载的、包含 Python 的镜像。`doctor` 不自动拉取镜像，会将选中的镜像解析为不可变 image ID；后续执行和清理核对该 ID 与所有权标签。容器使用 `--cap-drop ALL`、`no-new-privileges`，不挂载 Docker socket 或宿主目录。`network=none` 仍允许容器内回环访问。

`doctor` 检查解释器、可用空间、所需能力和环境变量引用；不证明实验环境没有竞争负载。对性能敏感的任务应在私有手册中记录 CPU/内存约束、并发实验策略和背景负载，必要时使用独占 VM 或配置好的 cgroup。`address_space_mib` 限制单个子进程地址空间，不等同于整个服务树的 RSS 限制。

凭据只通过 `env_from` 引用执行主机已有的环境变量，不在 profile 中填写值。SSH 任务从远端进程环境取值，不会自动转发本机变量。适配器可能将秘密写进原始日志，因此完整证据始终视为私有。执行器只运行明确声明的命令；不要执行来源不明的适配器。

## 4. 先定义问题，再选测量方法

计划开始前应明确：

1. **假设与适用范围**：比较哪几个确切产物，改变了什么，保持什么相同；结果支持哪个决策。
2. **测量单位**：新进程、一次任务运行还是函数批次；哪些初始化、预热与准备成本包含在指标中。
3. **任务与数据**：固定输入、任务划分、随机种子、快照校验和；区分冷启动、首次查询、热查询、并发、同步等场景。
4. **指标与门槛**：主指标、辅助指标、正确性与成本护栏；指标单位、方向、聚合方法及验收条件。不能看到结果后换口径挑赢家。
5. **误差与预算**：轮次、顺序、失败重试次数、单次时间、总执行时间、日志上限和磁盘余量。确定是否需要独立样本、置信区间或额外统计分析。

默认 A/B 交替 AB/BA，A/B/C 遍历六种排列；2–5 个比较对象均可通过 `design.orders` 显式登记每轮顺序。相同轮次的比较对象共享 seed，不同轮次 seed 递增。完整轮次包含全部比较对象一次，变更轮次顺序应创建新计划。

适配器自己确定测量方式：函数示例在进程内部预热并测量批次；描述示例直接评分静态工件；HTTP pack 每个 case 启动独立服务，测量就绪、首次调用和热调用。执行器不会统一减去启动成本、统一校验文本相同，或把静态评分包装成性能测试。

## 5. 适配器协议与已有 pack

适配器由 variant 的 `command` argv 启动，不经 shell。支持 `{python}`、`{bundle}`、`{work}`、`{variant}` 替换；替换也适用于合并后的 parameters 字符串。运行目录为该次尝试独占的 work 目录。pack、plan 和每个 variant 的 `files` 显式列出工件，目标路径不能重复、逃逸或占用 `control/`。

stdin 接收一个 JSON：

```json
{"version":1,"cases":[{"id":"task-1","input":{}}],"parameters":{},"context":{"round":0,"variant":"A","seed":1729,"unit":"task-run"}}
```

stdout 只输出一个 JSON；诊断写 stderr。展开后的请求和命令合计不能超过 profile 的 `max_bundle_mib`，收集预算同时计入请求、日志与元数据。返回每个 case 的全部已声明数值指标，顺序不限，不允许缺失、额外 case/metric、布尔数值或非有限值：

```json
{"version":1,"cases":[{"id":"task-1","metrics":{"success":1},"output":{"answer":"example"},"details":{"trace":"private details"}}]}
```

`details` 留在私有证据中。`equivalence=output-sha256` 时必须提供 output，并按同轮同 case 比较规范化 JSON；`none` 允许输出不同，由已声明指标判断。评分错误、超时与非法响应属于执行失败；合法测量未达到门槛属于实验结果，不会因此重新抽样。

| Pack | 比较内容 | 边界 |
| --- | --- | --- |
| [function-performance](../../tools/experiments/benchmarks/function-performance.json) | 两种排序实现 | 小规模函数批次示例，不代表服务端性能 |
| [description-coverage](../../tools/experiments/benchmarks/description-coverage.json) | 三种描述工件 | 确定性字段覆盖率与长度，不调用模型 |
| [mcp-http-smoke](../../tools/experiments/benchmarks/mcp-http-smoke.json) | 自备原生服务，通过真实 HTTP MCP 调用 `list_items` | 首次/热查询回归冒烟，不替代历史全场景矩阵 |

HTTP pack 的每个 variant 使用 `command=["{python}","{bundle}/adapter.py"]`，参数包括 `server_command`（argv）和 `server_environment`（对象）。例如将自备二进制声明到 `bin/A`，设置 `server_command=["{bundle}/bin/A"]`；将每个数据文件声明到 `data/...`，设置 `GAMEDATA_PATH`、`STORYJSON_PATH` 与需要的 `PRTS_DATA_BACKEND` 或 `PRTS_DATA_DB`。不要依赖执行主机某个未声明的活动数据目录。二进制须适配执行环境的 OS、架构与 ABI。fixture 可通过现有运行时验证脚本准备，发布数据集另行固定。

HTTP 适配器支持本仓库使用的旧式会话和 `2026-07-28` 无状态协议，由 parameters 的 `protocol` 选择；正式比较时两侧保持相同。服务绑定回环随机端口，stdout/stderr 进入私有日志。离线代理默认阻止外部 HTTP，但需要严格网络保证时应选择 `network=none` 容器。准备数据库、同步、并发与系统资源采样应另建明确的 case/适配器，不把这些成本混入查询指标。

接入新的 benchmark 时，保留上游任务和评分口径，固定数据、评分器、依赖与运行时版本，再将每项任务的量化结果转换成响应契约。若依赖模型，还应记录模型确切版本、提示、采样参数、任务划分、重复策略、judge 版本、调用与 token 成本，保留失败任务和原始轨迹。需要费用限制时在适配器实现明确的调用/token 预算；执行器的时间预算不能代替费用预算。

例如 [MCP Tool Descriptions Are Smelly!](https://arxiv.org/html/2602.14878v3) 涉及描述质量与下游 Agent 表现。接入时需区分描述诊断、改写与 MCP-Universe 下游评估，遵循 [作者实现](https://github.com/SAILResearch/mcp-tool-description-augmentation) 的具体版本和许可。仓库的字段覆盖率演示不是该研究评分器的实现；可先接上游适配器，再用相同执行、证据与对照机制运行。

## 6. 冻结、续跑与方法修订

`run` 在创建服务前固定计划、pack、操作手册、工具源码、声明产物与 SHA-256，打包到该 run 的独立 bundle。profile 和完整操作手册保存在本机快照，不上传为执行配置。执行端只接收必要的 job 与显式工件。

每个 round × variant 是 trial，每次尝试有独立目录。请求先写盘，stdout/stderr 保留，合法 JSON 在评分断言前保存。输入在执行前后核对哈希；不使用断言前失败而丢掉样本的方式决定结果。

```bash
python3 tools/experiments/experiment.py resume --run RUN
python3 tools/experiments/experiment.py resume --run RUN --retry-errors
python3 tools/experiments/experiment.py analyze --run RUN
```

已完成的合法测量不重跑。失败尝试只允许在登记的 `max_attempts` 内追加；遇到新的执行失败立即停止，排查后再次显式续跑。传输断开时先重新收集证据；无法确认的派发记录会保留并按完整 deadline 计入预算，不复用其尝试编号。执行端锁防止同一 run 并行操作；远端仍在运行时稍后重新收集，不另起同一尝试。

`max_run_seconds` 统计适配器执行时间，未知/中断尝试保守按其 timeout 计费；不含传输、归档与 cooldown，因此不是总墙钟时间或外部费用限制。超时和日志上限会停止所属进程组。POSIX 驱动的独立监护进程保留 run 锁，以死亡管道监测 worker，处理其 HUP/TERM 或硬退出后清理所属进程组。容器层资源限制可约束整个任务；进程若自行脱离进程组，需环境自己的进程隔离措施。当前实测覆盖 Linux 本地、SSH 和容器，Windows/macOS 执行路径尚未经真机验证。

改变源码、数据、配置、操作规范或工具后，执行续跑会拒绝混入新版本。创建新计划并用 `parent` 填写先前的 job SHA-256，说明方法修订；不会自动混合新旧数据。离线分析、导出、归档以及按原快照清理仍可进行。

## 7. 分析与公开结论

分析器按 case 汇总轮次，对每轮各 case 的数值取等权平均形成 `aggregate`，再按指标声明的 mean/median 汇总轮次。delta/ratio 门槛先计算配对轮次差值或比值，再聚合；零基线比值视为未定义，不会跳过零值后通过。

报告给出 n、均值、中位数、范围及门槛判定。n 是已测轮次，不是适配器内部调用次数，也不保证统计独立性。静态评分反复运行只能验证可复现性；任务数、抽样策略和推断范围应另行说明。少量轮次不报告伪精确的 P95，不自动生成置信区间或显著性结论。case 等权宏平均也不代表真实生产流量权重。

只有任务齐全、输入未变、等价规则与所有登记门槛通过时 `passed=true`。有完整数据但门槛未达标时 CLI 退出 1，数据仍然保留。结论应说明收益、退化、失败、环境和测量范围；不能仅凭演示或一次冒烟就声称正式性能改进。

```bash
python3 tools/experiments/experiment.py export --run RUN --output /path/to/shareable.json
python3 tools/experiments/experiment.py archive --run RUN --output /path/to/private-backup.tar.gz
python3 tools/experiments/experiment.py cleanup --run RUN
```

`export` 重新构造白名单报告，只含指标定义、统计、检查、顺序、公开标识、产物哈希和有限环境摘要；不复制原始配置、拓扑、路径、日志、参数、details 或操作手册。公开 ID、revision、单位仍由作者选择，分享前检查这些字段。完整 tar.gz 归档含私有证据，不能直接当公开报告上传。

`archive` 校验归档内每个文件与源清单一致，归档必须放在 RUN 之外。`cleanup` 重新收集证据、核对备份和所有权后仅移除本次 work；本机快照、冻结输入、raw 和归档保留。容器还会移除匹配标签及镜像 ID 的本次容器。若产生了新证据，先重新归档。初始化失败内容仅在无 raw/work 且归属匹配时可清理，保留所有权文件和锁；活动的初始化会拒绝并发清理。磁盘管理需另行决定已归档历史 bundle 的保留期，不运行全局 prune。

## 8. 仓库协作与验证

Codex 的仓库内入口位于 [.agents/skills/comparative-evaluation/SKILL.md](../../.agents/skills/comparative-evaluation/SKILL.md)，只引导到本指南和所选私有 profile。人类与其他客户端直接使用 CLI 即可，无需安装 Skill。Skill 不携带维护者拓扑，也不赋予部署、付费评测或合并 PR 的权限。

```bash
python3 -m unittest discover -s tools/experiments/tests -p 'test_*.py'
```

提交执行器或 pack 变更时运行测试和适用的示例；涉及远程驱动时增加独立环境验证并保留证据。PR 中记录计划/产物身份、公开报告、收益与退化、适用范围，以及运行时或依赖版本变化；按 [WORKFLOW](WORKFLOW.md) 完成相应验证和双轨审查。
