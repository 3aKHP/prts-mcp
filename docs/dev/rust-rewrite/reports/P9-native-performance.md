# P9：原生性能专项与发行包验证

日期：2026-10-13。起点：`rust-local` / `1f88174061cf8e7e801a6a2ab3c68cf026adcd45`。
业务 oracle 仍为固定 TS/v2.8.1（`e0ba36096cdd46640166b0a5db02902fa9a6a24c`），Bun 1.3.14。

## 目标与结果

维护者授权在“不回退 JS/TS”的前提下优化原有慢项，允许原生 C，但发行包不能要求用户另行配置 C 库。本轮具体验收是：冷剧情索引与六项代表热查询在同机同输入下优于 TS；原有工具契约和完整索引保持；删除产品中的 JS VM；Linux 分发三链实际运行。

**当前多核验证环境下达成上述目标。** 四个 CPU 的相同亲和性下，首个剧情搜索和六项热查询的 p50/p95 全部低于 TS。没有为基准缓存某次搜索的结果、减少扫描语料、预构建索引、改变限额/排序/参数，或删去高级正则语法。

这不是“任意正则、任意机器上 Rust 必然更快”的声明。单 CPU 补测的热查询全部占优，冷查询约持平（当前约 7% 差距，前一轮仅约 2%；不认领低资源机器上的稳定全面领先）。没有新增 macOS/Windows/musl/其他架构的已验证支持。

## 实现

- **冷读取**：借用属性和已有字符串，避免深复制和 Decision 列表克隆；无标签文本直接清理；HTML 标签扫描不再先分配 `Vec<char>`。
- **冷索引**：最多四个线程读取独立章节。ZIP 访问仍串行并保留原有路径/CRC/解析边界，JSON 解析移到 ZIP mutex 之外；按原始 ordinal 恢复稳定顺序及错误优先级。同代首次构建持有索引锁，避免原先“并发重复构建、只发布一份”的 CPU/内存浪费。
- **正则**：删除 rquickjs 与完整 QuickJS VM；从同一 checksum 固定的源包抽取独立 `libregexp.c`、`libunicode.c`，由 `cc` 编译静态 archive。Rust 直接调用原生匹配，复用 UTF-16 scratch。没有 JavaScript 解释执行、Node/Bun 子进程或 JS/TS 业务 fallback。
- **匹配加速**：只分析固定编译器输出的线性字节码，提取必需字面量前缀；遇到控制流/断言/量词停止。前缀缺失时可安全排除文本；纯字面量可直接确认，带约束的表达式仍交由同一个 native 引擎判断。特殊 Unicode folding 输入保留 native 计算；穷举该引擎 Unicode 表验证快捷路径假设。
- **Wiki**：实体解码、清理和筛选逻辑改为 Rust，固定表达式使用 native C 组件。保留清理顺序、RLQ 的首个右括号行为、JS whitespace、相邻 surrogate 实体合并和普通 JS entity 表继承字段的可观察输出。325 项冻结 TS helper 对照没有差异。
- **分发**：npm/独立目录/两个 Docker profile 都使用已静态包含 C 组件的二进制，增加 MIT + Unicode-3.0 版权声明。源码构建需要 C 编译器；发行包用户不需要。ELF 仍使用目标系统标准 glibc/libm/libgcc，并非承诺整个 ELF 全静态。

