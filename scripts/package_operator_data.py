# DEPRECATED: This script has been superseded by scripts/fetch_gamedata.py,
# which downloads data directly from GitHub without requiring a local clone
# of ArknightsGameData. This file is retained for reference and will be
# removed in a future release.
from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = PROJECT_ROOT / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from prts_mcp.config import Config

REQUIRED_FILES = (
    "character_table.json",
    "handbook_info_table.json",
    "charword_table.json",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Copy the minimal operator data bundle into the repository for Ubuntu/Docker deployment."
    )
    parser.add_argument(
        "--gamedata-source",
        type=Path,
        help="Path to the ArknightsGameData repository root. Defaults to the path resolved via GAMEDATA_PATH env var.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("data") / "gamedata",
        help="Output directory for the bundled data. Default: data/gamedata",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    config = Config.load()
    source_root = args.gamedata_source or config.gamedata_path
    if source_root is None:
        raise SystemExit("未找到 ArknightsGameData 路径。请传入 --gamedata-source，或先设置 GAMEDATA_PATH 环境变量。")

    source_root = source_root.resolve()
    excel_dir = source_root / "zh_CN" / "gamedata" / "excel"
    missing = [name for name in REQUIRED_FILES if not (excel_dir / name).is_file()]
    if missing:
        missing_text = ", ".join(missing)
        raise SystemExit(f"源目录不完整：{excel_dir} 中缺少 {missing_text}")

    output_root = args.output.resolve()
    output_excel_dir = output_root / "zh_CN" / "gamedata" / "excel"
    output_excel_dir.mkdir(parents=True, exist_ok=True)

    copied: list[Path] = []
    for filename in REQUIRED_FILES:
        src = excel_dir / filename
        dst = output_excel_dir / filename
        shutil.copy2(src, dst)
        copied.append(dst)

    print(f"已写入最小干员数据包：{output_root}")
    for path in copied:
        print(f" - {path}")
    print("现在可以将这些文件用于本地自用/私有部署，或构建包含 data/ 的私有 Docker 镜像。")
    print("当前版本不建议将这些打包数据直接提交到公开 Git 仓库。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
