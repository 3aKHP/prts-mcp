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

全量重跑还有一个更隐蔽的问题：它会重跑 `package` job，重新 `fetch_gamedata.py` 并下载最新的 storyjson；若 arknights-data-pipeline 在两次运行之间发布了新数据，重建出的 tarball 会与 npm 上已落地的不可变字节不同，Verify 会判定为“本地制品漂移”（见下节）。**注意：一旦漂移进入某个 run 的 artifact，对这个 run 做 `--failed` 也会重新下载同一个漂移 artifact 而再次失败**——`--failed` 只在重跑**最初发布该版本的 run**（其 artifact 与已发布字节一致）时才能恢复漂移。所以优先在原始 run 上用 `--failed`；若原始 run 已不可用，按下一节的漂移路径用 registry tarball 建 release。

## 手动校验回退

当对已发布版本仍有疑虑，或想在重跑前先确认 tarball 已可检索：

```bash
VERSION=2.6.2   # 替换为目标版本
# cache-bust 以绕过可能缓存了陈旧 404 的 CDN 边缘节点
curl -fsSL "$(npm view prts-mcp-ts@${VERSION} dist.tarball)?ts=$(date +%s)" | sha256sum
```

将输出与本轮 workflow artifact（`ts-release-package`，保留 7 天）的 sha256 比对。一致即可放心重跑 `github-release`。

## 报错信息如何区分失败类型

错误串的权威来源是 `ts/scripts/verify-npm-published.sh`；此处只描述区分要点，避免与脚本措辞同步漂移。注意打印的哈希算法不同：`expected/actual sha256` 是 SHA-256，`dist.shasum` 是 SHA-1，`dist.integrity` 是 base64 的 SHA-512 SRI——**不要跨算法直接比对**。

- **只声明 "not retrievable" / 传播延迟，没有 expected-vs-actual sha256** → npm 传播未完成或传输被中断，按上面“主恢复路径”重跑即可。
- **声明 "registry tarball is intact … drifted"** → registry 制品完好（与它自报的 `dist.shasum` 一致），但与本地 artifact 不符：本地制品漂移（典型于 bundled 数据变化后的全量重跑）。npm 上的 tarball 才是正确的发布内容。恢复：直接以 registry tarball 创建 release；或对**最初发布该版本的 run** 做 `gh run rerun <id> --failed`（其 artifact 字节一致）。对当前（已漂移的）run 做 `--failed` 会重新下载漂移 artifact 而再次失败。
- **声明 "does NOT match the registry's own declared hashes" 并附 downloaded sha1** → 下载到的字节与 registry 自己声明的哈希都不符（CDN/registry 异常或篡改）。**不要创建 GitHub Release**，先排查。

## Python (PyPI) 校验

`cd.yml` 的 `github-release` 同样有一个 Verify 步骤（`python/scripts/verify_pypi_published.py`），与 TS 版同构：传播/索引超时只失败 `github-release`，用 `gh run rerun <run-id> --failed` 恢复（不重发 PyPI）。

差异：Python 版是**最小校验**——轮询 PyPI JSON API（`pypi.org/pypi/prts-mcp/<ver>/json`）直到版本可见，把本地 wheel/sdist 的 sha256 与 PyPI 自报的 `digests.sha256` 比对；**不下载文件**（PyPI 的 JSON digest 即“已索引内容”的权威来源，且制品本身很小）。

- **"PyPI JSON not visible … propagation delay"** → PyPI 尚未完成索引，按主恢复路径重跑。
- **"sha256 mismatch"** → 本地制品与 PyPI 已记录的 digest 不符，通常是全量重跑后本地漂移（PyPI 文件不可变，已发布的才是正确内容）。恢复：以 PyPI 上的文件重建 release，或对**最初发布该版本的 run** 做 `--failed`。
- **"local artifact(s) not present in PyPI JSON" / "PyPI JSON lists file(s) absent from local dist"** → 本地与 PyPI 的文件集合不一致（同样是全量重跑后本地漂移的典型表现）。已发布的 PyPI 文件才是正确内容；以 PyPI 文件重建 release，或对最初发布的 run 做 `--failed`。

手动回退（`VERSION` 用 PEP 440 形式：预发布写成 `2.7.0a1` 而非 git tag `2.7.0-alpha.1`——脚本会自动归一化）：

```bash
VERSION=2.6.2   # 预发布示例：2.7.0a1
python3 -c "import json,urllib.request as u; d=json.load(u.urlopen('https://pypi.org/pypi/prts-mcp/$VERSION/json')); [print(x['filename'], x['digests']['sha256']) for x in d['urls']]"
# 与本地 python/dist/*.whl、*.tar.gz 的 sha256sum 比对
```

## 范围说明

- 两套 CD（TypeScript `cd-ts.yml` 与 Python `cd.yml`）的 `github-release` 各有一个 Verify 步骤；TS 版下载 tarball 比对字节，Python 版比对 PyPI JSON 的 declared digest（最小校验，见上节）。
- `environment: npm` / `environment: pypi` 审批门分别挂在 `publish-npm` / `publish-pypi`；任何让这两个 job 重新运行的重跑都会再次要求审批。
