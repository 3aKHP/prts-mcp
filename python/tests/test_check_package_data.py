from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from zipfile import ZipFile

from prts_mcp.data.datasets import GAMEDATA_EXCEL, GAMEDATA_LEVELS


def _write_story_zip(data_root: Path) -> None:
    story_zip = data_root / "storyjson" / "zh_CN.zip"
    story_zip.parent.mkdir()
    with ZipFile(story_zip, "w") as archive:
        archive.writestr("zh_CN/gamedata/excel/story_review_table.json", "{}")
        archive.writestr("zh_CN/storyinfo.json", "{}")


def _run_package_check(data_root: Path) -> subprocess.CompletedProcess[str]:
    script = Path(__file__).resolve().parents[1] / "scripts" / "check_package_data.py"
    return subprocess.run(
        [sys.executable, str(script), "--data-root", str(data_root)],
        capture_output=True,
        check=False,
        text=True,
    )


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

    _write_story_zip(tmp_path)
    result = _run_package_check(tmp_path)

    assert result.returncode == 0, result.stderr
    assert "Package data check passed" in result.stdout


def test_package_check_rejects_symlinked_external_data(tmp_path: Path) -> None:
    external = tmp_path / "external"
    external_excel = external / "excel"
    external_levels = external / "levels"
    external_excel.mkdir(parents=True)
    for relative_path in GAMEDATA_EXCEL.required_files:
        (external_excel / Path(relative_path).name).write_text("{}", encoding="utf-8")
    for relative_path in GAMEDATA_LEVELS.required_files:
        path = external_levels / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{}", encoding="utf-8")

    data_root = tmp_path / "package"
    excel_link = data_root / "gamedata" / "zh_CN" / "gamedata" / "excel"
    excel_link.parent.mkdir(parents=True)
    excel_link.symlink_to(external_excel, target_is_directory=True)
    levels_link = data_root / "gamedata-levels"
    levels_link.parent.mkdir(parents=True, exist_ok=True)
    levels_link.symlink_to(external_levels, target_is_directory=True)
    _write_story_zip(data_root)

    result = _run_package_check(data_root)

    assert result.returncode == 1
    assert "resolves outside package root" in result.stderr
