"""GitHub-backed data sync for PRTS-MCP.

Checks upstream commit SHA and downloads required game data files
only when the upstream repository has changed. Falls back gracefully
to cached/bundled data when the network is unavailable.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

import httpx

_logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

GAMEDATA_FILES: tuple[str, ...] = (
    "zh_CN/gamedata/excel/character_table.json",
    "zh_CN/gamedata/excel/handbook_info_table.json",
    "zh_CN/gamedata/excel/charword_table.json",
)

_GITHUB_COMMITS_URL = "https://api.github.com/repos/{owner}/{repo}/commits/{branch}"
_GITHUB_RAW_URL = "https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}"
_GITHUB_UA = "PRTS-MCP-Bot/0.1 (Arknights fan-creation helper)"

# Skip the upstream SHA check if cached data is fresher than this many seconds.
_CACHE_TTL_SECONDS = 3600


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RepoSpec:
    """Describes an upstream GitHub repository and its required files."""

    owner: str
    repo: str
    branch: str
    files: tuple[str, ...]
    local_root: Path


@dataclass
class CacheMeta:
    """Persisted metadata about the last successful sync."""

    repo: str
    branch: str
    commit_sha: str
    fetched_at: str  # ISO 8601 UTC, e.g. "2025-01-01T00:00:00Z"
    files: list[str]

    @classmethod
    def load(cls, path: Path) -> CacheMeta | None:
        if not path.is_file():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return cls(**data)
        except (json.JSONDecodeError, TypeError, KeyError):
            return None

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(
                {
                    "repo": self.repo,
                    "branch": self.branch,
                    "commit_sha": self.commit_sha,
                    "fetched_at": self.fetched_at,
                    "files": self.files,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )


@dataclass
class SyncResult:
    spec: RepoSpec
    status: Literal["updated", "up_to_date", "offline_fallback", "no_data"]
    commit_sha: str | None
    error: str | None


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _cache_meta_path(spec: RepoSpec) -> Path:
    return spec.local_root / "cache_meta.json"


def _files_present(spec: RepoSpec) -> bool:
    return all((spec.local_root / f).is_file() for f in spec.files)


def _cache_is_fresh(cache: CacheMeta) -> bool:
    """Return True if the cache was written within the TTL window."""
    try:
        ts = datetime.fromisoformat(cache.fetched_at.rstrip("Z")).replace(tzinfo=timezone.utc)
        age = (datetime.now(tz=timezone.utc) - ts).total_seconds()
        return age < _CACHE_TTL_SECONDS
    except (ValueError, AttributeError):
        return False


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def check_upstream_sha(spec: RepoSpec, timeout: float = 10.0) -> str | None:
    """Return the latest commit SHA from GitHub, or None on any failure."""
    url = _GITHUB_COMMITS_URL.format(owner=spec.owner, repo=spec.repo, branch=spec.branch)
    try:
        response = httpx.get(url, headers={"User-Agent": _GITHUB_UA}, timeout=timeout)
        response.raise_for_status()
        return response.json()["sha"]
    except Exception as exc:  # noqa: BLE001
        _logger.debug("Failed to check upstream SHA for %s/%s: %s", spec.owner, spec.repo, exc)
        return None


def download_files(spec: RepoSpec, sha: str, timeout: float = 60.0) -> None:
    """Download all required files atomically, then write cache metadata.

    Uses a write-to-tmp-then-replace pattern so partially downloaded files
    never appear to the data loader as complete.
    """
    tmp_pairs: list[tuple[Path, Path]] = []
    try:
        with httpx.Client(headers={"User-Agent": _GITHUB_UA}, timeout=timeout) as client:
            for file_path in spec.files:
                url = _GITHUB_RAW_URL.format(
                    owner=spec.owner,
                    repo=spec.repo,
                    branch=spec.branch,
                    path=file_path,
                )
                _logger.debug("Downloading %s", url)
                response = client.get(url)
                response.raise_for_status()

                dest = spec.local_root / file_path
                dest.parent.mkdir(parents=True, exist_ok=True)
                tmp = dest.with_suffix(dest.suffix + ".tmp")
                tmp.write_bytes(response.content)
                tmp_pairs.append((tmp, dest))

        # All downloads succeeded — atomically rename
        for tmp, dest in tmp_pairs:
            tmp.replace(dest)
        tmp_pairs.clear()

        # Persist cache metadata
        CacheMeta(
            repo=f"{spec.owner}/{spec.repo}",
            branch=spec.branch,
            commit_sha=sha,
            fetched_at=datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            files=list(spec.files),
        ).save(_cache_meta_path(spec))

    except Exception:
        # Clean up any temp files on failure
        for tmp, _ in tmp_pairs:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
        raise


def sync_repo(spec: RepoSpec) -> SyncResult:
    """Check upstream and download files if needed.

    Decision tree:
      1. If cache is fresh (< 1 h old) and files exist → up_to_date (skip API call)
      2. Call GitHub commits API:
         a. Network failure:
            - files present → offline_fallback
            - no files      → no_data
         b. SHA matches cache AND files present → up_to_date
         c. Otherwise → download_files()
            - success → updated
            - failure → files present → offline_fallback / no files → no_data
    """
    cache = CacheMeta.load(_cache_meta_path(spec))
    files_ok = _files_present(spec)

    # Fast path: cache is fresh, no need to hit the API
    if cache is not None and files_ok and _cache_is_fresh(cache):
        _logger.debug("Cache is fresh for %s/%s; skipping upstream check.", spec.owner, spec.repo)
        return SyncResult(spec=spec, status="up_to_date", commit_sha=cache.commit_sha, error=None)

    upstream_sha = check_upstream_sha(spec)

    if upstream_sha is None:
        if files_ok:
            return SyncResult(
                spec=spec,
                status="offline_fallback",
                commit_sha=cache.commit_sha if cache else None,
                error="Network unavailable",
            )
        return SyncResult(spec=spec, status="no_data", commit_sha=None, error="Network unavailable and no cached data")

    if cache is not None and cache.commit_sha == upstream_sha and files_ok:
        # Update fetched_at so the TTL resets from now
        CacheMeta(
            repo=cache.repo,
            branch=cache.branch,
            commit_sha=cache.commit_sha,
            fetched_at=datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            files=cache.files,
        ).save(_cache_meta_path(spec))
        return SyncResult(spec=spec, status="up_to_date", commit_sha=upstream_sha, error=None)

    try:
        download_files(spec, upstream_sha)
        return SyncResult(spec=spec, status="updated", commit_sha=upstream_sha, error=None)
    except Exception as exc:  # noqa: BLE001
        error_msg = str(exc)
        if files_ok:
            return SyncResult(
                spec=spec,
                status="offline_fallback",
                commit_sha=cache.commit_sha if cache else None,
                error=error_msg,
            )
        return SyncResult(spec=spec, status="no_data", commit_sha=None, error=error_msg)


def sync_all(specs: list[RepoSpec]) -> list[SyncResult]:
    """Sync each repo spec sequentially and return all results."""
    return [sync_repo(spec) for spec in specs]
