# Newest data release tag across the data-/datarev- namespaces, ordered by the
# (versionId, publicationRevision) tuple — mirrors the sync layer's
# latest_data_release (ts/src/sync/releaseDiscovery.ts, python …/release_discovery.py).
# All workflow sites must consume this file via: --jq "$(cat .github/scripts/data-tag-selector.jq)"
[.[] | .tagName as $t | if ($t | test("^datarev-.+-r[0-9]+$")) then ($t | capture("^datarev-(?<vid>.+)-r(?<rev>[0-9]+)$")) as $m | {tagName: $t, vid: $m.vid, rev: ($m.rev | tonumber)} elif ($t | startswith("data-")) then {tagName: $t, vid: ($t | sub("^data-"; "")), rev: 1} else empty end] | max_by([.vid, .rev]) | .tagName
