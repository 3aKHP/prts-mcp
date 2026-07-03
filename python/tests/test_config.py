"""Tests for prts_mcp.config — storyjson zip path resolution."""
from __future__ import annotations

import os
from unittest.mock import patch

import prts_mcp.config as config_module
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
        missing_default = tmp_path / "storyjson" / "zh_CN.zip"
        missing_docker = tmp_path / "docker" / "zh_CN.zip"
        missing_bundled = tmp_path / "bundled" / "zh_CN.zip"
        with patch.dict(os.environ, {"GAMEDATA_PATH": str(tmp_path)}, clear=True):
            with patch.object(config_module, "_DEFAULT_STORYJSON_ZIP", missing_default):
                with patch.object(config_module, "_DOCKER_STORYJSON_ZIP", missing_docker):
                    with patch.object(config_module, "_BUNDLED_STORYJSON_ZIP", missing_bundled):
                        cfg = Config.load()

        assert cfg.effective_storyjson_zip is None
        assert cfg.has_story_data is False


class TestEffectiveLevelsPath:
    def test_custom_gamedata_uses_embedded_levels_when_present(self, tmp_path):
        levels = tmp_path / "custom" / "zh_CN" / "gamedata" / "levels" / "enemydata"
        levels.mkdir(parents=True)
        (levels / "enemy_database.json").write_text("{}", encoding="utf-8")

        with patch.dict(
            os.environ,
            {"GAMEDATA_PATH": str(tmp_path / "custom"), "PRTS_MCP_ROOT": "/app"},
            clear=False,
        ):
            cfg = Config.load()

        assert cfg.levels_path == tmp_path / "custom"
        assert cfg.effective_levels_path == tmp_path / "custom"
        assert cfg.has_levels_data is True

    def test_custom_gamedata_without_embedded_levels_uses_sibling_path(self, tmp_path):
        with patch.dict(
            os.environ,
            {"GAMEDATA_PATH": str(tmp_path / "custom"), "PRTS_MCP_ROOT": "/app"},
            clear=False,
        ):
            cfg = Config.load()

        assert cfg.levels_path == tmp_path / "gamedata-levels"
        assert cfg.effective_levels_path is None
        assert cfg.has_levels_data is False
