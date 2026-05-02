"""Verify bundled fallback data before Docker or npm packaging."""
from __future__ import annotations

import argparse
import sys
import zipfile
from pathlib import Path

_PYTHON_DIR = Path(__file__).resolve().parents[1]
_REPO_ROOT = _PYTHON_DIR.parent
_SRC_DIR = _PYTHON_DIR / "src"
if str(_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(_SRC_DIR))

from prts_mcp.data.datasets import GAMEDATA_EXCEL, STORY_ZH_CN  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Check bundled PRTS-MCP data files.")
    parser.add_argument(
        "--data-root",
        type=Path,
        default=_REPO_ROOT / "data",
        help="Directory containing gamedata/ and storyjson/. Default: repo data/.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    data_root = args.data_root.resolve()
    gamedata_root = data_root / "gamedata"
    story_zip = data_root / "storyjson" / STORY_ZH_CN.asset_name

    missing = [path for path in GAMEDATA_EXCEL.required_files if not (gamedata_root / path).is_file()]
    if missing:
        print("Missing bundled gamedata files:", file=sys.stderr)
        for path in missing:
            print(f" - {gamedata_root / path}", file=sys.stderr)
        return 1

    if not story_zip.is_file():
        print(f"Missing bundled story zip: {story_zip}", file=sys.stderr)
        return 1

    try:
        with zipfile.ZipFile(story_zip) as zf:
            names = set(zf.namelist())
            missing_entries = [path for path in STORY_ZH_CN.required_files if path not in names]
    except zipfile.BadZipFile:
        print(f"Bundled story zip is not a valid zip: {story_zip}", file=sys.stderr)
        return 1

    if missing_entries:
        print("Missing bundled story zip entries:", file=sys.stderr)
        for path in missing_entries:
            print(f" - {path}", file=sys.stderr)
        return 1

    print(f"Package data check passed: {data_root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

