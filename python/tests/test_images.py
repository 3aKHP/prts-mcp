"""Tests for image artwork index parsing, labels and the operator_artwork tool."""
from __future__ import annotations

import asyncio
import base64
import json

import pytest

from prts_mcp.data.images import SCHEMA_VERSION, build_artwork_label, parse_index
import prts_mcp.output as output_module
from prts_mcp.tools_artwork import _do_get, _do_get_mediawiki, _do_list

# A 1x1 transparent PNG used as a stand-in image payload.
_SAMPLE_PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9aw"
    "AAAABJRU5ErkJggg=="
)


def _sample_index(include_foreign: bool = False) -> dict:
    index = {
        "schemaVersion": SCHEMA_VERSION,
        "baselineVersion": "b1",
        "currentVersion": "c1",
        "shards": {"chararts-large": "chararts-large.zip"},
        "artworks": {
            "char_002_amiya#1": {
                "kind": "base",
                "shard": "chararts",
                "large": {
                    "file": "amiya_1.large.png",
                    "w": 1024,
                    "h": 1100,
                    "bytes": 50,
                    "sha256": "h1",
                },
                "preview": {
                    "file": "amiya_1.preview.png",
                    "w": 256,
                    "h": 275,
                    "bytes": 20,
                    "sha256": "h2",
                },
            },
            "char_002_amiya@winter#1": {
                "kind": "skin",
                "shard": "skinpack",
                "large": {
                    "file": "amiya_winter.large.png",
                    "w": 1024,
                    "h": 1024,
                    "bytes": 60,
                    "sha256": "h3",
                },
            },
        },
    }
    if include_foreign:
        index["artworks"]["char_263_skadi#1"] = {
            "kind": "base",
            "shard": "chararts",
            "large": {
                "file": "amiya_1.large.png",
                "w": 1024,
                "h": 1100,
                "bytes": 50,
                "sha256": "h4",
            },
        }
    return index


def _add_amiya_form_artworks(index: dict) -> None:
    artworks = index["artworks"]
    for char_id, filename in (
        ("char_1001_amiya2", "amiya_guard.large.png"),
        ("char_1037_amiya3", "amiya_medic.large.png"),
    ):
        artworks[f"{char_id}#1"] = {
            "kind": "base",
            "shard": "chararts",
            "large": {
                "file": filename,
                "w": 1024,
                "h": 1100,
                "bytes": 50,
                "sha256": char_id,
            },
        }


# ---------------------------------------------------------------------------
# parse_index
# ---------------------------------------------------------------------------


def test_parse_index_accepts_valid_schema():
    idx = parse_index(_sample_index())
    assert idx is not None
    assert idx.baseline_version == "b1"
    assert idx.current_version == "c1"
    assert idx.shards == {"chararts-large": "chararts-large.zip"}
    entry = idx.artworks["char_002_amiya#1"]
    assert entry.kind == "base"
    assert entry.shard == "chararts"
    assert entry.variant("large").file == "amiya_1.large.png"
    assert entry.variant("original") is None
    assert entry.available_variants() == ("large", "preview")


def test_parse_index_rejects_unknown_schema():
    assert parse_index({"schemaVersion": "other"}) is None


def test_parse_index_skips_artworks_without_variants():
    raw = _sample_index()
    raw["artworks"]["char_002_amiya#2"] = {"kind": "base", "shard": "chararts"}
    idx = parse_index(raw)
    assert idx is not None
    assert "char_002_amiya#2" not in idx.artworks


# ---------------------------------------------------------------------------
# build_artwork_label
# ---------------------------------------------------------------------------


def test_build_artwork_labels():
    char_skins = {
        "char_002_amiya@winter#1": {"displaySkin": {"skinName": "报童"}},
    }
    assert build_artwork_label("char_002_amiya#1", char_skins) == "精英零立绘"
    assert build_artwork_label("char_002_amiya#1+", char_skins) == "精英零立绘（变体）"
    assert build_artwork_label("char_002_amiya#2", char_skins) == "精英二立绘"
    assert build_artwork_label("char_002_amiya@winter#1", char_skins) == "报童"
    # Unknown fashion theme falls back to a theme-derived placeholder.
    assert build_artwork_label("char_002_amiya@unknown#1", char_skins) == "时装（unknown）"
    # Unknown base illust number gets a tolerant label.
    assert build_artwork_label("char_002_amiya#5", char_skins) == "立绘 5"


# ---------------------------------------------------------------------------
# operator_artwork list / get
# ---------------------------------------------------------------------------


@pytest.fixture
def mock_images(monkeypatch, tmp_path):
    """Stand up a fake active generation directory with index.json + PNGs."""
    monkeypatch.setenv("LOCAL_IMAGE", "true")
    gen = tmp_path / "gen"
    gen.mkdir()
    (gen / "index.json").write_text(json.dumps(_sample_index()), "utf-8")
    png = base64.b64decode(_SAMPLE_PNG_B64)
    for name in ("amiya_1.large.png", "amiya_1.preview.png", "amiya_winter.large.png"):
        (gen / name).write_bytes(png)

    monkeypatch.setattr(
        "prts_mcp.tools_artwork._images_generation", lambda: gen,
    )
    monkeypatch.setattr(
        "prts_mcp.tools_artwork.resolve_char_id",
        lambda name: "char_002_amiya" if name == "阿米娅" else None,
    )
    monkeypatch.setattr(
        "prts_mcp.tools_artwork.load_char_skins",
        lambda: {"char_002_amiya@winter#1": {"displaySkin": {"skinName": "报童"}}},
    )
    return gen


