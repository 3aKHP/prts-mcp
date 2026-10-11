# 持续验证与测试取舍

## 验证目标

证明相同固定输入下的用户行为、持久状态和恢复能力，而不是证明Rust代码长得像TS。每阶段同时实现、差分、记录证据；最后阶段只做综合闭环与缺口清零。

验证分三层：纯算法/解析的少量高价值案例；真实文件系统与本地HTTP的领域状态测试；独立进程MCP差分。层级分别捕获不同问题，不用同一函数的实现表达式计算期望值。不设代码覆盖率百分比、测试数量或mock调用次数门槛。

## TS oracle 和测试输入

P0建立 `.reference/ts-v2.8.1` 和独立 `.runtime/ts-oracle`、`.runtime/rust` 数据根。输入数据相同而可写目录分开；共享卷争用测试才明确使用第三个临时公共根。进程环境采用必要变量白名单，避免继承真实GITHUB_TOKEN、PRTS_MCP_ROOT、GAMEDATA_PATH和用户数据根；需认证的live步骤单独传入且不记录。

普通差分关闭auto-sync副作用：指向非空自定义GameData目录和非空Story ZIP路径、LOCAL_IMAGE=false，图片本地案例另用受控harness；仅设置interval=0仍会执行启动同步，不能当禁网开关。测试harness可在构造边界注入固定网络/时钟，不能要求修改冻结TS业务代码或新增Rust公共测试环境变量。

fixtures来源分为：既有共享JSON预期及其最小输入；TS测试中值得保留的合成数据；固定完整AKDP数据；固定Wiki/图片HTTP响应。保存样本出处与hash。公网只用于明确的live互操作环节，失败不触发更新golden。

oracle是主要行为参照，但不是独立正确性证明。金额/数值插值、敌人覆盖、同代快照、哈希与回滚等关键规则还需要人工可核对的案例或状态不变量。

## 差分案例格式

P0实现一个小型manifest驱动的runner，不建设通用测试平台。JS可用于驱动TS和Rust两个子进程；Rust产品无JS运行时依赖。manifest字段固定如下，附加字段需有实际消费者：

```json
{
  "id": "stage.list.default",
  "contract": "TOOL-list_stages",
  "dataset": "minimal-gamedata-v1",
  "transport": "http",
  "era": "legacy",
  "channel": "both",
  "request": {"method":"tools/call","params":{"name":"list_stages","arguments":{}}},
  "compare": "exact-tool-result",
  "normalizations": []
}
```

runner负责握手、请求id、端口、超时、捕获stdout/stderr和清理本方子进程。结果保存TS原始响应、Rust原始响应、归一化后diff、基线/数据版本。归一化规则按case显式allow-list，不能全局删除所有包含error/time/path的字段。

golden第一次来自冻结TS，人工核对关键字段后入Git。Rust结果不能自动覆盖golden；更新golden必须解释是基线修订、原录制错误还是已批准差异，并保留旧证据。成功只表示比较通过，不等于所有范围均已完成。

## 比较规则

| 对象 | 比较方式 |
|---|---|
| tools/list | 按工具name对齐集合；中文描述精确；schema解析后比较输入语义和公开字段。只有无语义的对象键序可忽略；不能删除required/default/additionalProperties差异 |
| tool result | content块顺序/类型、文本逐字符、structuredContent类型/字段/null/缺失、数组顺序、isError存在性均比较 |
| 图片 | 同一fixture比较MIME和解码后字节SHA；不比较base64换行样式以外的替代内容，不重编码图像 |
| JSON数值 | 解析后数值等价，文本中的1/1.0区别仍精确。安全整数与大数案例不能靠浮点容差掩盖 |
| runtime生成字段 | 会话ID/UUID按同一次流程中的一致引用绑定；时间按合理范围/先后关系；版本按D-001；随机端口映射到实例标识 |
| 路径 | 只替换已知TS/Rust沙箱根，保留其后路径、文件名、分隔符语义与文案 |
| 错误 | 项目文案/码/错误层级精确；依赖详情仅在标注D-003案例归一化为已验证类别和字段位置。不能把所有失败比较成同一个字符串 |
| 同步 | active generation、文件hash、metadata不变性、失败不覆盖、旧reader回读；忽略随机目录名但保留指针绑定 |
| debug | 按D-002映射校验真实类型、计数趋势和授权；不比JS内存数值 |

schema结构变化如 `$defs` 与inline等价不能直接当成通过。优先发布TS形状的schema；确需等价表示时提供接受/拒绝案例及无消费者影响说明，并登记到阶段报告。默认描述/字段仍保持。

opaque artwork_id不能作为随机session ID归一化：固定后端和数据时保留TS格式，并验证list→get及错属拒绝。

## 覆盖矩阵而非无意义笛卡尔积

每工具/每action/scope在主HTTP legacy入口至少有固定成功结果、空/未找到结果、缺数据或网络失败（适用者）、关键参数分支。全部S工具成功场景覆盖content/structured/both；全部T工具验证structured仍纯文字；图片各通道保留image。

