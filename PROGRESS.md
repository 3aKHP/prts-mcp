# 执行进度

最后更新：2026-10-12（P4 完成）。

| 阶段 | 状态 | 报告 | 下一步 |
|---|---|---|---|
| P0 | complete (tag local/p0-complete) | [reports/P0.md](reports/P0.md)、[reports/P0-audit.md](reports/P0-audit.md) | — |
| P1 | complete (tag local/p1-complete) | [reports/P1.md](reports/P1.md) | — |
| P2 | complete (tag local/p2-complete) | [reports/P2.md](reports/P2.md) | — |
| P3 | complete (tag local/p3-complete) | [reports/P3.md](reports/P3.md) | — |
| P4 | complete (tag local/p4-complete) | [reports/P4.md](reports/P4.md) | — |
| P5 | not-started | — | 完整2个Wiki工具 |
| P6 | not-started | — | 图片工具与完整图片同步 |
| P7 | not-started | — | 配置、诊断、部署和本地分发 |
| P8 | not-started | — | 最终全范围验收与转正评估 |

## P1 交付摘要（2026-10-11）

- **选型落定**：rmcp 3.5.1 经 `examples/rmcp_probe.rs` 实证无法复现 oracle wire 指纹（SSE priming/帧、未知会话体、discover 版本集、modern JSON 格式）→ 薄 JSON-RPC 适配（`src/protocol`），rmcp 留 dev-deps 保证据可复现。
- **协议层**：HTTP（SSE 帧、202/404/405/406/415、会话 idle 剩余预算重排、失效 initialize 恢复、legacy 通道会话固定 vs modern 逐请求）+ stdio（时代规则、stdout 纯净、EOF 退 0）。
- **第一条完整链**：真实 `list_stages`（DirectoryStore 读取、UTF-16 排序、Zod 等价校验含 JS 数字语义与多字段错误、oracle 逐字 schema、三通道包装）。
- **语言探针**：QuickJS 正则适配器 49 例语料与 Bun 零差异；UTF-16 排序/切片、浮点整数语义差分；J1 孤立代理对边界实证并登记维护者决策项。
- **验证**：差分 31/31（四格×三通道+会话生命周期+空数据启动）；进程测试（无监听、双会话通道隔离）；fmt/clippy(-D)/test(28)/release 全过；Node 辅助对照 2 案例；性能基线入 `artifacts/p1-bench.json`。
- 工具数 1（阶段契约）；24 工具面 tools/list 差分以 `diff_phase=P8` 推迟（07 明示允许）。
- **维护者 2026-10-11 批准差异**：D-005-input-surrogate-rejection（拒孤立代理码元+明确解析错误）、D-006-unparseable-body-json-error（400+JSON-RPC 解析错误替代 HTML 页）——已登记 baseline.json 并配回归测试；有效代理对/正常 Unicode 由 `stage.list.chapter-astral-pair` 差分与截断单测守护。

## P2 交付摘要（2026-10-11）

- **存储**：Directory/Zip/Fallback 三存储完整读路径（primary 坏 JSON 不静默回退、不安全路径报错传播）+ 代际指针读取器（activatedRoot/activatedPair，realpath 逃逸拒绝）。
- **Release 状态机**：fresh 跳过、离线/no_data 分支、盲下载（仅镜像+无记录版本）、防降级（tuple 比较、记录版本阻止替换、重复身份 fail-closed）、manifest 全错误族校验；`data-release-selection` 9 例共享发布语料通过。
- **锁**：目录 owner 租约协议（心跳 utimes、陈旧隔离、释放前 owner 校验）与 `.gamedata-pair → activation → release` 层级；跨进程（Rust↔真实 TS dist）双向争用验证。
- **成对代际**：双幂等守卫（#152 activationSha 短路、#155 pair 无变化不重写——inode/mtime 级断言）；混合代不发布；Story 原子换包。
- **架构**：TS `config↔activation` 循环按计划消解——RuntimeConfig 静态 + DataState 签名缓存快照，单次工具调用单代一致，缺数据→后台激活→不重启可读（输出与 TS golden 逐字节一致）。
- **调度**：single-flight、30/120/600s 密集重试（仅启动轮）、周期不重叠、interval=0 仅启动；stdio EOF 在重试已武装时 <10s 退 0。
- **互操作**：TS 写↔Rust 读 / Rust 写↔TS 读 / 元数据字节一致 / 锁争用 5 案例全过；差分案例 `stage.list.pair-activated`（TS 同步代码写入的 fixture 卷）33/33。
- **峰值**：3 轮实测（artifacts/p2-bench.json）：Rust 冷同步峰值 RSS ~23MB（流式，不随 60.6MB 包体增长）vs TS ~321MB（整包缓冲）；无变化周期 454ms。
- **门禁**：fmt/clippy(-D)/112 测试/release 全过；P0 自检 29/29、P1 32/32、P2 33/33 差分。
- 工具数 1（阶段契约）。图片完整链（baseline/delta/.images.lock）按计划留 P6；bundle 回退与入口 profiles 留 P7。

