"""Release-archive activation: cross-process lock + generation tree + staging.

Extracted from ``data/sync`` in P2.B.1. Owns the activation lock that
serializes release-tree changes across Python and TypeScript processes, plus
the ``.releases/<gen>/`` generation tree, staging, extract-meta pointer, zip
validate/extract, and retention prune. ``data/sync`` re-exports these during
the P2.B migration.
"""
from __future__ import annotations

import hashlib
import json
import logging
import shutil
import threading
import time
import zipfile
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator
from uuid import uuid4

from prts_mcp.sync._types import ReleaseArchiveSpec
from prts_mcp.sync.release_discovery import ReleaseSpec

_logger = logging.getLogger(__name__)

_ACTIVATION_LOCK_TIMEOUT_SECONDS = 120
_ACTIVATION_LOCK_STALE_SECONDS = 30 * 60
_ACTIVATION_LOCK_OWNER_GRACE_SECONDS = 10
_ACTIVATION_LOCK_HEARTBEAT_SECONDS = 60
_RELEASE_RETENTION_SECONDS = 24 * 60 * 60


class _ActivationLockTimeout(TimeoutError):
    """Activation lock not acquired within the wait budget.

    Subclasses the builtin ``TimeoutError`` (itself an ``OSError``) so
    existing ``except TimeoutError`` consumers keep working; introduced for
    parity with TS ``ActivationLockTimeoutError``.
    """


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
            owner_path = lock / "owner"
            try:
                lease_path = owner_path if owner_path.is_file() else lock
                age = time.time() - lease_path.stat().st_mtime
            except FileNotFoundError:
                continue
            ownerless = not owner_path.is_file()
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
                raise _ActivationLockTimeout(f"Timed out waiting for archive activation lock: {lock}")
            time.sleep(0.05)
    try:
        owner_path = lock / "owner"
        owner_path.write_text(owner, encoding="utf-8")
    except Exception:
        shutil.rmtree(lock, ignore_errors=True)
        raise
    stop_heartbeat = threading.Event()

    def _refresh_lease() -> None:
        while not stop_heartbeat.wait(_ACTIVATION_LOCK_HEARTBEAT_SECONDS):
            try:
                if owner_path.read_text(encoding="utf-8") != owner:
                    return
                owner_path.touch()
            except OSError:
                return

    heartbeat = threading.Thread(target=_refresh_lease, daemon=True)
    heartbeat.start()
    try:
        yield
    finally:
        stop_heartbeat.set()
        heartbeat.join(timeout=1)
        try:
            current_owner = owner_path.read_text(encoding="utf-8")
        except OSError:
            current_owner = None
        if current_owner == owner:
            shutil.rmtree(lock, ignore_errors=True)


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
