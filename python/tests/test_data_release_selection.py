"""The runtime and build-time selectors share publication identity rules."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from prts_mcp.sync.release_discovery import latest_data_release

ROOT = Path(__file__).resolve().parents[2]
CASES = json.loads((ROOT / "tests/parity-fixtures/data-release-selection.json").read_text())


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
def test_runtime_and_ci_selection(case):
    releases = [{"tag_name": tag, "draft": tag == case.get("draft"),
                 "prerelease": tag == case.get("prerelease")} for tag in case["tags"]]
    if case.get("error"):
        with pytest.raises(ValueError, match="duplicate"):
            latest_data_release(releases)
    else:
        selected = latest_data_release(releases)
        assert (selected["tag_name"] if selected else None) == case["expected"]
    if shutil.which("jq") is None:
        pytest.skip("jq required to verify the CI selector")
    selected = subprocess.run(
        ["jq", "-f", str(ROOT / ".github/scripts/data-tag-selector.jq")],
        input=json.dumps([{"tagName": tag, "isDraft": tag == case.get("draft"),
                           "isPrerelease": tag == case.get("prerelease")} for tag in case["tags"]]),
        text=True, capture_output=True,
    )
    if case.get("error"):
        assert selected.returncode != 0 and "duplicate" in selected.stderr
    else:
        assert selected.returncode == 0, selected.stderr
        assert json.loads(selected.stdout) == case["expected"]


@pytest.mark.parametrize("flag", ["draft", "prerelease"])
def test_unpublished_data_cannot_outrank_stable(flag):
    assert latest_data_release([
        {"tag_name": "data-V"}, {"tag_name": "datarev-V-r2", flag: True},
    ])["tag_name"] == "data-V"
