"""Verify bundled fallback data before Docker or npm packaging."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

_PYTHON_DIR = Path(__file__).resolve().parents[1]
_REPO_ROOT = _PYTHON_DIR.parent
_SRC_DIR = _PYTHON_DIR / "src"
if str(_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(_SRC_DIR))

from prts_mcp.config import Config  # noqa: E402
from prts_mcp.data.datasets import GAMEDATA_EXCEL, GAMEDATA_LEVELS, STORY_ZH_CN  # noqa: E402


_EXCEL_ROOT = Path("zh_CN/gamedata/excel")


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
    levels_root = data_root / "gamedata-levels"
    story_zip = data_root / "storyjson" / STORY_ZH_CN.asset_name
    for label, root in (
        ("Bundled gamedata", gamedata_root),
        ("Bundled level data", levels_root),
    ):
        if not root.resolve().is_relative_to(data_root):
            print(f"{label} resolves outside package root: {root}", file=sys.stderr)
            return 1
    config = Config(
        gamedata_path=gamedata_root,
        storyjson_zip=story_zip,
        is_custom_gamedata=True,
    )

    active_excel = config.effective_excel_path
    if active_excel is None:
        missing = [gamedata_root / path for path in GAMEDATA_EXCEL.required_files]
    elif not active_excel.resolve().is_relative_to(gamedata_root.resolve()):
        print(
            f"Bundled gamedata resolves outside package root: {active_excel}",
            file=sys.stderr,
        )
        return 1
    else:
        missing = [
            active_excel / Path(path).relative_to(_EXCEL_ROOT)
            for path in GAMEDATA_EXCEL.required_files
            if not (active_excel / Path(path).relative_to(_EXCEL_ROOT)).is_file()
        ]
    if missing:
        print("Missing bundled gamedata files:", file=sys.stderr)
        for path in missing:
            print(f" - {path}", file=sys.stderr)
        return 1

    active_levels = config.effective_levels_path
    if active_levels is None:
        missing_levels = [levels_root / path for path in GAMEDATA_LEVELS.required_files]
    elif not active_levels.resolve().is_relative_to(levels_root.resolve()):
        print(
            f"Bundled level data resolves outside package root: {active_levels}",
            file=sys.stderr,
        )
        return 1
    else:
        missing_levels = [
            active_levels / path
            for path in GAMEDATA_LEVELS.required_files
            if not (active_levels / path).is_file()
        ]
    if missing_levels:
        print("Missing bundled level data files:", file=sys.stderr)
        for path in missing_levels:
            print(f" - {path}", file=sys.stderr)
        return 1

    if not story_zip.is_file():
        print(f"Missing bundled story zip: {story_zip}", file=sys.stderr)
        return 1

    missing_entries = STORY_ZH_CN.validate_zip(story_zip)

    if missing_entries:
        print("Invalid bundled story zip entries:", file=sys.stderr)
        for path in missing_entries:
            print(f" - {path}", file=sys.stderr)
        return 1

    print(f"Package data check passed: {data_root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
