"""Tests for images_sync round-trip behavior (discovery mocked).

These guard the meta read/write key consistency and the atomic-activation
invariants that a single-shot E2E cannot exercise.
"""
from __future__ import annotations

import json
from pathlib import Path
from zipfile import ZipFile

import pytest

from prts_mcp.data.images import SCHEMA_VERSION
from prts_mcp.data.images_sync import _active_generation, needed_shard_keys, sync_images


def _make_index(baseline: str = "b1", current: str = "c1") -> dict:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "baselineVersion": baseline,
        "currentVersion": current,
        "shards": {f"{s}-{v}": f"images-baseline-{s}-{v}-{baseline}.zip"
                   for s in ("chararts", "skinpack")
                   for v in ("original", "large", "preview")},
        "artworks": {},
    }


def _setup_mocks(monkeypatch, *, current: str = "c1", baseline: str = "b1",
                 delta_fails: bool = False) -> dict:
    """Mock discovery + downloads; return a call counter."""
    calls = {"large": 0}
    releases = [{
        "tag_name": f"images-{current}",
        "created_at": "2026-08-06T00:56:29Z",
        "assets": [
            {"name": "index.json",
             "browser_download_url": f"https://ex/{current}/index.json"},
            {"name": f"images-delta-{current}.zip",
             "browser_download_url": f"https://ex/{current}/delta.zip"},
        ],
    }]

    monkeypatch.setattr(
        "prts_mcp.data.images_sync._list_releases",
        lambda owner, repo, *, timeout=10.0: releases,
    )
    monkeypatch.setattr(
        "prts_mcp.data.images_sync._download_small",
        lambda url, *, timeout=30.0: json.dumps(_make_index(baseline, current)).encode("utf-8")
        if "index.json" in url else None,
    )

    def mock_download_large(url: str, dest: Path, *, timeout: float = 300.0) -> None:
        calls["large"] += 1
        if delta_fails and "delta" in url:
            raise RuntimeError("delta download failed")
        dest.parent.mkdir(parents=True, exist_ok=True)
        with ZipFile(dest, "w"):  # empty zip — extracts nothing
            pass

    monkeypatch.setattr("prts_mcp.data.images_sync._download_large", mock_download_large)
    return calls


def test_sync_first_updated_then_up_to_date(tmp_path, monkeypatch):
    """Regression guard: meta read/write keys must match.

    A key mismatch (write camelCase, read snake_case) would make the second
    sync re-download everything instead of returning up_to_date.
    """
    image_dir = tmp_path / "images"
    calls = _setup_mocks(monkeypatch)

    r1 = sync_images(image_dir, include_original=False, force_check=True)
    assert r1.status == "updated"
    assert r1.commit_sha == "c1"
    first = calls["large"]
    assert first == len(needed_shard_keys(False)) + 1  # shards + delta

    r2 = sync_images(image_dir, include_original=False, force_check=True)
    assert r2.status == "up_to_date", "same versions must be up_to_date"
    assert calls["large"] == first, "up_to_date must not re-download"


def test_sync_original_image_switch_triggers_rebuild(tmp_path, monkeypatch):
    """ORIGINAL_IMAGE false→true changes the shard set; must rebuild, not shortcut."""
    image_dir = tmp_path / "images"
    calls = _setup_mocks(monkeypatch)

    sync_images(image_dir, include_original=False, force_check=True)
    first = calls["large"]

    r2 = sync_images(image_dir, include_original=True, force_check=True)
    assert r2.status == "updated", "shard set change must trigger rebuild"
    assert calls["large"] > first


def test_sync_delta_failure_does_not_activate(tmp_path, monkeypatch):
    """A delta download failure must not leave a broken generation active."""
    image_dir = tmp_path / "images"
    _setup_mocks(monkeypatch, delta_fails=True)

    r = sync_images(image_dir, include_original=False, force_check=True)
    assert r.status == "no_data", "delta failure with no prior generation → no_data"
    assert _active_generation(image_dir) is None


def test_sync_offline_falls_back_to_existing(tmp_path, monkeypatch):
    """Network failure after a successful sync returns offline_fallback."""
    image_dir = tmp_path / "images"
    calls = _setup_mocks(monkeypatch)
    sync_images(image_dir, include_original=False, force_check=True)

    # Simulate network loss on the next cycle.
    monkeypatch.setattr(
        "prts_mcp.data.images_sync._list_releases",
        lambda owner, repo, *, timeout=10.0: None,
    )
    r = sync_images(image_dir, include_original=False, force_check=True)
    assert r.status == "offline_fallback"
    assert r.commit_sha == "c1"
    assert _active_generation(image_dir) is not None


def test_verify_variant_hashes_passes_on_match(tmp_path):
    """#100: a variant whose PNG matches its index sha256 verifies cleanly."""
    import hashlib
    from prts_mcp.data.images import parse_index
    from prts_mcp.data.images_sync import _verify_variant_hashes

    png = tmp_path / "chararts" / "test_large.png"
    png.parent.mkdir(parents=True)
    content = b"\x89PNG\r\n\x1a\nfake"
    png.write_bytes(content)

    index = parse_index({
        "schemaVersion": SCHEMA_VERSION,
        "baselineVersion": "b1",
        "currentVersion": "c1",
        "shards": {},
        "artworks": {
            "test_skin": {
                "kind": "base",
                "large": {
                    "file": "chararts/test_large.png",
                    "sha256": hashlib.sha256(content).hexdigest(),
                    "w": 1024,
                    "h": 1024,
                    "bytes": 100,
                },
            },
        },
    })
    assert index is not None
    _verify_variant_hashes(tmp_path, index, ("chararts-large",))  # no raise


def test_verify_variant_hashes_rejects_mismatch(tmp_path):
    """#100: a corrupted shard must not pass sha256 verification."""
    from prts_mcp.data.images import parse_index
    from prts_mcp.data.images_sync import _verify_variant_hashes

    png = tmp_path / "chararts" / "test_large.png"
    png.parent.mkdir(parents=True)
    png.write_bytes(b"\x89PNG\r\n\x1a\nfake")

    index = parse_index({
        "schemaVersion": SCHEMA_VERSION,
        "baselineVersion": "b1",
        "currentVersion": "c1",
        "shards": {},
        "artworks": {
            "test_skin": {
                "kind": "base",
                "large": {
                    "file": "chararts/test_large.png",
                    "sha256": "0" * 64,
                    "w": 1024,
                    "h": 1024,
                    "bytes": 100,
                },
            },
        },
    })
    assert index is not None
    with pytest.raises(ValueError, match="sha256 verification failed"):
        _verify_variant_hashes(tmp_path, index, ("chararts-large",))
