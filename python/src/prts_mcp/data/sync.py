"""GitHub-backed data sync for PRTS-MCP.

Downloads GitHub Release zip assets (gamedata excel/levels, storyjson)
only when the release tag has changed. Falls back gracefully to
cached/bundled data when the network is unavailable.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import time
import zipfile
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterator, Literal
from uuid import uuid4

import httpx

_logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

GAMEDATA_FILES: tuple[str, ...] = (
    "zh_CN/gamedata/excel/character_table.json",
    "zh_CN/gamedata/excel/handbook_info_table.json",
    "zh_CN/gamedata/excel/charword_table.json",
    "zh_CN/gamedata/excel/story_review_table.json",
    "zh_CN/gamedata/excel/enemy_handbook_table.json",
    "zh_CN/gamedata/excel/stage_table.json",
    "zh_CN/gamedata/excel/zone_table.json",
    "zh_CN/gamedata/excel/item_table.json",
)

_GITHUB_UA = "PRTS-MCP-Bot/0.1 (Arknights fan-creation helper)"


def _github_headers() -> dict[str, str]:
    headers: dict[str, str] = {"User-Agent": _GITHUB_UA}
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _parse_mirrors() -> list[str]:
    """Parse GITHUB_MIRRORS env var into a list of proxy base URLs (trailing slash stripped).

    Unset / empty → [] (direct only, no cascade)
    "https://ghproxy.net" → ["https://ghproxy.net"]
    "https://a.example,https://b.example" → ["https://a.example", "https://b.example"]

    Mirror URL format (ghproxy-style): <mirror>/<original_url>
    e.g. "https://ghproxy.net/https://raw.githubusercontent.com/..."
    """
    raw = os.environ.get("GITHUB_MIRRORS", "")
    return [m.rstrip("/") for m in raw.split(",") if m.strip()]


def _url_candidates(url: str) -> list[str]:
    """Return [url, mirror1/url, mirror2/url, ...]."""
    return [url] + [f"{m}/{url}" for m in _parse_mirrors()]


def _get_cascading(url: str, *, timeout: float, **kwargs: object) -> httpx.Response:
    """httpx.get() wrapper that cascades through URL candidates on failure.

    - HTTP 4xx from the direct URL propagates immediately (resource missing).
    - Network error or HTTP 5xx from any candidate → try the next one.
    """
    candidates = _url_candidates(url)
    last_exc: BaseException = RuntimeError("All URL candidates failed")
    for i, candidate in enumerate(candidates):
        try:
            response = httpx.get(candidate, timeout=timeout, **kwargs)  # type: ignore[arg-type]
            if response.is_success:
                return response
            last_exc = Exception(f"HTTP {response.status_code}")
            # Direct 4xx → resource genuinely missing; mirrors cannot help.
            if i == 0 and 400 <= response.status_code < 500:
                break
        except httpx.HTTPStatusError:
            raise  # only reached for direct 4xx via raise_for_status(); propagate as-is
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
    raise last_exc


# Skip the upstream SHA check if cached data is fresher than this many seconds.
_CACHE_TTL_SECONDS = 3600
_ACTIVATION_LOCK_TIMEOUT_SECONDS = 120
_ACTIVATION_LOCK_STALE_SECONDS = 30 * 60
_ACTIVATION_LOCK_OWNER_GRACE_SECONDS = 10
_RELEASE_RETENTION_SECONDS = 24 * 60 * 60


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
            commit_sha = data.get("commit_sha", data.get("commitSha"))
            fetched_at = data.get("fetched_at", data.get("fetchedAt"))
            files = data.get("files")
            if (
                not isinstance(commit_sha, str)
                or not commit_sha
                or not isinstance(fetched_at, str)
                or not fetched_at
                or not isinstance(files, list)
                or not all(isinstance(file, str) for file in files)
            ):
                return None
            return cls(
                repo=data["repo"],
                branch=data["branch"],
                commit_sha=commit_sha,
                fetched_at=fetched_at,
                files=files,
            )
        except (json.JSONDecodeError, TypeError, KeyError, AttributeError):
            return None

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
        tmp.write_text(
            json.dumps({
                "repo": self.repo,
                "branch": self.branch,
                "commit_sha": self.commit_sha,
                "fetched_at": self.fetched_at,
                "files": self.files,
            }, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        tmp.replace(path)


@dataclass
class SyncResult:
    spec: RepoSpec
    status: Literal["updated", "up_to_date", "offline_fallback", "no_data"]
    commit_sha: str | None
    error: str | None


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _cache_is_fresh(cache: CacheMeta) -> bool:
    """Return True if the cache was written within the TTL window."""
    try:
        ts = datetime.fromisoformat(cache.fetched_at.rstrip("Z")).replace(tzinfo=timezone.utc)
        age = (datetime.now(tz=timezone.utc) - ts).total_seconds()
        return age < _CACHE_TTL_SECONDS
    except (ValueError, AttributeError):
        return False


# ---------------------------------------------------------------------------
# Release-based sync (for storyjson zip)
# ---------------------------------------------------------------------------

_GITHUB_RELEASES_LATEST_URL = "https://api.github.com/repos/{owner}/{repo}/releases/latest"
_TAG_PREFIX = "upstream-"


@dataclass(frozen=True)
class ReleaseSpec:
    """Describes a GitHub Release asset to download as a local zip."""

    owner: str
    repo: str
    asset_name: str   # e.g. "zh_CN.zip"
    local_zip: Path   # destination path on disk
    validate_zip: Callable[[Path], list[str]] | None = None


@dataclass(frozen=True)
class ReleaseArchiveSpec:
    """Describes a GitHub Release zip asset that should be extracted locally."""

    owner: str
    repo: str
    asset_name: str
    local_zip: Path
    local_root: Path
    required_files: tuple[str, ...]


def _release_cache_path(spec: ReleaseSpec) -> Path:
    return spec.local_zip.parent / "release_meta.json"


def _release_cache_is_fresh(cache: CacheMeta) -> bool:
    return _cache_is_fresh(cache)


def check_latest_release(spec: ReleaseSpec, timeout: float = 10.0) -> tuple[str, str] | None:
    """Return (tag_name, asset_download_url) for the latest release, or None on failure."""
    url = _GITHUB_RELEASES_LATEST_URL.format(owner=spec.owner, repo=spec.repo)
    try:
        response = _get_cascading(url, timeout=timeout, headers=_github_headers())
        data = response.json()
        tag = data["tag_name"]
        for asset in data.get("assets", []):
            if asset["name"] == spec.asset_name:
                return tag, asset["browser_download_url"]
        _logger.debug("Asset %s not found in release %s", spec.asset_name, tag)
        return None
    except Exception as exc:  # noqa: BLE001
        _logger.debug("Failed to check latest release for %s/%s: %s", spec.owner, spec.repo, exc)
        return None


def download_release_asset(spec: ReleaseSpec, tag: str, url: str, timeout: float = 120.0) -> None:
    """Download a release asset zip atomically, then write cache metadata."""
    spec.local_zip.parent.mkdir(parents=True, exist_ok=True)
    tmp = spec.local_zip.with_name(
        f".{spec.local_zip.name}.{uuid4().hex}.tmp"
    )
    try:
        _logger.debug("Downloading release asset %s", url)
        response = _get_cascading(url, timeout=timeout, headers=_github_headers(), follow_redirects=True)
        tmp.write_bytes(response.content)
        if spec.validate_zip is not None:
            missing = spec.validate_zip(tmp)
            if missing:
                raise ValueError("Downloaded release asset is invalid: " + "; ".join(missing[:10]))
        tmp.replace(spec.local_zip)

        # Extract upstream SHA from tag (format: "upstream-<sha>")
        commit_sha = tag[len(_TAG_PREFIX):] if tag.startswith(_TAG_PREFIX) else tag
        CacheMeta(
            repo=f"{spec.owner}/{spec.repo}",
            branch="releases",
            commit_sha=commit_sha,
            fetched_at=datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            files=[spec.asset_name],
        ).save(_release_cache_path(spec))
    except Exception:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def _sync_release_locked(spec: ReleaseSpec, *, force_check: bool = False) -> SyncResult:
    """Check latest GitHub Release and download asset if the tag has changed.

    Decision tree mirrors the legacy per-file sync path:
      1. Cache fresh + zip exists → up_to_date
      2. Network failure → offline_fallback / no_data
      3. Tag unchanged + zip exists → up_to_date (refresh fetched_at)
      4. Tag changed or zip missing → download → updated / offline_fallback / no_data
    """
    # Wrap ReleaseSpec in a minimal RepoSpec-like object for SyncResult
    _dummy_spec = RepoSpec(
        owner=spec.owner,
        repo=spec.repo,
        branch="releases",
        files=(spec.asset_name,),
        local_root=spec.local_zip.parent,
    )

    cache = CacheMeta.load(_release_cache_path(spec))
    zip_error = _release_zip_error(spec)
    zip_ok = zip_error is None

    if (
        not force_check
        and cache is not None
        and zip_ok
        and _release_cache_is_fresh(cache)
    ):
        _logger.debug("Release cache is fresh for %s/%s; skipping check.", spec.owner, spec.repo)
        return SyncResult(spec=_dummy_spec, status="up_to_date", commit_sha=cache.commit_sha, error=None)

    result = check_latest_release(spec)

    if result is None:
        if zip_ok:
            return SyncResult(
                spec=_dummy_spec,
                status="offline_fallback",
                commit_sha=cache.commit_sha if cache else None,
                error="Network unavailable",
            )
        # No zip and API unreachable — attempt blind download via releases/latest/download/
        # (does not require the GitHub API; ghproxy and similar mirrors support this URL).
        if _parse_mirrors():
            blind_url = f"https://github.com/{spec.owner}/{spec.repo}/releases/latest/download/{spec.asset_name}"
            try:
                download_release_asset(spec, "unknown", blind_url)
                return SyncResult(spec=_dummy_spec, status="updated", commit_sha="unknown", error=None)
            except Exception as exc:  # noqa: BLE001
                return SyncResult(spec=_dummy_spec, status="no_data", commit_sha=None, error=str(exc))
        error = "Network unavailable and no cached zip"
        if spec.local_zip.is_file() and zip_error:
            error += f"; cached zip invalid: {zip_error}"
        return SyncResult(spec=_dummy_spec, status="no_data", commit_sha=None, error=error)

    tag, asset_url = result
    upstream_sha = tag[len(_TAG_PREFIX):] if tag.startswith(_TAG_PREFIX) else tag

    if cache is not None and cache.commit_sha == upstream_sha and zip_ok:
        CacheMeta(
            repo=cache.repo,
            branch=cache.branch,
            commit_sha=cache.commit_sha,
            fetched_at=datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            files=cache.files,
        ).save(_release_cache_path(spec))
        return SyncResult(spec=_dummy_spec, status="up_to_date", commit_sha=upstream_sha, error=None)

    try:
        download_release_asset(spec, tag, asset_url)
        return SyncResult(spec=_dummy_spec, status="updated", commit_sha=upstream_sha, error=None)
    except Exception as exc:  # noqa: BLE001
        error_msg = str(exc)
        if zip_ok:
            return SyncResult(
                spec=_dummy_spec,
                status="offline_fallback",
                commit_sha=cache.commit_sha if cache else None,
                error=error_msg,
            )
        return SyncResult(spec=_dummy_spec, status="no_data", commit_sha=None, error=error_msg)


def _release_zip_error(spec: ReleaseSpec) -> str | None:
    if not spec.local_zip.is_file():
        return "zip file is missing"
    validator = spec.validate_zip
    if validator is None:
        return None
    try:
        missing = validator(spec.local_zip)
    except Exception as exc:  # noqa: BLE001
        return f"{spec.local_zip.name} is not a valid zip: {exc}"
    if not missing:
        return None
    return "; ".join(str(path) for path in missing[:10])


def _archive_files_present(spec: ReleaseArchiveSpec) -> bool:
    root = _active_archive_root(spec)
    return all((root / f).is_file() for f in spec.required_files)


def _archive_missing_files(spec: ReleaseArchiveSpec, root: Path) -> list[str]:
    return [f for f in spec.required_files if not (root / f).is_file()]


def _extract_meta_path(spec: ReleaseArchiveSpec) -> Path:
    return spec.local_zip.parent / "extract_meta.json"


def _load_extract_meta(spec: ReleaseArchiveSpec) -> tuple[str, Path] | None:
    try:
        value = json.loads(_extract_meta_path(spec).read_text(encoding="utf-8"))
        commit_sha = value.get("commit_sha")
        data_root = value.get("data_root")
        if not isinstance(commit_sha, str) or not commit_sha:
            return None
        if not isinstance(data_root, str) or not data_root:
            return None
        root = (spec.local_root / data_root).resolve()
        if not root.is_relative_to(spec.local_root.resolve()) or not root.is_dir():
            return None
        return commit_sha, root
    except (OSError, json.JSONDecodeError, AttributeError):
        return None


def _active_archive_root(spec: ReleaseArchiveSpec) -> Path:
    meta = _load_extract_meta(spec)
    return meta[1] if meta is not None else spec.local_root


def _save_extract_meta(
    spec: ReleaseArchiveSpec,
    commit_sha: str,
    data_root: Path,
) -> None:
    path = _extract_meta_path(spec)
    tmp = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    path.parent.mkdir(parents=True, exist_ok=True)
    relative_root = data_root.relative_to(spec.local_root).as_posix()
    tmp.write_text(
        json.dumps(
            {"commit_sha": commit_sha, "data_root": relative_root},
            indent=2,
        ),
        encoding="utf-8",
    )
    tmp.replace(path)


def _validate_archive_zip(zip_path: Path, required_files: tuple[str, ...]) -> list[str]:
    try:
        with zipfile.ZipFile(zip_path) as zf:
            names = set(zf.namelist())
            return [path for path in required_files if path not in names]
    except Exception as exc:  # noqa: BLE001
        return [f"{zip_path.name} is not a valid zip: {exc}"]


def _safe_extract_zip(zip_path: Path, local_root: Path) -> None:
    """Extract zip entries under local_root with a write-to-tmp-then-replace pattern."""
    root = local_root.resolve()
    tmp_paths: list[Path] = []
    try:
        with zipfile.ZipFile(zip_path) as zf:
            for member in zf.infolist():
                if member.is_dir():
                    continue
                dest = (local_root / member.filename).resolve()
                if dest == root or not dest.is_relative_to(root):
                    raise ValueError(f"Unsafe zip member path: {member.filename}")

                dest.parent.mkdir(parents=True, exist_ok=True)
                tmp = dest.with_name(dest.name + ".tmp")
                with zf.open(member) as src, tmp.open("wb") as dst:
                    shutil.copyfileobj(src, dst)
                tmp_paths.append(tmp)
                tmp.replace(dest)
                tmp_paths.remove(tmp)
    except Exception:
        for tmp in tmp_paths:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
        raise


def _releases_path(spec: ReleaseArchiveSpec) -> Path:
    releases = spec.local_root / ".releases"
    try:
        if releases.is_symlink():
            raise ValueError(f"Unsafe release directory symlink: {releases}")
    except OSError as exc:
        raise ValueError(f"Cannot inspect release directory: {releases}") from exc
    releases.mkdir(parents=True, exist_ok=True)
    if (
        releases.is_symlink()
        or not releases.resolve().is_relative_to(spec.local_root.resolve())
    ):
        raise ValueError(f"Unsafe release directory: {releases}")
    return releases


def _stage_release_tree(
    spec: ReleaseArchiveSpec,
    commit_sha: str,
) -> tuple[Path, Path]:
    releases = _releases_path(spec)
    release_key = hashlib.sha256(commit_sha.encode("utf-8")).hexdigest()[:16]
    generation = f"{release_key}-{uuid4().hex}"
    staging = releases / f".{generation}.tmp"
    activated = releases / generation
    try:
        _safe_extract_zip(spec.local_zip, staging)
        missing = _archive_missing_files(spec, staging)
        if missing:
            raise ValueError(
                "Archive extraction missing required files: "
                + "; ".join(missing[:10])
            )
        return staging, activated
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def _archive_activation_sha(spec: ReleaseArchiveSpec, release_sha: str | None) -> str:
    if release_sha is not None:
        return release_sha
    digest = hashlib.sha256()
    with spec.local_zip.open("rb") as archive:
        for chunk in iter(lambda: archive.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"local-{digest.hexdigest()}"


@contextmanager
def _archive_activation_lock(
    spec: ReleaseSpec | ReleaseArchiveSpec,
    lock_name: str = ".activation.lock",
) -> Iterator[None]:
    """Serialize release state changes across Python and TypeScript processes."""
    lock = spec.local_zip.parent / lock_name
    owner = uuid4().hex
    deadline = time.monotonic() + _ACTIVATION_LOCK_TIMEOUT_SECONDS
    while True:
        try:
            lock.mkdir(parents=False)
            break
        except FileExistsError:
            if lock.is_symlink():
                raise ValueError(f"Unsafe activation lock symlink: {lock}")
            try:
                age = time.time() - lock.stat().st_mtime
            except FileNotFoundError:
                continue
            ownerless = not (lock / "owner").is_file()
            stale = age > _ACTIVATION_LOCK_STALE_SECONDS or (
                ownerless and age > _ACTIVATION_LOCK_OWNER_GRACE_SECONDS
            )
            if stale:
                quarantine = lock.with_name(f"{lock.name}.stale-{uuid4().hex}")
                try:
                    lock.replace(quarantine)
                except OSError as exc:
                    if not lock.exists():
                        continue
                    _logger.error("Failed to reclaim stale activation lock %s: %s", lock, exc)
                    raise
                shutil.rmtree(quarantine, ignore_errors=True)
                continue
            if time.monotonic() >= deadline:
                raise TimeoutError(f"Timed out waiting for archive activation lock: {lock}")
            time.sleep(0.05)
    try:
        (lock / "owner").write_text(owner, encoding="utf-8")
    except Exception:
        shutil.rmtree(lock, ignore_errors=True)
        raise
    try:
        yield
    finally:
        try:
            current_owner = (lock / "owner").read_text(encoding="utf-8")
        except OSError:
            current_owner = None
        if current_owner == owner:
            shutil.rmtree(lock, ignore_errors=True)


def sync_release(spec: ReleaseSpec, *, force_check: bool = False) -> SyncResult:
    """Publish a release ZIP and its metadata as one serialized operation."""
    dummy_spec = RepoSpec(
        owner=spec.owner,
        repo=spec.repo,
        branch="releases",
        files=(spec.asset_name,),
        local_root=spec.local_zip.parent,
    )
    try:
        spec.local_zip.parent.mkdir(parents=True, exist_ok=True)
        with _archive_activation_lock(spec, ".release.lock"):
            return _sync_release_locked(spec, force_check=force_check)
    except Exception as exc:  # noqa: BLE001
        cache = CacheMeta.load(_release_cache_path(spec))
        return SyncResult(
            spec=dummy_spec,
            status=(
                "offline_fallback"
                if _release_zip_error(spec) is None
                else "no_data"
            ),
            commit_sha=cache.commit_sha if cache is not None else None,
            error=str(exc),
        )


def _prune_release_trees(spec: ReleaseArchiveSpec, keep: set[Path]) -> None:
    try:
        releases = _releases_path(spec)
        cutoff = time.time() - _RELEASE_RETENTION_SECONDS
        for candidate in releases.iterdir():
            if candidate in keep:
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
    except OSError:
        pass


def _sync_release_archive_locked(
    spec: ReleaseArchiveSpec,
    *,
    force_check: bool = False,
) -> SyncResult:
    release_result = sync_release(
        ReleaseSpec(
            owner=spec.owner,
            repo=spec.repo,
            asset_name=spec.asset_name,
            local_zip=spec.local_zip,
            validate_zip=lambda path: _validate_archive_zip(path, spec.required_files),
        ),
        force_check=force_check,
    )
    dummy_spec = RepoSpec(
        owner=spec.owner,
        repo=spec.repo,
        branch="releases",
        files=spec.required_files,
        local_root=spec.local_root,
    )

    extract_meta = _load_extract_meta(spec)
    active_root = extract_meta[1] if extract_meta is not None else spec.local_root
    _prune_release_trees(spec, {active_root})
    files_ok = all((active_root / f).is_file() for f in spec.required_files)
    if release_result.status == "no_data":
        if files_ok:
            return SyncResult(
                spec=dummy_spec,
                status="offline_fallback",
                commit_sha=release_result.commit_sha,
                error=release_result.error,
            )
        return SyncResult(
            spec=dummy_spec,
            status="no_data",
            commit_sha=release_result.commit_sha,
            error=release_result.error,
        )

    extracted_sha = extract_meta[0] if extract_meta is not None else None
    should_extract = (
        release_result.status == "updated"
        or not files_ok
        or extracted_sha is None
        or (
            release_result.commit_sha is not None
            and extracted_sha != release_result.commit_sha
        )
    )
    if should_extract:
        staging: Path | None = None
        try:
            activation_sha = _archive_activation_sha(spec, release_result.commit_sha)
            staging, activated_root = _stage_release_tree(spec, activation_sha)
            current_meta = _load_extract_meta(spec)
            current_root = (
                current_meta[1] if current_meta is not None else spec.local_root
            )
            if (
                current_meta is not None
                and current_meta[0] == activation_sha
                and all(
                    (current_root / path).is_file()
                    for path in spec.required_files
                )
            ):
                shutil.rmtree(staging, ignore_errors=True)
                staging = None
                return SyncResult(
                    spec=dummy_spec,
                    status="up_to_date",
                    commit_sha=activation_sha,
                    error=None,
                )
            staging.replace(activated_root)
            staging = None
            if current_root.parent == _releases_path(spec):
                os.utime(current_root)
            _save_extract_meta(spec, activation_sha, activated_root)
            _prune_release_trees(spec, {current_root, activated_root})
        except Exception as exc:  # noqa: BLE001
            if staging is not None:
                shutil.rmtree(staging, ignore_errors=True)
            if _archive_files_present(spec):
                return SyncResult(
                    spec=dummy_spec,
                    status="offline_fallback",
                    commit_sha=release_result.commit_sha,
                    error=str(exc),
                )
            return SyncResult(
                spec=dummy_spec,
                status="no_data",
                commit_sha=release_result.commit_sha,
                error=str(exc),
            )
        return SyncResult(
            spec=dummy_spec,
            status="updated",
            commit_sha=activation_sha,
            error=None,
        )

    return SyncResult(
        spec=dummy_spec,
        status=release_result.status,
        commit_sha=release_result.commit_sha,
        error=release_result.error,
    )


def sync_release_archive(
    spec: ReleaseArchiveSpec,
    *,
    force_check: bool = False,
) -> SyncResult:
    """Publish and activate one release archive under a shared-volume lock."""
    dummy_spec = RepoSpec(
        owner=spec.owner,
        repo=spec.repo,
        branch="releases",
        files=spec.required_files,
        local_root=spec.local_root,
    )
    try:
        spec.local_zip.parent.mkdir(parents=True, exist_ok=True)
        with _archive_activation_lock(spec):
            return _sync_release_archive_locked(spec, force_check=force_check)
    except Exception as exc:  # noqa: BLE001
        return SyncResult(
            spec=dummy_spec,
            status=("offline_fallback" if _archive_files_present(spec) else "no_data"),
            commit_sha=None,
            error=str(exc),
        )
