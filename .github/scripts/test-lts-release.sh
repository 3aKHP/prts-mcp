#!/usr/bin/env bash
# Exercise the release guard against real commits, tags and branch ancestry.
set -euo pipefail

LTS_TEST_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
LTS_TEST_GUARD="${LTS_TEST_SCRIPT_DIR}/verify-lts-release.sh"
LTS_TEST_TMP="$(mktemp -d)"
trap 'rm -rf -- "$LTS_TEST_TMP"' EXIT
mkdir "$LTS_TEST_TMP/repo" "$LTS_TEST_TMP/bin"

# Inject time via the external date command, not a production override.
cat > "$LTS_TEST_TMP/bin/date" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == "-u +%F" ]]
printf '%s\n' "$LTS_TEST_DATE"
SH
chmod +x "$LTS_TEST_TMP/bin/date"
export PATH="$LTS_TEST_TMP/bin:$PATH"
export LTS_TEST_DATE=2026-10-13

cd "$LTS_TEST_TMP/repo"
git init -q
git config user.name "LTS release test"
git config user.email "lts-release-test@example.invalid"
git commit -qm baseline --allow-empty
LTS_TEST_BASE="$(git rev-parse HEAD)"
git update-ref refs/remotes/origin/lts/2.8 "$LTS_TEST_BASE"
git tag ts/v2.8.1
git tag -a python/v2.8.1 -m "annotated baseline"

LTS_TEST_COUNT=0
expect_pass() {
  local tag="$1" commit="$2" expected="$3" output
  : > "$LTS_TEST_TMP/github-output"
  output="$(GITHUB_OUTPUT="$LTS_TEST_TMP/github-output" bash "$LTS_TEST_GUARD" "$tag" "$commit")"
  [[ "$output" == "$expected" ]]
  [[ "$(cat "$LTS_TEST_TMP/github-output")" == "$expected" ]]
  LTS_TEST_COUNT=$((LTS_TEST_COUNT + 1))
}

expect_fail() {
  local tag="$1" commit="$2"
  : > "$LTS_TEST_TMP/github-output"
  if GITHUB_OUTPUT="$LTS_TEST_TMP/github-output" bash "$LTS_TEST_GUARD" "$tag" "$commit" > "$LTS_TEST_TMP/stdout" 2> "$LTS_TEST_TMP/stderr"; then
    echo "Unexpected release approval: $tag" >&2
    exit 1
  fi
  [[ ! -s "$LTS_TEST_TMP/github-output" ]]
  [[ ! -s "$LTS_TEST_TMP/stdout" ]]
  LTS_TEST_COUNT=$((LTS_TEST_COUNT + 1))
}

LTS_TEST_EXPECTED=$'version=2.8.1\nnpm_dist_tag=lts-2.8\ndocker_alias=2'
expect_pass ts/v2.8.1 "$LTS_TEST_BASE" "$LTS_TEST_EXPECTED"
expect_pass python/v2.8.1 "$LTS_TEST_BASE" "$LTS_TEST_EXPECTED"
expect_fail ts/v2.8.2-alpha.1 "$LTS_TEST_BASE"
expect_fail python/v2.8.2-rc.1 "$LTS_TEST_BASE"
expect_fail ts/v3.0.0 "$LTS_TEST_BASE"
expect_fail python/v1.7.3 "$LTS_TEST_BASE"
expect_fail rust/v2.8.1 "$LTS_TEST_BASE"
expect_fail ts/v2.8.01 "$LTS_TEST_BASE"
expect_fail ts/v2.8.1/extra "$LTS_TEST_BASE"
expect_fail ts/v2.8.9 "$LTS_TEST_BASE"
expect_fail ts/v2.8.1 missing-commit

git commit -qm "LTS patch" --allow-empty
LTS_TEST_PATCH="$(git rev-parse HEAD)"
git tag ts/v2.8.2
git update-ref refs/remotes/origin/lts/2.8 "$LTS_TEST_PATCH"
expect_pass ts/v2.8.2 "$LTS_TEST_PATCH" $'version=2.8.2\nnpm_dist_tag=lts-2.8\ndocker_alias=2'
expect_fail ts/v2.8.1 "$LTS_TEST_PATCH"

git checkout -q --detach "$LTS_TEST_BASE"
git commit -qm "Main-only patch" --allow-empty
LTS_TEST_MAIN="$(git rev-parse HEAD)"
git tag ts/v2.8.3
git update-ref refs/remotes/origin/main "$LTS_TEST_MAIN"
expect_fail ts/v2.8.3 "$LTS_TEST_MAIN"

git update-ref -d refs/remotes/origin/lts/2.8
expect_fail ts/v2.8.1 "$LTS_TEST_BASE"
git update-ref refs/remotes/origin/lts/2.8 "$LTS_TEST_PATCH"

export LTS_TEST_DATE=2027-07-02
expect_pass ts/v2.8.1 "$LTS_TEST_BASE" "$LTS_TEST_EXPECTED"
export LTS_TEST_DATE=2027-07-03
expect_fail ts/v2.8.1 "$LTS_TEST_BASE"
printf 'LTS release guard: %s cases passed.\n' "$LTS_TEST_COUNT"
