"""Tests for images_sync round-trip behavior (discovery mocked).

These guard the meta read/write key consistency and the atomic-activation
invariants that a single-shot E2E cannot exercise.
"""
from __future__ import annotations

import hashlib
import inspect
import json
from collections import Counter
from pathlib import Path
from zipfile import ZipFile

import pytest

from prts_mcp.data.images import SCHEMA_VERSION, parse_index
from prts_mcp.sync.images_sync import (
    _verify_variant_hashes,
    needed_shard_keys,
    sync_images,
)
from prts_mcp.sync.generation_store import active_generation


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
        "prts_mcp.sync.images_sync.list_releases",
        lambda owner, repo, *, timeout=10.0: releases,
    )
    monkeypatch.setattr(
        "prts_mcp.sync.images_sync.list_releases_paginated",
        lambda owner, repo, *, stop, max_pages=20, timeout=10.0: releases,
    )
    monkeypatch.setattr(
        "prts_mcp.sync.images_sync._download_small",
        lambda url, *, timeout=30.0: json.dumps(_make_index(baseline, current)).encode("utf-8")
        if "index.json" in url else None,
    )

    def mock_stream_cascading(url: str, dest: Path, *, timeout: float = 1800.0) -> None:
        calls["large"] += 1
        if delta_fails and "delta" in url:
            raise RuntimeError("delta download failed")
        dest.parent.mkdir(parents=True, exist_ok=True)
        with ZipFile(dest, "w"):  # empty zip — extracts nothing
            pass

    monkeypatch.setattr("prts_mcp.sync.images_sync.stream_cascading", mock_stream_cascading)
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
    assert active_generation(image_dir) is None


def test_sync_offline_falls_back_to_existing(tmp_path, monkeypatch):
    """Network failure after a successful sync returns offline_fallback."""
    image_dir = tmp_path / "images"
    calls = _setup_mocks(monkeypatch)
    sync_images(image_dir, include_original=False, force_check=True)

    # Simulate network loss on the next cycle.
    monkeypatch.setattr(
        "prts_mcp.sync.images_sync.list_releases",
        lambda owner, repo, *, timeout=10.0: None,
    )
    r = sync_images(image_dir, include_original=False, force_check=True)
    assert r.status == "offline_fallback"
    assert r.commit_sha == "c1"
    assert active_generation(image_dir) is not None


def test_verify_variant_hashes_passes_on_match(tmp_path):
    """#100: a variant whose PNG matches its index sha256 verifies cleanly."""
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


def test_verify_variant_hashes_rejects_missing_file(tmp_path):
    """#100 CR: a wanted variant whose PNG is absent blocks activation."""
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
    # No PNG created — the wanted variant's file is absent (incomplete shard).
    with pytest.raises(ValueError, match="sha256 verification failed"):
        _verify_variant_hashes(tmp_path, index, ("chararts-large",))


def test_stream_cascading_default_timeout_is_30_minutes():
    """Default must stay aligned with the TS twin's 1_800_000 ms (parity)."""
    from prts_mcp.sync.transport import stream_cascading

    default = inspect.signature(stream_cascading).parameters["timeout"].default
    assert default == 1800.0


def test_download_large_enforces_total_deadline(tmp_path, monkeypatch):
    """A stream that never finishes must hit the per-candidate total deadline.

    Fakes httpx.stream with an infinite chunk generator; the deadline check
    inside the chunk loop must abort the attempt as a TimeoutError.
    """
    import prts_mcp.sync.transport as transport_module

    class _FakeResponse:
        is_success = True
        status_code = 200

        def iter_bytes(self, chunk_size: int):
            while True:
                yield b"x" * chunk_size

    class _FakeStream:
        def __enter__(self):
            return _FakeResponse()

        def __exit__(self, *exc_info):
            return False

    monkeypatch.setattr(transport_module.httpx, "stream", lambda *a, **kw: _FakeStream())
    monkeypatch.delenv("GITHUB_MIRRORS", raising=False)  # direct candidate only
    dest = tmp_path / "shard.zip"
    with pytest.raises(TimeoutError, match="total deadline"):
        transport_module.stream_cascading(
            "https://example.com/shard.zip", dest, timeout=0.0
        )
    assert not dest.exists()
    assert list(tmp_path.glob(".*.tmp")) == []


