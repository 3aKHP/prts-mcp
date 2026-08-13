# CD 发布恢复手册

维护者文档：当一次发布触发 `CD (TypeScript)` / `CD` 工作流、且某个 job 失败时，如何在不重发已发布制品的前提下完成恢复。

适用范围：`.github/workflows/cd-ts.yml`（TypeScript）与 `.github/workflows/cd.yml`（Python）。本文以 TypeScript 的 npm tarball 传播超时为典型场景（参见 #156），其余失败模式按通用步骤处理。

## 背景：为什么 Verify 单独成 job

`cd-ts.yml` 的 `Verify npm published bytes` 步骤位于 `github-release` job 内（而非 `publish-npm`）。npm 在 Trusted Publishing 完成后，tarball 在 CDN/registry 上的可检索存在数分钟的传播延迟。Verify 步骤会 cache-bust registry/CDN 路径并轮询约 10 分钟（`40 × 15s`）。

把 Verify 放在 `github-release` 而不是 `publish-npm`，使得一次传播超时**只失败 `github-release` 这一个 job**：`publish-npm` 已经绿，npm 上的版本已经不可变地落地。恢复时不需要、也不应该再触发 `npm publish`。

## 主恢复路径：重跑失败的 job

```bash
# 列出最近的 CD (TypeScript) 运行
gh run list --workflow "CD (TypeScript)" --limit 5

# 只重跑失败的 job（推荐）
gh run rerun <run-id> --failed
```

`--failed` 只重跑 `github-release`：它重新下载 workflow artifact、对**已经传播完成**的不可变 npm tarball 重新校验，字节一致后创建 GitHub Release。整个过程**不会再触发 `npm publish`**。

### 为什么优先 `--failed` 而非全量重跑

`publish-npm` 已加幂等 guard：若版本已存在则跳过 `npm publish`。**一旦传播完成**，全量重跑（`gh run rerun <run-id>`，不带 `--failed`）也是安全的——但它会重新走完整条流水线（verify/build/test/dist-tag 解析等），耗时更长，且会再次触发 `environment: npm` 审批门。

注意一个窄边角：在版本已落地但**尚未对 CDN 可见**的传播窗口内全量重跑，guard 的 `npm view` 可能仍拿到 404 而重新 `npm publish`，命中 EPUBLISHCONFLICT（无害，不会双发，但会让该 job 失败）。恢复场景下通常已在传播完成之后操作，故优先 `--failed`；确需在传播窗口内重跑时，等几分钟再试。

## 手动校验回退

当对已发布版本仍有疑虑，或想在重跑前先确认 tarball 已可检索：

```bash
VERSION=2.6.2   # 替换为目标版本
# cache-bust 以绕过可能缓存了陈旧 404 的 CDN 边缘节点
curl -fsSL "$(npm view prts-mcp-ts@${VERSION} dist.tarball)?ts=$(date +%s)" | sha256sum
```

将输出与本轮 workflow artifact（`ts-release-package`，保留 7 天）的 sha256 比对。一致即可放心重跑 `github-release`。

## 报错信息如何区分两种失败

区分依据是错误里**是否给出 expected 与 actual 两组 sha256**（错误串的权威来源是 `cd-ts.yml` 的 Verify 步骤；此处只描述区分要点，避免与工作流措辞同步漂移）：

- **只声明 "not retrievable" / 传播延迟，没有 expected-vs-actual sha256** → 传播延迟，按上面“主恢复路径”重跑即可。
- **声明 "bytes differ" 并附 expected/actual sha256 及 registry `dist.shasum` / `dist.integrity`** → 可检索但字节不符（硬失败）。**不要创建 GitHub Release**，先排查 workflow artifact 与 registry 制品的差异（极罕见，通常是流水线非确定性或中途篡改）。

## 范围说明

- 本文目前仅覆盖 TypeScript CD。Python CD（`cd.yml` 的 `publish-pypi`）尚无对应的发布后字节校验步骤；parity 跟踪见 #157。
- `environment: npm` 审批门挂在 `publish-npm`；任何让 `publish-npm` 重新运行的重跑都会再次要求审批。