PCRE2 探针无法接受 Bun 可用的无限长后顾 `(?<=a+)b`，因此没有作为生产替代。当前方案直接复用原正则内核，减少契约风险。上游对无限长后顾的限制也见 [PCRE2 pattern 文档](https://www.pcre.org/current/doc/html/pcre2pattern.html)。

## 性能证据

完整可提交摘要见 [P9-measurements.json](P9-measurements.json)。原始样本、日志、起点二进制在忽略目录 `artifacts/native-performance/`，需要维护者另存备份。

机器 i7-12700H / WSL2，服务器均 `taskset -c 2-5`，请求并发 1，HTTP legacy/content；数据相同且同步关闭；CPU 亲和性是共同可用资源范围，Rust 内部可使用最多四个解析线程。保留 OS 页缓存，没有清宿主缓存。冷测每实现五个独立进程、按轮旋转顺序；热测每场景十次预热后一百次调用，统计 p50/p95，不报低样本 p99。

数据：`full-story-r2/storyjson/zh_CN.zip`，SHA-256 `f987b360d72e7de270ee00ad4998e6bc3d88a192db52fe35ac98864299070eb5`；共 2,285 章 / 424,281 条搜索记录。

下表时间单位 ms，均为客户端测量的 p50。起点 Rust、最终 Rust、TS 在同一次三方脚本中测量。

| 工作负载 | TS | 起点 Rust | 最终 Rust | 最终相对 TS |
|---|---:|---:|---:|---:|
| 首次阿米娅 30 条（含冷索引） | 1263.98 | 2103.42 | 464.09 | 2.72× |
| 热阿米娅 30 条 | 4.19 | 21.67 | 2.69 | 1.56× |
| 热阿米娅 5 条 | 2.46 | 2.52 | 1.74 | 1.42× |
| 热罗德岛 5 条 | 2.37 | 2.00 | 1.74 | 1.36× |
| 热罗德岛 30 条 | 2.32 | 2.52 | 1.93 | 1.20× |
| 全扫描无命中 | 22.24 | 360.35 | 13.79 | 1.61× |
| 阿米娅后跟句号的 lookahead | 12.37 | 184.85 | 9.22 | 1.34× |

空模式 1 条控制：TS 3.12ms / Rust 1.63ms。各场景 p95 也低于 TS；冷结果 hash、全部热结果逐项比较一致。

热查询 RSS：最终 Rust 约 123MiB，TS 约 288–356MiB。起点 Rust 约 109–110MiB；并行解析/分配器保留导致最终比旧版多约 13–14MiB，需要披露，仍明显低于 TS。主二进制约 8.81MB，起点约 9.92MB（未 strip）。

单 CPU 补测（`taskset -c 2`）冷查询 p50：TS 1474.74ms、Rust 1371.51ms；p95：1719.64ms、1491.35ms。冷建仅小幅改善（本轮约 7%，此前重复约 2%），不认领低资源机器上的稳定全面领先。六项热查询仍全部占优，详见测量 JSON。主要冷建收益来自并行，不把多核墙钟改善误写成单核算法达到同样倍数。

## 兼容性裁决

原有 49 项正则 corpus 保持通过。初始 2,880 项扩展发现六个案例；为约束同一机制，随后补充 ASCII range 变体和 Unicode property 的正向、反向、别名案例。新增 3,276 项中，3,190 项与 Bun 严格一致，86 项属于两个原有差异类别：ASCII range 对 `ſ`/`K` 的 folding，以及 Unicode property（包含正向/反向和别名）的 folding。旧 rquickjs 适配器单独重跑也得到完全相同的 86 项差异；不是本轮引入。

维护者明确按成本/实际体验的权衡保留原有 Rust 语义，不增加 Bun 专用例外，登记 **D-007-native-regex-unicode-folding**。具体最小案例和 Rust/Bun 预期见 `contracts/cases/native-regex-differences.json`，测试逐项验证而非全局忽略布尔差异。已知类别不等于全 ECMAScript 等价证明；其他不相关差异仍需正常处理。

顺手修复 `contracts/baseline.json` 原有多余结尾 `}` 和旧 P0/P1 状态，使批准日志可机器读取；刷新当前依赖许可证闭包与 vendored 组件说明。README / PROGRESS 旧交接信息改为当前状态。P8 历史结果保留，不用 P9 数字覆写旧报告。

## 验证

| 检查 | 结果 |
|---|---|
| fmt / clippy 全 targets (`-D warnings`) / release | pass |
| 当前 Rust 全量行为测试 | 211 pass |
| 原始 Bun 正则 corpus | 49 严格一致 |
| 扩展 Bun 正则 corpus | 3190 严格一致 + 86 已批准 D-007；无其他差异 |
| Rust Wiki helpers 对冻结 TS 源码 | 325/325 一致 |
| C ASan + UBSan + leak detection | 3276 案例通过，无检测错误 |
| Native binary 符号/依赖/原始源码 hash | pass；无 JS VM 符号/依赖；7 文件 hash 相符 |
| 完整索引 digest | 2285 章 / 424281 条元数据、type/role/text 与 record ordinal 全等 |
| 全离线 MCP 差分 | 384/384 pass，0 fail/blocked |
| 公开 Wiki live 对照 | 4/4 pass，0 fail/blocked |
| npm launcher/私有包 | 10/10 pass |
| 独立目录（无 JS 运行时 PATH），增加 native lookbehind | 7/7 pass |
| 两个 Docker profile 与旧 TS/GHCR 卷回读 | 11/11 pass |
| 外层完整 Python+TS 生产式独立 E2E | not-run；本轮采用以上 scoped 验证 |
| 独立 reviewer | not-run；未获额外执行代理授权，不伪称独立审查 |

完整索引 digest：`96f0115147139a8a3b977727f779e0a5a26a8aed5516505be2664518e6c4363c`。

## 复跑与交接

```bash
cargo fmt --all -- --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo build --locked --release --bins --example story_index_digest
node tools/check-native-binary.mjs
node tools/check-native-regexp.mjs
node tools/check-full-story-index.mjs
node tools/verify.mjs --all
node tools/verify.mjs --live
node tools/bench-native-performance.mjs --cpus 2-5
node tools/package-native.mjs --data-source .runtime/bundle-source --skip-build
node tools/verify-p7-npm.mjs
node tools/verify-p7-local.mjs
node tools/verify-p7-docker.mjs
```

三方 benchmark 可加 `--before-bin artifacts/native-performance/prts-mcp-rust-before`。固定 TS oracle/运行数据/图片卷沿用 P0–P8 的本地准备流程；没有这些忽略数据时不能将跳过计为通过。

本轮只进行独立本地仓库提交与验证，不 push、不发布、不修改外层 tracked 文件。未来转正、平台扩展和正式发行仍按 docs/09 由维护者决定。P9 的源码/记录 bundle 与此前 P0–P8 bundle 一样需要另存，原始性能/ASan/分发证据也在忽略目录。
