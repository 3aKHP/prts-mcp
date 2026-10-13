//! Shared sync-layer filesystem primitives — port of TS `sync/primitives.ts`
//! plus the ISO-8601 helpers the cache freshness check needs.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

use super::types::SyncError;

fn uuid_nodash() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// Write JSON via tmp-file + atomic rename so readers never see a partial
/// file. Byte shape matches the oracle: `JSON.stringify(data, null, 2)` with
/// no trailing newline, tmp name `.<basename>.<uuid-nodash>.tmp`.
pub fn atomic_write_json(path: &Path, data: &Value) -> Result<(), SyncError> {
    let tmp = path.with_file_name(format!(
        ".{}.{}.tmp",
        path.file_name()
            .map(|n| n.to_string_lossy())
            .unwrap_or_default(),
        uuid_nodash()
    ));
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(
        &tmp,
        serde_json::to_string_pretty(data).map_err(|e| SyncError::Message(e.to_string()))?,
    )?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Delete non-kept entries older than the retention window (best-effort).
/// `skip_hidden` keeps dot-prefixed entries — the in-flight staging dirs of a
/// concurrent sync in the same release tree.
pub fn prune_old_trees(
    directory: &Path,
    keep: &HashSet<PathBuf>,
    retention_ms: u128,
    skip_hidden: bool,
) {
    let cutoff_ms = now_ms().saturating_sub(retention_ms as u64) as u128;
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if skip_hidden && name.starts_with('.') {
            continue;
        }
        let candidate = entry.path();
        if keep.contains(&candidate) {
            continue;
        }
        let Ok(info) = std::fs::symlink_metadata(&candidate) else {
            continue;
        };
        let Ok(mtime) = info.modified() else {
            continue;
        };
        if mtime_ms(mtime) >= cutoff_ms {
            continue;
        }
        if info.is_dir() {
            let _ = std::fs::remove_dir_all(&candidate);
        } else {
            let _ = std::fs::remove_file(&candidate);
        }
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn mtime_ms(time: SystemTime) -> u128 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

/// `new Date().toISOString()` — "YYYY-MM-DDTHH:MM:SS.sssZ".
pub fn now_iso() -> String {
    iso_from_unix_ms(now_ms() as i128)
}

pub fn iso_from_unix_ms(ms: i128) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days as i64);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// `new Date(text).getTime()` for the toISOString shape; None for anything
/// else (mirrors the NaN → not-fresh path in `cacheIsFresh`).
pub fn parse_iso_ms(text: &str) -> Option<i128> {
    let bytes = text.as_bytes();
    let digit = |b: u8| b.is_ascii_digit();
    // YYYY-MM-DDTHH:MM:SS[.fff]Z
    if bytes.len() < 20 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    if bytes[10] != b'T' || bytes[13] != b':' || bytes[16] != b':' {
        return None;
    }
    let all_digits = |slice: &[u8]| slice.iter().all(|b| digit(*b));
    if !all_digits(&bytes[0..4])
        || !all_digits(&bytes[5..7])
        || !all_digits(&bytes[8..10])
        || !all_digits(&bytes[11..13])
        || !all_digits(&bytes[14..16])
        || !all_digits(&bytes[17..19])
    {
        return None;
    }
    let mut tail = &bytes[19..];
    let mut millis: i128 = 0;
    if tail.first() == Some(&b'.') {
        let fraction_len = tail[1..]
            .iter()
            .position(|b| *b == b'Z')
            .unwrap_or(tail.len());
        let fraction = &tail[1..1 + fraction_len];
        if fraction.is_empty() || !all_digits(fraction) {
            return None;
        }
        let mut scaled = String::from("0.");
        scaled.push_str(std::str::from_utf8(fraction).ok()?);
        millis = (scaled.parse::<f64>().ok()? * 1000.0).round() as i128;
        tail = &tail[1 + fraction_len..];
    }
    if tail != b"Z" {
        return None;
    }
    let year: i64 = std::str::from_utf8(&bytes[0..4]).ok()?.parse().ok()?;
    let month: u32 = std::str::from_utf8(&bytes[5..7]).ok()?.parse().ok()?;
    let day: u32 = std::str::from_utf8(&bytes[8..10]).ok()?.parse().ok()?;
    let hour: i64 = std::str::from_utf8(&bytes[11..13]).ok()?.parse().ok()?;
    let minute: i64 = std::str::from_utf8(&bytes[14..16]).ok()?.parse().ok()?;
    let second: i64 = std::str::from_utf8(&bytes[17..19]).ok()?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let days = days_from_civil(year, month, day) as i128;
    Some(
        days * 86_400_000
            + hour as i128 * 3_600_000
            + minute as i128 * 60_000
            + second as i128 * 1000
            + millis,
    )
}

/// Howard Hinnant's civil algorithms.
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let mp = if m > 2 { m - 3 } else { m + 9 } as u64;
    let doy = (153 * mp + 2) / 5 + d as u64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe as i64 - 719_468
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// A short unique suffix in the oracle's shape (`uuid.replaceAll("-", "")`).
pub fn random_suffix() -> String {
    uuid_nodash()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_round_trip_and_rejections() {
        let ms = 1_762_800_000_123i128; // arbitrary instant
        let text = iso_from_unix_ms(ms);
        assert_eq!(parse_iso_ms(&text), Some(ms));
        assert_eq!(
            parse_iso_ms("2099-01-01T00:00:00.000Z"),
            Some(4_070_908_800_000)
        );
        assert_eq!(
            parse_iso_ms("2026-10-11T08:09:10Z"),
            Some(parse_iso_ms("2026-10-11T08:09:10.000Z").unwrap())
        );
        assert_eq!(parse_iso_ms("not a date"), None);
        assert_eq!(parse_iso_ms("2026-13-01T00:00:00Z"), None);
        assert_eq!(parse_iso_ms(""), None);
    }

    #[test]
    fn atomic_write_json_is_pretty_without_newline() {
        let dir = std::env::temp_dir().join(format!("prts-atomic-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("meta.json");
        let value = serde_json::json!({"repo": "a/b", "files": ["x.zip"], "n": 1});
        atomic_write_json(&path, &value).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            text,
            "{\n  \"repo\": \"a/b\",\n  \"files\": [\n    \"x.zip\"\n  ],\n  \"n\": 1\n}"
        );
        assert!(!text.ends_with('\n'));
        // No tmp leftovers.
        let entries: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().collect();
        assert_eq!(entries.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_respects_keep_cutoff_and_hidden() {
        let dir = std::env::temp_dir().join(format!("prts-prune-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("old")).unwrap();
        std::fs::create_dir_all(dir.join("new")).unwrap();
        std::fs::create_dir_all(dir.join(".staging.tmp")).unwrap();
        std::fs::write(dir.join("old/file.txt"), "x").unwrap();

        let stale = filetime::FileTime::from_unix_time(0, 0);
        filetime::set_file_mtime(dir.join("old"), stale).unwrap();
        filetime::set_file_mtime(dir.join(".staging.tmp"), stale).unwrap();

        let keep = HashSet::from([dir.join("new")]);
        prune_old_trees(&dir, &keep, 24 * 60 * 60 * 1000, true);
        assert!(!dir.join("old").exists());
        assert!(dir.join("new").exists());
        assert!(dir.join(".staging.tmp").exists()); // skipHidden

        prune_old_trees(&dir, &keep, 24 * 60 * 60 * 1000, false);
        assert!(!dir.join(".staging.tmp").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
