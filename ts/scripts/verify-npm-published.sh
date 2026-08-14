#!/usr/bin/env bash
# Verify the npm-published tarball for the TypeScript package is byte-identical
# to the exact local release artifact, tolerating registry/CDN propagation.
#
# Invoked from .github/workflows/cd-ts.yml (github-release job). Extracted to a
# script so the release error contract is shellcheck-able and unit-tested
# (ts/scripts/verify-npm-published.test.mjs) rather than living only in YAML.
#
# Usage: verify-npm-published.sh [<tarball>]
#        If <tarball> is omitted, the script discovers the packed artifact in
#        the current directory (cd-ts.yml runs it with working-directory: ts),
#        so the release-artifact glob has a single owner instead of three.
# Env (optional unless noted):
#   VERSION          required if GITHUB_REF_NAME is unset; e.g. 2.7.0 / 2.7.0-alpha.1
#   NPM_PACKAGE      default prts-mcp-ts  (the published name; mirrors ts/package.json)
#   NPM_REGISTRY     default https://registry.npmjs.org
#   VERIFY_ATTEMPTS  default 40  (x VERIFY_SLEEP ~= 10 min polling budget)
#   VERIFY_SLEEP     default 15
#
# Exit 0: served tarball is byte-identical to the local artifact.
# Exit 1: propagation timeout, or a retrievable mismatch classified as
#         drift (registry intact, local artifact changed) vs anomaly. See the
#         ::error:: lines for the cause and recovery.
set -euo pipefail

PACKAGE="${NPM_PACKAGE:-prts-mcp-ts}"
REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"

# Take the tarball explicitly, or discover the packed artifact in the cwd so
# the release-artifact glob lives here rather than being re-derived in YAML.
TARBALL="${1:-$(find . -maxdepth 1 -name "${PACKAGE}-*.tgz" -type f -print -quit)}"
test -n "$TARBALL"
test -f "$TARBALL"

if [ -z "${VERSION:-}" ]; then
  if [ -n "${GITHUB_REF_NAME:-}" ]; then
    VERSION="${GITHUB_REF_NAME#ts/v}"
  fi
fi
: "${VERSION:?VERSION could not be determined (set VERSION or run under a ts/v* tag)}"

ATTEMPTS="${VERIFY_ATTEMPTS:-40}"
SLEEP="${VERIFY_SLEEP:-15}"

EXPECTED=$(sha256sum "$TARBALL" | awk '{print $1}')

TMP=$(mktemp); META=$(mktemp)
trap 'rm -f "$TMP" "$META"' EXIT

print_diag() {
  # Shared diagnostics for the two retrievable-mismatch branches. The labels
  # matter: dist.shasum is SHA-1 and dist.integrity is a base64 SHA-512 SRI,
  # neither comparable to the SHA-256 lines without converting algorithms.
  echo "::error::expected sha256 (local artifact):     ${EXPECTED}"
  echo "::error::actual sha256   (registry tarball):   ${ACTUAL:-<none>}"
  echo "::error::registry dist.tarball:                ${URL:-<unknown>}"
  echo "::error::registry dist.shasum (sha1):          ${SHASUM:-<none>}"
  echo "::error::registry dist.integrity (sha512 sri): ${INTEGRITY:-<none>}"
}

LAST_HTTP="000"
URL=""
SHASUM=""
INTEGRITY=""
ACTUAL=""

for attempt in $(seq 1 "$ATTEMPTS"); do
  TS=$(date +%s)
  URL=""; SHASUM=""; INTEGRITY=""
  # Cache-bust the per-version packument so a stale CDN 404 cannot mask a
  # publish that already landed. The ?ts= query is ignored by the registry.
  if curl -fsSL "${REGISTRY}/${PACKAGE}/${VERSION}?ts=${TS}" -o "$META" 2>/dev/null; then
    # node reads the packument from fd 0; if it is non-JSON (transient CDN
    # hiccup) node throws and read returns non-zero — `|| true` keeps the
    # retry loop intact under `set -e`.
    # shellcheck disable=SC2311
    read -r URL SHASUM INTEGRITY < <(node -e 'const m=JSON.parse(require("fs").readFileSync(0,"utf8"));const d=m.dist||{};console.log(d.tarball||"",d.shasum||"",d.integrity||"")' < "$META") || true
  fi

  if [ -n "$URL" ]; then
    # Fetch without -f so %{http_code} is captured on 4xx/5xx. Only hash when
    # curl exited 0 (no interrupted/partial transfer) AND status is 200;
    # otherwise treat as transient and retry, so a truncated download is not
    # misread as a permanent byte mismatch.
    if HTTP=$(curl -sSL -o "$TMP" -w '%{http_code}' "${URL}?ts=${TS}" 2>/dev/null); then
      LAST_HTTP="$HTTP"
      if [ "$HTTP" = "200" ]; then
        ACTUAL=$(sha256sum "$TMP" | awk '{print $1}')
        if [ "$ACTUAL" = "$EXPECTED" ]; then
          echo "npm tarball SHA-256 verified: $ACTUAL"
          exit 0
        fi
        # Retrievable but bytes differ. Cross-check the download against the
        # registry's OWN declared hashes: if the served tarball matches what
        # npm indexed at publish, the registry is intact and the LOCAL
        # artifact drifted (expected on a full rerun that re-fetched bundled
        # gamedata/storyjson) — not registry tampering.
        DL_SHA1=$(sha1sum "$TMP" | awk '{print $1}')
        if [ -n "$SHASUM" ] && [ "$DL_SHA1" = "$SHASUM" ]; then
          echo "::error::${PACKAGE}@${VERSION}: registry tarball is intact (matches its declared dist.shasum) but differs from the local artifact — the local artifact drifted (expected on a full rerun after bundled data changed). The published tarball is the verified release content."
          echo "::error::Recovery: create the GitHub Release from the registry tarball above, or re-run the ORIGINAL run that published this version with 'gh run rerun <run-id> --failed' (only its artifact is byte-identical). A --failed rerun of THIS run re-uses the drifted artifact and will fail again."
          print_diag
        else
          echo "::error::${PACKAGE}@${VERSION}: downloaded tarball does NOT match the registry's own declared hashes — possible CDN/registry anomaly or tampering."
          echo "::error::downloaded sha1: ${DL_SHA1}"
          echo "::error::Do NOT create the GitHub Release; investigate first."
          print_diag
        fi
        exit 1
      fi
    else
      # curl non-zero: connection failure or interrupted transfer (partial
      # body). Retry on the next iteration; do not hash a truncated file.
      LAST_HTTP="${HTTP:-000}"
    fi
  fi
  echo "Waiting for npm tarball propagation (attempt ${attempt}/${ATTEMPTS}, last HTTP ${LAST_HTTP})..."
  sleep "$SLEEP"
done

echo "::error::${PACKAGE}@${VERSION} is published but the tarball was not retrievable after ${ATTEMPTS} attempts (~$((ATTEMPTS*SLEEP/60)) min); last tarball HTTP status ${LAST_HTTP}."
echo "::error::This is a registry propagation delay, not a byte mismatch."
echo "::error::expected sha256: ${EXPECTED}"
echo "::error::Recovery: wait for propagation, then re-run this github-release job (gh run rerun <run-id> --failed), or verify manually:"
# shellcheck disable=SC2016 # the $(date +%s) is meant to be copied literally
echo "::error::  curl -fsSL \"${URL:-<url>}?ts=\$(date +%s)\" | sha256sum"
exit 1
