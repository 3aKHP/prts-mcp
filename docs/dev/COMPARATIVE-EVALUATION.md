# 可复用对照实验流程

本文面向需要用量化数据评估变更的贡献者，说明如何使用 `tools/experiments/experiment.py` 在本地、SSH 主机或容器中开展 A/B 或 A/B/C 对照实验。被比较的对象可以是完整服务、PoC、单个函数、工具描述或配置，指标可以是耗时、内存、正确率、任务完成率、调用次数等任何可量化的结果。

执行器负责按计划重复执行、保存证据并汇总指标。指标的含义、方向与验收门槛由 benchmark 作者在契约中声明。

> **何时使用本流程？**
> 当你需要用数据支撑一项“更快”“更省”“更准”的结论时，例如：
> - 评估性能优化是否真正带来收益；
> - 对比不同工具描述对参数覆盖率的影响；
> - 在隔离环境中回归验证某个服务版本的首次与热查询耗时。
>
> 日常 PR 的常规验证仍按 [`WORKFLOW.md`](WORKFLOW.md) 的最小验证矩阵执行。

---

## 1. 三份契约

一次实验由三类文件共同描述：

| 文件 | 内容 | 存放位置 |
| --- | --- | --- |
| **Benchmark pack** | 任务、输入、评分器、指标定义、结果等价规则与适配器 | 可公开的 pack 提交进仓库，敏感任务集放在私有位置 |
| **Experiment plan** | 假设、比较对象、版本与产物、轮次顺序、预算与验收门槛 | 可公开的计划提交进仓库，含本机路径的计划留在私有位置 |
| **Environment profile 与 operations** | 执行驱动、拓扑、资源限制，以及环境所有者的操作规范 | 本地被忽略的目录，或仓库之外 |

字段定义以 JSON Schema 为准：[benchmark](../../tools/experiments/schemas/benchmark.schema.json)、[plan](../../tools/experiments/schemas/plan.schema.json)、[environment](../../tools/experiments/schemas/environment.schema.json)、[response](../../tools/experiments/schemas/response.schema.json)。工具内置的校验器覆盖这些文件用到的 Schema 子集。

私有 profile 通过 `operations` 字段指向自己的操作手册。`preview` 命令会展示解析后的路径、命令参数来源、指标门槛和该手册全文，AI 协作者执行实验前应先读取并遵循所选的手册。

profile 中的 `ready=true` 表示配置已经填写完整。实际执行权限与授权范围以环境所有者和当前任务的约定为准。

---

## 2. 快速开始

执行器只依赖 Python 3.6+ 标准库，与 Rust 服务的构建和运行互相独立。在仓库根目录运行：

```bash
python3 tools/experiments/experiment.py init --directory dev/experiments/private/demo
python3 tools/experiments/experiment.py validate --plan dev/experiments/private/demo/plan.json
python3 tools/experiments/experiment.py preview --plan dev/experiments/private/demo/plan.json
python3 tools/experiments/experiment.py doctor --plan dev/experiments/private/demo/plan.json
python3 tools/experiments/experiment.py run --plan dev/experiments/private/demo/plan.json
```

各命令的作用：

- **`init`**：生成 `plan.json`、`environment.json` 和 `operations.md`，遇到同名文件时停止，保护已有内容。
- **`validate`**：校验计划、benchmark 与 profile 的字段。
- **`preview`**：展示配置摘要、命令参数来源和操作手册。
- **`doctor`**：检查执行环境是否满足要求。
- **`run`**：开始实验，并在输出的 `private_run` 字段给出本次运行的完整目录。后文命令中的 `RUN` 即指这个目录。

默认示例在本地比较插入排序与内置排序，全程离线，无需 SSH、Docker 或维护者账号。

第二个示例比较三种工具描述，指标为参数说明覆盖率、必填字段声明和描述长度：

```bash
python3 tools/experiments/experiment.py init --directory dev/experiments/private/schema-demo --example description-coverage
python3 tools/experiments/experiment.py run --plan dev/experiments/private/schema-demo/plan.json
```

