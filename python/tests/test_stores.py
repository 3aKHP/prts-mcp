from __future__ import annotations

import json
import zipfile
from pathlib import Path

import pytest

from prts_mcp.data.stores import DirectoryStore, FallbackStore, ZipStore


FIXTURE_PATH = "zh_CN/gamedata/excel/sample.json"
FIXTURE_DATA = {"name": "阿米娅", "rarity": 5}


def write_fixture_dir(root: Path, data: dict = FIXTURE_DATA) -> None:
    target = root / FIXTURE_PATH
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def write_fixture_zip(path: Path, data: dict = FIXTURE_DATA) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr(FIXTURE_PATH, json.dumps(data, ensure_ascii=False))


class TestDirectoryStore:
    def test_reads_json_from_directory(self, tmp_path):
        write_fixture_dir(tmp_path)
        store = DirectoryStore(tmp_path)

        assert store.exists(FIXTURE_PATH)
        assert "阿米娅" in store.read_text(FIXTURE_PATH)
        assert store.read_json(FIXTURE_PATH) == FIXTURE_DATA
        assert store.describe().startswith("directory:")

    def test_missing_file_raises(self, tmp_path):
        store = DirectoryStore(tmp_path)

        assert not store.exists(FIXTURE_PATH)
        with pytest.raises(FileNotFoundError):
            store.read_text(FIXTURE_PATH)

    def test_rejects_parent_path(self, tmp_path):
        store = DirectoryStore(tmp_path)

        with pytest.raises(ValueError):
            store.exists("../outside.json")


class TestZipStore:
    def test_reads_json_from_zip(self, tmp_path):
        zip_path = tmp_path / "fixture.zip"
        write_fixture_zip(zip_path)
        store = ZipStore(zip_path)

        assert store.exists(FIXTURE_PATH)
        assert "阿米娅" in store.read_text(FIXTURE_PATH)
        assert store.read_json(FIXTURE_PATH) == FIXTURE_DATA
        assert store.describe().startswith("zip:")

    def test_missing_entry_raises(self, tmp_path):
        zip_path = tmp_path / "fixture.zip"
        write_fixture_zip(zip_path)
        store = ZipStore(zip_path)

        assert not store.exists("zh_CN/missing.json")
        with pytest.raises(FileNotFoundError):
            store.read_text("zh_CN/missing.json")

    def test_rejects_parent_path(self, tmp_path):
        store = ZipStore(tmp_path / "fixture.zip")

        with pytest.raises(ValueError):
            store.exists("../outside.json")


class TestFallbackStore:
    def test_prefers_primary_store(self, tmp_path):
        primary = tmp_path / "primary"
        fallback = tmp_path / "fallback"
        write_fixture_dir(primary, {"source": "primary"})
        write_fixture_dir(fallback, {"source": "fallback"})

        store = FallbackStore(DirectoryStore(primary), DirectoryStore(fallback))

        assert store.exists(FIXTURE_PATH)
        assert store.read_json(FIXTURE_PATH) == {"source": "primary"}
        assert store.describe().startswith("fallback:")

    def test_reads_fallback_when_primary_missing(self, tmp_path):
        primary = tmp_path / "primary"
        fallback = tmp_path / "fallback"
        write_fixture_dir(fallback, {"source": "fallback"})

        store = FallbackStore(DirectoryStore(primary), DirectoryStore(fallback))

        assert store.exists(FIXTURE_PATH)
        assert store.read_json(FIXTURE_PATH) == {"source": "fallback"}

    def test_missing_in_both_raises(self, tmp_path):
        store = FallbackStore(
            DirectoryStore(tmp_path / "primary"),
            DirectoryStore(tmp_path / "fallback"),
        )

        assert not store.exists(FIXTURE_PATH)
        with pytest.raises(FileNotFoundError):
            store.read_text(FIXTURE_PATH)

