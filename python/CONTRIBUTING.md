# Python Contribution Notes

整个仓库的贡献规则见 [`CONTRIBUTING.md`](../CONTRIBUTING.md)，跨平台环境准备见
[`docs/dev/ENVIRONMENT.md`](../docs/dev/ENVIRONMENT.md)。

从仓库根目录运行 Python 检查：

```bash
uv sync --directory python --locked
uv run --directory python --locked python -m compileall src scripts
uv run --directory python --locked python -m pytest tests -q
```

Python 实现的使用与部署说明见 [`README.md`](README.md)。代码需要遵守根贡献
指南和 [`docs/dev/STYLE.md`](../docs/dev/STYLE.md) 中的架构、store 与 parity 约束。