该示例演示离线的字段覆盖率统计，适合用来熟悉流程。评估模型理解或任务完成率，需要另行接入对应的 benchmark。

### 配置发现与路径基准

profile 按以下优先级确定：`--profile` 参数 > 环境变量 `EXPERIMENT_PROFILE` > plan 中的 `environment` 字段。

相对路径的基准：

- 命令行参数与环境变量中的路径，相对于当前工作目录。
- plan 中的文件路径，相对于 plan 文件。
- profile 中的 `operations` 与本地 `work_root`，相对于 profile 文件。
- benchmark pack 中的文件路径，相对于 pack 文件。

多个 worktree 共用同一个私有环境时，显式传入 profile 的绝对路径即可：

```bash
python3 tools/experiments/experiment.py doctor --plan /path/to/plan.json --profile /path/to/private/environment.json
```

仓库已忽略 `dev/` 目录。把私有文件放在其他位置时，请先确认 Git 忽略规则，提交前用 `git status --short` 复查。`init` 生成的私有计划包含当前 checkout 的绝对路径，更换 checkout 后重新初始化即可。

---

## 3. 配置独立的执行环境

SSH 与容器环境由贡献者自行准备：

```bash
python3 tools/experiments/experiment.py init --directory dev/experiments/private/remote --driver ssh
python3 tools/experiments/experiment.py init --directory dev/experiments/private/container --driver container
```

生成的 profile 初始为 `ready=false`，按以下步骤启用：

1. 填写 profile 中的主机、镜像与资源限制，可参考[远程配置](../../tools/experiments/examples/ssh.json)和[容器配置](../../tools/experiments/examples/container.json)。
2. 对照[操作手册模板](../../tools/experiments/templates/OPERATIONS.example.md)补全 `operations.md`，写明环境归属、工作目录、共享负载、网络与凭据策略、磁盘余量、资源预算以及保留与清理要求。
3. 将 `ready` 改为 `true`。

私有主机名、IP、SSH 别名、用户名、绝对路径、代理地址和令牌都保存在你自己的私有文件中，公开模板只保留占位内容。

### 执行驱动

| 驱动 | 执行方式 | 隔离边界 |
| --- | --- | --- |
| `local` | 本地 Python 子进程，每次运行使用独立目录 | 工作目录与进程组，适合受信任的 benchmark 代码 |
| `ssh` | 通过已有的 SSH 配置别名连接，使用 BatchMode | 独立主机或虚拟机上的目录与进程组 |
| `container` | Docker 容器，可选通过 `ssh` 连接远端宿主 | 独立容器，带内存、CPU、PID 限制，可选 `network=none` |

所有执行主机都需要 Python 3.6+。SSH 驱动还需要本地 SSH 客户端和已配置好的认证，容器驱动需要宿主安装 Docker 并预先下载含 Python 的镜像。

容器驱动的行为：

- `doctor` 把所选镜像解析为不可变的 image ID，后续执行与清理都会核对该 ID 和所有权标签。镜像需要提前自行拉取。
- 容器使用 `--cap-drop ALL` 与 `no-new-privileges`，并且隔离宿主的 Docker socket 与目录。
- `network=none` 禁用外部网络，容器内的回环访问保持可用。

### 环境检查与资源限制

`doctor` 检查解释器、可用空间、所需能力和环境变量引用。对性能敏感的实验，建议在私有操作手册中记录 CPU 与内存约束、并发实验策略和背景负载，必要时使用独占的虚拟机或配置好的 cgroup，以保证测量条件稳定。

profile 的 `address_space_mib` 限制单个子进程的地址空间，整个服务进程树的内存上限请通过容器或 cgroup 设置。

### 凭据

凭据通过 `env_from` 引用执行主机上已有的环境变量，profile 中只写变量名。SSH 任务读取远端进程环境中的变量。

适配器可能把敏感信息写入原始日志，因此完整的实验证据统一按私有数据保管。执行器只运行 benchmark 与计划中明确声明的命令，请只使用来源可信的适配器。

---

## 4. 设计一次实验

动手写计划前，先梳理以下问题：

