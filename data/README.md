# 游戏数据目录（`data/`）

仓库根目录下的 `data/` 仅用于在本地开发时存放运行时下载的游戏数据；Git 只跟踪本说明文件与子目录占位文件（`.gitkeep`）。

完整的明日方舟游戏数据由 [`3aKHP/arknights-data-pipeline`](https://github.com/3aKHP/arknights-data-pipeline) 的 GitHub Release 提供，数据集契约声明见 [`contracts/data-declarations.json`](../contracts/data-declarations.json)。正式发行包（原生归档包、npm 包与 Docker 镜像）内置的备用数据由打包脚本从固定 Release 独立拉取并校验生成，不会从开发者的本机 `data/` 目录直接复制。

## 目录结构与用途

| 子目录 | 对应归档包与内容 | 主要用途 |
| --- | --- | --- |
| `gamedata/` | `zh_CN-excel.zip` 及其解压后的 JSON 表格 | 干员基础档案、语音、敌方图鉴、关卡索引、物品材料、基建技能、时装与战斗技能等数据。 |
| `gamedata-levels/` | `zh_CN-levels.zip` 及其解压内容 | 关卡战斗详细数据、敌方关卡级属性覆盖与实际刷怪波次。 |
| `storyjson/` | `zh_CN.zip` | 剧情对话正文、章节梗概及包内索引（服务端直接从 ZIP 按需流式读取，无需预先解压全量文本）。 |

同步过程中生成的 `archives/`、`.releases/`、`release_meta.json`、`extract_meta.json`、`.gamedata_pair.json` 及锁文件均为本地同步状态元数据，已被 `.gitignore` 忽略。干员立绘资产不在本目录下设占位目录，而是根据 `LOCAL_IMAGE` 与 `PRTS_IMAGE_DIR` 配置单独存放在用户数据目录的 `images/` 下或按需从 PRTS MediaWiki 获取。

## 从源码运行时的默认路径

直接从源码编译运行（未设置自定义路径环境变量）时，服务会将同步的数据写入操作系统标准的用户数据目录，而非本仓库的 `data/`：

- **Linux / macOS**：`${XDG_DATA_HOME:-~/.local/share}/prts-mcp`
- **Windows**：`%LOCALAPPDATA%\prts-mcp`（若未设置 `LOCALAPPDATA`，则回退至用户目录下的 `AppData\Local\prts-mcp`）
- **Docker 容器**：`/data`

> **注意**：若显式设置了 `GAMEDATA_PATH`（哪怕赋值为空）会立即禁用游戏表与关卡的自动同步；设置了非空 `STORYJSON_PATH` 会禁用剧情自动同步。因此，请勿将尚未同步完整的空目录设为自定义数据路径。详细规则见[环境变量参考](../docs/admin/environment-variables.md)与[数据同步管理](../docs/admin/data-and-sync.md)。

## 正式发行物的内置备用数据

公开发布的 3.x 原生归档包、npm 包（通过共享的 `@3akhp/prts-mcp-data`）与 Docker 镜像均内置了一份经过完整校验的只读备用游戏数据（由 `packaging/npm/data-release.json` 固定上游 Release 与 SHA-256，经 `node tools/npm/prepare-data.mjs` 与 `examples/package_data.rs` 校验打包）。

- **备用与优先规则**：当用户数据目录为空且首次同步尚未完成（或网络不可用）时，服务自动回退读取内置备用数据；一旦用户数据目录中存在完整的同步数据，服务始终优先读取用户数据，且后台同步只写入可写的用户目录，绝不修改安装目录内的备用数据。
- **Cargo 源码包**：`cargo package` 生成的源码包不包含体积庞大的游戏数据，从源码构建的安装依赖启动后自动同步或显式指定本地数据路径。
- **版权与许可**：第三方游戏数据与 Wiki 内容的知识产权声明见根目录 [NOTICE](../NOTICE)。

## 本地数据维护提示

由于 `.gitignore` 忽略了 `data/` 下的实际数据文件，在跨大版本切换分支（例如在 `lts/2.8` 与 `develop` 之间切换）或执行 `git clean` 前，若本目录存有需要保留的本地数据，请先将其备份到仓库外部或移至用户数据目录，以免被清理。
