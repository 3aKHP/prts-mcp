# Rust 候选发行物与发布流程

M3A 为 M3 的工程准备：五平台完整原生候选、单版本检查和多渠道产物汇总；M3A 工程准备完整通过是合并本发布流程的前置条件；M3B 增加发布流水线，真实渠道验收按下文记录，本页不把代码完成视为公开发布完成。详细步骤和维护者配置见[M3计划](plans/3.0-m3-release.md)。

## 本机重现

```bash
node tools/native/build.mjs linux-x64
node tools/native/pack.mjs linux-x64
node tools/npm/prepare-data.mjs
node tools/npm/pack.mjs linux-x64
node tools/release/pack-native.mjs linux-x64
node tools/release/probe-native.mjs linux-x64
```

候选包为 artifacts/candidate/{platform}/prts-mcp-{version}-{platform}-candidate.tar.gz（Windows为.zip），同目录保存candidate.json、candidate-evidence.json与SHA sidecar。M2A原有SDK输出仍在artifacts/native/，不改写其运行验收。新候选包括bin/、data/、完整第三方许可证、BUILD/ABI/BUNDLE、CANDIDATE.json和完整SHA256SUMS；data保留独立子清单。Linux/macOS用tar，Windows用.NET ZIP，避免路径字符丢失。

原生运行测试解压实际档案到工作树外，核对完整文件集合、类型和全部hash，空PATH/空用户目录直接启动原生程序，自动从bin/../data发现备用数据，不通过JS启动桥，不设置--bundle-root。阻断同步网络后中文查询和EOF须通过；独立完整用户fixture必须优先于安装内备用数据，测试后安装文件hash保持原样。POSIX由非root测试用户运行，并移除整个安装树的写权限位；Windows检查前后完整hash，暂不认领ACL禁止写入。用户优先直接查询operator Excel，不扩大为全部剧情/关卡优先验收。对应native runner才可认领执行通过。

## 汇总

.github/workflows/release-rust.yml读取当前Cargo/Cargo.lock单版本，调用同一native-platforms.yml完成五平台原生/npm/候选与双架构Docker验证，再收集同次run的候选与真实tarball/镜像，不把旧run或开发者下载目录当成来源。构建和汇总job仅contents:read。tag通过版本门禁后，npm发布job单独获得id-token:write，GitHub/GHCR发布job单独获得contents:write/packages:write；发布job均使用rust-release环境，分支push只构建。主仓main仍是2.x，M5前新workflow的workflow_dispatch可能受默认分支登记限制；release/v3.*分支push和v3.*tagpush使用对应ref的workflow，标签必须通过版本/范围门禁。

node tools/release/collect.mjs artifacts/incoming要求candidate-{五平台}、npm-{五平台}与docker-{两Linux}目录（npm artifact内部保留npm/{platform}及native/{platform}层级）。验证当前干净提交、版本、CPU/pin、实际归档SHA、运行证据、绑定实际tarball列表的npm运行证据、绑定已加载档案SHA的Docker运行证据，与tarball/原生候选的实际package.json/BUILD/BUNDLE；五套共享npm tarball必须完全一致，不能任选一个冲突副本。NOTICE在checkout时统一LF；两入口小包的bin执行位和gzip元数据在npm pack后统一，解决Windows没有Unix执行位的差异，正文及实际代码字节不改，SHA/integrity按最终tarball重新计算。汇总得到五个带数据原生包、九个唯一npm包、两个Docker档案、验证证据、RELEASE.json及SHA256SUMS，保存在artifacts/release/和CI的rust-release-candidate artifact（14天）。发布前必须先核对该清单，不能从单个平台临时重新打包覆盖候选。

## 版本与渠道

Cargo.toml与Cargo.lock的产品版本一致，dev只可作为开发候选，不能公开发布。实际v3.*tag必须与产品version和当前提交完全一致；旧ts/python标签、fork、错误tag和M5前的stable均拒绝。预发布按next/候选Docker标签和GitHub prerelease发布；LTS和稳定latest不推进。公开流程由release-rust.yml承载，不能只以policy函数测试通过认领实际权限正确。

M3A仍不是M4完整真实客户端验收或旧发行物回滚，也不关闭文档/data两项门禁。本机root data/、已有用户卷、lts工作树和旧oracle不作为候选打包输入。

## 发布开关与重试

仓库变量RUST_NPM_PUBLISH_ENABLED=true启用npm真实发布，RUST_NON_NPM_PUBLISH_ENABLED=true启用GitHub/GHCR。未设置则相应job跳过。维护者AFK期间npm保持关闭，非npm按明确授权独立推进；npm不发布时Release说明会披露该状态。维护者返回后已开启两个候选渠道开关；stable开关仍关闭。RUST_STABLE_RELEASE_ENABLED在M5正式切换前不启用，稳定版本在流程入口被拒绝。

发布job下载同一次CI汇总的rust-release-candidate，重新核对完整文件集合/SHA、产品版本和source commit，禁止重打包替换已验收产物。npm按五平台→data→runtime→两入口顺序发布，使用npm11.21.0及Node24支持直接OIDC发布与独立dist-tag权限；已有版本须integrity相同，必要时仅修复所属候选标签。GHCR加载两份已运行验证的镜像档案，检查image ID/CPU，再推送精确版本平台标签并建立双架构版本/next manifest；已有精确版本不允许不同镜像覆盖。GitHub使用相同清单上传档案、tarball、镜像和证据，设置prerelease及latest=false。

npm接受上传后可能仍在服务端校验，版本接口与dist-tag接口可能在不同时刻可读；发布器在同一三十分钟预算内确认版本公开/integrity一致以及所属候选标签已指向该版本，再处理后续依赖；npm实际首发处理曾超过二十分钟，因此预算覆盖已观测的延迟；超时仍失败，不把CLI退出0算成公开成功。预发布只推进next，逐项核验所有既有标签保持原值，包括八个新名字首次建立的latest=0.0.0-stage或3.0.0-alpha.1；旧prts-mcp-ts稳定/LTS标签同样不变。npm官方[registry契约](https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md#package)将latest列为必有键，[同类报告](https://github.com/npm/cli/issues/8490)和本次实际删除的E400表明不能以强制删除它作为收口条件。首次注册自动产生的latest只能保留并披露，M5前不得主动推进；候选安装明确使用next或精确版本。

九包发布成功后，verify-npm-tags.mjs用prts-release-check-{GITHUB_RUN_ID}临时标签实际执行add与rm，验证独立dist-tag权限；结束后核对临时标签消失、next/latest/LTS等所有既有标签保持不变。临时验证标签可能在检查期间短暂出现，不是用户安装渠道；同run重试可清理该run遗留且精确指向同版本的标签，冲突版本或任何写入/清理失败均失败，不能以公开GET或同值add当成权限证明。

公开流程中途失败时使用同一次run的“Re-run failed jobs”，复用已经成功汇总的快照。npm已存在且字节相同则跳过重复上传；Docker已有精确版本必须image ID/digest相同；GitHub已有资产先比对字节哈希，缺失资产补传且不使用--clobber。不要通过重跑全部构建来覆盖同版本，重建可能改变档案时间戳或镜像依赖。需要重新构建时使用新的候选版本。

M5前main仍为2.x。预发布从已审查Rust快照创建release/v3.x.y-alpha.N等短发布分支，版本更改与发行内容经独立只读审查及完整CI；tag必须指向该远端发布分支内的提交。此过渡期不将预发布合入main，也不让develop长期停在alpha版本。实际候选的公开记录、渠道和未验范围必须单独核验；npm账号准备见[M3计划](plans/3.0-m3-release.md)。