def test_list_returns_markdown_with_labels(mock_images):
    result = asyncio.run(_do_list("阿米娅"))
    assert result.is_error is False
    assert result.structured_content is None  # default channel = content
    text_blocks = [c for c in result.content if c.type == "text"]
    assert len(text_blocks) == 1
    body = text_blocks[0].text
    assert "阿米娅" in body
    assert "精英零立绘" in body
    assert "报童" in body
    # No image content in list.
    assert not any(c.type == "image" for c in result.content)


def test_list_structured_channel(mock_images):
    # test_output reloads the module when exercising import-time environment
    # parsing, so access the current ContextVar through the module rather than
    # retaining a stale imported instance.
    token = output_module._channel_var.set("structured")
    try:
        result = asyncio.run(_do_list("阿米娅"))
    finally:
        output_module._channel_var.reset(token)
    data = result.structured_content
    assert data is not None
    assert data["operator_name"] == "阿米娅"
    assert data["char_id"] == "char_002_amiya"
    assert data["total"] == 2
    labels = {a["label"] for a in data["artworks"]}
    assert "精英零立绘" in labels
    assert "报童" in labels


def test_list_unknown_operator(mock_images):
    result = asyncio.run(_do_list("不存在"))
    text = result.content[0].text
    assert "找不到" in text


@pytest.mark.parametrize(
    ("operator_name", "expected_char_id"),
    [
        ("阿米娅(近卫)", "char_1001_amiya2"),
        ("阿米娅(医疗)", "char_1037_amiya3"),
    ],
)
def test_list_resolves_amiya_artwork_form_aliases(
    mock_images, operator_name, expected_char_id,
):
    index = _sample_index()
    _add_amiya_form_artworks(index)
    (mock_images / "index.json").write_text(json.dumps(index), "utf-8")

    result = asyncio.run(_do_list(operator_name))

    body = result.content[0].text
    assert expected_char_id in body
    assert "char_002_amiya#1" not in body


def test_get_rejects_opaque_artwork_token_from_another_amiya_form(mock_images):
    index = _sample_index()
    _add_amiya_form_artworks(index)
    (mock_images / "index.json").write_text(json.dumps(index), "utf-8")

    result = asyncio.run(
        _do_get("阿米娅(医疗)", "char_1001_amiya2#1", "large")
    )

    assert "不属于" in result.content[0].text
    assert not any(block.type == "image" for block in result.content)


def test_get_returns_image_content(mock_images):
    result = asyncio.run(_do_get("阿米娅", "char_002_amiya#1", "large"))
    assert result.is_error is False
    image_blocks = [c for c in result.content if c.type == "image"]
    assert len(image_blocks) == 1
    assert image_blocks[0].mime_type == "image/png"
    # Pure base64 (no data: prefix) that decodes to the fixture PNG.
    assert image_blocks[0].data == _SAMPLE_PNG_B64
    text_blocks = [c for c in result.content if c.type == "text"]
    assert any("精英零立绘" in t.text for t in text_blocks)


def test_get_default_variant_is_large(mock_images):
    result = asyncio.run(_do_get("阿米娅", "char_002_amiya#1", None))
    image_blocks = [c for c in result.content if c.type == "image"]
    assert len(image_blocks) == 1


def test_get_missing_artwork_id(mock_images):
    result = asyncio.run(_do_get("阿米娅", "char_999_nonexistent#1", "large"))
    text = result.content[0].text
    assert "找不到" in text
    assert not any(c.type == "image" for c in result.content)


def test_get_rejects_artwork_owned_by_another_operator(mock_images):
    (mock_images / "index.json").write_text(
        json.dumps(_sample_index(include_foreign=True)), "utf-8",
    )
    result = asyncio.run(_do_get("阿米娅", "char_263_skadi#1", "large"))
    assert "不属于" in result.content[0].text
    assert not any(c.type == "image" for c in result.content)


def test_mediawiki_get_rejects_mismatched_filename_before_network(monkeypatch):
    import prts_mcp.tools_artwork as artwork
    from prts_mcp.config import Config

    monkeypatch.setenv("LOCAL_IMAGE", "false")

    async def unexpected_imageinfo(*_args, **_kwargs):
        raise AssertionError("ownership validation must run before imageinfo")

    monkeypatch.setattr(artwork, "_get_imageinfo", unexpected_imageinfo)
    result = asyncio.run(_do_get_mediawiki(
        "阿米娅", "立绘_斯卡蒂_2.png", "large", Config.load(),
    ))
    assert "不属于" in result.content[0].text
    assert not any(c.type == "image" for c in result.content)


def test_get_unavailable_variant(mock_images):
    # char_002_amiya@winter#1 only has large, not preview.
    result = asyncio.run(_do_get("阿米娅", "char_002_amiya@winter#1", "preview"))
    text = result.content[0].text
    assert "不提供" in text
    assert not any(c.type == "image" for c in result.content)


def test_get_without_artwork_id(mock_images):
    result = asyncio.run(_do_get("阿米娅", None, "large"))
    text = result.content[0].text
    assert "artwork_id" in text