def test_download_large_cascades_to_mirror_with_fresh_budget(tmp_path, monkeypatch):
    """Core C2 semantics: a candidate that blows its deadline cascades, and
    the next mirror attempt gets a fresh budget and can succeed."""
    import prts_mcp.sync.transport as transport_module

    class _FakeResponse:
        is_success = True
        status_code = 200

        def __init__(self, chunk_source):
            self._chunk_source = chunk_source

        def iter_bytes(self, chunk_size: int):
            return self._chunk_source

    class _FakeStream:
        def __init__(self, response):
            self._response = response

        def __enter__(self):
            return self._response

        def __exit__(self, *exc_info):
            return False

    def fake_stream(method: str, url: str, **kwargs):
        if "ghproxy.net" in url:
            return _FakeStream(_FakeResponse(iter([b"mirror-bytes"])))

        def infinite():
            while True:
                yield b"x"

        return _FakeStream(_FakeResponse(infinite()))

    monkeypatch.setattr(transport_module.httpx, "stream", fake_stream)
    # Double trailing slash doubles as a C1 normalization exercise.
    monkeypatch.setenv("GITHUB_MIRRORS", "https://ghproxy.net//")
    dest = tmp_path / "shard.zip"
    transport_module.stream_cascading(
        "https://example.com/shard.zip", dest, timeout=0.05
    )
    assert dest.read_bytes() == b"mirror-bytes"
    assert list(tmp_path.glob(".*.tmp")) == []


# ---------------------------------------------------------------------------
# Delta-chain scenarios (#179): real zips + truthful index artworks, so the
# sha256 gate actually exercises the applied chain instead of vacuously
# passing over empty artworks.
# ---------------------------------------------------------------------------

_B = "26-08-03-00-00-00_aaaaaa"
_D1 = "26-08-07-00-00-00_bbbbbb"
_D2 = "26-08-17-00-00-00_cccccc"


def _png(tag: str) -> bytes:
    return b"\x89PNG\r\n\x1a\n" + tag.encode()


def _skin_files(
    skin: str, variants: tuple[str, ...] = ("large", "preview"),
) -> dict[str, bytes]:
    return {f"chararts/{skin}_{v}.png": _png(f"{skin}-{v}") for v in variants}


def _artwork_entries(files: dict[str, bytes]) -> dict:
    """Build index.json artworks entries with truthful sha256 for *files*."""
    artworks: dict[str, dict] = {}
    for path, content in files.items():
        stem = path.split("/")[1][: -len(".png")]
        skin, variant = stem.rsplit("_", 1)
        artworks.setdefault(skin, {"kind": "base"})[variant] = {
            "file": path,
            "sha256": hashlib.sha256(content).hexdigest(),
            "w": 1,
            "h": 1,
            "bytes": len(content),
        }
    return artworks


