# 运行时 配置 协议与诊断

## 入口 profiles

| 入口 | 默认 transport | 配置语义 |
|---|---|---|
| `prts-mcp-rust` | HTTP | 本地开发入口，`--transport http|stdio`；不扩展管理 CLI |
| `prts-mcp-ts`、`prts-mcp-ts-bun` | HTTP | 保留旧 TS bin 行为；不依赖 Node/Bun 执行业务；不读取 PRTS_TRANSPORT 选择 transport |
| `prts-mcp-ts-stdio` | stdio | 无 HTTP listener；输出通道只读环境 |
| `prts-mcp`，GHCR 兼容镜像 ENTRYPOINT | stdio | PRTS_TRANSPORT先trim/lowercase，仅http选择HTTP，其余回stdio；P0固定入口案例 |

HTTP 默认 HOST=`0.0.0.0`、PORT=`3000`，`/mcp`、`/health`。本地验证总是显式 HOST=`127.0.0.1` 和隔离端口；容器内监听遵守 profile。stdio stdout 只能有协议，日志/启动/同步诊断走 stderr。退出、EOF、SIGTERM/SIGINT、后台任务取消用进程测试验证，不把下载完成作为关闭进程的前置条件。

GHCR专属覆盖只包括启动profile与镜像部署连续性：transport选择、既有PORT解析/失败退出、卷及bundle布局、权限和进程启动方式。固定Python入口用 `int(PORT)`，TS用 `Number(PORT)`，P0采集两者的合法/非法输入分别应用于对应profile。GHCR的工具、HTTP会话与output channel仍采用TS契约，不继承Python env-only通道限制或业务差异。

生产启动不能依赖外层源码、`.reference`、test fixtures 或用户 cwd。bundle 数据在可重定位 package/image 布局下读取：native 发布目录为 `bin/` 与 `data/` 同级于 package root，npm launcher 显式传递内部 bundle root，Docker 固定 `/app/data/`。这是内部参数，不新增公共环境变量；不得把编译机绝对路径写入二进制。

## 配置清单

以固定 `ts/src/config.ts`、`startupSync.ts`、`server.ts`、`sync/transport.ts` 和环境变量文档联合核对。下面是必须实现的全部运行时变量族；不能只实现 README 快速开始中的几个。

| 变量 | TS 基准 | 必须验证 |
|---|---|---|
| GAMEDATA_PATH | 是否存在决定 custom；custom 关闭 excel/levels 同步 | unset 与空字符串不同；完整目录内 levels 优先，否则 sibling |
| STORYJSON_PATH | 路径用 nullish fallback；同步以非空真值决定禁用 | 空字符串可能仍启动 sync，不得照搬“存在即禁用” |
| XDG_DATA_HOME | 未设置用 `~/.local/share`，再接 prts-mcp | 空值、相对路径、路径含空格 |
| LOCALAPPDATA | Windows 默认 `~/AppData/Local` | 纯解析 fixture；Linux 不冒称 Windows 实机通过 |
| PRTS_MCP_ROOT | 仅严格等于 `/app` 才选择 Docker 卷路径 | 其他值不能被当作新的任意根目录 |
| PRTS_IMAGE_DIR | 覆盖 images 路径 | 空值、相对值按源码语义，不加新自动目录迁移 |
| GITHUB_TOKEN | GitHub 请求认证 | 不记录 token；不把认证传播到不应携带的目标 |
| GITHUB_MIRRORS | split逗号、trim、去全部尾斜杠、去空项 | 直连→镜像顺序、直连4xx、各次超时 |
| PRTS_AUTO_SYNC_INTERVAL_SECONDS | 默认3600；整数60..604800；0只启动同步 | 空值、符号、小数、指数、负数、越界回退；以解析函数为准 |
| HTTP_PROXY/HTTPS_PROXY 与小写、NO_PROXY/no_proxy | 保留 Bun 主基准的代理行为 | 冲突优先级、排除项和 Wiki/sync 两条路径各验证 |
| IMAGES_ENABLED | 默认true | false移除工具；其余布尔值见下 |
| LOCAL_IMAGE | 默认false | false只走 Wiki；true才走本地同步 |
| ORIGINAL_IMAGE | 默认false | 只改变本地同步所需 shards；不改变 Wiki 的 original 获取语义 |
| PRTS_IMAGE_CACHE | 默认true | 仅 Wiki 图片 LRU；关闭后不保留缓存 |
| PRTS_OUTPUT_CHANNEL | content | trim/lowercase；非法和空值回 content |
| HOST/PORT | 0.0.0.0/3000 | 基准 PORT 使用 Number 转换；有效边界/错误/0端口由进程探针固定，不擅改成严格十进制 |
| PRTS_DEBUG_TOKEN | 未设置关闭 debug | 缺失/空/错误/正确 Bearer；错误返回404 |
| PRTS_METRICS_ENABLED | 仅原样字符串 `true` | TRUE/1/空不是 true，不能复用普通 envBool |
| SESSION_IDLE_TIMEOUT_MS | unset=86400000；正有限严格十进制；非法/≤0关闭 | 小数/指数、空值、0x10、1_000、全角数字、超大值及实际计时行为 |
| PRTS_TRANSPORT | TS不采用；GHCR profile采用 | 仅部署例外，不扩散到其他入口 |

