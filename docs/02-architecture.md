# Rust 架构与依赖决策

## 工程形状

先采用一个 Cargo package、一份业务 library、少量薄 binary。包名 `prts-mcp-rust`，`publish = false`，版本 `0.1.0+ts2.8.1.local`。不因有多个模块就创建十几个 crate；出现真实独立复用需求时再拆。`Cargo.lock` 和精确 `rust-toolchain.toml` 必须入本地 Git。

建议目录职责如下；文件可以随实现拆细，但依赖方向与契约拥有者不能改变。

```text
src/
  lib.rs
  bin/prts-mcp-rust.rs          # 本地开发入口，默认 HTTP，支持 --transport
  bin/prts-mcp-ts.rs            # HTTP 兼容入口
  bin/prts-mcp-ts-bun.rs        # HTTP 兼容入口，无 Bun 业务依赖
  bin/prts-mcp-ts-stdio.rs      # stdio 兼容入口
  bin/prts-mcp.rs               # GHCR profile：env 选择，默认 stdio
  config.rs                    # 启动选项解析，无运行时全局单例
  app.rs                       # 组装 AppState、后台任务、停机
  protocol/                    # rmcp 接线、HTTP/session、stdio
  tools/                       # 参数边界、薄分派、统一结果包装
  domain/                      # operator/enemy/stage/item/story/artwork
  storage/                     # Directory/ZIP/fallback、代际指针、快照
  sync/                        # discovery/transfer/validation/activation/images
  wiki/                        # MediaWiki HTTP、模板与正文转换
  contracts/                   # 共享 AKDP/图片元数据类型，无业务依赖
  text/                        # JS 正则适配、排序、数值/文本纯函数
  diagnostics/                 # 聚合统计，不保存请求或结果
tests/                         # Rust 行为和状态测试
tools/                         # oracle、差分与报告，不参与产品运行
packaging/                     # Docker、私有 npm launcher
```

三个 TS 名称的 binary 可以共享 `run_http`/`run_stdio`，不复制业务。`prts-mcp` 只代表 GHCR 兼容 profile；未来正式产品主命令仍另行决定。不得让 `PRTS_TRANSPORT` 改变 TS 兼容入口的 transport。

## 依赖方向与技术债修复

`app → protocol/tools/domain/wiki/sync/storage/config`；`tools → domain/wiki/结果包装`；`domain → storage/contracts/text`；`sync → storage/contracts/HTTP client`；`storage → contracts/基础文件系统`。`config` 只解析输入并形成配置，不 import app、domain、sync 或 storage 状态。诊断由 app 汇总各组件显式提供的数据，不靠 import 副作用注册。

| TS 现状及证据 | Rust 决策 | 必须保留的行为 |
|---|---|---|
| `config.ts ↔ activation.ts` 循环、模块级快照 | 启动配置与动态 DataView 分离；app 显式传递快照 | 更新可见、单次查询使用同代 excel/levels |
| `building.ts ↔ operator.ts` 受控回边 | 独立 OperatorCatalog/身份索引供两者消费 | 同名干员优先级、building_skills 关联 |
| `data/datasets.ts → data/sync.ts` 反向类型依赖 | dataset、manifest、image index 归无副作用 contracts | 文件路径、required files、容错与版本语义 |
| `datasetAccess.ts` 字符串 registry 和任意 onError 模式 | 具名缓存字段、Rust enum/Result；只实现真实调用方需要的策略 | 缺数据后重试、失效、诊断可解释 |
| `__reset*ForTesting`、cacheBust、模块加载注册 | 每个测试独立 AppState/数据根，构造器注入 | 多实例隔离，不增加生产 reset API |
| 同步下载整包 `arrayBuffer` 后再整包 hash | 流式写临时文件并增量 hash，ZIP 按条读取 | 完整校验后才发布，失败保留旧文件 |
| `CacheStat` 投影绑定内部 loader | 固定逻辑域的诊断投影，见 04 | 不暴露实现对象；缓存优化不会被旧访问次数绑死 |

这几项是基于源码的结构调整，不要求在外层 TS 先修。函数约 50 行、嵌套超过 3 层、重复公式等按 STYLE 的提取原则处理；不要为满足行数指标制造无意义的一行转发函数。单文件不超过约千行作为评审信号，而非靠自动扫描替代设计判断。

## 状态和并发

`RuntimeConfig` 保存启动配置；`DataState` 持有当前激活的可共享 `Arc<DataView>`。GameData 相关工具开始时取得一次快照，整次查询只用该快照。同步准备新树后发布指针，后续查询取新快照，在途查询继续完成。Story ZIP 和 images 有各自身份/代际，不能以 excel 更新代替它们的失效。

避免进程级“当前请求快照”变量；TS 同步函数能依赖事件循环的假设不适用于 Rust 并发。缓存要按数据身份关联，既不能让一次 HTTP 会话独占全部大索引，也不能让新旧代复用同一个无身份缓存。首次加载可用简单互斥或 once-cell 类结构保证同代只构建一次，失败不得永久毒化本应重试的条目。

CPU 密集剧情搜索、ZIP 解压和大量 JSON 读取不能阻塞 async reactor。优先使用有界 blocking 工作；不先建设通用任务调度平台。锁只保护必要状态，不持全局 AppState 锁跨网络 await。不为提升并发率改变排序或提前截断结果。