1. **假设与范围**：比较哪些确切的产物，改变了什么，保持了什么不变，结果将支持哪个决策。
2. **测量单位**：一次测量对应一个新进程、一次任务运行还是一批函数调用，初始化与预热成本是否计入指标。
3. **任务与数据**：固定输入、任务划分、随机种子和数据快照校验和。冷启动、首次查询、热查询、并发和同步属于不同场景，分别设计 case。
4. **指标与门槛**：确定主指标、辅助指标，以及正确性与成本方面的护栏，写明单位、方向、聚合方式和验收条件。这些内容在运行前确定，保证结论口径一致。
5. **误差与预算**：轮次数、顺序、失败重试次数、单次超时、总执行时间、日志上限和磁盘余量。是否需要独立样本、置信区间或进一步的统计分析，也在这一步决定。

### 轮次顺序

一轮包含每个比较对象各运行一次，默认的顺序安排如下：

- **A/B**：交替使用 AB 与 BA。
- **A/B/C**：遍历全部六种排列。
- **2 到 5 个比较对象**：通过 `design.orders` 显式登记每一轮的顺序。

同一轮内的所有比较对象共用同一个 seed，不同轮次的 seed 依次递增。需要调整轮次顺序时，创建新的计划即可。

### 测量方式由适配器决定

每个适配器按自身场景选择最合适的测量方式：

- **函数示例**在进程内预热，然后测量一批调用。
- **描述示例**直接对静态工件评分。
- **HTTP pack** 为每个 case 启动独立的服务，分别测量就绪时间、首次调用和热调用。

---

## 5. 适配器与内置 pack

### 适配器协议

适配器由 variant 的 `command` 以 argv 形式启动，直接执行，不经过 shell。命令与合并后的 `parameters` 字符串支持以下占位符：

| 占位符 | 含义 |
| --- | --- |
| `{python}` | 执行端的 Python 解释器 |
| `{bundle}` | 本次运行打包的工件目录 |
| `{work}` | 本次尝试独占的工作目录，也是适配器的运行目录 |
| `{variant}` | 当前 variant 的 ID |

pack、plan 和每个 variant 的 `files` 字段显式列出所需工件。目标路径需保持唯一，位于 bundle 目录之内，并避开保留目录 `control/`。

适配器从 stdin 读取一个 JSON 请求：

```json
{"version":1,"cases":[{"id":"task-1","input":{}}],"parameters":{},"context":{"round":0,"variant":"A","seed":1729,"unit":"task-run"}}
```

然后向 stdout 输出一个 JSON 响应，诊断信息写入 stderr：

```json
{"version":1,"cases":[{"id":"task-1","metrics":{"success":1},"output":{"answer":"example"},"details":{"trace":"private details"}}]}
```

响应的要求：

- 为每个 case 返回全部已声明的数值指标，case 之间的顺序任意。
- case 与指标集合须和声明完全一致，数值须为有限的数字类型。
- `details` 仅保存在私有证据中，不进入导出报告。
- 展开后的请求与命令总大小不超过 profile 的 `max_bundle_mib`，收集预算同时计入请求、日志与元数据。

结果等价规则由 pack 的 `equivalence` 决定：

- **`output-sha256`**：适配器须提供 `output`，执行器在同一轮内逐 case 比较规范化后的 JSON。
- **`none`**：允许各 variant 输出不同，由已声明的指标判断优劣。

评分错误、超时和不合法的响应记为执行失败。合法的测量即使未达到门槛，也是有效的实验结果，会如实记入报告。

### 内置 pack

| Pack | 比较内容 | 适用范围 |
| --- | --- | --- |
| [function-performance](../../tools/experiments/benchmarks/function-performance.json) | 两种排序实现 | 小规模函数批次示例 |
| [description-coverage](../../tools/experiments/benchmarks/description-coverage.json) | 三种描述工件 | 确定性的字段覆盖率与长度统计 |
| [mcp-http-smoke](../../tools/experiments/benchmarks/mcp-http-smoke.json) | 自备的原生服务，通过真实 HTTP MCP 调用 `list_items` | 首次与热查询的回归冒烟 |

