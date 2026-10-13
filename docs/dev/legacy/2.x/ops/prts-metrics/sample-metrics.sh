#!/usr/bin/env bash
# Sample aggregate PRTS-MCP metrics and the owning systemd cgroup as JSONL.
set -euo pipefail

SERVICE="${PRTS_METRICS_SERVICE:-prts-mcp-ts.service}"
METRICS_URL="${PRTS_METRICS_URL:-http://127.0.0.1:5102/debug/metrics}"
LOG_DIR="${PRTS_METRICS_LOG_DIR:-/var/log/prts-mcp}"
LOG_FILE="${LOG_DIR}/metrics-samples.jsonl"

if [[ -z "${PRTS_DEBUG_TOKEN:-}" ]]; then
  echo "PRTS_DEBUG_TOKEN is required for the local metrics probe" >&2
  exit 1
fi

control_group="$(systemctl show "${SERVICE}" --property=ControlGroup --value)"
main_pid="$(systemctl show "${SERVICE}" --property=MainPID --value)"
if [[ ! "${control_group}" =~ ^/ ]] || [[ "${main_pid}" -le 0 ]]; then
  echo "${SERVICE} has no running process or cgroup" >&2
  exit 1
fi

cgroup_root="${PRTS_METRICS_CGROUP_ROOT:-/sys/fs/cgroup${control_group}}"
proc_root="${PRTS_METRICS_PROC_ROOT:-/proc}"
for required in memory.current memory.peak memory.events; do
  if [[ ! -r "${cgroup_root}/${required}" ]]; then
    echo "missing required cgroup file: ${cgroup_root}/${required}" >&2
    exit 1
  fi
done

metrics_json="$(printf '%s\n' "header = \"Authorization: Bearer ${PRTS_DEBUG_TOKEN}\"" | curl --config - --fail --silent --show-error --max-time 5 "${METRICS_URL}")"
rss_kb="$(awk '/^VmRSS:/ {print $2; found=1} END {if (!found) exit 1}' "${proc_root}/${main_pid}/status")"
memory_current="$(<"${cgroup_root}/memory.current")"
memory_peak="$(<"${cgroup_root}/memory.peak")"
memory_swap_current="null"
if [[ -r "${cgroup_root}/memory.swap.current" ]]; then
  memory_swap_current="$(<"${cgroup_root}/memory.swap.current")"
fi

mkdir -p "${LOG_DIR}"
printf '%s' "${metrics_json}" | node "$(dirname "$0")/validate-sample.mjs" \
  "$(date -Iseconds)" "${SERVICE}" "${main_pid}" "${rss_kb}" "${memory_current}" \
  "${memory_peak}" "${memory_swap_current}" "${cgroup_root}/memory.events" >> "${LOG_FILE}"
