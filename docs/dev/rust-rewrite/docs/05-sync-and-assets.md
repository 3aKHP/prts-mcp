# 存储 同步 图片与恢复契约

## 数据来源和存储

GameData/Story 使用 `3aKHP/arknights-data-pipeline` Release：`zh_CN-excel.zip`、`zh_CN-levels.zip`、`zh_CN.zip`；manifest contractVersion=`prts-mcp-data/v1`。图片 index schemaVersion=`akdp-images/v1`。P0 归档实际样本及hash，固定 TS reader/validator 是消费契约；不按最新上游文档擅自升级格式。

Directory、ZIP、fallback 三种读取行为都保留。fallback 是 primary 条目不存在才查 fallback；primary 存在但读取坏JSON不自动吞错改读旧文件。目录/ZIP路径归一化和越界拒绝来自 stores.ts；图片原始字节读取由专用存储入口负责，不强塞进 JSON store。

ZIP 不必完整驻留内存，但条目读取顺序、解码和坏数据行为需差分。required files 清单直接从固定 `data/datasets.ts` 与 `data/sync.ts` 的 GAMEDATA_FILES 提取，P0写入数据契约记录，不另手抄一份易漂移列表。

这些声明已提取到 [data-declarations.json](../contracts/data-declarations.json)：excel有11个必要文件，levels有enemy_database，story有review_table和storyinfo；story实际验证还遍历目录引用的章节，不能只检查两个基础文件。

## 磁盘格式必须互操作

| 产物 | 契约 |
|---|---|
| `gamedata/archives/zh_CN-excel.zip`、`gamedata-levels/archives/zh_CN-levels.zip` | 原始下载包，下载完成与解压完成是两种状态 |
| 各archive旁 `release_meta.json` | 写 repo/branch/commit_sha/fetched_at/files；读兼容 TS已接受的 camelCase 历史字段 |
| 各archive旁 `extract_meta.json` | commit_sha、相对 data_root；realpath 不得逃出 root |
| 共同父目录 `.gamedata_pair.json` | commit_sha、excel_data_root、levels_data_root；同代成对的权威发布点 |
| `.releases/<generation>/` | staging 完成后发布；相对路径，保留旧代供在途读取和回滚 |
| `storyjson/zh_CN.zip` 及 `release_meta.json` | 原子换包、缓存身份改变、坏包不覆盖旧有效包 |
| `images/.images_meta.json`、`.releases/<generation>/index.json` | meta包含schemaVersion/baselineVersion/currentVersion/shardsSynced/generation_root；代内meta无generation_root；不能改成Rust私有持久化结构 |
| `.release.lock`、`.activation.lock`、`.gamedata-pair.lock`、`.images.lock` | 位置和调用层级从基线确认；目录owner租约协议互操作 |

不得要求一次性不可逆卷迁移。临时名、UUID与内存布局可不同，metadata字段、含义与旧reader兼容必须保持。读取旧卷与“Rust写完旧TS还能读”均需验证；GHCR卷再增加旧Python镜像回读，仅限部署互操作，不测试Python业务全文。

## Release 状态机

`发现候选 → 判断版本/缓存 → 下载临时文件 → 包/manifest校验 → 替换archive → 解压staging → 校验树 → 发布单代信息/成对指针 → 失效缓存 → 延后清理`。这是职责图，不允许把“archive已下载”当作“已激活”。

版本使用 data-/datarev- 的 versionId/revision 规则，接受源码支持的下划线/连字符版本；优先级是可解析版本tuple，不是 GitHub列表时间，也不是纯字符串。旧数据仍有效而远端更旧时不能降级；manifest必须匹配versionId，revision>1核对publicationRevision。`data-release-selection.json` 和 sync.test.ts 提供真实历史回归。

manifest仅在**直接URL确认404且不是datarev命名空间**时沿用旧包兼容；镜像404、网络失败、坏JSON、contractVersion不符、revision不符、size/SHA不符不能跳过验证。

状态 `updated/up_to_date/offline_fallback/no_data` 应对应实际可用状态。离线能继续使用有效缓存；损坏缓存即便fresh也不能宣称可用。fresh TTL为3600秒；周期检查forceCheck绕过fresh，未变化不重复激活、不替换pair metadata、不清业务缓存。

excel/levels 必须同代激活：一边成功另一边失败不能把混合代暴露给工具。中途崩溃重启后完成未完成解压/激活，不要求重下同一包；缺失pair只在可证明同代或legacy合法场景下重建。单次工具快照同时固定两者。

## 锁和清理

