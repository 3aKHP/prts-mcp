# Rust 候选发行物（M3A）

M3A 为 M3 的工程准备：五平台完整原生候选、单版本检查和多渠道产物汇总；当前正在实现和验证。公开发布身份与实际 npm/GHCR/Release 在 M3B 验收，本页不表示已有3.x公开发行。详细步骤和维护者配置见[M3计划](plans/3.0-m3-release.md)。

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

.github/workflows/release-rust.yml读取当前Cargo/Cargo.lock单版本，调用同一native-platforms.yml完成五平台原生/npm/候选与双架构Docker验证，再收集同次run的候选与真实tarball/镜像，不把旧run或开发者下载目录当成来源。该准备workflow仅contents:read，不推送包或容器、不创建公开Release。主仓main仍是2.x，M5前新workflow的workflow_dispatch可能受默认分支登记限制；release/v3.*分支push和v3.*tagpush使用对应ref的workflow，标签必须通过版本/范围门禁。

node tools/release/collect.mjs artifacts/incoming要求candidate-{五平台}、npm-{五平台}与docker-{两Linux}目录（npm artifact内部保留npm/{platform}及native/{platform}层级）。验证当前干净提交、版本、CPU/pin、实际归档SHA、运行证据、绑定实际tarball列表的npm运行证据、绑定已加载档案SHA的Docker运行证据，与tarball/原生候选的实际package.json/BUILD/BUNDLE；五套共享npm tarball必须完全一致，不能任选一个冲突副本。NOTICE在checkout时统一LF；两入口小包的bin执行位和gzip元数据在npm pack后统一，解决Windows没有Unix执行位的差异，正文及实际代码字节不改，SHA/integrity按最终tarball重新计算。汇总得到五个带数据原生包、九个唯一npm包、两个Docker档案、验证证据、RELEASE.json及SHA256SUMS，保存在artifacts/release/和CI的rust-release-candidate artifact（14天）。发布前必须先核对该清单，不能从单个平台临时重新打包覆盖候选。

## 版本与渠道

Cargo.toml与Cargo.lock的产品版本一致，dev只可作为开发候选，不能公开发布。实际v3.*tag必须与产品version和当前提交完全一致；旧ts/python标签、fork、错误tag和M5前的stable均拒绝。预发布按next/候选Docker标签和GitHub prerelease发布；LTS和稳定latest不推进。真正公开流程尚待M3B，不能只以policy函数测试通过认领实际权限正确。

M3A仍不是M4完整真实客户端验收或旧发行物回滚，也不关闭文档/data两项门禁。本机root data/、已有用户卷、lts工作树和旧oracle不作为候选打包输入。
