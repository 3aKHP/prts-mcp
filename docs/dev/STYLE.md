# 代码规范与架构 — PRTS-MCP 3.x

协作者先读 CLAUDE.md、STATUS.md 和 ENVIRONMENT.md。2.x 特定 Python/TS 风格和历史审计保存在 legacy/2.x/STYLE.md，当前 Rust 工程按本页执行。

## 分层与职责

依赖方向为 app → protocol/tools/domain/wiki/sync/storage/config；config 不依赖下游。domain 数据读取经 storage 的 DirectoryStore/ZipStore；数据同步 HTTP 归 sync，Wiki HTTP 归 wiki。tools 是薄注册/参数校验/渲染边界，protocol 持有 stdio、Streamable HTTP、版本协商和会话行为。text 仅提供纯文本/数字/正则操作。native regexp 的不安全 FFI 边界集中在 text/regexp 与 native/regexp.c，vendor 源码及许可保持可核对。

文件单一职责。超过约 300 行是耦合预警，不机械拆分已审的内聚单元；一个函数约 50 行、嵌套超过三层、逻辑重复或独立状态/更新/查询集合时评估抽取。看到不相关坏味道另开重构 PR，不随迁移引入新功能。

## Rust

执行 cargo fmt；cargo clippy --locked --all-targets -- -D warnings。保持依赖锁定，生产不可加入 JS/TS/Python VM 或业务回退；允许随二进制静态链接原生 C。公开函数说明 what/why；避免废话注释和杂物 helpers。错误消息面向最终用户，缺数据和网络失败保持中文可读提示、降级与重试契约。unsafe 必须解释所有权、长度、生命周期和释放责任，FFI 指针不得跨任务随意共享。

数据激活必须失效对应缓存；无需配置的用户路径、旧卷、锁/lease、哈希、原子替换和离线恢复遵循冻结契约。依赖升级或行为改动不能仅靠单测认领 parity。

## 契约与测试

工具名/参数/输出保持冻结 TS/v2.8.1 契约，24 工具（关闭图片为 23）。工具描述中文、用途/返回/调用时机约三短句，参数语义放参数 schema。输出通道、传输、工具或环境变量变化，同步 owning docs 和 CHANGELOG。stdout 仅 MCP，日志 stderr。已批准差异 contracts/baseline.json 使用封闭枚举，新增差异由维护者决定。

适量增加能验证真实契约的回归测试，不为移动文件添加镜像实现的机械测试。开发 harness 可以使用 JS 和固定历史 oracle，生产服务不能执行它们。忽略目录中的下载资产不代替版本化的验证 manifest；不能把缺 fixture 的跳过算通过。

公开 Markdown 每个自然段、列表项使用一行物理行，代码栅栏、表格等结构例外。CHANGELOG 的 Unreleased 写实际用户/部署影响，不写“优化了代码”式空话；未发布内容明确区分已完成实现与发行承诺。
