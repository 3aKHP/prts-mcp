#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
SHARED_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/prts-shared-sync.XXXXXX")"

cleanup() {
  rm -rf -- "${SHARED_ROOT}"
}
trap cleanup EXIT

REQUIRED_FILE="zh_CN/gamedata/excel/character_table.json"
ARCHIVE_DIR="${SHARED_ROOT}/archives"
ARCHIVE_PATH="${ARCHIVE_DIR}/zh_CN-excel.zip"
mkdir -p "${ARCHIVE_DIR}"

uv run --directory "${REPO_ROOT}/python" --frozen --no-sync python - \
  "${ARCHIVE_PATH}" "${REQUIRED_FILE}" <<'PY'
import json
import sys
import zipfile
from pathlib import Path

archive = Path(sys.argv[1])
required_file = sys.argv[2]
with zipfile.ZipFile(archive, "w") as bundle:
    bundle.writestr(required_file, '{"char_001_amiya":{"name":"Amiya"}}')
(archive.parent / "release_meta.json").write_text(
    json.dumps(
        {
            "repo": "3aKHP/ArknightsGameData",
            "branch": "releases",
            "commit_sha": "shared-volume-test",
            "fetched_at": "2099-01-01T00:00:00Z",
            "files": [archive.name],
        }
    ),
    encoding="utf-8",
)
PY

uv run --directory "${REPO_ROOT}/python" --frozen --no-sync python - \
  "${SHARED_ROOT}" "${ARCHIVE_PATH}" "${REQUIRED_FILE}" \
  >"${SHARED_ROOT}/python.status" <<'PY' &
import sys
from pathlib import Path

from prts_mcp.data.sync import ReleaseArchiveSpec, sync_release_archive

root = Path(sys.argv[1])
result = sync_release_archive(
    ReleaseArchiveSpec(
        owner="3aKHP",
        repo="ArknightsGameData",
        asset_name=Path(sys.argv[2]).name,
        local_zip=Path(sys.argv[2]),
        local_root=root,
        required_files=(sys.argv[3],),
    )
)
print(result.status)
if result.error is not None:
    raise RuntimeError(result.error)
PY
PYTHON_PID=$!

(cd "${REPO_ROOT}/ts" && node --import tsx \
  --input-type=module - \
  "${SHARED_ROOT}" "${ARCHIVE_PATH}" "${REQUIRED_FILE}") \
  >"${SHARED_ROOT}/typescript.status" <<'TS' &
import { basename } from "node:path";
import { syncReleaseArchive } from "./src/data/sync.ts";

const [, , root, archive, requiredFile] = process.argv;
const result = await syncReleaseArchive({
  owner: "3aKHP",
  repo: "ArknightsGameData",
  assetName: basename(archive),
  localZip: archive,
  localRoot: root,
  requiredFiles: [requiredFile],
});
console.log(result.status);
if (result.error !== null) throw new Error(result.error);
TS
TYPESCRIPT_PID=$!

PYTHON_EXIT=0
TYPESCRIPT_EXIT=0
wait "${PYTHON_PID}" || PYTHON_EXIT=$?
wait "${TYPESCRIPT_PID}" || TYPESCRIPT_EXIT=$?
if ((PYTHON_EXIT != 0 || TYPESCRIPT_EXIT != 0)); then
  echo "Sync process failed: Python=${PYTHON_EXIT}, TypeScript=${TYPESCRIPT_EXIT}" >&2
  exit 1
fi

PYTHON_STATUS="$(<"${SHARED_ROOT}/python.status")"
TYPESCRIPT_STATUS="$(<"${SHARED_ROOT}/typescript.status")"
if [[ ! (
  "${PYTHON_STATUS}" == "updated" && "${TYPESCRIPT_STATUS}" == "up_to_date"
) && ! (
  "${PYTHON_STATUS}" == "up_to_date" && "${TYPESCRIPT_STATUS}" == "updated"
) ]]; then
  echo "Unexpected sync statuses: Python=${PYTHON_STATUS}, TypeScript=${TYPESCRIPT_STATUS}" >&2
  exit 1
fi

uv run --directory "${REPO_ROOT}/python" --frozen --no-sync python - \
  "${SHARED_ROOT}" "${ARCHIVE_DIR}" "${REQUIRED_FILE}" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1]).resolve()
archive_dir = Path(sys.argv[2])
required_file = sys.argv[3]
meta = json.loads((archive_dir / "extract_meta.json").read_text(encoding="utf-8"))
active_root = (root / meta["data_root"]).resolve()
active_root.relative_to(root)
assert meta["commit_sha"] == "shared-volume-test"
assert (active_root / required_file).is_file()
assert not (archive_dir / ".activation.lock").exists()
assert not (archive_dir / ".release.lock").exists()
print("Cross-runtime shared-volume sync passed.")
PY