## P3 交付摘要（2026-10-11）

- **12 个 GameData 工具全部实现**：operator 档案/语音/basic（basic/skills/stats 三 action）、list/get enemy、stage-enemies、appearances、get_stage_info、list/get item、六 scope 统一 search；list_stages 分支补齐。声明字节取自 oracle tools/list 捕获；注册顺序=oracle 顺序。
- **数值/文本保真内核**：roundHalfAway、JS Number→string（最短往返+指数阈值）、V8 实测 toFixed（精确二进制值半离零、-0）、pythonFloatString/千分位、stripWikitext 六遍（含 oracle 实证的 category 死代码遍）、QuickJS `iu` 正则复用。
- **ICU localeCompare**：stageEnemy 计数并列 tie-break —— 从 oracle 逐对探测导出 95 字符 ASCII 权重表（零传递矛盾），15 探针单测钉死；与 compareIds（UTF-16）按 docs/02 分离实现。
- **Zod 4.3.6 等价校验**：11 条探针文案（enum/boolean/nullish/int/bounds/多字段顺序）单测钉死；协议层 -32602 record 校验复用 P1。
- **每代数据集缓存**：datasetAccess 对应物挂 DataView（成功缓存/失败重试/换代释放）；levelsStore `zh_CN/gamedata/levels` 根与 excelStore null 文案差分钉死。
- **差分 157/157**（P3 124 新例）：四格矩阵 44、S 工具三通道全覆盖、成功/空/缺数据/参数分支齐备；`minimal-gamedata-v2` fixture（13 文件）登记 data-manifest；`map-regex-error-detail` 归一化（引擎详情差异，docs/06 依赖详情规则）。
- **语料单测**：operator-query-cases 16 例、operator-talent-cases 3 例、tool-bounds、trap 同名优先级、同代缓存——语料入库 contracts/cases/。
- **门禁**：fmt/clippy(-D)/136 测试/release；P0 自检 29/29+变异、P1 32/32、P2 33/33 全保持。
- 全规模 GameData 差分与冷/热测量按计划归 P4；`/debug/cache` 映射留 P7。

## P4 交付摘要（2026-10-12）

- **9 个 Story 工具全部实现**（累计 21，`registry_has_21_tools_at_p4` 钉死）：events/list/summary/read/activity/search/memoir/appearances/speakers；T/S 通道与 oracle 摘要覆盖（memoir 自定义 summary）一致。
- **保真内核**：cleanText（`{@nickname}`→博士+去标签）、Decision 标量/数组/对象、sticker content/text、pyRepr、摘要三级回退（summaries 覆盖 storyinfo→storyInfo）、read_activity 分页与坏章跳过、错误分层（未找到裸返回 vs `读取…失败：` 前缀）、发言计数降序+码点并列。
- **supplement 整链**：发现→列表→读取→搜索→角色追踪（roguelike 案例集）；review 碰撞不覆盖、坏 supplement 降级、NONE 非密录不入索引。
- **共享单份索引**：进程级单例按 zip stat descriptor 身份缓存；换包重建恰一次（计数断言）+ 旧索引随末位读者释放（RSS 110.7→104.3MB 证据）+ 4 线程单飞（构建恰一次）；多会话共享（bench wall=1.13× 单建）。
- **差分 275/275**（P4 +118：story 98 + 全规模 20）：四格 36 cell、S 工具三通道、全分支；`full-story-r2`（真实 datarev excel+story zip，hash 入 manifest）全规模搜索顺序与 golden 逐字节一致；P3 遗留的 GameData 全规模代表 8 例一并通过。
- **性能**（artifacts/p4-bench.json）：冷建索引 Rust p50 1828ms/峰值 108MB vs TS(bun) 1216ms/427MB（冷慢 0.6s 如实记录，热查 2.7ms vs 4.0ms 占优）；换包 28ms/1929ms 恰一次。
- **门禁**：fmt/clippy(-D)/140 测试/release；P0 自检 29/29+变异、P1 32/32、P2 33/33、P3 157/157 全保持；`--all` 275/280（5 个 P8 全工具面案例按计划）。

## 交接入口

- 分支 `rust-local`；HEAD 见 `git log -1`（tag local/p4-complete）；工作树干净。
- 阶段 bundle：`artifacts/p0.bundle` … `artifacts/p4.bundle`（hash 以最终文件为准；请维护者另存备份并自行记录）。
- 差分重跑：`node tools/verify.mjs --phase P4`（Rust 需 `cargo build --locked --release`；全规模数据集 `node tools/make-fullscale.mjs`）；性能 `node tools/bench-p4.mjs`。
- P5 首个任务：`search_prts` 全部搜索模式与 `prts_page` 5 action——固定 Wiki 响应回放差分优先，节流/代理与模板提取随后（docs/07 P5）。
