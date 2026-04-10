#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

if [[ -x "${PROJECT_ROOT}/.venv/bin/prts-mcp" ]]; then
  exec "${PROJECT_ROOT}/.venv/bin/prts-mcp" "$@"
fi

export PYTHONPATH="${PROJECT_ROOT}/src${PYTHONPATH:+:${PYTHONPATH}}"

if command -v uv >/dev/null 2>&1; then
  exec uv run --directory "${PROJECT_ROOT}" prts-mcp "$@"
fi

exec python3 -m prts_mcp.server "$@"
