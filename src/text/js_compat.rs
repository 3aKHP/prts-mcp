//! JavaScript string/number semantics the oracle relies on.
//!
//! JS strings are UTF-16 code unit sequences; Rust strings are UTF-8. The
//! oracle's `compareIds` is a plain JS relational comparison (UTF-16 code
//! unit order — `data/sort.ts`), and its `slice()` cuts at code unit
//! boundaries, which can split surrogate pairs. These helpers keep those
//! semantics explicit instead of silently using Rust byte order.

use std::cmp::Ordering;

/// JS `<`/`>` relational comparison on UTF-16 code units (compareIds).
pub fn compare_ids(a: &str, b: &str) -> Ordering {
    let mut ia = a.chars();
    let mut ib = b.chars();
    loop {
        match (ia.next(), ib.next()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(ca), Some(cb)) => {
                let ua = ca as u32;
                let ub = cb as u32;
                // Encode to UTF-16 on the fly: a char outside the BMP becomes
                // a surrogate pair, and the first unit decides the order.
                let head_a = if ua > 0xFFFF {
                    (ua - 0x10000) / 0x400 + 0xD800
                } else {
                    ua
                };
                let head_b = if ub > 0xFFFF {
                    (ub - 0x10000) / 0x400 + 0xD800
                } else {
                    ub
                };
                if head_a != head_b {
                    return head_a.cmp(&head_b);
                }
                if ua <= 0xFFFF && ub <= 0xFFFF {
                    continue;
                }
                let tail_a = if ua > 0xFFFF {
                    (ua - 0x10000) % 0x400 + 0xDC00
                } else {
                    ua
                };
                let tail_b = if ub > 0xFFFF {
                    (ub - 0x10000) % 0x400 + 0xDC00
                } else {
                    ub
                };
                if tail_a != tail_b {
                    return tail_a.cmp(&tail_b);
                }
            }
        }
    }
}

/// JS `String.prototype.slice(start, end)` on UTF-16 code unit indices.
///
/// A cut inside a surrogate pair leaves a lone surrogate in JS; since Rust
/// strings cannot hold one, the orphan unit is replaced with U+FFFD — the
/// same character a UTF-8 round-trip of the JS string would show. The J1
/// boundary probe in reports/P1.md documents this input-set difference.
pub fn js_slice(s: &str, start: usize, end: usize) -> String {
    if start >= end {
        return String::new();
    }
    let units: Vec<u16> = s.encode_utf16().collect();
    let start = start.min(units.len());
    let end = end.min(units.len());
    String::from_utf16_lossy(&units[start..end])
}

/// JS `Number.isInteger` semantics for a JSON number: integral f64 counts as
/// integer (JS cannot distinguish `1` from `1.0`).
pub fn json_number_is_integer(n: &serde_json::Number) -> bool {
    match n.as_i64() {
        Some(_) => true,
        None => n
            .as_f64()
            .is_some_and(|f| f.fract() == 0.0 && f.is_finite()),
    }
}

/// JS `Number.isFinite` + integral check returning the i64 value.
pub fn json_number_as_integer(n: &serde_json::Number) -> Option<i64> {
    n.as_i64().or_else(|| {
        let f = n.as_f64()?;
        if f.fract() == 0.0 && f.is_finite() && f >= -(2f64.powi(53)) && f <= 2f64.powi(53) {
            Some(f as i64)
        } else {
            None
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering;

    #[test]
    fn utf16_order_matches_js_examples() {
        // JS `<` puts uppercase before lowercase (S1 from the audit corpus).
        assert_eq!(compare_ids("AP_GAMEPLAY", "ap_item_1"), Ordering::Less);
        // '+' (0x2B) sorts before '.' (0x2E) — localeCompare would disagree (S2).
        assert_eq!(compare_ids("1+.png", "1.png"), Ordering::Less);
        // Prefix rule: shorter string first (S3, matches the golden order).
        assert_eq!(compare_ids("main_00-01", "main_00-01#f#"), Ordering::Less);
    }

    #[test]
    fn utf16_order_astral_boundary() {
        // U+10000 encodes to surrogates starting 0xD800; U+FFFD is a single
        // unit 0xFFFD > 0xD800, so the astral char sorts first in UTF-16 but
        // AFTER U+FFFD in UTF-8 byte order (0xEF ... > 0xF0 ...).
        let astral = "\u{10000}";
        let bmp = "\u{FFFD}";
        assert_eq!(compare_ids(astral, bmp), Ordering::Less);
        // Rust's own byte-order sort disagrees (0xEF… < 0xF0…), which is
        // exactly why compare_ids exists instead of str::cmp.
        let mut rust_sorted = vec![bmp.to_string(), astral.to_string()];
        rust_sorted.sort();
        assert_eq!(rust_sorted, vec![bmp.to_string(), astral.to_string()]);
    }

    #[test]
    fn js_slice_cuts_code_units() {
        let s = "ab米de";
        assert_eq!(js_slice(s, 0, 3), "ab米");
        assert_eq!(js_slice(s, 10, 20), "");
        // Splitting the surrogate pair of U+20BB7 yields U+FFFD + nothing valid.
        let pair = "\u{20BB7}x";
        assert_eq!(js_slice(pair, 0, 1), "\u{FFFD}");
        assert_eq!(js_slice(pair, 1, 2), "\u{FFFD}");
    }

    #[test]
    fn integral_floats_are_integers() {
        let one_point_zero: serde_json::Number =
            serde_json::from_str::<serde_json::Number>("1.0").unwrap();
        assert!(json_number_is_integer(&one_point_zero));
        assert_eq!(json_number_as_integer(&one_point_zero), Some(1));
        let one_point_five: serde_json::Number =
            serde_json::from_str::<serde_json::Number>("1.5").unwrap();
        assert!(!json_number_is_integer(&one_point_five));
        assert_eq!(json_number_as_integer(&one_point_five), None);
    }
}
