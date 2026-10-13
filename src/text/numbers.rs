//! Shared numeric rounding and JS number-to-string semantics — port of TS
//! `utils/numbers.ts` plus the formatting shims `data/enemyStats.ts` needs
//! (pythonFloatString / withThousands / formatNumber are pure number
//! formatting, so they sit next to their rounding twin).

/// Round midpoints away from zero (.NET numeric format semantics).
///
/// `Math.round` / Python's `round` differ across runtimes (half-up vs
/// banker's), so both sides share this explicit formula. A zero result is
/// normalized to +0 so formatting never emits "-0" / "-0%".
pub fn round_half_away(value: f64, decimals: i32) -> f64 {
    let factor = 10f64.powi(decimals);
    let rounded = (value.abs() * factor + 0.5).floor() / factor;
    if rounded == 0.0 {
        0.0
    } else {
        value.signum() * rounded
    }
}

/// ECMAScript `Number::toString` for the doubles the data domains format:
/// shortest round-trip decimal, integral values without a fraction part,
/// exponential notation outside [1e-6, 1e21) — matching V8/JSC output so
/// panel/stats text is byte-identical.
pub fn js_number_to_string(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_string();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
    }
    if value == 0.0 {
        return "0".to_string(); // String(-0) === "0"
    }
    let abs = value.abs();
    if !(1e-6..1e21).contains(&abs) {
        return js_exponential(value, abs);
    }
    // Rust's Display for f64 produces the shortest round-trip decimal and
    // omits ".0" for integral values — the same shape as ECMAScript in the
    // plain-notation range.
    format!("{value}")
}

/// `Number::toString` exponential form: shortest mantissa, "e+"/"e-" with a
/// sign and no leading zeros in the exponent.
fn js_exponential(value: f64, abs: f64) -> String {
    let digits = format!("{abs:e}"); // e.g. "1.25e-7"
    let (mantissa, exponent) = digits.split_once('e').expect("scientific form");
    let exponent: i32 = exponent.parse().expect("exponent parses");
    let sign = if value < 0.0 { "-" } else { "" };
    format!(
        "{sign}{mantissa}e{}{}",
        if exponent < 0 { '-' } else { '+' },
        exponent.abs()
    )
}

/// JS truthiness for a JSON value: null/false/0/""/NaN are falsy.
pub fn js_truthy(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Null => false,
        serde_json::Value::Bool(b) => *b,
        serde_json::Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        serde_json::Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// JS `Number.isInteger` on an f64.
pub fn is_js_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0
}

/// Mimic Python `str(float)` (TS pythonFloatString): integral doubles render
/// with a trailing ".0", everything else like JS String(number). Non-number
/// blackboard values stringify like a JS template literal.
pub fn python_float_string(value: &serde_json::Value) -> String {
    if let Some(n) = value.as_f64() {
        if is_js_integer(n) {
            return format!("{}.0", js_number_to_string(n));
        }
        return js_number_to_string(n);
    }
    // TS `String(value ?? 0)`: null/undefined stringify as "0".
    match value {
        serde_json::Value::Null => "0".to_string(),
        other => json_value_to_string(other),
    }
}

/// Locale-independent thousands separator for any number, mirroring the
/// unconditional Python `f"{n:,}"` (TS applies `/\B(?=(\d{3})+(?!\d))/g` to
/// the JS string form).
pub fn with_thousands(n: f64) -> String {
    apply_thousands(&js_number_to_string(n))
}

/// Int-gated thousands separator for unknown values (the stage-enemies
/// compact path): only `Number.isInteger` values get separators.
pub fn format_number(value: &serde_json::Value) -> String {
    if let Some(n) = value.as_f64() {
        if is_js_integer(n) {
            return with_thousands(n);
        }
        return js_number_to_string(n);
    }
    // TS `String(value ?? 0)`.
    match value {
        serde_json::Value::Null => "0".to_string(),
        other => json_value_to_string(other),
    }
}

/// Insert `,` at every position matched by `/\B(?=(\d{3})+(?!\d))/g`: between
/// two digits when the following digit run's length is a positive multiple
/// of 3 and the character after the run is not a digit.
fn apply_thousands(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let is_digit = |c: char| c.is_ascii_digit();
    let mut out = String::with_capacity(s.len() + s.len() / 3);
    for (i, &c) in chars.iter().enumerate() {
        if i > 0 && is_digit(chars[i - 1]) && is_digit(c) {
            let run_len = chars[i..].iter().take_while(|&&b| is_digit(b)).count();
            let after_run_non_digit = chars.get(i + run_len).is_none_or(|&b| !is_digit(b));
            if run_len >= 3 && run_len % 3 == 0 && after_run_non_digit {
                out.push(',');
            }
        }
        out.push(c);
    }
    out
}

/// `String(value)` for JSON-typed blackboard values: numbers via JS
/// semantics, strings verbatim, other types like a JS template literal.
pub fn json_value_to_string(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Null => "null".to_string(),
        serde_json::Value::Number(n) => js_number_to_string(n.as_f64().unwrap_or(0.0)),
        other => other.to_string(),
    }
}