class _ChainWorld:
    """Controlled AKDP images world: real zips and a truthful index.

    ``base_files`` ship in the baseline shards; ``delta_files`` maps each
    delta version to the files its zip adds. The latest delta release also
    serves the authoritative index.json covering every file, so the sha256
    gate fails unless the full chain was applied (#179).
    """

    def __init__(
        self,
        *,
        baseline: str = _B,
        shard_keys: tuple[str, ...] = ("chararts-large", "chararts-preview"),
    ) -> None:
        self.baseline = baseline
        self.shard_keys = shard_keys
        self.base_files: dict[str, bytes] = {}
        self.delta_files: dict[str, dict[str, bytes]] = {}
        self.missing_delta_assets: set[str] = set()
        self.omitted_releases: set[str] = set()
        self.extra_releases: list[dict] = []
        self.index_current_override: str | None = None
        self.page1_only_latest = False
        self.downloads: Counter[str] = Counter()
        self.paginated_calls = 0

    @property
    def current(self) -> str:
        versions = sorted(self.delta_files)
        return versions[-1] if versions else self.baseline

    def all_files(self) -> dict[str, bytes]:
        files = dict(self.base_files)
        for version in sorted(self.delta_files):
            files.update(self.delta_files[version])
        return files

    def _index_payload(self) -> dict:
        return {
            "schemaVersion": SCHEMA_VERSION,
            "baselineVersion": self.baseline,
            "currentVersion": self.index_current_override or self.current,
            "shards": {
                key: f"images-baseline-{key}-{self.baseline}.zip"
                for key in self.shard_keys
            },
            "artworks": _artwork_entries(self.all_files()),
        }

    def _releases(self) -> list[dict]:
        releases = [{
            "tag_name": f"images-baseline-{self.baseline}",
            "created_at": "2026-08-01T00:00:00Z",
            "assets": [],
        }]
        versions = sorted(self.delta_files)
        for seq, version in enumerate(versions):
            if version in self.omitted_releases:
                continue
            assets = []
            if version not in self.missing_delta_assets:
                assets.append({
                    "name": f"images-delta-{version}.zip",
                    "browser_download_url": f"https://ex/delta/{version}.zip",
                })
            if version == versions[-1]:
                assets.append({
                    "name": "index.json",
                    "browser_download_url": f"https://ex/{version}/index.json",
                })
            releases.append({
                "tag_name": f"images-{version}",
                "created_at": f"2026-08-{2 + seq:02d}T00:00:00Z",
                "assets": assets,
            })
        return releases + self.extra_releases

    def _stream(self, url: str, dest: Path, *, timeout: float = 1800.0) -> None:
        self.downloads[url] += 1
        dest.parent.mkdir(parents=True, exist_ok=True)
        if url.startswith("https://ex/delta/"):
            version = url.split("/")[-1][: -len(".zip")]
            files = self.delta_files[version]
        else:
            shard_file = url.rsplit("/", 1)[-1]
            shards = self._index_payload()["shards"]
            shard_key = next(k for k, f in shards.items() if f == shard_file)
            variant = shard_key.rsplit("-", 1)[-1]
            files = {
                p: c for p, c in self.base_files.items()
                if p.endswith(f"_{variant}.png")
            }
        with ZipFile(dest, "w") as zf:
            for path, content in files.items():
                zf.writestr(path, content)

    def install(self, monkeypatch) -> None:
        releases = self._releases()
        monkeypatch.setattr(
            "prts_mcp.sync.images_sync.list_releases",
            lambda owner, repo, *, timeout=10.0: (
                releases[-1:] if self.page1_only_latest else releases
            ),
        )

        def _paginated(owner, repo, *, stop, max_pages=20, timeout=10.0):
            self.paginated_calls += 1
            return releases

        monkeypatch.setattr(
            "prts_mcp.sync.images_sync.list_releases_paginated", _paginated,
        )
        monkeypatch.setattr(
            "prts_mcp.sync.images_sync._download_small",
            lambda url, *, timeout=30.0: json.dumps(self._index_payload()).encode()
            if "index.json" in url else None,
        )
        monkeypatch.setattr(
            "prts_mcp.sync.images_sync.stream_cascading", self._stream,
        )

    def baseline_downloads(self) -> int:
        return sum(
            n for url, n in self.downloads.items() if "/releases/download/" in url
        )


def _chain_world() -> _ChainWorld:
    world = _ChainWorld()
    world.base_files = _skin_files("skin_base")
    world.delta_files = {
        _D1: _skin_files("skin_d1"),
        _D2: _skin_files("skin_d2"),
    }
    return world


def _active_files(image_dir: Path) -> set[str]:
    gen = active_generation(image_dir)
    assert gen is not None
    return {str(p.relative_to(gen)) for p in gen.rglob("*.png")}