普通布尔值是 trim+lowercase 后属于 `1/true/yes/on`；未设置用默认，其余是假。不要用“非法值启动失败”统一处理已经有宽容回退的旧变量。

有效数据路径有动态激活与 bundle fallback；缺数据的服务照常启动，工具返回已有提示，后台同步完成后无需重启即可工作。启动选项一次解析，运行态数据视图动态更新。单元测试直接构造配置；不要求生产程序响应测试进程内随意修改环境变量的行为。

## MCP 验收矩阵

| transport / era | 入口行为 | 必须覆盖 |
|---|---|---|
| HTTP legacy | initialize/session | 初始化、notifications/initialized、list/call、GET/POST/DELETE相关行为、空闲淘汰、失效恢复 |
| HTTP modern | 2026-07-28 stateless | server/discover、每请求_meta、list/call、无session；声明modern但缺信封不能降级legacy |
| stdio legacy | 首请求确定时代 | initialize→list/call、EOF、独立进程、stdout纯协议 |
| stdio modern | 首请求确定时代 | discover→list/call、每请求元数据、不能同连接切换时代 |

Legacy 在 P0 至少记录旧测试使用的 `2024-11-05`、smoke 使用的 `2025-03-26`，并探测 `2025-06-18`、`2025-11-25` 的协商行为；支持集合和返回版本以固定 TS SDK 实测为准，探测请求不代表已确认支持。不能只测现代协议就宣称双时代通过。

固定 modern 信封示例来自 `e2eStdio.test.ts`、`e2e.test.ts`：`params._meta` 中包含 `io.modelcontextprotocol/protocolVersion`、`io.modelcontextprotocol/clientInfo` 与 `io.modelcontextprotocol/clientCapabilities`。执行者复制完整 oracle 请求，不凭 README 拼字段；P0 保存最小原始请求/响应。rmcp 如默认增添能力或输出 schema，必须抑制或调整为 TS 实际暴露集合。

额外覆盖：未知方法/工具、参数不匹配、请求 id 保留、notification无普通reply、错误层级与 code、JSON/SSE 解析、损坏 modern 请求、不支持的协议版本、session id 位置和重复请求。不重写整个 JSON-RPC/MCP SDK，仅对已发现的项目兼容点加薄适配。

## HTTP 会话与 output channel

HTTP query `output_channel` > header `x-prts-output-channel` > env。高优先级值存在但为空或非法时，结果回 content，而不是继续找较低优先级。重复 query/header 选择规则分别按 legacy Express 和 modern URL/Headers oracle 固定。

**Legacy channel 在创建会话时解析并固定；modern 每次请求解析；stdio 每进程解析。** 不把旧说明中的泛称“HTTP每请求覆盖”应用到 legacy 已存在会话。两个 legacy 会话可用不同通道，不得串线。

失效/未知 session：非 initialize 返回404和固定 JSON-RPC错误 `-32002`；initialize允许丢弃旧ID重新建会话。空闲计时每请求更新 last activity，定时器按剩余预算重排，不等第二个完整周期。关停/淘汰计数与清理只发生一次；暂未清理的会话不能重复计数。现代请求不制造 legacy sessions。

计时测试允许调度容差，不能把“精确同一毫秒触发”写成契约；也不能只 mock 一个 timer 回调而没验证客户端会话行为。

## 诊断适配 D-002

`/health` 返回 `{"status":"ok"}`，不要求同步完成。debug无/错认证均404，成功返回聚合统计；metrics额外要求严格true开关。所有 schema 变更集中登记，不能每个模块自由改字段。

`/debug/metrics` 新 schema_version 固定 `prts-mcp.rust.metrics/v1`。保留 `server.version/uptime_ms`、requests、tool_calls、sessions、cache 的逻辑组织；process 保留真实 `rss_bytes` 和 `rss_high_water_bytes`（Linux /proc 或等价测量），新增 `runtime: "rust"`。删除 `heap_total_bytes`、`heap_used_bytes`、`external_bytes`、`array_buffers_bytes`，不填0、不拿分配器指标冒充。需要分配器诊断时以后加清楚命名的可选字段，不作为一期要求。

`/debug/cache` 保留逻辑域 `operator/enemy/stage/stage_enemy/item/search/building/skill/story_search/images/artwork_mediawiki`，对应真实缓存的 loaded/count/hits/misses/clears/可选bytes。不承诺 Rust 与 TS 因内部加载路径不同而计数逐次相等；不允许删掉统计、伪造缓存状态或依靠跨实例共享全局数字。P7 输出每个旧子键到新子键的映射，子键若因真实缓存合并而变化必须有解释；端点仍是上述域对象，避免额外混入统计域。

requests duration 可能包含长连接时间，tool_calls 当前按 HTTP tools/call 请求生命周期聚合。保留这一计数口径，不能把它当算法纯耗时；benchmark 在客户端另行计时。指标标签只允许注册工具名，未知用户输入不能变成无限增长 label。

不得记录参数、结果、session ID、认证、图片 base64 或正文。诊断模型设计是对已批准运行时差异的适配，不是新增监控平台。
