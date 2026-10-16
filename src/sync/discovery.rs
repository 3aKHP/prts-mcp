//! GitHub Release discovery: tag-prefix-filtered list / latest / asset_url.
//!
//! Port of TS `sync/releaseDiscovery.ts`. Data and images releases share one
//! repo, so data sync filters by tag prefix and orders by the
//! (versionId, revision) tuple — never by created_at or raw strings.

use serde_json::Value;

use super::transport::Transport;
use super::types::{ReleaseSpec, SyncError};

pub const TAG_PREFIX: &str = "data-";
pub const DATAREV_TAG_PREFIX: &str = "datarev-";

/// Parsed data release identity: versionId plus publication revision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataTagVersion {
    pub version_id: String,
    pub revision: u64,
}

/// A data versionId is fixed-width "YY-MM-DD-HH-MM-SS" plus a lowercase hex
/// hash, joined by `_` before 2026-10 and `-` since (VID_RE). The fixed-width
/// timestamp prefix dominates, so lexicographic order stays chronological.
fn is_version_id(suffix: &str) -> bool {
    if !fixed_width_head(suffix) {
        return false;
    }
    let bytes = suffix.as_bytes();
    if bytes.len() < 19 {
        return false;
    }
    let join = bytes[17];
    if join != b'-' && join != b'_' {
        return false;
    }
    let hash = &bytes[18..];
    !hash.is_empty()
        && hash
            .iter()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// First 17 characters match `dd-dd-dd-dd-dd-dd` (digits joined by `-`/`_`).
fn fixed_width_head(s: &str) -> bool {
    const PATTERN: &[u8; 17] = b"dd-dd-dd-dd-dd-dd";
    let bytes = s.as_bytes();
    if bytes.len() < 17 {
        return false;
    }
    for (index, expected) in PATTERN.iter().enumerate() {
        match expected {
            b'd' => {
                if !bytes[index].is_ascii_digit() {
                    return false;
                }
            }
            _ => {
                if bytes[index] != b'-' && bytes[index] != b'_' {
                    return false;
                }
            }
        }
    }
    true
}

/// `parseDataTag`: `data-<vid>` (revision 1) or `datarev-<vid>-r<N>`.
pub fn parse_data_tag(tag: &str) -> Option<DataTagVersion> {
    if let Some(rest) = tag.strip_prefix(DATAREV_TAG_PREFIX) {
        // `^datarev-(?<vid>.+)-r(?<rev>\d+)$` with a greedy `.+`: the LAST
        // "-r" whose tail is all digits wins.
        if let Some(split) = rsplit_revision(rest) {
            return Some(DataTagVersion {
                version_id: split.0.to_string(),
                revision: split.1,
            });
        }
        return None;
    }
    if let Some(vid) = tag.strip_prefix(TAG_PREFIX) {
        return Some(DataTagVersion {
            version_id: vid.to_string(),
            revision: 1,
        });
    }
    None
}

/// Split `vid-rN` at the last "-r" with an all-digit tail. Revisions beyond
/// u64 saturate — no real revision approaches that bound.
fn rsplit_revision(rest: &str) -> Option<(&str, u64)> {
    let mut search = rest;
    loop {
        let pos = search.rfind("-r")?;
        let (vid, rev) = (&rest[..pos], &rest[pos + 2..]);
        if !vid.is_empty() && !rev.is_empty() && rev.bytes().all(|b| b.is_ascii_digit()) {
            let parsed = rev.parse::<u64>().unwrap_or(u64::MAX);
            return Some((vid, parsed));
        }
        search = &search[..pos];
    }
}

/// `tagSuffix`: strip the data/datarev namespace prefix — the canonical
/// commitSha persisted in release_meta/extract_meta/.gamedata_pair.
pub fn tag_suffix(tag: &str) -> String {
    if let Some(rest) = tag.strip_prefix(DATAREV_TAG_PREFIX) {
        return rest.to_string();
    }
    if let Some(rest) = tag.strip_prefix(TAG_PREFIX) {
        return rest.to_string();
    }
    tag.to_string()
}

/// `parseReleaseSuffix`: a stored commitSha back into {versionId, revision}.
/// Sentinels ("unknown", "legacy", "local-<digest>") return None so callers
/// fall back to plain string comparison.
pub fn parse_release_suffix(suffix: &str) -> Option<DataTagVersion> {
    if let Some(rest) = suffix_strip_datarev_shape(suffix) {
        if let Some((vid, rev)) = rsplit_revision(rest) {
            return Some(DataTagVersion {
                version_id: vid.to_string(),
                revision: rev,
            });
        }
    }
    if is_version_id(suffix) {
        return Some(DataTagVersion {
            version_id: suffix.to_string(),
            revision: 1,
        });
    }
    None
}

/// DATAREV_SUFFIX_RE anchors on a fixed-width versionId head: reject early
/// when the suffix cannot start with one.
fn suffix_strip_datarev_shape(suffix: &str) -> Option<&str> {
    if fixed_width_head(suffix) {
        Some(suffix)
    } else {
        None
    }
}

/// True when *b* is strictly newer than *a* (tuple order). versionIds are
/// fixed-width ASCII, so byte order equals JS string order.
fn is_newer(a: &DataTagVersion, b: &DataTagVersion) -> bool {
    if a.version_id != b.version_id {
        return b.version_id > a.version_id;
    }
    b.revision > a.revision
}

fn is_truthy_field(release: &Value, key: &str) -> bool {
    matches!(release.get(key), Some(Value::Bool(true)))
}

/// `latestDataRelease`: pick the newest data release by (versionId, revision)
/// tuple. Two releases claiming the same tuple is an upstream integrity
/// violation — fail closed.
pub fn latest_data_release(releases: &[Value]) -> Result<Option<Value>, SyncError> {
    let mut best: Option<(DataTagVersion, Value)> = None;
    let mut seen: std::collections::HashSet<(String, u64)> = std::collections::HashSet::new();
    for release in releases {
        if is_truthy_field(release, "draft") || is_truthy_field(release, "prerelease") {
            continue;
        }
        let Some(tag) = release.get("tag_name").and_then(|v| v.as_str()) else {
            continue;
        };
        let Some(parsed) = parse_data_tag(tag) else {
            continue;
        };
        let key = (parsed.version_id.clone(), parsed.revision);
        if !seen.insert(key.clone()) {
            eprintln!(
                "[sync] duplicate data release identity (versionId={}, revision={}) claimed by \"{tag}\"; failing closed",
                key.0, key.1
            );
            return Err(SyncError::DuplicateReleaseIdentity);
        }
        if best.as_ref().is_none_or(|(k, _)| is_newer(k, &parsed)) {
            best = Some((parsed, release.clone()));
        }
    }
    Ok(best.map(|(_, release)| release))
}

/// `listReleases`: the tag-prefix-filtered list API. None on any failure.
pub async fn list_releases(
    transport: &dyn Transport,
    owner: &str,
    repo: &str,
    timeout_ms: u64,
) -> Option<Vec<Value>> {
    let url = format!("https://api.github.com/repos/{owner}/{repo}/releases?per_page=100");
    let data = transport.fetch_json(&url, timeout_ms).await.ok()?;
    data.as_array().cloned()
}

/// `listReleasesPaginated`: page until *stop* matches a release in the
/// current page or a short page ends the list; None on failure or when
/// maxPages passes without a match (fail closed — the history window is
/// unproven).
pub async fn list_releases_paginated(
    transport: &dyn Transport,
    owner: &str,
    repo: &str,
    stop: impl Fn(&Value) -> bool,
) -> Option<Vec<Value>> {
    const MAX_PAGES: usize = 20;
    let mut releases: Vec<Value> = Vec::new();
    for page in 1..=MAX_PAGES {
        let url = format!(
            "https://api.github.com/repos/{owner}/{repo}/releases?per_page=100&page={page}"
        );
        let data = transport.fetch_json(&url, 10_000).await.ok()?;
        let page_items = data.as_array()?.clone();
        releases.extend(page_items.clone());
        if page_items.iter().any(&stop) {
            return Some(releases);
        }
        if page_items.len() < 100 {
            return Some(releases);
        }
    }
    None
}

/// `latestReleaseByPrefix`: newest release whose tag starts with `prefix`
/// (optionally excluding `exclude_prefix`), sorted by created_at desc.
pub fn latest_release_by_prefix(
    releases: &[Value],
    prefix: &str,
    exclude_prefix: Option<&str>,
) -> Option<Value> {
    let mut candidates: Vec<&Value> = releases
        .iter()
        .filter(|release| {
            let tag = release.get("tag_name").and_then(|t| t.as_str());
            match tag {
                Some(tag) if tag.starts_with(prefix) => match exclude_prefix {
                    Some(excl) => !tag.starts_with(excl),
                    None => true,
                },
                _ => false,
            }
        })
        .collect();
    // String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")):
    // empty strings sort first ascending — with the default en-US collator
    // this matches UTF-16 code-unit order for ISO timestamps.
    candidates.sort_by(|a, b| {
        let av = a.get("created_at").and_then(|v| v.as_str()).unwrap_or("");
        let bv = b.get("created_at").and_then(|v| v.as_str()).unwrap_or("");
        bv.cmp(av)
    });
    candidates.into_iter().next().cloned()
}

/// `assetUrl`: the browser_download_url for `asset_name` in a release object.
pub fn asset_url(release: &Value, asset_name: &str) -> Option<String> {
    let assets = release.get("assets")?.as_array()?;
    for asset in assets {
        if asset.get("name").and_then(|n| n.as_str()) == Some(asset_name) {
            if let Some(url) = asset.get("browser_download_url").and_then(|u| u.as_str()) {
                return Some(url.to_string());
            }
        }
    }
    None
}

/// `checkLatestRelease`: the latest data release tag + asset URL, or None on
/// network failure / no matching release or asset.
pub async fn check_latest_release(
    transport: &dyn Transport,
    spec: &ReleaseSpec,
    timeout_ms: u64,
) -> Result<Option<(String, String)>, SyncError> {
    let Some(releases) = list_releases(transport, &spec.owner, &spec.repo, timeout_ms).await else {
        return Ok(None);
    };
    let latest = latest_data_release(&releases)?;
    let Some(latest) = latest else {
        return Ok(None);
    };
    let Some(tag) = latest.get("tag_name").and_then(|t| t.as_str()) else {
        return Ok(None);
    };
    let Some(url) = asset_url(&latest, &spec.asset_name) else {
        return Ok(None);
    };
    Ok(Some((tag.to_string(), url)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const REV_VID: &str = "26-09-03-04-06-00_ed95a2";
    const REV_VID2: &str = "26-10-01-11-22-33_aabbcc";
    const REV_VID_HYPHEN: &str = "26-10-08-04-51-28-56071834";

    #[test]
    fn parse_data_tag_handles_both_namespaces() {
        assert_eq!(
            parse_data_tag(&format!("data-{REV_VID}")),
            Some(DataTagVersion {
                version_id: REV_VID.into(),
                revision: 1
            })
        );
        assert_eq!(
            parse_data_tag(&format!("datarev-{REV_VID}-r2")),
            Some(DataTagVersion {
                version_id: REV_VID.into(),
                revision: 2
            })
        );
        assert_eq!(
            parse_data_tag(&format!("datarev-{REV_VID}-r10")),
            Some(DataTagVersion {
                version_id: REV_VID.into(),
                revision: 10
            })
        );
        assert_eq!(
            parse_data_tag(&format!("datarev-{REV_VID_HYPHEN}-r2")),
            Some(DataTagVersion {
                version_id: REV_VID_HYPHEN.into(),
                revision: 2
            })
        );
        assert_eq!(parse_data_tag("images-v1"), None);
        assert_eq!(parse_data_tag("datarev-x-r2-extra"), None);
        assert_eq!(parse_data_tag("datarev-vid"), None);
        assert_eq!(parse_data_tag("unknown"), None);
    }

    #[test]
    fn parse_release_suffix_and_tag_suffix_round_trip() {
        assert_eq!(
            parse_release_suffix(REV_VID),
            Some(DataTagVersion {
                version_id: REV_VID.into(),
                revision: 1
            })
        );
        assert_eq!(
            parse_release_suffix(&format!("{REV_VID}-r3")),
            Some(DataTagVersion {
                version_id: REV_VID.into(),
                revision: 3
            })
        );
        assert_eq!(
            parse_release_suffix(&format!("{REV_VID_HYPHEN}-r10")),
            Some(DataTagVersion {
                version_id: REV_VID_HYPHEN.into(),
                revision: 10
            })
        );
        for sentinel in ["unknown", "legacy", "local-abc123", "manual", "abc123"] {
            assert_eq!(parse_release_suffix(sentinel), None, "{sentinel}");
        }
        assert_eq!(tag_suffix(&format!("data-{REV_VID}")), REV_VID);
        assert_eq!(
            tag_suffix(&format!("datarev-{REV_VID}-r2")),
            format!("{REV_VID}-r2")
        );
        assert_eq!(tag_suffix("unknown"), "unknown");
    }

    fn release_entry(tag: &str) -> Value {
        serde_json::json!({
            "tag_name": tag,
            "created_at": "2026-01-01T00:00:00Z",
            "assets": [{"name": "zh_CN.zip", "browser_download_url": "https://example.test/asset"}],
        })
    }

    #[test]
    fn latest_data_release_orders_by_tuple() {
        let pick = |tags: &[&str]| {
            latest_data_release(&tags.iter().map(|t| release_entry(t)).collect::<Vec<_>>())
                .unwrap()
                .and_then(|r| {
                    r.get("tag_name")
                        .and_then(|t| t.as_str())
                        .map(str::to_string)
                })
        };

        assert_eq!(
            pick(&[&format!("data-{REV_VID}"), &format!("datarev-{REV_VID}-r2")]),
            Some(format!("datarev-{REV_VID}-r2"))
        );
        assert_eq!(
            pick(&[
                &format!("datarev-{REV_VID}-r9"),
                &format!("data-{REV_VID2}")
            ]),
            Some(format!("data-{REV_VID2}"))
        );
        assert_eq!(
            pick(&[
                &format!("datarev-{REV_VID}-r2"),
                &format!("datarev-{REV_VID}-r10")
            ]),
            Some(format!("datarev-{REV_VID}-r10"))
        );
        assert_eq!(
            pick(&[
                &format!("datarev-{REV_VID}-r10"),
                &format!("data-{REV_VID_HYPHEN}")
            ]),
            Some(format!("data-{REV_VID_HYPHEN}"))
        );
        assert_eq!(pick(&["images-v1"]), None);
    }

    #[test]
    fn latest_data_release_fails_closed_on_duplicates() {
        let releases = vec![
            release_entry(&format!("data-{REV_VID}")),
            release_entry(&format!("datarev-{REV_VID}-r1")),
        ];
        assert!(matches!(
            latest_data_release(&releases),
            Err(SyncError::DuplicateReleaseIdentity)
        ));
    }

    #[test]
    fn draft_and_prerelease_releases_are_skipped() {
        let mut draft = release_entry("datarev-V-r2");
        draft["draft"] = Value::Bool(true);
        let normal = release_entry("data-V");
        let releases = vec![draft, normal.clone()];
        let latest = latest_data_release(&releases).unwrap().unwrap();
        assert_eq!(latest["tag_name"], "data-V");
    }
}