现有目录锁owner、续租、陈旧判断和释放所有权要保留，不能替换为只有Rust进程理解的flock文件。基线默认等待120秒、ownerless宽限10秒、陈旧30分钟、heartbeat60秒，轮询50毫秒；代际retention24小时。

pair锁在excel/levels共同父目录 `.gamedata-pair.lock`；archive激活锁在各自archives目录 `.activation.lock`，其内部Release下载锁为同目录 `.release.lock`。顺序是pair→excel activation→excel release，释放excel后再levels activation→levels release。独立Story在ZIP旁 `.release.lock`；图片在images根 `.images.lock`。不要反向获取造成死锁。P2报告核对调用顺序与TS争用证据。

释放前确认owner；旧owner不能删除接班者锁。活owner心跳保持租约；陈旧目录先改名隔离再清理。同步取消/异常释放本方资源，未完成staging可在后续清扫。普通清理失败不能回滚已成功激活数据；不得为了省空间立即删除仍可能使用的旧树。

测试使用真实临时文件系统与两个进程验证争用；时钟/故障注入仅限自然边界，避免实际等30分钟。至少一组TS→Rust/Rust→TS共享测试副本验证格式互操作。

## 传输与调度

直连先试，网络/5xx再镜像；直连4xx停止，直连404保留typed absent语义。每个候选独立超时，不让前一候选耗尽后一候选预算。Rust client不自动叠加新的多层重试。下载流写入临时文件并增量校验，保持取消/失败不发布。

启动同步后台执行，各数据集single-flight。密集重试延迟30/120/600秒；正常周期在本轮结束后排下一轮，不重叠；interval=0仍有启动同步。custom GameData与非空STORYJSON_PATH分别关闭对应同步；图片只有IMAGES_ENABLED且LOCAL_IMAGE为真才同步。配对sync重试条件保留，不能把任意updated都当作重试理由。

重试、定时器不能阻止stdio在客户端关闭后退出。无需复制Node unref API，但必须达到对应资源生命周期效果。

## 图片同步

所有required shard key、baseline/delta前缀和original额外分片从imagesSync.ts固定。完整链应按版本顺序应用baseline后所有缺失delta，不能只取最新delta。original=false/true分别验证所需集合。

初次安装、当前代增量、跨多delta、baseline翻页发现、缺中间release、缺asset、重复version、index/tag不一致、逐文件SHA错、离线已有代、回退到另一baseline重建均有现成失败模式。读取与应用过程中失败不得发布新images pointer；旧代继续可用。

图片逐文件hash检查与解压路径边界保留。不是只校验zip hash就宣称资产完整。目录复制/增量优化可以调整，但不得让原代因hardlink原地写被修改；使用copy-on-write策略前证明旧文件字节不变。

## 图片工具两条后端

local：解析阿米娅形态别名（半角/全角括号）、list排序及皮肤元数据、artwork_id归属、variant默认large、original未同步提示、守卫读取PNG、每次get一张。local token当前可能由稳定ID组成，Wiki token由文件名等组成；都按oracle精确记录，不能假定所有token都是随机值而归一化。

MediaWiki：allimages分页、CharinfoV2标签、imageinfo按large1024/preview256请求缩略图，original按原后端行为；LRU按字节256MiB，关闭开关生效。两后端只有输出与身份解析可共享，不伪造一个后端有另一个后端才存在的元数据。

Wiki下载边界来自prtsWiki.ts：HTTPS、允许host=`media.prts.wiki`、最终URL校验、30秒、MIME png/jpeg/webp及magic、响应体上限1MiB。不得用image crate重新编码图片改变字节。也不得把“1MiB decoded cap”误读为解码后像素内存：源码统计的是HTTP response body读出的字节。

这个1MiB上限仅属于Wiki下载；local路径按已同步PNG读取，不得把Wiki上限或MIME请求验证机械复制到local get而拒绝原图。同步时的index/SHA检查和读取时的归属/路径校验仍保留。

参数token必须属于精确归一化形态，兄弟形态和基础形态的错配在读取文件/发请求之前拒绝。路径realpath守卫不可删除。若强化redirect逐跳检查影响基线网络行为，先登记差异，不以框架默认配置静默改变。

## P2/P6 必须产出的状态证据

报告至少附：更新前后metadata与文件hash；失败注入点；重启后的active pointer；读取到的excel/levels版本对；锁owner转换；未变化周期metadata不变；图片缺delta失败不激活；TS和Rust交替写/读同一隔离卷结果。日志里“sync done”不足以证明状态正确。
