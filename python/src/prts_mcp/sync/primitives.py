"""Shared sync-layer filesystem primitives.

Atomic JSON writes and retention pruning were previously re-implemented
per sync module (five ``tmp.replace`` copies and two prune variants); they
live here once. Mirrors ts/src/sync/primitives.ts.
"""
from __future__ import annotations

import json
import shutil
import time
from collections.abc import Iterable
from pathlib import Path
from uuid import uuid4


def atomic_write_json(
    path: Path,
    data: object,
    *,
    indent: int = 2,
    ensure_ascii: bool = True,
) -> None:
    """Write JSON via tmp-file + atomic replace so readers never see a partial file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=ensure_ascii, indent=indent), encoding="utf-8")
    tmp.replace(path)


def prune_old_trees(
    directory: Path,
    keep: Iterable[Path],
    retention_seconds: float,
    *,
    skip_hidden: bool = False,
) -> None:
    """Delete non-kept entries older than the retention window (best-effort).

    Per-entry stat errors are tolerated and symlinks are unlinked.
    ``skip_hidden`` keeps dot-prefixed entries — e.g. the in-flight staging
    dirs of a concurrent sync in the same release tree.
    """
    kept = set(keep)
    cutoff = time.time() - retention_seconds
    try:
        entries = list(directory.iterdir())
    except OSError:
        return
    for candidate in entries:
        if candidate in kept or (skip_hidden and candidate.name.startswith(".")):
            continue
        try:
            if candidate.stat().st_mtime >= cutoff:
                continue
        except OSError:
            continue
        if candidate.is_symlink():
            candidate.unlink(missing_ok=True)
        elif candidate.is_dir():
            shutil.rmtree(candidate, ignore_errors=True)
