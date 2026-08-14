from __future__ import annotations

import json
import zipfile

from prts_mcp.data.datasets import GAMEDATA_EXCEL, GAMEDATA_LEVELS, STORY_ZH_CN


def test_gamedata_excel_requires_current_public_tool_tables():
    assert "zh_CN/gamedata/excel/enemy_handbook_table.json" in GAMEDATA_EXCEL.required_files
    assert "zh_CN/gamedata/excel/item_table.json" in GAMEDATA_EXCEL.required_files
    assert "zh_CN/gamedata/excel/stage_table.json" in GAMEDATA_EXCEL.required_files
    assert "zh_CN/gamedata/excel/building_data.json" in GAMEDATA_EXCEL.required_files
    assert "zh_CN/gamedata/excel/skin_table.json" in GAMEDATA_EXCEL.required_files


def test_gamedata_levels_spec_requires_enemy_database():
    assert GAMEDATA_LEVELS.dataset_id == "gamedata.levels"
    assert GAMEDATA_LEVELS.asset_name == "zh_CN-levels.zip"
    assert GAMEDATA_LEVELS.required_files == (
        "zh_CN/gamedata/levels/enemydata/enemy_database.json",
    )


def test_storyjson_zip_requires_referenced_story_files(tmp_path):
    zip_path = tmp_path / "zh_CN.zip"
    story_key = "activities/act_test/level_act_test_01_beg"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("zh_CN/storyinfo.json", "{}")
        zf.writestr(
            "zh_CN/gamedata/excel/story_review_table.json",
            json.dumps(
                {
                    "act_test": {
                        "infoUnlockDatas": [
                            {"storyTxt": story_key},
                        ],
                    },
                }
            ),
        )

    assert STORY_ZH_CN.validate_zip(zip_path) == [
        f"zh_CN/gamedata/story/{story_key}.json",
    ]


def test_storyjson_zip_accepts_required_metadata_and_story_files(tmp_path):
    zip_path = tmp_path / "zh_CN.zip"
    story_key = "activities/act_test/level_act_test_01_beg"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("zh_CN/storyinfo.json", "{}")
        zf.writestr(
            "zh_CN/gamedata/excel/story_review_table.json",
            json.dumps(
                {
                    "act_test": {
                        "infoUnlockDatas": [
                            {"storyTxt": story_key},
                        ],
                    },
                }
            ),
        )
        zf.writestr(f"zh_CN/gamedata/story/{story_key}.json", "{}")

    assert STORY_ZH_CN.validate_zip(zip_path) == []