磁盘代际保留沿用 05；进程内 Arc 不是跨进程文件锁的替代。Rust 与 TS 同时使用测试共享卷时遵守相同锁目录协议。旧代缓存最后使用者释放后可回收；长时间保留旧数据需要在报告中说明原因。

## 依赖方案和验证责任

以下是执行默认方案，不是已经编译或兼容验收通过的结果。P0 固定精确版本和 license 清单，P1 完成高风险探针；依赖不能直接用浮动 git main。

| 领域 | 默认方案 | 需要验证的点 |
|---|---|---|
| MCP | `rmcp = 3.5.1` | 四格协议矩阵、实际 schema、结果字段、现代路由与 session 行为 |
| async/HTTP server | Tokio；沿 rmcp 示例选择同一兼容 Axum 版本 | 关闭任务、流式响应、session idle、健康与诊断路由 |
| JSON | serde / serde_json，必要时 preserve_order | null/缺失、整数与浮点、JSON 对象枚举影响、UTF-16 边界 |
| HTTP client | reqwest + rustls，共享 client | 显式超时、代理与 NO_PROXY、重定向、镜像级联、取消 |
| ZIP/hash | zip + sha2，文件流处理 | CRC/损坏、required entries、路径语义、流式校验与重命名 |
| XML | quick-xml 等成熟 parser | 仅替换解析机制，保留 TS 模板安全渲染规则，不换成通用全文 HTML 转 Markdown |
| 日志/错误 | tracing + stderr；具名错误 enum，必要时 thiserror | 不把所有失败变为泛化 anyhow 文案；项目文案仍归工具边界 |
| 正则 | 下节的嵌入 QuickJS 兼容方案 | `iu` 行为差分、生命周期、性能、Unicode |

除了 rmcp 和正则候选，本计划不虚构尚未实际 resolve 的依赖版本。P0 选取能在 Rust 1.96.1 上编译的稳定版本并写锁文件；无法满足 MSRV 时记录具体冲突，允许在本地固定更新 toolchain，但不得偷偷更改全局默认 toolchain。

## 正则与 JS 文本语义

用户 pattern 的契约是 `new RegExp(pattern, "iu")`。Rust `regex` 缺少 look-around/反向引用；`regress 0.12.0` 文档明确存在 Unicode property escapes 缺口，因此二者都不能未经验证作为唯一替代。[regex 文档](https://docs.rs/regex/latest/regex/)、[regress 文档](https://docs.rs/regress/0.12.0/regress/)。

执行默认：P1 以 `rquickjs 0.14.0` 嵌入的 QuickJS 作为正则兼容候选，提供仅 `compile(pattern)` 和 `is_match(text)` 的窄适配层。模式通过 API 参数传入，不拼接为可执行 JS；不开放文件、网络、模块加载，也不运行 TS 业务。每次查询编译一次、匹配多行，不按每行初始化 VM。QuickJS 是库内嵌组件，不要求用户安装 JS 运行时。[rquickjs 文档](https://docs.rs/rquickjs/0.14.0/rquickjs/)。

P1 必须覆盖：字面量/空模式、大小写、中文 `\w`、`\d`、`\s`、`\b`、astral `^.$`、`\p{Script=Han}`、lookahead/lookbehind、命名与数字反向引用、未参与匹配的捕获组、锚点和换行、非法模式、Unicode case folding、组合字符。以 Bun 为主 oracle，Node 差异单列，不跟随 Python。引擎编译错误详情属于 D-003，接受/拒绝和匹配集合不属于豁免。

QuickJS 支持 ECMAScript 不构成与 Bun 全等证明。若以上任一能力出现无法解决的匹配差异，P1 正则行阻塞：提供最小案例、替代引擎/版本成本，再由维护者决定；禁止降级到字面量搜索或静默移除语法。生产引擎选定后去掉并行候选与双引擎路由，不堆叠 fallback 猜测语义。

JS 特有行为只在实际业务需要处实现：UTF-16 比较/切片，Object.entries 的整数键顺序，稳定排序，浮点舍入和文本格式。`compareIds` 实際是 JS `<` 比较，不能因为注释写“codepoint”就统一换 Rust `str::cmp`；`stageEnemy` 尚有 `localeCompare`，要抓排序碰撞案例分别验证。读取文本不能统一做 Unicode normalize。不要实现一个完整 JS 兼容标准库。

Rust String/serde 与孤立 UTF-16 surrogate 的差异在 P1 的输入边界探针中报告；只要基线能接受并产生可观察结果，就不能无记录丢弃。若需要改变支持输入集，走契约差异决策。

## 防御边界

外部 JSON、ZIP、网络、路径和 MCP 参数各在所属入口校验一次；内部成功解析后依赖类型不变量。开放数据表只建模实际读取的字段，保留 TS 已有 optional/unknown-field 容错。不能把整个上游数据表反序列化成全字段必填结构，导致新增无关字段或可选字段缺失使整包拒绝。

保留真实威胁/故障边界：ZIP 路径逃逸、图片 token 归属、哈希、原子发布、锁所有权、未授权 debug。不要为了臆测输入创建层层 fallback、通用 retry、熔断器、插件框架或每字段重复校验。测试无法指出保护的真实契约时，先质疑设计。
