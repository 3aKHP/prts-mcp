from __future__ import annotations

import json
import zipfile
from pathlib import Path
from typing import Any, Protocol


class JsonStore(Protocol):
    """Minimal JSON reader interface for local dataset storage."""

    def exists(self, path: str) -> bool:
        ...

    def read_text(self, path: str) -> str:
        ...

    def read_json(self, path: str) -> Any:
        ...

    def describe(self) -> str:
        ...


def _normalize_path(path: str) -> str:
    normalized = path.replace("\\", "/")
    if normalized.startswith("/"):
        raise ValueError(f"Unsafe dataset path: {path!r}")
    parts = [part for part in normalized.split("/") if part not in ("", ".")]
    if any(part == ".." for part in parts):
        raise ValueError(f"Unsafe dataset path: {path!r}")
    return "/".join(parts)


class DirectoryStore:
    """Read JSON files from a directory root."""

    def __init__(self, root: Path | str) -> None:
        self.root = Path(root)

    def _resolve(self, path: str) -> Path:
        root = self.root.resolve()
        target = (self.root / _normalize_path(path)).resolve()
        if not target.is_relative_to(root):
            raise ValueError(f"Unsafe dataset path: {path!r}")
        return target

    def exists(self, path: str) -> bool:
        return self._resolve(path).is_file()

    def read_text(self, path: str) -> str:
        target = self._resolve(path)
        if not target.is_file():
            raise FileNotFoundError(f"Dataset file not found: {path}")
        return target.read_text(encoding="utf-8")

    def read_json(self, path: str) -> Any:
        return json.loads(self.read_text(path))

    def describe(self) -> str:
        return f"directory:{self.root}"


class ZipStore:
    """Read JSON entries from a zip file."""

    def __init__(self, zip_path: Path | str) -> None:
        self.zip_path = Path(zip_path)

    def exists(self, path: str) -> bool:
        inner_path = _normalize_path(path)
        if not self.zip_path.is_file():
            return False
        with zipfile.ZipFile(self.zip_path) as zf:
            return inner_path in zf.namelist()

    def read_text(self, path: str) -> str:
        inner_path = _normalize_path(path)
        try:
            with zipfile.ZipFile(self.zip_path) as zf:
                with zf.open(inner_path) as f:
                    return f.read().decode("utf-8")
        except KeyError as exc:
            raise FileNotFoundError(f"Dataset zip entry not found: {path}") from exc

    def read_json(self, path: str) -> Any:
        return json.loads(self.read_text(path))

    def describe(self) -> str:
        return f"zip:{self.zip_path}"


class FallbackStore:
    """Read from primary storage first, then fall back to bundled storage."""

    def __init__(self, primary: JsonStore, fallback: JsonStore) -> None:
        self.primary = primary
        self.fallback = fallback

    def _store_for(self, path: str) -> JsonStore | None:
        if self.primary.exists(path):
            return self.primary
        if self.fallback.exists(path):
            return self.fallback
        return None

    def exists(self, path: str) -> bool:
        return self._store_for(path) is not None

    def read_text(self, path: str) -> str:
        store = self._store_for(path)
        if store is None:
            raise FileNotFoundError(f"Dataset file not found in fallback chain: {path}")
        return store.read_text(path)

    def read_json(self, path: str) -> Any:
        return json.loads(self.read_text(path))

    def describe(self) -> str:
        return f"fallback:{self.primary.describe()} -> {self.fallback.describe()}"