### 使用 HTTP 冒烟 pack

每个 variant 的命令设为 `["{python}","{bundle}/adapter.py"]`，并在 `parameters` 中提供 `server_command`（argv 数组）与 `server_environment`（对象）。准备被测服务的步骤：

1. 把自备的二进制声明到 `bin/A` 等路径，并设置 `server_command=["{bundle}/bin/A"]`。二进制需匹配执行环境的操作系统、架构与 ABI。
2. 把每个数据文件声明到 `data/...`，并在 `server_environment` 中设置 `GAMEDATA_PATH`、`STORYJSON_PATH`，按需设置 `PRTS_DATA_BACKEND` 或 `PRTS_DATA_DB`，让服务只读取 bundle 内声明过的数据。
3. fixture 可以用现有的运行时验证脚本准备，需要对比发布数据集时再单独固定版本。

适配器同时支持仓库使用的旧式会话协议与 `2026-07-28` 无状态协议，通过 `parameters.protocol` 选择。正式比较时，各 variant 使用相同的协议。

服务绑定回环地址的随机端口，stdout 与 stderr 写入私有日志。离线代理默认阻断外部 HTTP，需要严格网络保证时，选用 `network=none` 的容器。数据库准备、同步、并发和系统资源采样的成本，请用单独的 case 或适配器度量，让查询指标保持纯净。

### 接入新的 benchmark

1. 沿用上游的任务和评分口径。
2. 固定数据、评分器、依赖与运行时的版本。
3. 把每项任务的量化结果转换成上文的响应格式。

评测依赖大模型时，同时记录模型的确切版本、提示词、采样参数、任务划分、重复策略、judge 版本，以及调用次数与 token 成本，并保留失败任务和原始轨迹。需要控制费用时，在适配器中实现明确的调用或 token 预算，执行器的时间预算专用于约束执行时长。

---

## 6. 冻结、续跑与方法修订

### 冻结输入

`run` 在启动任何服务之前，先固定计划、pack、操作手册、工具源码和声明的工件，记录各自的 SHA-256，并打包成本次运行独立的 bundle。profile 与完整操作手册保存在本机快照中，执行端仅接收必要的 job 与显式声明的工件。

冻结阶段失败或中断时，可以先归档本地运行目录，再用 `cleanup` 将其标记为结束。残留输入会保留，此时尚未创建执行端的工作区。

### 尝试与证据

每个“轮次 × variant”是一个 trial，每次尝试拥有独立目录。请求先写入磁盘，stdout 和 stderr 按输出上限保留，超限时保存已捕获的内容并将该尝试标记为失败。合法的 JSON 响应在评分断言之前就已保存，输入文件在执行前后各核对一次哈希。这样每一份有效样本都会进入最终分析。

### 续跑

```bash
python3 tools/experiments/experiment.py resume --run RUN
python3 tools/experiments/experiment.py resume --run RUN --retry-errors
python3 tools/experiments/experiment.py analyze --run RUN
```

续跑遵循以下规则：

- 已完成的合法测量直接复用。
- 失败的尝试在计划登记的 `max_attempts` 范围内追加。遇到新的执行失败时，执行器立即停止，等你排查后再显式续跑。
- 传输中断时，先重新收集证据。无法确认结果的派发记录会保留，并按完整的超时时间计入预算，对应的尝试编号也一并保留。
- 执行端的锁保证同一次运行同一时刻只有一个操作者。远端仍在运行时，稍后重新收集即可。

### 预算与进程清理

`max_run_seconds` 统计适配器的执行时间，状态未知或被中断的尝试按其超时时间保守计费。传输、归档与 cooldown 的耗时不计入该预算，总墙钟时间与外部费用需要另行控制。

超时或日志超限时，执行器会终止该尝试所属的进程组。POSIX 驱动还会启动独立的监护进程：它持有运行锁，通过管道监测 worker，在 worker 收到 HUP、TERM 或异常退出后清理其进程组。容器层的资源限制可以约束整个任务，被测进程若主动脱离进程组，则由环境自身的进程隔离措施兜底。

