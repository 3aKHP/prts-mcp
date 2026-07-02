from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

import pytest

from prts_mcp.data.item import (
    clear_item_caches,
    get_item_info,
    get_item_name_by_id,
    list_items,
    search_items,
)


def _write_sentinels(excel: Path) -> None:
    for fname in (
        "character_table.json",
        "handbook_info_table.json",
        "charword_table.json",
        "story_review_table.json",
    ):
        (excel / fname).write_text("{}", encoding="utf-8")


def _make_fixture(root: Path) -> None:
    excel = root / "zh_CN" / "gamedata" / "excel"
    excel.mkdir(parents=True, exist_ok=True)
    _write_sentinels(excel)
    (excel / "item_table.json").write_text(
        json.dumps(
            {
                "items": {
                    "30011": {
                        "itemId": "30011",
                        "name": "源岩",
                        "description": "常见于源石挥发殆尽后的地区。",
                        "rarity": "TIER_1",
                        "iconId": "MTL_SL_G1",
                        "sortId": 100040,
                        "usage": "可用于多种强化场合。",
                        "obtainApproach": None,
                        "hideInItemGet": False,
                        "classifyType": "MATERIAL",
                        "itemType": "MATERIAL",
                        "stageDropList": [
                            {"stageId": "main_00-01", "occPer": "ALWAYS", "sortId": 0},
                            {"stageId": "main_00-02", "occPer": "SOMETIMES", "sortId": 1},
                        ],
                        "buildingProductList": [],
                        "voucherRelateList": None,
                        "shopRelateInfoList": None,
                    },
                    "7001": {
                        "itemId": "7001",
                        "name": "招聘许可",
                        "description": "人事部颁发的许可书。",
                        "rarity": "TIER_4",
                        "iconId": "TKT_RECRUIT",
                        "sortId": 40012,
                        "usage": "可从公开渠道招聘一位干员。",
                        "obtainApproach": "采购中心、任务奖励",
                        "hideInItemGet": False,
                        "classifyType": "NORMAL",
                        "itemType": "TKT_RECRUIT",
                        "stageDropList": [],
                        "buildingProductList": [],
                        "voucherRelateList": None,
                        "shopRelateInfoList": [{"shopId": "credit", "itemId": "7001"}],
                    },
                    "hidden": {
                        "itemId": "hidden",
                        "name": "隐藏物品",
                        "hideInItemGet": True,
                        "classifyType": "NONE",
                        "itemType": "PLOT_ITEM",
                        "sortId": 1,
                    },
                    "dup-source-rock": {
                        "itemId": "dup-source-rock",
                        "name": "源岩",
                        "description": "重复名称条目不应覆盖先出现的物品。",
                        "hideInItemGet": True,
                        "classifyType": "NONE",
                        "itemType": "PLOT_ITEM",
                        "sortId": 2,
                    },
                }
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )


@pytest.fixture(autouse=True)
def _reset_caches() -> None:
    clear_item_caches()


@pytest.fixture
def gamedata() -> str:
    root = tempfile.mkdtemp(prefix="prts-item-test-")
    os.environ["GAMEDATA_PATH"] = root
    _make_fixture(Path(root))
    yield root
    clear_item_caches()
    os.environ.pop("GAMEDATA_PATH", None)


def test_list_items_default(gamedata: str) -> None:
    out = list_items()
    assert "物品列表" in out
    assert "源岩" in out
    assert "招聘许可" in out
    assert "隐藏物品" not in out
    assert "共 2 个" in out


def test_list_items_golden_default(gamedata: str) -> None:
    # Golden: exact full markdown. Hardcoded expectation (not a tautology),
    # catches build-layer field omissions, ordering, and label regressions.
    assert list_items() == (
        "# 物品列表（共 2 个）\n"
        "- **招聘许可** [普通/TKT_RECRUIT] T4（id: 7001） — 可从公开渠道招聘一位干员。\n"
        "- **源岩** [材料/MATERIAL] T1（id: 30011） — 可用于多种强化场合。\n"
        "\n"
        "（显示第 1–2 条，共 2 条。使用 offset=50 查看下一页）"
    )


def test_list_items_golden_category_filter(gamedata: str) -> None:
    assert list_items(category="MATERIAL") == (
        "# 物品列表：MATERIAL（共 1 个）\n"
        "- **源岩** [材料/MATERIAL] T1（id: 30011） — 可用于多种强化场合。\n"
        "\n"
        "（显示第 1–1 条，共 1 条。使用 offset=50 查看下一页）"
    )


def test_list_items_category_filter(gamedata: str) -> None:
    out = list_items(category="MATERIAL")
    assert "源岩" in out
    assert "招聘许可" not in out
    assert "共 1 个" in out


def test_get_item_info_by_name(gamedata: str) -> None:
    out = get_item_info("源岩")
    assert "# 源岩" in out
    assert "ID**：30011" in out
    assert "T1" in out
    assert "可用于多种强化场合" in out
    assert "main_00-01（固定）" in out
    assert "main_00-02（小概率）" in out


def test_get_item_info_golden(gamedata: str) -> None:
    # Golden: exact full markdown for 源岩 against the fixture. Stronger than
    # substring asserts — catches build-layer field omissions and
    # section-ordering regressions. Pattern copied from operator/enemy/stage.
    assert get_item_info("源岩") == (
        "# 源岩 — 物品信息\n\n"
        "## 基本信息\n"
        "- **ID**：30011\n"
        "- **稀有度**：T1\n"
        "- **分类**：材料\n"
        "- **类型**：MATERIAL\n"
        "- **图标**：MTL_SL_G1\n"
        "\n"
        "## 描述\n"
        "常见于源石挥发殆尽后的地区。\n"
        "\n"
        "## 用途\n"
        "可用于多种强化场合。\n"
        "\n"
        "## 掉落关卡\n"
        "- main_00-01（固定）\n"
        "- main_00-02（小概率）"
    )


def test_get_item_info_by_id(gamedata: str) -> None:
    out = get_item_info("7001")
    assert "招聘许可" in out
    assert "采购中心、任务奖励" in out
    assert "shopId=credit" in out


def test_get_item_name_by_id(gamedata: str) -> None:
    assert get_item_name_by_id("30011") == "源岩"
    assert get_item_name_by_id("missing") is None


def test_search_items(gamedata: str) -> None:
    out = search_items("公开渠道")
    assert "招聘许可" in out
    assert "搜索结果" in out


def test_search_items_invalid_regex(gamedata: str) -> None:
    out = search_items("[bad")
    assert "正则表达式无效" in out
