"""Unit tests for the local artwork backend (data/artwork_local)."""
from __future__ import annotations

import base64
import json
import os

import pytest

from prts_mcp.data.artwork_local import (
    char_id_of,
    get_artwork_local,
    list_artworks_local,
    normalized_artwork_form_name,
    resolve_artwork_char_id,
)
from prts_mcp.data.images import SCHEMA_VERSION

_PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lQVXR42mNk+M9QDwADhgGAWjR9aw"
    "AAAABJRU5ErkJggg=="
)


@pytest.fixture
def gen_dir(tmp_path, monkeypatch):
    gen = tmp_path / "gen"
    gen.mkdir()
    (gen / "index.json").write_text(json.dumps({
        "schemaVersion": SCHEMA_VERSION,
        "baselineVersion": "b1",
        "currentVersion": "c1",
        "shards": {},
        "artworks": {
            "char_002_amiya#1": {
                "kind": "base",
                "shard": "chararts",
                "large": {
                    "file": "amiya_1.large.png", "w": 1024, "h": 1100,
                    "bytes": 50, "sha256": "h1",
                },
                "preview": {
                    "file": "escape.png", "w": 256, "h": 275,
                    "bytes": 20, "sha256": "h2",
                },
            },
        },
    }), "utf-8")
    (gen / "amiya_1.large.png").write_bytes(base64.b64decode(_PNG_B64))
    # The preview entry is a symlink pointing outside the generation dir —
    # lexically contained, realpath-escaped; the guard must reject it.
    secret = tmp_path / "secret.png"
    secret.write_bytes(b"host-secret")
    os.symlink(secret, gen / "escape.png")

    monkeypatch.setattr(
        "prts_mcp.data.artwork_local.resolve_char_id",
        lambda name: "char_002_amiya" if name == "阿米娅" else None,
    )
    monkeypatch.setattr("prts_mcp.data.artwork_local.load_char_skins", lambda: {})
    return gen


def test_char_id_of_shapes():
    assert char_id_of("char_002_amiya#1+") == "char_002_amiya"
    assert char_id_of("char_002_amiya@epoque#4") == "char_002_amiya"


def test_form_alias_resolution(monkeypatch):
    # The alias table is consulted before the operator table, so even when
    # resolve_char_id knows nothing, the two Amiya forms resolve.
    monkeypatch.setattr(
        "prts_mcp.data.artwork_local.resolve_char_id", lambda _name: None,
    )
    assert normalized_artwork_form_name("阿米娅（近卫）") == "阿米娅(近卫)"
    assert resolve_artwork_char_id("阿米娅(近卫)") == "char_1001_amiya2"
    assert resolve_artwork_char_id("阿米娅（医疗）") == "char_1037_amiya3"
    assert resolve_artwork_char_id("未知干员") is None


def test_list_filters_by_char_id_and_renders(gen_dir):
    outcome = list_artworks_local("阿米娅", gen_dir)
    assert not isinstance(outcome, str)
    assert outcome.data["char_id"] == "char_002_amiya"
    assert outcome.data["total"] == 1
    assert "char_002_amiya#1" in outcome.markdown


def test_list_messages(gen_dir):
    assert "找不到干员" in list_artworks_local("不存在", gen_dir)
    assert "立绘数据未就绪" in list_artworks_local("阿米娅", None)


def test_get_serves_contained_file(gen_dir):
    outcome = get_artwork_local("阿米娅", "char_002_amiya#1", "large", gen_dir)
    assert not isinstance(outcome, str)
    assert outcome.image_b64 == _PNG_B64
    assert outcome.mime == "image/png"
    assert outcome.data["variant"] == "large"


def test_get_rejects_symlink_escape(gen_dir):
    outcome = get_artwork_local("阿米娅", "char_002_amiya#1", "preview", gen_dir)
    assert isinstance(outcome, str)
    assert "图片文件缺失" in outcome
