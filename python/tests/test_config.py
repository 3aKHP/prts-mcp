"""Tests for prts_mcp.config — storyjson zip path resolution."""
from __future__ import annotations

import json
import os
import threading
from unittest.mock import patch

import prts_mcp.config as config_module
from prts_mcp.config import Config, activation_aware_cache, activation_snapshot


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


class TestActivatedDataRoot:
    def test_effective_excel_path_uses_activated_release(self, tmp_path):
        root = tmp_path / "gamedata"
        activated = root / ".releases" / "abc123"
        excel = activated / "zh_CN" / "gamedata" / "excel"
        excel.mkdir(parents=True)
        for name in config_module._REQUIRED_OPERATOR_FILES:
            (excel / name).write_text("{}", encoding="utf-8")
        archives = root / "archives"
        archives.mkdir()
        (archives / "extract_meta.json").write_text(
            json.dumps({
                "commit_sha": "abc123",
                "data_root": ".releases/abc123",
            }),
            encoding="utf-8",
        )

        with patch.dict(os.environ, {"GAMEDATA_PATH": str(root)}):
            cfg = Config.load()

        assert cfg.excel_path == root / "zh_CN" / "gamedata" / "excel"
        assert cfg.effective_excel_path == excel

    def test_late_old_generation_load_cannot_replace_current_cache(self, tmp_path):
        root = tmp_path / "gamedata"
        archives = root / "archives"
        archives.mkdir(parents=True)
        for name in ("first", "second"):
            generation = root / ".releases" / name
            generation.mkdir(parents=True)
        metadata = archives / "extract_meta.json"

        def activate(name: str) -> None:
            tmp = archives / f"{name}.tmp"
            tmp.write_text(
                json.dumps({"commit_sha": name, "data_root": f".releases/{name}"}),
                encoding="utf-8",
            )
            tmp.replace(metadata)

        selected = threading.Event()
        release_old = threading.Event()
        block_first = True

        @activation_aware_cache(maxsize=2)
        def selected_root() -> str:
            nonlocal block_first
            value = str(config_module._activated_root(root))
            if block_first:
                block_first = False
                selected.set()
                release_old.wait(timeout=5)
            return value

        activate("first")
        with patch.dict(os.environ, {"GAMEDATA_PATH": str(root)}):
            thread_result: list[str] = []
            thread = threading.Thread(target=lambda: thread_result.append(selected_root()))
            thread.start()
            assert selected.wait(timeout=5)
            activate("second")
            assert selected_root().endswith("/.releases/second")
            release_old.set()
            thread.join(timeout=5)

            assert thread_result[0].endswith("/.releases/first")
            assert selected_root().endswith("/.releases/second")

    def test_activation_snapshot_keeps_multi_table_read_on_one_generation(self, tmp_path):
        root = tmp_path / "gamedata"
        archives = root / "archives"
        archives.mkdir(parents=True)
        for name in ("first", "second"):
            excel = root / ".releases" / name / "zh_CN" / "gamedata" / "excel"
            excel.mkdir(parents=True)
            for filename in config_module._REQUIRED_OPERATOR_FILES:
                (excel / filename).write_text("{}", encoding="utf-8")
        metadata = archives / "extract_meta.json"

        def activate(name: str) -> None:
            tmp = archives / f"{name}.tmp"
            tmp.write_text(
                json.dumps({"commit_sha": name, "data_root": f".releases/{name}"}),
                encoding="utf-8",
            )
            tmp.replace(metadata)

        selected = threading.Event()
        release_read = threading.Event()

        @activation_snapshot
        def read_twice() -> tuple[object, object]:
            first = Config.load().effective_excel_path
            selected.set()
            release_read.wait(timeout=5)
            return first, Config.load().effective_excel_path

        activate("first")
        with patch.dict(os.environ, {"GAMEDATA_PATH": str(root)}):
            result: list[tuple[object, object]] = []
            thread = threading.Thread(target=lambda: result.append(read_twice()))
            thread.start()
            assert selected.wait(timeout=5)
            activate("second")
            release_read.set()
            thread.join(timeout=5)

            assert result[0][0] == result[0][1]
            assert str(result[0][0]).endswith("/.releases/first/zh_CN/gamedata/excel")
            assert str(Config.load().effective_excel_path).endswith(
                "/.releases/second/zh_CN/gamedata/excel"
            )
