"""Shared sync spec/result types.

Cross-cutting dataclasses consumed across the ``sync/`` tier
(release_activation, release, gamedata_pair) and re-exported by
``data/sync``. Extracted from ``data/sync`` in P2.B.1 so the moved
sub-modules depend on ``sync/_types`` rather than reaching back into
``data/sync`` (no upward back-edge in the sync pyramid).
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal


@dataclass(frozen=True)
class RepoSpec:
    """Describes an upstream GitHub repository and its required files."""

    owner: str
    repo: str
    branch: str
    files: tuple[str, ...]
    local_root: Path


@dataclass(frozen=True)
class ReleaseArchiveSpec:
    """Describes a GitHub Release zip asset that should be extracted locally."""

    owner: str
    repo: str
    asset_name: str
    local_zip: Path
    local_root: Path
    required_files: tuple[str, ...]
    verify_manifest: bool = False


@dataclass
class SyncResult:
    spec: RepoSpec
    status: Literal["updated", "up_to_date", "offline_fallback", "no_data"]
    commit_sha: str | None
    error: str | None
