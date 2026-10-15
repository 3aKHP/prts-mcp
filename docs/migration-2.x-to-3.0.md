# 2.x → 3.0 迁移指南

PRTS-MCP 3.0 将底层业务实现统一为原生 Rust，同时完整保留 2.8.1 的 24 个 MCP 工具契约、参数结构与数据目录格式。本文面向从 2.x（Python 或 TypeScript）升级到 3.x 的部署者。

当前公开稳定版仍为 `2.8.1`，Rust 公开候选版为 `3.0.0-rc.2`；待 3.0.0 正式版发布时才会切换 `latest` 标签。客户端配置见[客户端接入指南](user/quick-start.md)，容器与服务端运维见[服务端部署指南](admin/deployment.md)。

---

## 1. 选择升级渠道

| 2.x 原安装方式 | 3.x 升级选择 | 关键变化说明 |
| --- | --- | --- |
| **npm (`prts-mcp-ts`)** | 继续使用 `prts-mcp-ts`，或切换至新主包 `prts-mcp` | 两个 npm 包在 3.x 下均执行预编译 Rust 二进制（需 `Node >= 22`、`npm >= 10` 作为启动桥，不再需要 Bun）。候选期请安装 `@next` 或指定 `@3.0.0-rc.2`。 |
| **Python / PyPI (`prts-mcp`)** | 改用预编译原生归档包、npm 或 Docker | 3.x 不再向 PyPI 发布 Rust 包装包；执行 `pip install -U prts-mcp` 会停留在 2.8.x，不会升级到 3.x。 |
| **Docker (`ghcr.io/3akhp/prts-mcp`)** | 拉取同一镜像仓库的 `3.x` 标签（当前为 `:3.0.0-rc.2` 或 `:next`） | 保持默认 `stdio` 与 `/data` 数据卷约定不变，移除容器内 Python 运行时。 |
| **本地 `python/` 或 `ts/` 源码** | 切换为根目录 Cargo 工程或直接使用预编译归档包 | 3.x 主开发分支不再保留 `python/` 与 `ts/` 目录；2.x 源码维护在 `lts/2.8` 分支进行。 |

```bash
# 方案 A：保留 2.x 的 prts-mcp-ts 命令名，直接升级到 3.x 候选版
npm install -g prts-mcp-ts@3.0.0-rc.2
prts-mcp-ts-stdio

# 方案 B：改用 3.x 新主包 prts-mcp（默认启动 HTTP，可通过环境变量切 stdio）
npm install -g prts-mcp@3.0.0-rc.2
```

> **关于版本标签的说明**：即使未来 3.0.0 正式版切换了 `latest`，已固定 `@2`、`@lts-2.8`、精确 `2.8.x` 版本号或未更新锁文件的部署也不会被自动升级到 3.x。`lts/2.8` 与 `lts/1.7` 分支将继续接收维护修复至 **2027-07-02**。

---

## 2. 核对启动命令与默认传输模式

不同入口命令的默认传输模式如下表所示：

| 启动命令 / 入口 | 默认传输模式 | 切换传输模式的方式 |
| --- | --- | --- |
| **`prts-mcp`**（原生二进制 / npm 新主包） | **Streamable HTTP**（`:3000/mcp`） | 设置 `PRTS_TRANSPORT=stdio` 切换为 stdio。 |
| **`prts-mcp-ts` / `prts-mcp-ts-bun`**（兼容命令） | **Streamable HTTP**（`:3000/mcp`） | 固定为 HTTP（忽略 `PRTS_TRANSPORT`）。 |
| **`prts-mcp-ts-stdio`**（兼容命令） | **stdio** | 固定为 stdio（忽略 `PRTS_TRANSPORT`）。 |
| **Docker 镜像 / `prts-mcp-ghcr`** | **stdio** | 传入 `-e PRTS_TRANSPORT=http` 切换为 HTTP。 |