24工具默认代表调用在四格transport/era矩阵都运行一次（Wiki用回放响应，图片用小fixture）。参数边界和复杂数据组合在共享业务层/主入口验证一次；不在每个transport重复全部上游畸形字段组合。另有专门协议负向测试覆盖每个transport，而不是依赖业务案例顺便碰到协议问题。

`IMAGES_ENABLED=false`只需核对23工具集合及无本地图同步，没必要把所有业务案例再跑一遍。配置解析用表驱动的代表边界，不枚举所有环境变量的全组合。

## 现有测试如何取舍

| 现有类型/例子 | 处置 |
|---|---|
| 共享结果fixtures、skills/stats计算、story补充目录、数值/排序回归 | 保留行为意图；精简输入并在Rust验证真实业务 |
| toolSurface通过正则扫描registerTool字面量、检查7处RegExp源码 | 不移植；用实际tools/list和搜索语料代替 |
| Zod safeParse存在性、TS手工强转非法onError | 不移植语言/框架内部断言；保留用户输入实际接受/拒绝行为 |
| registry重复注册顺序、cacheBust模块隔离、reset测试专用API | 不移植；独立实例、代际变化、内存释放验证替代 |
| ZipStore close清某私有成员 | 只保留真实资源释放/换包后读取行为，不要求Rust也有同名字段 |
| sync故障、manifest、锁续租、pair幂等、防降级、images完整delta | 保留；这些对应实际历史故障，不是可随意删除的防御测试 |
| mock fetch后返回同一个预设字符串的无逻辑包装 | 仅在需要验证参数映射/错误包装时保留，避免重复测试mock本身 |
| live E2E默认skip | 不计为通过；记录live未跑，保留离线可重复对应案例 |

P0/P各阶段的测试取舍记录以“旧案例→保护的契约→保留/合并/替代/删除理由”四列填写。无需逐个照搬旧测试；删除一个旧测试并不自动授权删除它保护的行为。

## 故障验证最小集合

真实临时文件系统：下载中断、hash错、ZIP坏/缺必要文件、解压中断、pair只更新一半、重启恢复、同版本不变、远端较旧、两个进程锁争用及租约接班、指针或图片路径越界。

本地HTTP：直连404与镜像404区别、5xx级联、超时/取消、manifest缺失允许分支、Wiki异常形状、模板渲染失败、图片错误host/MIME/magic/超限。只针对真实入口建立边界，不生成海量无意义JSON排列。

真实进程：stdio EOF及信号、HTTP重连/idle淘汰、无stdout污染、后台sync退出、不在import时监听、native无Node/Python也能工作。时钟注入只控制时间进度，状态转换仍由实际代码完成。

## 性能与本地实机

P1记录空载/普通查询；P2记录同步峰值；P4记录完整剧情索引；P6记录图片同步；P8重复同一负载综合对比。只使用release编译Rust，固定机器/CPU、runtime、数据hash、并发度和冷/热状态。

至少记录：冷启动到可服务；首个普通查询；首次全剧情索引；热查询；6个legacy会话与同等modern请求；冷同步与无变化同步；数据切代后的旧索引释放；native包/容器大小与构建时间。冷进程不等于冷OS页缓存，分开标注；不要为了清页缓存修改宿主全局状态。

冷启动/索引至少5个独立进程样本；热查询先预热再至少100次，报告样本数及p50/p95；p99只在至少1000次可重复样本时报告，并说明低样本尾部不稳定。重型同步至少3轮或明确标为单次观察。记录RSS/峰值、cgroup anon/file/swap（可用时），不要把文件缓存与进程堆合并归因。

性能没有预设“Rust必须快几倍”承诺。功能验收不因某项性能未提升自动失败，但出现持续无界增长、死锁、资源不释放或代表负载无法完成，属于正确性/生命周期缺陷。明显延迟或内存回退必须解释，不能隐瞒后宣布具备生产替换条件。

P8本地实机必须覆盖：两个Rust入口profile、全工具组、真实规模数据、一次公开Wiki和两图片后端真实读取、受控同步与恢复、TS副本/旧GHCR卷回读。外部网络不可用时保留blocked行，不能把离线fixture冒称live通过。此处是本地复刻验收，不强制运行外层“Python+TS全量生产式E2E”流程；未来转正PR的重量级E2E裁量仍由外层WORKFLOW拥有。

## 命令与证据

从P0建好Cargo工程后，每个阶段末执行：

```bash
cargo fmt --all -- --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo build --locked --release
```

仅检查实际启用的生产features；不盲目 `--all-features` 打开互斥或实验功能。针对修改先跑相关案例，阶段末跑当前全量Rust测试与受影响MCP差分；不每改一行就重复全量下载。

P0创建 `tools/verify.mjs`，命令固定为 `node tools/verify.mjs --phase Pn`、`--all`、`--live`、`--bench`。当前文件尚未实现，不能把这些命令写为已通过。runner失败退出非零，报告pass/fail/blocked/not-run计数、case ID、数据/TS/Rust版本、命令、耗时、diff路径。`--all`只跑离线确定性合集；live/bench明确单独启动。
