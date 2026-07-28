from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from zipfile import ZipFile

from prts_mcp.data.datasets import GAMEDATA_EXCEL, GAMEDATA_LEVELS


def test_package_check_follows_active_gamedata_generations(tmp_path: Path) -> None:
    excel_root = tmp_path / "gamedata"
    levels_root = tmp_path / "gamedata-levels"
    excel_generation = excel_root / ".releases" / "excel-generation"
    levels_generation = levels_root / ".releases" / "levels-generation"

    for relative_path in GAMEDATA_EXCEL.required_files:
        path = excel_generation / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{}", encoding="utf-8")
    for relative_path in GAMEDATA_LEVELS.required_files:
        path = levels_generation / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{}", encoding="utf-8")

    for root, data_root in (
        (excel_root, ".releases/excel-generation"),
        (levels_root, ".releases/levels-generation"),
    ):
        archives = root / "archives"
        archives.mkdir(parents=True)
        (archives / "extract_meta.json").write_text(
            json.dumps({"commit_sha": "test-sha", "data_root": data_root}),
            encoding="utf-8",
        )

    story_zip = tmp_path / "storyjson" / "zh_CN.zip"
    story_zip.parent.mkdir()
    with ZipFile(story_zip, "w") as archive:
        archive.writestr("zh_CN/gamedata/excel/story_review_table.json", "{}")
        archive.writestr("zh_CN/storyinfo.json", "{}")

    script = Path(__file__).resolve().parents[1] / "scripts" / "check_package_data.py"
    result = subprocess.run(
        [sys.executable, str(script), "--data-root", str(tmp_path)],
        capture_output=True,
        check=False,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    assert "Package data check passed" in result.stdout