def test_fresh_install_applies_full_delta_chain(tmp_path, monkeypatch):
    """#179: a fresh install must apply baseline + every intermediate delta."""
    image_dir = tmp_path / "images"
    world = _chain_world()
    world.install(monkeypatch)

    r = sync_images(image_dir, include_original=False, force_check=True)
    assert r.status == "updated"
    assert r.commit_sha == _D2
    assert _active_files(image_dir) == set(world.all_files())
    # Two baseline shards + both deltas, each fetched exactly once.
    assert world.baseline_downloads() == 2
    assert world.paginated_calls == 0  # page 1 already covers the baseline

    r2 = sync_images(image_dir, include_original=False, force_check=True)
    assert r2.status == "up_to_date"


def test_fast_path_applies_intermediate_deltas(tmp_path, monkeypatch):
    """#179: a prior generation must absorb every delta since its version."""
    image_dir = tmp_path / "images"
    world = _ChainWorld()
    world.base_files = _skin_files("skin_base")
    world.delta_files = {_D1: _skin_files("skin_d1")}
    world.install(monkeypatch)

    r1 = sync_images(image_dir, include_original=False, force_check=True)
    assert r1.status == "updated"
    assert r1.commit_sha == _D1
    shards_after_first = world.baseline_downloads()

    # The pipeline publishes D2; the instance jumps D1 -> D2 directly.
    world.delta_files[_D2] = _skin_files("skin_d2")
    world.install(monkeypatch)

    r2 = sync_images(image_dir, include_original=False, force_check=True)
    assert r2.status == "updated"
    assert r2.commit_sha == _D2
    assert _active_files(image_dir) == set(world.all_files())
    # Fast path: baseline shards and the already-applied D1 are not re-fetched.
    assert world.baseline_downloads() == shards_after_first
    assert world.downloads[f"https://ex/delta/{_D1}.zip"] == 1
    assert world.downloads[f"https://ex/delta/{_D2}.zip"] == 1


def test_chain_include_original(tmp_path, monkeypatch):
    """ORIGINAL_IMAGE=true adds the original shards; chain semantics unchanged."""
    image_dir = tmp_path / "images"
    world = _ChainWorld(
        shard_keys=("chararts-large", "chararts-preview", "chararts-original"),
    )
    variants = ("large", "preview", "original")
    world.base_files = _skin_files("skin_base", variants)
    world.delta_files = {
        _D1: _skin_files("skin_d1", variants),
        _D2: _skin_files("skin_d2", variants),
    }
    world.install(monkeypatch)

    r = sync_images(image_dir, include_original=True, force_check=True)
    assert r.status == "updated"
    assert _active_files(image_dir) == set(world.all_files())


def test_missing_intermediate_release_fails_closed(tmp_path, monkeypatch):
    """#179: a delta the pipeline never published cannot be enumerated; the
    sha256 gate is the authoritative stop and nothing activates."""
    image_dir = tmp_path / "images"
    world = _chain_world()
    world.omitted_releases = {_D1}
    world.install(monkeypatch)

    r = sync_images(image_dir, include_original=False, force_check=True)
    assert r.status == "no_data"
    assert "sha256" in (r.error or "")
    assert active_generation(image_dir) is None


def test_missing_delta_asset_fails_before_baseline_download(tmp_path, monkeypatch):
    """#179: a broken chain fails closed *before* the ~1.5 GB baseline pull."""
    image_dir = tmp_path / "images"
    world = _chain_world()
    world.missing_delta_assets = {_D1}
    world.install(monkeypatch)

    r = sync_images(image_dir, include_original=False, force_check=True)
    assert r.status == "no_data"
    assert "delta asset missing" in (r.error or "")
    assert sum(world.downloads.values()) == 0
    assert active_generation(image_dir) is None


def test_duplicate_delta_version_fails_closed(tmp_path, monkeypatch):
    """#179: two releases carrying the same delta version fail closed."""
    image_dir = tmp_path / "images"
    world = _chain_world()
    world.extra_releases = [{
        "tag_name": f"images-{_D1}",
        # Older than D2 so latest_release_by_prefix still picks D2.
        "created_at": "2026-08-02T12:00:00Z",
        "assets": [{
            "name": f"images-delta-{_D1}.zip",
            "browser_download_url": f"https://ex/delta/{_D1}.zip",
        }],
    }]
    world.install(monkeypatch)

    r = sync_images(image_dir, include_original=False, force_check=True)
    assert r.status == "no_data"
    assert "duplicate" in (r.error or "")
    assert sum(world.downloads.values()) == 0


