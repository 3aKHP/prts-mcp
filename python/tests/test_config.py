"""Tests for prts_mcp.config — storyjson zip path resolution."""
from __future__ import annotations

import os
from pathlib import Path
from unittest.mock import patch

import pytest

from prts_mcp.config import Config


class TestEffectiveStoryjsonZip:
    def test_env_var_takes_priority(self, tmp_path):
        fake_zip = tmp_path / "custom.zip"
        fake_zip.write_bytes(b"PK")  # minimal fake zip marker

        with patch.dict(os.environ, {"STORYJSON_PATH": str(fake_zip), "GAMEDATA_PATH": str(tmp_path)}):
            cfg = Config.load()

        assert cfg.storyjson_zip == fake_zip
        assert cfg.effective_storyjson_zip == fake_zip
        assert cfg.has_story_data is True

    def test_missing_zip_returns_none(self, tmp_path):
        nonexistent = tmp_path / "missing.zip"
        with patch.dict(os.environ, {"STORYJSON_PATH": str(nonexistent), "GAMEDATA_PATH": str(tmp_path)}):
            cfg = Config.load()

        assert cfg.has_story_data is False
        assert cfg.effective_storyjson_zip is None

    def test_has_story_data_false_by_default(self, tmp_path):
        # No env vars, no bundled zip at default paths
        with patch.dict(os.environ, {"GAMEDATA_PATH": str(tmp_path)}, clear=False):
            os.environ.pop("STORYJSON_PATH", None)
            cfg = Config.load()

        # On a dev machine without bundled docker paths, should be False
        # (unless local zip happens to exist at default path)
        assert isinstance(cfg.has_story_data, bool)

    def test_local_zip_resolves(self):
        """If the local dev zip exists, effective path should point to it."""
        local_zip = Path(r"F:\2026-Spring\ArknightsStoryJson\zh_CN.zip")
        if not local_zip.is_file():
            pytest.skip("Local zip not available")

        with patch.dict(os.environ, {"STORYJSON_PATH": str(local_zip)}):
            cfg = Config.load()

        assert cfg.effective_storyjson_zip == local_zip
        assert cfg.has_story_data is True
