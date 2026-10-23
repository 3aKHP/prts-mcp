# ADR-0002：lts/1.7 数据源的 AKDP 兼容投影仓

- 状态：Accepted（补录）
- 决策日期：2026-08-05（决策不晚于该日冻结）
- 关联：[LTS.md](../LTS.md)、上游仓库 [3aKHP/ArknightsGameData](https://github.com/3aKHP/ArknightsGameData) 与 [3aKHP/ArknightsStoryJson](https://github.com/3aKHP/ArknightsStoryJson)

> 补录说明：本决策冻结于 ADR 目录建立之前（2.5.x 时代），因其机制至今现役且档案库无逐条记录，按本目录的补录例外整理自决策与执行期间（2026-08-05 至 2026-08-06）的内部工作记录。

## 背景与问题

2.5.0 起，主线的数据自动同步切换到自托管的 AKDP 工厂仓，并改为按 `data-` 标签前缀发现发行版（见 [CHANGELOG.zh-CN.md](../../../CHANGELOG.zh-CN.md)）。而 `lts/1.7` 的同步实现只会读取 `ArknightsGameData` 与 `ArknightsStoryJson` 两个 fork 仓的 `/releases/latest` 和固定资产名，且 [LTS.md](../LTS.md) 明确把架构性改动排除在 LTS 维护范围之外——1.7 线面临断供。

与此同时，两个 fork 仓的旧生产链存在记录在案的负债：StoryJson fork 内含 LLM 摘要管线（有调用费用、摘要非幂等、且存在摘要失败仍发布的降级路径）；GameData fork 依赖双上游跟踪，链路复杂。

硬约束：不删除或重建仓库、不强制推送，必须保留历史、Release 与回滚能力；仓库 detach（脱离 fork 网络）是独立的后续窗口，不与本次改造合并。

## 备选方案

- **继续让 fork 跟踪旧上游**：否决。AKDP 已是唯一规范生产源，旧链保留 LLM 调用成本与双上游复杂度。
- **detach 前最后再同步一次旧上游**：否决。旧上游变化不再进入新主线，无法形成稳定的 detach 基线，且会重新触发 LLM 摘要链路；只允许做不发布的固定快照。
- **保留或复制 `zh_CN-resource-manifest.zip`**：否决。盘点确认 1.7 线无任何消费者；复制旧版或生成空伪清单会制造隐性过期数据。裁定为 legacy 可选资产，新 Release 不再投影，并在 Release notes 中明示。
- **修改 1.7 客户端以直接消费 AKDP**：未留下当时的书面权衡记录（材料缺口）。事后按 LTS 范围政策的解释是：在冻结的客户端里回填标签前缀发现、manifest 校验等新代码，风险高于保持消费接口逐字节不变；此条属事后解释，非当时记录。

## 决定

把两个 fork 仓改造为 **AKDP 兼容分发层（投影仓）**：从 AKDP 最新非 draft Release 下载 manifest 与所需 ZIP，经 GitHub digest、manifest 内 SHA-256 与体积、归档完整性、路径安全、JSON 可解析五重验证后，**直接上传 AKDP 原始字节（不重压缩）**，保证兼容仓资产与工厂产物逐字节一致。

配套规则：

- 兼容仓自产 manifest 携带工厂溯源字段（来源仓库、Release、版本号、工厂 manifest 摘要、流水线提交、兼容契约标识）；旧校验字段保留。
- 以数据源版本号为幂等键：同一工厂 Release 只产生一个逻辑 Release；先以 draft 形式发布、验证通过后再公开；任何不一致直接失败并保留上一版。
- StoryJson 兼容仓删除全部 LLM 生产路径与对应密钥，摘要保持 AKDP 产物原样；校验侧新增摘要覆盖率检查，部分覆盖必须显式标记，不得隐式声称完整。

## 后果

正面：

- 1.7 客户端零改动继续获得工厂数据；LLM 成本与非幂等路径从分发链中移除。
- 资产与工厂字节级一致，任何人均可公开核验 SHA。
- 改造后两个仓库完成了 detach，历史、Release 与既有 URL 全部保留；投影机制至今现役（1.7.3 于 2026-10-21 发布）。
- 执行留痕完整：开局完成约 1.8 GB 的镜像备份与契约占定，首日即发布首个兼容 Release。

负面与代价：

- `datarev-` 修复修订不投影到 1.7 fork，修复内容随下一个标准 `data-` 版本到达（已公开于 [LTS.md](../LTS.md)）。
- 只投影最新代的设计会跳过中间代（其后实测确实发生）。
- `zh_CN-resource-manifest.zip` 停止发布：若存在未审计的外部消费者，对其构成静默断供，只能靠 Release notes 明示缓解。
- 单一维护账号的结构风险被一次 GitHub 侧可用性事件实证：2026-09-15 至 2026-10-18 投影中断，后以手动触发恢复。中断根因未在可公开材料中记录，本文不作归因。

遗留事项：

- wave0 发现 AKDP Release 正文内嵌的资产 SHA 与 manifest.json 中的资产摘要不一致，当时裁定以 manifest 资产为唯一权威；工厂侧正文生成逻辑的修复状态未跟踪。
- 自建对象存储数据源的关联调研已完成但未实施，其中“1.7 投影链如何存续”的问题留为待定，不属本决策范围。

公开记录：[LTS.md](../LTS.md)（投影安排、datarev 不投影规则）、[CHANGELOG.zh-CN.md](../../../CHANGELOG.zh-CN.md) 2.5.0 段（主线切源与标签前缀发现）、[data-and-sync.md](../../admin/data-and-sync.md)（3.x 直消费 AKDP 与数据契约）、[packaging/npm/data-release.json](../../../packaging/npm/data-release.json)、两个投影仓的 PR #2/#3 与 `akdp-*` Release 列表。