def test_rollback_rebuilds_from_baseline(tmp_path, monkeypatch):
    """#179: index currentVersion moving backwards must not reuse the newer
    prior generation; rebuild from baseline + chain instead."""
    image_dir = tmp_path / "images"
    world = _chain_world()
    world.install(monkeypatch)
    r1 = sync_images(image_dir, include_original=False, force_check=True)
    assert r1.commit_sha == _D2

    # The factory retracts D2 (release deleted, index regenerated at D1).
    world.delta_files.pop(_D2)
    world.install(monkeypatch)

    r2 = sync_images(image_dir, include_original=False, force_check=True)
    assert r2.status == "updated"
    assert r2.commit_sha == _D1
    assert _active_files(image_dir) == {
        *world.base_files, *world.delta_files[_D1],
    }


def test_sentinel_only_chain_applies_baseline_alone(tmp_path, monkeypatch):
    """A world whose only delta is the baseline sentinel (empty zip) is a
    legal empty chain: shards only, no delta asset requested."""
    image_dir = tmp_path / "images"
    world = _ChainWorld()
    world.base_files = _skin_files("skin_base")
    world.delta_files = {_B: {}}  # sentinel: same version as the baseline
    world.install(monkeypatch)

    r = sync_images(image_dir, include_original=False, force_check=True)
    assert r.status == "updated"
    assert r.commit_sha == _B
    assert _active_files(image_dir) == set(world.base_files)
    assert world.baseline_downloads() == 2
    assert not any("delta" in url for url in world.downloads)


def test_index_current_tag_mismatch_fails_closed(tmp_path, monkeypatch):
    """#179: index currentVersion is authoritative; drift from the latest
    delta tag fails closed instead of building the wrong chain."""
    image_dir = tmp_path / "images"
    world = _chain_world()
    world.index_current_override = "26-08-19-00-00-00_dddddd"
    world.install(monkeypatch)

    r = sync_images(image_dir, include_original=False, force_check=True)
    assert r.status == "no_data"
    assert "currentVersion" in (r.error or "")
    assert sum(world.downloads.values()) == 0


def test_pagination_recovers_baseline_beyond_first_page(tmp_path, monkeypatch):
    """#179: when the baseline falls out of the newest-100 page, discovery
    paginates until the chain start is covered."""
    image_dir = tmp_path / "images"
    world = _chain_world()
    world.page1_only_latest = True
    world.install(monkeypatch)

    r = sync_images(image_dir, include_original=False, force_check=True)
    assert r.status == "updated"
    assert world.paginated_calls == 1
    assert _active_files(image_dir) == set(world.all_files())


def test_fast_path_overlays_multiple_pending_deltas(tmp_path, monkeypatch):
    """#179 CR: prior generation sits at the baseline/sentinel version and two
    deltas publish at once — the fast path must overlay BOTH (the pre-fix
    single-delta overlay fails the truthful sha256 gate on this scenario)."""
    image_dir = tmp_path / "images"
    world = _ChainWorld()
    world.base_files = _skin_files("skin_base")
    world.delta_files = {_B: {}}  # sentinel-only world: gen lands at version B
    world.install(monkeypatch)

    r1 = sync_images(image_dir, include_original=False, force_check=True)
    assert r1.status == "updated"
    assert r1.commit_sha == _B

    world.delta_files = {
        _D1: _skin_files("skin_d1"),
        _D2: _skin_files("skin_d2"),
    }
    world.install(monkeypatch)

    r2 = sync_images(image_dir, include_original=False, force_check=True)
    assert r2.status == "updated"
    assert r2.commit_sha == _D2
    assert _active_files(image_dir) == set(world.all_files())
    # Fast path: baseline shards are not re-fetched; both deltas overlay once.
    assert world.baseline_downloads() == 2
    assert world.downloads[f"https://ex/delta/{_D1}.zip"] == 1
    assert world.downloads[f"https://ex/delta/{_D2}.zip"] == 1
