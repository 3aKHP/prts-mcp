# 游戏数据目录

根 data/ 用于本地下载数据；Git 仅保存本说明和目录占位文件。完整游戏数据来自 arknights-data-pipeline 的 Release，数据集声明见 [contracts/data-declarations.json](../contracts/data-declarations.json)。正式发行物的备用数据由发行构建流程单独准备、校验，不从开发者本机 data/ 直接复制。

## 内容与来源

| 子目录 | 内容 | 主要用途 |
| --- | --- | --- |
| gamedata/ | zh_CN-excel.zip 及其解压表格 | 干员、档案、语音、敌人、关卡索引、物品、基建、皮肤、技能等游戏数据。 |
| gamedata-levels/ | zh_CN-levels.zip 及其解压内容 | 关卡战斗、敌人属性和出场数据。 |
| storyjson/ | zh_CN.zip | 剧情正文、剧情索引及包内配套表格；剧情读取直接使用 ZIP。 |

archives/、.releases/、release_meta.json、extract_meta.json 和锁文件属于下载、激活及同步状态，均为本机数据。立绘不在本目录的源码占位范围内，按 LOCAL_IMAGE 和 PRTS_IMAGE_DIR 配置单独同步或经 Wiki 获取。

旧版曾在 Git 中携带 character_table.json、charword_table.json、handbook_info_table.json、story_review_table.json 四份表格及 cache_meta.json，来源记录标注下载于 2026-04-08。这份约 29.7 MiB 的局部快照缺少当前功能需要的其他核心表格，3.x 不再跟踪它及其旧来源记录。已有本机文件可保留，忽略规则会同时排除后续下载的表格、压缩包和同步状态；这些文件不能作为完整、同版本的正式备用数据。

## 从源码运行

普通源码运行不会自动把工作目录下的 data/ 当作默认数据源。服务默认将下载数据写入用户数据目录；Linux/macOS 使用 ${XDG_DATA_HOME:-~/.local/share}/prts-mcp，Windows 使用 %LOCALAPPDATA%/prts-mcp（未设置时回退用户目录下的 AppData/Local/prts-mcp），Docker 兼容入口使用 /data。具体路径及自定义行为见[环境变量说明](../docs/user/environment-variables.md)。

指定 GAMEDATA_PATH 会关闭 GameData 自动同步，非空 STORYJSON_PATH 会关闭剧情自动同步；因此不要将未完成的本地下载目录配置成可用数据。源码首次运行可等待默认同步完成，或指定一套已经完整校验的数据。开发验证通过固定 TS tag 重建 .reference/ 与 .runtime/，不依赖本目录的旧表格；历史契约和黄金结果继续保留，见[开发环境](../docs/dev/ENVIRONMENT.md)。

## 正式发行物的备用数据

维护者已确认：3.0 的原生、npm 和 Docker 正式发行物继续提供经过校验的只读备用游戏数据，供首次同步尚未完成或失败时使用；用户数据目录内已经可用的数据优先，后续同步写入用户目录或既有数据卷，不修改安装包内的备用数据。Wiki 联网查询和未下载的立绘不因此成为离线功能。

发行构建需固定 AKDP 数据 Release 与 manifest，校验三个压缩包的版本、大小、SHA-256、必需表格和剧情结构，再生成可读取的备用布局。Excel 与 levels 须来自同一数据版本，剧情配套信息须按该版本校验；只携带 ZIP 而缺少运行时所需的 Excel/levels 解压内容不能视为完成。不得将本机残留的锁、无效激活指针或旧四表快照作为备用数据。来源和校验清单随发行物保留，第三方内容声明见 [NOTICE](../NOTICE)。

当前 M2A 原生 CI 产物仅验证二进制、平台与传输，不携带完整备用数据。共享数据包装在 M2B、Docker 包装在 M2C、候选原生产物与发布构建在 M3、真实首次启动/离线备用/旧卷升级及回滚在 M4 验收。Cargo 源码包不内嵌完整游戏数据，源码安装沿用运行时同步。data/ 发布门禁仍需上述包装与运行证据，清理源码跟踪或写下方案并不关闭门禁。

## 保留已有本机文件

仅新增 .gitignore 不能停止跟踪已经进入 Git 的文件。本次对上述五个文件使用 git rm --cached，只从 Git 索引移除，本机内容保持原样；.dockerignore 排除根 data/，Cargo 源码包也以现有 include 白名单排除完整数据。

跨分支切换或同步含 Git 删除记录的提交前，建议将仍需保留的数据备份到仓库之外，或放入忽略的 .runtime/、dev/；Git 的忽略规则不提供跨分支的数据备份保证。2.x 历史 tag 和 LTS 分支的表格及发布流程保持各自原有状态，不在本次改动中清理。