- **从 Python `prts-mcp` 命令行迁移的特别提醒**：2.x 的 Python `prts-mcp` 命令默认是 `stdio`；而 3.x 的同名 `prts-mcp`（原生二进制与 npm 新主包）默认是 **Streamable HTTP**。如果本地 MCP 客户端直接拉起 `prts-mcp` 子进程，请在客户端配置的 `env` 中加上 `PRTS_TRANSPORT=stdio`，或改用固定 stdio 的 `prts-mcp-ts-stdio`。
- **无需 Bun**：兼容命令 `prts-mcp-ts-bun` 仅保留名称以兼容旧启动脚本，实际直接运行 Rust 二进制，无需安装 Bun。
- **工具面与协议完全兼容**：24 个工具（`IMAGES_ENABLED=false` 时为 23 个）、`get_operator_basic_info` 的 `basic` / `skills` / `stats` 三种 `action`、`PRTS_OUTPUT_CHANNEL`（`content` / `structured` / `both`）以及 `2026-07-28` 现代协议信封行为均与 2.8.1 一致（协议时代说明见 [2.5 → 2.6 迁移指南](migration-2.5-to-2.6.md)）。

---

## 3. 数据目录与 Docker 卷平滑衔接

3.x 直接兼容 2.x 的 `gamedata`、`gamedata-levels`、`storyjson` 与 `images` 目录结构及版本元数据，**升级时无需清空或转换既有数据，也不需要重新下载已同步的立绘包**。

1. **升级前备份**：升级前请先停止旧版服务进程，并完整备份数据目录或 Docker 卷（包含 `.gamedata_pair.json`、`archives/`、`.releases/` 等隐藏元数据及已下载的 PNG）。
2. **用户数据优先**：3.x 发行包内置了只读备用数据，但只要本地可写数据目录或挂载卷中已有完整的用户数据，服务就会优先读取用户数据，并将后续增量更新继续写入该目录。
3. **Docker 卷挂载方式**：
   - **既有分卷挂载（3 个或 4 个子目录卷）**：可直接沿用原挂载参数启动 3.x 容器，无需立即合卷。
   - **新部署或整理卷结构**：推荐直接将单个卷挂载到 `/data`（`-v prts-data:/data`），使根目录下的 `.gamedata_pair.json` 配对指针一并持久化。若从分卷切换为整卷，请先将各子卷内容拷入新卷的对应子目录。
4. **自定义路径变量检查**：
   - 在 3.x 与 2.8.1 中，只要环境变量中存在 `GAMEDATA_PATH`（即使是空值 `GAMEDATA_PATH=`），都会禁用游戏表与关卡自动同步；非空 `STORYJSON_PATH` 会禁用剧情自动同步。升级时请确认没有误传空值占位符。完整规则见[环境变量参考](admin/environment-variables.md)。

---

## 4. 已知实现细节变化（`D-001` – `D-007`）

Rust 实现与 TS/v2.8.1 基线之间有 7 项经批准的实现差异，完整记录在 [`contracts/baseline.json`](../contracts/baseline.json) 中，主要包括：

- **诊断与指标结构（`D-001`、`D-002`）**：`/debug/cache` 保留领域缓存统计，`/debug/metrics` 中的 `process.runtime` 标识为 `"rust"`，内存指标改为 OS 原生驻留集（RSS / Working Set）与峰值统计，不再输出 V8/Python 堆字段。如果你在 2.x 中部署了自定义指标采集脚本，请按新的 Rust 指标字段更新解析逻辑。
- **底层依赖错误文案（`D-003`）**：无效正则表达式等错误的底层依赖报错文本可能与旧实现不同。
- **分发包装（`D-004`）**：发行物改用 Rust 原生程序，npm 包保留 Node 启动桥；安装方式见前文。
- **JSON 输入边界（`D-005`、`D-006`）**：HTTP 请求体包含孤立的 UTF-16 代理码元或无法解析的 JSON 时，返回 HTTP 400 与 JSON-RPC `-32700` 解析错误。stdio 中无法解析的行仍按原有规则跳过。
- **正则大小写折叠（`D-007`）**：ASCII 字符范围和 Unicode 属性转义（含反向属性）沿用 Rust 原有的 Unicode 大小写折叠语义，例如 `[a-zA-Z]` 对 `ſ`、`K` 的匹配与 Bun 不同。具体案例见[已批准的正则差异](../contracts/cases/native-regex-differences.json)。

---

## 5. 回滚指南

由于 3.x 保持了与 2.8.1 相同的数据目录与元数据格式，回滚操作非常直接：

1. 停止 3.x 服务或容器。
2. 切回 2.8.1 的安装版本（如 `npm install -g prts-mcp-ts@2.8.1`、`ghcr.io/3akhp/prts-mcp:2.8.1` 或 `pip install 'prts-mcp==2.8.1'`）及原启动配置。
3. 使用升级前备份的数据卷（或经确认正常的现有数据卷）重新启动服务，并通过代表性查询确认数据读取正常。