/// `Number.prototype.toFixed(digits)` for the fixed formats the skill
/// placeholder renderer uses (0..=6 digits): round the double's EXACT
/// binary value half away from zero (V8 behavior probed on the oracle's
/// node: 0.5→"1", -0.5→"-1", 2.675→"2.67"), print exactly `digits`
/// fraction digits; >= 1e21 falls back to toString.
pub fn js_to_fixed(value: f64, digits: usize) -> String {
    if value.is_nan() {
        return "NaN".to_string();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
    }
    if value.abs() >= 1e21 {
        return js_number_to_string(value);
    }
    // Exact arithmetic: value = m · 2^e. Scale by 10^digits without binary
    // rounding, round the rational to an integer half away from zero, then
    // lay out the decimal point.
    let bits = value.to_bits();
    let negative = bits >> 63 == 1;
    let biased = ((bits >> 52) & 0x7FF) as i32;
    let mantissa = bits & 0xF_FFFF_FFFF_FFFF;
    let (m, e) = if biased == 0 {
        (mantissa, -1074i32)
    } else {
        (mantissa | (1u64 << 52), biased - 1075)
    };
    // scaled = m · 2^e · 10^d = m · 5^d · 2^(e+d)
    let m_scaled = (m as u128) * pow5(digits);
    let scaled: i128 = if e + digits as i32 >= 0 {
        (m_scaled as i128) << (e + digits as i32)
    } else {
        let shift = (-(e + digits as i32)) as u32;
        if shift >= 128 {
            // m_scaled < 2^128 <= half for shift >= 129 (round down); the
            // shift == 128 case compares against a computable half below.
            if shift == 128 && m_scaled >= (1u128 << 127) {
                1
            } else {
                0
            }
        } else {
            let quot = (m_scaled >> shift) as i128;
            let rem = (m_scaled & ((1u128 << shift) - 1)) as i128;
            // Round half away from zero on the exact rational.
            let half = 1i128 << (shift - 1);
            if rem >= half {
                quot + 1
            } else {
                quot
            }
        }
    };
    // Spec: the sign is decided by x's sign, not n's — (-0.04).toFixed(0)
    // prints "-0" (probed on the oracle's node).
    let sign = if negative { "-" } else { "" };
    let digits_val = scaled.unsigned_abs().to_string();
    if digits == 0 {
        return format!("{sign}{digits_val}");
    }
    let padded = format!("{digits_val:0>width$}", width = digits + 1);
    let split = padded.len() - digits;
    format!("{sign}{}.{}", &padded[..split], &padded[split..])
}

fn pow5(digits: usize) -> u128 {
    let mut v = 1u128;
    for _ in 0..digits {
        v *= 5;
    }
    v
}

/// Serialize an f64 with JS JSON number semantics: integral values (within
/// the safe-integer range) print without a fractional part.
pub fn json_number_value(f: f64) -> serde_json::Value {
    if f.fract() == 0.0 && f.is_finite() && f.abs() < 9.007199254740992e15 {
        serde_json::Value::from(f as i64)
    } else {
        serde_json::Number::from_f64(f)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn half_away_rounding() {
        assert_eq!(round_half_away(2.5, 0), 3.0);
        assert_eq!(round_half_away(-2.5, 0), -3.0);
        assert_eq!(round_half_away(1.25, 1), 1.3);
        assert_eq!(round_half_away(-0.25, 1), -0.3);
        let zero = round_half_away(-0.4, 0);
        assert_eq!(zero, 0.0);
        assert!(!zero.is_sign_negative()); // -0 normalized to +0
    }

    #[test]
    fn js_number_strings() {
        assert_eq!(js_number_to_string(1480.0), "1480");
        assert_eq!(js_number_to_string(10.0), "10");
        assert_eq!(js_number_to_string(0.5), "0.5");
        assert_eq!(js_number_to_string(3.7), "3.7");
        assert_eq!(js_number_to_string(-0.0), "0");
        assert_eq!(js_number_to_string(1e21), "1e+21");
        assert_eq!(js_number_to_string(1e-7), "1e-7");
        assert_eq!(js_number_to_string(1234.56), "1234.56");
        assert_eq!(js_number_to_string(2.675), "2.675");
    }

    #[test]
    fn python_float_strings() {
        assert_eq!(python_float_string(&json!(10.0)), "10.0");
        assert_eq!(python_float_string(&json!(0.5)), "0.5");
        assert_eq!(python_float_string(&json!(50)), "50.0");
        assert_eq!(python_float_string(&json!(3.7)), "3.7");
        assert_eq!(python_float_string(&serde_json::Value::Null), "0");
        assert_eq!(python_float_string(&json!("法术")), "法术");
    }

    #[test]
    fn thousands_separators() {
        assert_eq!(with_thousands(25000.0), "25,000");
        assert_eq!(with_thousands(1234.0), "1,234");
        assert_eq!(with_thousands(999.0), "999");
        assert_eq!(with_thousands(1234567.0), "1,234,567");
        assert_eq!(with_thousands(1234.5), "1,234.5");
        assert_eq!(format_number(&json!(1234)), "1,234");
        assert_eq!(format_number(&json!(1.5)), "1.5");
    }

    #[test]
    fn to_fixed_matches_v8_probes() {
        assert_eq!(js_to_fixed(0.5, 0), "1");
        assert_eq!(js_to_fixed(-0.5, 0), "-1");
        assert_eq!(js_to_fixed(1.5, 0), "2");
        assert_eq!(js_to_fixed(-1.5, 0), "-2");
        assert_eq!(js_to_fixed(27.5, 0), "28");
        assert_eq!(js_to_fixed(0.275 * 100.0, 0), "28");
        assert_eq!(js_to_fixed(0.35, 6), "0.350000");
        assert_eq!(js_to_fixed(30.0, 6), "30.000000");
        assert_eq!(js_to_fixed(115.0, 1), "115.0");
        assert_eq!(js_to_fixed(2.675, 2), "2.67");
        assert_eq!(js_to_fixed(1e21, 2), "1e+21");
        assert_eq!(js_to_fixed(0.0, 3), "0.000");
    }
}
