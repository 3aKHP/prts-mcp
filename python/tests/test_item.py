from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

import pytest

from prts_mcp.data.item import (
    build_item_info,
    build_item_search,
    build_items_listing,
    clear_item_caches,
    get_item_info,
    get_item_name_by_id,
    list_items,
    render_item_info,
    render_item_search,
    render_items_listing,
    search_items,
)
from prts_mcp.output import render_result


def _load_parity_fixture(name: str) -> dict:
    path = Path(__file__).parents[2] / "tests" / "parity-fixtures" / name
    return json.loads(path.read_text(encoding="utf-8"))


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
    assert build_items_listing() == _load_parity_fixture("list_items.json")


def test_list_items_golden_category_filter(gamedata: str) -> None:
    assert list_items(category="MATERIAL") == (
        "# 物品列表：MATERIAL（共 1 个）\n"
        "- **源岩** [材料/MATERIAL] T1（id: 30011） — 可用于多种强化场合。\n"
        "\n"
        "（显示第 1–1 条，共 1 条。使用 offset=50 查看下一页）"
    )


def test_list_items_empty_match_is_structured_not_error(gamedata: str) -> None:
    # Empty-result contract (P2b plan §3.4): a legitimate-but-empty result
    # (filter no-match) is a normal structured payload {total:0, items:[]},
    # NOT a content-only error — structured consumers can rely on it. The
    # content channel still emits the original "没有匹配" message verbatim.
    data = build_items_listing(category="NONEXISTENT")
    assert data == _load_parity_fixture("list_items_empty.json")
    # content stays byte-for-byte (the original message)
    assert list_items(category="NONEXISTENT") == "没有匹配的物品（category=NONEXISTENT）。"
    assert render_items_listing(data) == "没有匹配的物品（category=NONEXISTENT）。"
    # structured channel carries the empty payload
    r = render_result(data, list_items(category="NONEXISTENT"), channel="structured")
    assert r.structured_content == data


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
    data = build_item_info("源岩")
    assert data == _load_parity_fixture("item_info.json")
    assert render_item_info(data) == get_item_info("源岩")


def test_get_item_info_by_id(gamedata: str) -> None:
    out = get_item_info("7001")
    assert "招聘许可" in out
    assert "采购中心、任务奖励" in out
    assert "shopId=credit" in out


def test_get_item_info_missing_optional_lists_are_null(gamedata: str) -> None:
    data = build_item_info("隐藏物品")
    assert isinstance(data, dict)
    assert data["building_product_list"] is None
    assert data["shop_relate_list"] is None
    assert data["voucher_relate_list"] is None


def test_get_item_name_by_id(gamedata: str) -> None:
    assert get_item_name_by_id("30011") == "源岩"
    assert get_item_name_by_id("missing") is None


def test_search_items_structured_golden(gamedata: str) -> None:
    data = build_item_search("公开渠道")
    assert isinstance(data, dict)
    assert data == _load_parity_fixture("search_items.json")
    expected = (
        "# 搜索结果：公开渠道（共 1 个）\n\n"
        "## 招聘许可 [普通/TKT_RECRUIT] T4（id: 7001）\n"
        "- **用途**：可从公开渠道招聘一位干员。\n"
        "- **获取方式**：采购中心、任务奖励"
    )
    assert render_item_search(data) == expected
    assert search_items("公开渠道") == expected
    r = render_result(data, expected, channel="both")
    assert r.structured_content == data


def test_search_items_no_match_is_structured_empty(gamedata: str) -> None:
    data = build_item_search("绝对不存在的物品")
    assert data == {
        "scope": "items",
        "pattern": "绝对不存在的物品",
        "total": 0,
        "results": [],
    }
    expected = "未找到匹配 '绝对不存在的物品' 的物品。"
    assert render_item_search(data) == expected
    assert search_items("绝对不存在的物品") == expected
    r = render_result(data, expected, channel="structured")
    assert r.structured_content == data
    assert build_item_search("ZZZZNOMATCH") == _load_parity_fixture(
        "search_items_empty.json"
    )


def test_search_items_invalid_regex(gamedata: str) -> None:
    out = search_items("[bad")
    assert "正则表达式无效" in out
