#!/usr/bin/env bash
# Validate a 2.8 LTS tag before any release job can write to a registry.
set -euo pipefail

LTS_RELEASE_TAG="${1:-${GITHUB_REF_NAME:-}}"
LTS_RELEASE_SHA="${2:-${GITHUB_SHA:-}}"
LTS_RELEASE_BRANCH="refs/remotes/origin/lts/2.8"

fail() {
  echo "::error::$*" >&2
  exit 1
}

if [[ ! "$LTS_RELEASE_TAG" =~ ^(python|ts)/v(2\.8\.(0|[1-9][0-9]*))$ ]]; then
  fail "2.8 LTS requires a stable python/v2.8.x or ts/v2.8.x tag; prereleases and other release lines are rejected."
fi
LTS_RELEASE_VERSION="${BASH_REMATCH[2]}"

# EOL includes the whole named UTC calendar day; do not publish thereafter.
LTS_RELEASE_DATE="$(date -u +%F)"
if [[ "$LTS_RELEASE_DATE" > "2027-07-02" ]]; then
  fail "2.8 LTS reached EOL on 2027-07-02; no further releases are supported."
fi

git show-ref --verify --quiet "$LTS_RELEASE_BRANCH" ||
  fail "origin/lts/2.8 is missing; fetch the maintenance branch before verifying a tag."
LTS_RELEASE_COMMIT="$(git rev-parse --verify --end-of-options "${LTS_RELEASE_SHA}^{commit}")" ||
  fail "Release SHA does not identify a commit."
LTS_TAG_COMMIT="$(git rev-parse --verify "refs/tags/${LTS_RELEASE_TAG}^{commit}")" ||
  fail "Release tag is missing or does not identify a commit."
[[ "$LTS_TAG_COMMIT" == "$LTS_RELEASE_COMMIT" ]] ||
  fail "Release tag and requested commit differ."
git merge-base --is-ancestor "$LTS_RELEASE_COMMIT" "$LTS_RELEASE_BRANCH" ||
  fail "2.8 LTS release commit must belong to origin/lts/2.8, not main or develop."

LTS_RELEASE_OUTPUT="$(printf 'version=%s\nnpm_dist_tag=lts-2.8\ndocker_alias=2\n' "$LTS_RELEASE_VERSION")"
printf '%s\n' "$LTS_RELEASE_OUTPUT"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf '%s\n' "$LTS_RELEASE_OUTPUT" >> "$GITHUB_OUTPUT"
fi
