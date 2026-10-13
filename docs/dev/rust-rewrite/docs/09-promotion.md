# 未来转正与本地完成边界

## 可直接复用的内容

本地实现从第一天按产品代码维护：一个独立Cargo工程、可重定位数据路径、业务与transport/配置组装分离、固定契约fixture、可独立构建的容器和安装目录。生产运行不依赖外层repo相对路径、TS oracle、测试harness或完整开发依赖。

最小模块边界为未来管理CLI复用配置解析、数据状态查询和一次同步留出入口；不提前实现命令树、配置文件、daemon、热重载或通用插件。3.x正式管理CLI另按既有CLI评估收口，不计入本次完整复刻。

所有修改历史留在本地Git，不以dev被忽略为由只保存最终目录。许可证、NOTICE和第三方数据声明要与源码和打包产物一起保留，不能只迁移src忘记fixtures/脚本/数据许可来源。

## 本地分发验证范围

Linux x86_64 native二进制、Linux容器、私有npm包本地安装是本次范围。npm包仅提供三个兼容bin，负责定位随包携带的已构建binary、传递argv/stdin/stdout/stderr、信号和退出码。一个可验证的最小launcher即可；不实现从公网自动下载/自更新。

本地npm package命名 `prts-mcp-rust-local`、`private:true`，不能覆盖公开 `prts-mcp-ts`。纯native路径在无Node/Bun环境验证；npm launcher自身需要Node不等于TS业务仍存在。

镜像分别验证TS profile（默认HTTP）和GHCR profile（默认stdio、PRTS_TRANSPORT选择HTTP）。只使用本地镜像tag，不推 `ghcr.io/3akhp/prts-mcp`。挂载 `/data/gamedata`、`/data/gamedata-levels`、`/data/storyjson`、`/data/images`，bundle fallback在 `/app/data`，继承旧数据读写权限契约，不擅自强制新UID导致旧卷不可读。

GHCR验收的Python仅是旧镜像启动、卷格式、配置及回滚参照；业务结果仍按TS。Rust不能因GHCR默认stdio就让所有TS bin也默认stdio，不能把Python env-only output channel限制带入Rust HTTP。

## 转正前仍需维护者决定

| 事项 | 本地实现准备什么 | 不自行执行什么 |
|---|---|---|
| 最终3.x技术栈 | 完整复刻、资源与维护成本证据 | 宣布Rust已成为公开主线 |
| 主仓位置与历史迁移 | 保留本地Git及bundle，去外层绝对路径 | 拷贝 `.git` 到主仓、强行合并无关历史 |
| 版本与命令命名 | 使用本地身份，旧入口profile已验证 | bump外层3.0、废弃旧bin |
| npm/二进制平台矩阵 | Linux本地pack/install、license清单 | 认领未验证OS/架构，上传包 |
| GHCR标签与入口 | 配置/卷连续性和回读报告 | 更新latest或2/3标签 |
| 管理CLI | 无副作用配置与可复用业务接口 | 偷增完整管理产品 |
| 2.x维护与Python归档 | 记录新旧差异、回滚方法 | 停止2.x或1.7支持、归档仓库 |

未来迁入主仓时，从外层develop新feature分支开始，按届时STYLE/WORKFLOW做拆分PR、独立审阅与Bot审阅。可用git subtree、保留历史导入或经审阅的迁移提交，具体方式届时决定；不能把本地fast-forward授权扩大为外层merge授权。

转正PR必须携带最后固定TS兼容报告、后续2.x修复待移植清单、每个差异的迁移说明、平台支持矩阵。若加入新CLI或工具行为调整，使用新的验收范围，不能继续声称对整个3.x进行TS2.8.1逐字兼容。

## 最终交付用语

P8通过时可报告“Linux本地环境下TS/v2.8.1功能与运行行为复刻完成，批准差异见清单，已具备转正评审所需实现和证据”。不能报告“用户直接换任何平台都无感”“性能必然更好”或“已发布3.x”。未完成项必须指向case/平台/证据，不用笼统免责声明代替清单。
