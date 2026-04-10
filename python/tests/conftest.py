"""Shared pytest fixtures."""
from __future__ import annotations

import pytest
from pathlib import Path

# ---------------------------------------------------------------------------
# Local zip path — used only when the file actually exists on disk.
# Tests that require this fixture are skipped automatically on CI
# (where the large zip file is not checked in).
# ---------------------------------------------------------------------------

_LOCAL_ZIP = Path(r"F:\2026-Spring\ArknightsStoryJson\zh_CN.zip")


@pytest.fixture(scope="session")
def story_zip() -> Path:
    """Return path to the local zh_CN.zip; skip if not present."""
    if not _LOCAL_ZIP.is_file():
        pytest.skip(f"Local story zip not found: {_LOCAL_ZIP}")
    return _LOCAL_ZIP
