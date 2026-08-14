"""Images generation-filesystem store (state + update + query).

Owns the ``.images_meta.json`` pointer and the ``.releases/<generation>/``
tree layout for the AKDP image sync: resolving the active generation,
atomically saving generation metadata, and pruning superseded generations.
Mirrors ts/src/sync/generationStore.ts.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from prts_mcp.sync.primitives import atomic_write_json, prune_old_trees

IMAGES_META = ".images_meta.json"

_RETENTION_SECONDS = 24 * 60 * 60


def meta_path(root: Path) -> Path:
    return root / IMAGES_META


def load_meta(root: Path) -> dict | None:
    """Load the images meta pointer; None on missing/unreadable."""
    try:
        data = json.loads(meta_path(root).read_text("utf-8"))
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def save_meta(root: Path, meta: dict) -> None:
    """Atomically write the images meta pointer."""
    atomic_write_json(meta_path(root), meta, ensure_ascii=False)


def active_generation(image_dir: Path) -> Path | None:
    """Resolve the currently activated generation directory, or None."""
    meta = load_meta(image_dir)
    if meta is None:
        return None
    rel = meta.get("generation_root")
    if not isinstance(rel, str) or not rel:
        return None
    gen = (image_dir / rel).resolve()
    try:
        if not gen.is_relative_to(image_dir.resolve()):
            return None
    except ValueError:
        return None
    if not gen.is_dir() or not (gen / "index.json").is_file():
        return None
    return gen


def releases_dir(image_dir: Path) -> Path:
    releases = image_dir / ".releases"
    releases.mkdir(parents=True, exist_ok=True)
    return releases


def version_hash(version: str) -> str:
    return hashlib.sha256(version.encode("utf-8")).hexdigest()[:16]


def prune_generations(releases_dir: Path, keep: Path) -> None:
    """Delete superseded generation trees older than the retention window.

    Hidden (dot-prefixed) entries are skipped so a concurrent sync's staging
    dir is never pruned mid-flight.
    """
    prune_old_trees(releases_dir, {keep}, _RETENTION_SECONDS, skip_hidden=True)
