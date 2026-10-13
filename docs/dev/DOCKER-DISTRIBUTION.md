# Rust Docker 分发（M2C）

M2C 在原生 Linux x64/ARM64 上分别构建并执行 Docker 镜像，使用 M2A 审计过的同版原生 payload 和 M2B 校验过的共享备用数据。双架构构建和范围内运行验证通过，见[验收记录](reports/3.0-m2c-docker-distribution.md)；本阶段不推送 GHCR，不改写 ghcr.io/3akhp/prts-mcp 的公开版本或 latest。M3 负责汇总双架构候选和发布，M4 负责真实客户端完整升级/回滚验收。

## 构建

生产 Dockerfile 消费经过校验的独立构建上下文，不能直接把开发者的根 data/ 当作备用数据。tools/docker/build.mjs 要求匹配本机和 Docker daemon 的 Linux CPU、当前干净提交、同版原生 BUILD/BUNDLE，以及实际 payload 的完整文件集合、哈希和许可引用（拒绝清单外文件、链接及特殊文件）；拒绝交叉编译或模拟运行作为原生证据。版本来自 Cargo.toml。

```bash
node tools/native/build.mjs linux-x64
node tools/native/pack.mjs linux-x64
node tools/npm/prepare-data.mjs
node tools/docker/build.mjs linux-x64
node tools/prepare-validation.mjs --minimal
node tools/docker/probe.mjs linux-x64
```

ARM64 在原生 ARM64 主机使用 linux-arm64。out 目录为 artifacts/docker/{platform}/，保存 image.json、可 docker load 的 .docker.tar.gz 和 SHA256 sidecar，成功验证另写 docker-evidence.json。两个独立原生镜像的证据不等同于已在 registry 发布双架构 manifest；候选汇总和发布在 M3 完成。

根 Dockerfile 为发行包装配方，tools/docker/build.mjs 自动暂存经过审核的 native-payload/ 与 bundle/ 后调用它。源码开发镜像使用 docker build -f packaging/docker/Dockerfile.source -t prts-mcp:source-dev .；该开发镜像不携带完整备用数据，不作为正式发行物或本阶段通过证据。

## 运行与权限

运行镜像只包含 Rust 程序、静态原生组件、备用游戏数据和基础 OS 包；没有 Node/Bun/Python 业务运行时或编译器。Ubuntu 24.04 base index 以 digest 固定，安装 ca-certificates 和 tini；OS 包版本取构建时仓库，不能承诺 bit-for-bit 重建。原生 ABI/许可证和数据来源/校验记录保留在 /app；tini 的许可随 OS 包版权文件保留。

ENTRYPOINT 是 tini -g -- /app/bin/prts-mcp-ghcr。tini 作为 PID 1 转发停止信号、回收进程，避免直接 PID 1 的默认信号行为使 docker stop 等到 SIGKILL。SIGTERM 终止退出语义不等于已经实现应用层 graceful shutdown。

沿用固定 2.8.1 GHCR/Python Docker profile：默认 root（0:0），默认 stdio；只有规范化后 PRTS_TRANSPORT=http 才选择 HTTP，默认端口 3000。HTTP 分支非法 PORT 写 stderr 并退出 1，stdio 不读取该端口值。新 npm 主命令的默认 HTTP/:3000 不改变此容器契约。

```bash
# M2C 本地构建标签；不是公开 GHCR 安装命令。
docker run --rm -i prts-mcp:m2c-linux-x64
# HTTP 明确选择；端口仅向本机开放。
docker run --rm -e PRTS_TRANSPORT=http -p 127.0.0.1:3000:3000 prts-mcp:m2c-linux-x64
```

## 数据卷和旧版迁移

/app/data 是经过校验的备用读取来源；同步写 /data/gamedata、/data/gamedata-levels、/data/storyjson 和 /data/images。已完整的用户数据优先；安装目录不作为同步目标，镜像构建不复制本机残留状态或旧四表快照。[完整政策](../../data/README.md)。

既有四个子目录的 named volume/bind mount 可以继续使用，无需转换数据格式。新部署推荐挂载整个 /data，让 .gamedata_pair.json 一起持久化；四个分离挂载无法持久化容器 overlay 中的根 pair pointer，重建后仍按各根 archives/extract_meta.json 读取，这是旧部署布局的既有边界。更换挂载方式前应备份整个相关目录，M2C 不自动搬迁用户数据。

```bash
docker run --rm -i -v prts-data:/data prts-mcp:m2c-linux-x64
# 可选非 root：host-data 的四个目录须由该 UID/GID 创建并可写。
docker run --rm -i --user "$(id -u):$(id -g)" --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777 -v "$PWD/host-data:/data" prts-mcp:m2c-linux-x64
```

四个分离挂载配合 --read-only 时，还须添加 --tmpfs /data:rw,nosuid,nodev,mode=1777，使父目录的锁和 pair pointer 能写入临时空间。普通可写根文件系统的旧部署不需要此额外选项；整卷 /data 挂载本身已提供可写父目录。

默认 root 延续旧镜像，不擅自改为固定非 root UID，也不自动 chown 既有卷。选择 --user 的部署者负责挂载目录所有权；镜像内备用数据对普通 UID 可读。无卷时同步数据只存在于容器可写层，删除容器后丢失，与旧行为一致。

## 验证边界

原生两架构 CI 验证真实镜像、全部原生/数据哈希、原始许可、无业务语言运行时/编译器、默认 stdio/EOF、显式 HTTP/旧新协议、PORT 错误、tini PID 1/停止码、非 root/只读根文件系统、用户数据优先、旧 TS 写入的 pair/图片代际，以及整卷和四分卷的真实同步与离线重建。临时卷由测试独立创建，不使用用户已有卷；测试镜像/网络使用唯一名称并清理。

测试 mirror 使用单独 digest 固定的 Node fixture 容器，只在测试网络中提供已校验的固定数据；该容器及 JS 文件不进入发行镜像。旧 TS oracle 从冻结 tag 在 .reference/ 重建，仅用于旧卷写入与读回。图片使用五幅代表性 fixture，不能代替 M4 全部工具和真实上游图片链路验收。旧 TS 对容器写入数据的读回是有限兼容证据，完整实际旧发行物回滚仍在 M4。

文档专场和 data/ 跨渠道/候选运行门禁继续开放；CLI、功能新增和公开发布均不在 M2C。Docker 平台策略参见[官方多平台说明](https://docs.docker.com/build/building/multi-platform/)，构建输入见[官方 context 说明](https://docs.docker.com/build/concepts/context/)。