目前 Linux 本地、SSH 与容器环境已经过实测，Windows 与 macOS 的执行路径等待真机验证。

### 方法修订

源码、数据、配置、操作规范或工具发生变化后，续跑会被拒绝，以保证同一次实验的数据来自同一版本。需要修订方法时，创建新的计划，并在 `parent` 中填写先前 job 的 SHA-256 来说明两次实验的关系，新旧数据各自独立保存。

离线分析、导出、归档，以及按原快照清理，在这种情况下仍可正常进行。

---

## 7. 分析与结论

### 汇总方式

分析器分两步汇总：

1. 对每一轮，把各 case 的数值取等权平均，得到 `aggregate`。
2. 按指标声明的聚合方式（mean 或 median）汇总各轮结果。

delta 与 ratio 门槛先逐轮计算配对的差值或比值，再做聚合。基线为零时比值未定义，对应门槛判定为未通过。

报告给出样本数 n、均值、中位数、范围和门槛判定，解读时请注意：

- n 是已测量的轮次数，与适配器内部的调用次数无关，轮次之间的统计独立性需要实验设计来保证。
- 对静态评分重复运行，验证的是结果可复现。任务数、抽样策略和推断范围请在结论中另行说明。
- 轮次较少时，报告只给出基本统计量，P95、置信区间与显著性结论按需要另行分析。
- case 之间等权平均，与真实生产流量的权重可能不同。

### 判定与退出码

任务齐全、输入未变、等价规则通过，并且所有登记的门槛都达标时，`passed` 为 `true`。数据完整但门槛未达标时，CLI 以退出码 1 结束，数据完整保留，可继续分析。

撰写结论时，请同时说明收益、退化、失败情况、实验环境和测量范围。演示与单次冒烟适合用来验证流程，正式的性能改进结论需要足够轮次的完整实验支撑。

### 导出、归档与清理

```bash
python3 tools/experiments/experiment.py export --run RUN --output /path/to/shareable.json
python3 tools/experiments/experiment.py archive --run RUN --output /path/to/private-backup.tar.gz
python3 tools/experiments/experiment.py cleanup --run RUN
```

- **`export`**：按白名单生成可分享的报告，内容包括指标定义、统计结果、检查结果、轮次顺序、公开标识、产物哈希和有限的环境摘要。公开 ID、revision 和单位由作者自行填写，分享前请再检查一遍。
- **`archive`**：生成完整的 tar.gz 归档，并校验其中每个文件与源清单一致。归档须放在 `RUN` 之外，内含私有证据，仅用于自己保管。
- **`cleanup`**：重新收集证据，核对备份与所有权之后，移除本次运行的 work 目录。本机快照、冻结的输入、原始证据和归档均会保留。容器驱动还会移除标签和镜像 ID 都匹配的本次容器。清理前如果产生了新证据，请先重新归档。

初始化失败留下的内容，在没有 raw 与 work 数据且所有权匹配时可以清理，清理后保留所有权文件和锁。初始化仍在进行时，并发的清理请求会被拒绝。已归档的历史 bundle 保留多久，由你按磁盘情况自行决定。

---

## 8. 协作与验证

仓库为 Codex 提供了入口 [`.agents/skills/comparative-evaluation/SKILL.md`](../../.agents/skills/comparative-evaluation/SKILL.md)，它引导读者查阅本指南和所选的私有 profile。人类贡献者和其他客户端直接使用 CLI 即可。部署、付费评测与合并 PR 等操作，仍按当次任务的授权和仓库的常规流程进行。

修改执行器或 pack 后，运行测试：

```bash
python3 -m unittest discover -s tools/experiments/tests -p 'test_*.py'
```

同时运行适用的示例。涉及远程驱动的改动，还需要在独立环境中验证并保留证据。

PR 描述中请写明计划与产物的标识、公开报告、收益与退化、结论的适用范围，以及运行时或依赖版本的变化，并按 [`WORKFLOW.md`](WORKFLOW.md) 完成对应的验证与双轨审查。
