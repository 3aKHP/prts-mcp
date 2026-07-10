"""Shared pytest fixtures."""
from __future__ import annotations

import os
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Local zip path — used only when the file actually exists on disk.
# Tests that require this fixture are skipped automatically on CI
# (where the large zip file is not checked in).
#
# Override via STORYJSON_ZIP env var for other development environments.
# ---------------------------------------------------------------------------

_DEFAULT_STORY_ZIP = (
    Path(__file__).resolve().parents[2] / "data" / "storyjson" / "zh_CN.zip"
)
_LOCAL_ZIP = Path(os.environ.get("STORYJSON_ZIP", str(_DEFAULT_STORY_ZIP)))


@pytest.fixture(scope="session")
def story_zip() -> Path:
    """Return path to the local zh_CN.zip; skip if not present."""
    if not _LOCAL_ZIP.is_file():
        pytest.skip(f"Local story zip not found: {_LOCAL_ZIP}")
    return _LOCAL_ZIP
