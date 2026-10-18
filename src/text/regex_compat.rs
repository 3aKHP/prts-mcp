//! ECMAScript regex semantics, using only the statically linked native
//! regexp/Unicode components. No JavaScript VM or executable JS is involved.
//! User patterns retain the `new RegExp(pattern, "iu")` contract.

use std::cell::RefCell;
use std::ffi::{c_char, c_int, CStr};

unsafe extern "C" {
    fn prts_re_compile(
        pattern: *const c_char,
        length: usize,
        flags: c_int,
        length_out: *mut c_int,
        error: *mut c_char,
        error_length: c_int,
    ) -> *mut u8;
    fn prts_re_free(ptr: *mut std::ffi::c_void);
    fn prts_re_exec(
        bytecode: *const u8,
        text: *const u16,
        length: c_int,
        start: c_int,
        match_start: *mut c_int,
        match_end: *mut c_int,
        cancel: extern "C" fn(*mut std::ffi::c_void) -> c_int,
        cancel_opaque: *mut std::ffi::c_void,
    ) -> c_int;
    fn prts_re_prefix(
        bytecode: *const u8,
        length: c_int,
        prefix: *mut u32,
        capacity: c_int,
        insensitive: *mut c_int,
        complete: *mut c_int,
    ) -> c_int;
    #[cfg(test)]
    fn prts_re_fold(codepoint: u32) -> c_int;
}

/// Flags for the crate's fixed Wiki patterns. User patterns always use IU.
pub(crate) const IGNORE_CASE: i32 = 2;
pub(crate) const DOT_ALL: i32 = 8;
const UNICODE: i32 = 16;

enum Prefix {
    Exact(String),
    AsciiFold {
        literal: String,
        special_folds: bool,
    },
}

/// One immutable compiled native regex plus reusable UTF-16 scratch space.
/// The name denotes ECMAScript semantics, not a JavaScript runtime.
pub struct JsRegex {
    bytecode: Vec<u8>,
    scratch: RefCell<Vec<u16>>,
    prefix: Option<Prefix>,
    complete_literal: bool,
}

impl JsRegex {
    pub fn compile(pattern: &str) -> Result<Self, String> {
        Self::compile_flags(pattern, IGNORE_CASE | UNICODE)
    }

    pub(crate) fn compile_flags(pattern: &str, flags: i32) -> Result<Self, String> {
        let mut source = pattern.as_bytes().to_vec();
        source.push(0); // The native compiler requires a trailing NUL, with explicit length.
        let mut length = 0;
        let mut error = [0 as c_char; 256];
        // SAFETY: source/error/out pointers are live for the synchronous call;
        // native bytecode is copied before releasing its C allocator ownership.
        let ptr = unsafe {
            prts_re_compile(
                source.as_ptr().cast(),
                pattern.len(),
                flags,
                &mut length,
                error.as_mut_ptr(),
                error.len() as i32,
            )
        };
        if ptr.is_null() {
            return Err(unsafe { CStr::from_ptr(error.as_ptr()) }
                .to_string_lossy()
                .into_owned());
        }
        let bytecode = unsafe { std::slice::from_raw_parts(ptr, length as usize) }.to_vec();
        unsafe { prts_re_free(ptr.cast()) };
        let (prefix, complete_literal) = Self::literal_prefix(&bytecode, flags);
        Ok(Self {
            bytecode,
            scratch: RefCell::new(Vec::new()),
            prefix,
            complete_literal,
        })
    }

    fn literal_prefix(bytecode: &[u8], flags: i32) -> (Option<Prefix>, bool) {
        // Only IU public searches use the shortcut. Wiki replacement needs exact ranges.
        if flags != IGNORE_CASE | UNICODE {
            return (None, false);
        }
        let mut points = [0u32; 32];
        let (mut insensitive, mut complete) = (0, 0);
        // SAFETY: bytecode comes solely from the pinned compiler; output buffer capacity is exact.
        let n = unsafe {
            prts_re_prefix(
                bytecode.as_ptr(),
                bytecode.len() as i32,
                points.as_mut_ptr(),
                points.len() as i32,
                &mut insensitive,
                &mut complete,
            )
        };
        let chars: Option<String> = points[..n as usize]
            .iter()
            .map(|&c| char::from_u32(c))
            .collect();
        let Some(text) = chars.filter(|s| !s.is_empty()) else {
            return (None, false);
        };
        let prefix = if insensitive == 0
            || text.chars().all(|c| {
                ('\u{4e00}'..='\u{9fff}').contains(&c) || (c.is_ascii() && !c.is_ascii_alphabetic())
            }) {
            Some(Prefix::Exact(text))
        } else if text.is_ascii() {
            let special_folds = text.contains('s') || text.contains('k');
            Some(Prefix::AsciiFold {
                literal: text,
                special_folds,
            })
        } else {
            None
        };
        (prefix, complete != 0)
    }

    /// Conservative block prefilter: binary metadata may add false positives.
    pub(crate) fn may_match_bytes(&self, bytes: &[u8]) -> bool {
        match &self.prefix {
            Some(Prefix::Exact(text)) => memchr::memmem::find(bytes, text.as_bytes()).is_some(),
            Some(Prefix::AsciiFold { literal, .. }) => ascii_iu_contains(bytes, literal.as_bytes()),
            None => true,
        }
    }

    pub fn is_match(&self, text: &str) -> Result<bool, String> {
        super::cancellation::check()?;
        if let Some(prefix) = &self.prefix {
            let found = match prefix {
                Prefix::Exact(literal) => text.contains(literal),
                Prefix::AsciiFold {
                    literal,
                    special_folds,
                } => {
                    // Under /iu, long s and Kelvin sign are the only non-ASCII
                    // folds into ASCII. Keep these equivalent inputs in the native engine.
                    match ascii_fold_contains(text.as_bytes(), literal.as_bytes(), *special_folds) {
                        Some(found) => found,
                        None => return self.native_match(text),
                    }
                }
            };
            if !found {
                return Ok(false);
            }
            if self.complete_literal {
                return Ok(true);
            }
        }
        self.native_match(text)
    }

    fn native_match(&self, text: &str) -> Result<bool, String> {
        let mut buffer = self.scratch.borrow_mut();
        buffer.clear();
        buffer.extend(text.encode_utf16());
        Ok(self.find_utf16(&buffer, 0)?.is_some())
    }

    fn find_utf16(&self, buffer: &[u16], start: usize) -> Result<Option<(usize, usize)>, String> {
        let length =
            i32::try_from(buffer.len()).map_err(|_| "Regular expression input too long")?;
        let (mut from, mut to) = (0, 0);
        // SAFETY: buffer is aligned UTF-16, bytecode is compiler-owned immutable data;
        // captures remain inside the buffer and the bridge returns offsets only.
        match unsafe {
            prts_re_exec(
                self.bytecode.as_ptr(),
                buffer.as_ptr(),
                length,
                start as i32,
                &mut from,
                &mut to,
                super::cancellation::cancelled,
                std::ptr::null_mut(),
            )
        } {
            0 => Ok(None),
            1 => Ok(Some((from as usize, to as usize))),
            error => Err(format!(
                "Native regular expression execution failed ({error})"
            )),
        }
    }

    /// Native replacement for the fixed Wiki expressions; no dynamic replacement code.
    pub(crate) fn replace(
        &self,
        text: &str,
        global: bool,
        mut replacement: impl FnMut(&str) -> Result<String, String>,
    ) -> Result<String, String> {
        let buffer: Vec<u16> = text.encode_utf16().collect();
        let mut offsets = Vec::with_capacity(buffer.len() + 1);
        for (byte, c) in text.char_indices() {
            offsets.push(byte);
            if c.len_utf16() == 2 {
                offsets.push(usize::MAX);
            }
        }
        offsets.push(text.len());
        let (mut cursor, mut copied) = (0, 0);
        let mut out = String::with_capacity(text.len());
        while cursor <= buffer.len() {
            let Some((from, to)) = self.find_utf16(&buffer, cursor)? else {
                break;
            };
            let (begin, end) = (offsets[from], offsets[to]);
            if begin == usize::MAX || end == usize::MAX {
                return Err("Replacement splits a Unicode surrogate pair".into());
            }
            out.push_str(&text[copied..begin]);
            out.push_str(&replacement(&text[begin..end])?);
            copied = end;
            if !global {
                break;
            }
            cursor = if to == from { to + 1 } else { to };
        }
        out.push_str(&text[copied..]);
        Ok(out)
    }
}

// ASCII IU prefixes have only two non-ASCII equivalents in the pinned
// QuickJS Unicode table: long s and Kelvin sign. Match those explicitly so
// arbitrary non-ASCII bytes after an unrelated ASCII candidate do not force
// an entire text block through the native engine.
fn ascii_iu_contains(text: &[u8], literal: &[u8]) -> bool {
    let first = literal[0].to_ascii_lowercase();
    let matches_at = |mut cursor: usize| {
        for expected in literal {
            let expected = expected.to_ascii_lowercase();
            let Some(&actual) = text.get(cursor) else {
                return false;
            };
            if actual.is_ascii() && actual.to_ascii_lowercase() == expected {
                cursor += 1;
            } else if expected == b's' && text[cursor..].starts_with("ſ".as_bytes()) {
                cursor += 2;
            } else if expected == b'k' && text[cursor..].starts_with("K".as_bytes()) {
                cursor += 3;
            } else {
                return false;
            }
        }
        true
    };
    if first == b's' || first == b'k' {
        memchr::memchr3_iter(
            first,
            first.to_ascii_uppercase(),
            if first == b's' { 0xc5 } else { 0xe2 },
            text,
        )
        .any(matches_at)
    } else {
        memchr::memchr2_iter(first, first.to_ascii_uppercase(), text).any(matches_at)
    }
}

fn ascii_fold_contains(text: &[u8], literal: &[u8], special_folds: bool) -> Option<bool> {
    let first = literal[0];
    if (first == b's' && memchr::memmem::find(text, "ſ".as_bytes()).is_some())
        || (first == b'k' && memchr::memmem::find(text, "K".as_bytes()).is_some())
    {
        return None;
    }
    for pos in memchr::memchr2_iter(first.to_ascii_lowercase(), first.to_ascii_uppercase(), text) {
        if let Some(candidate) = text.get(pos..pos + literal.len()) {
            if candidate.eq_ignore_ascii_case(literal) {
                return Some(true);
            }
            // A non-ASCII unit can hide an s/k equivalent within a candidate.
            if special_folds && !candidate.is_ascii() {
                return None;
            }
        }
    }
    Some(false)
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn block_ascii_prefilter_matches_native_unicode_folds() {
        for pattern in ["sqlite_poc_absent", "ask", "sk", "k", "s", "SQLITE"] {
            let re = JsRegex::compile(pattern).unwrap();
            for text in [
                "S汉字",
                "😀S汉字sqlite_poc_absent",
                "aſK",
                "ſK",
                "K",
                "ſ",
                "SQLITE",
                "sqlite",
                "aSk",
                "",
            ] {
                assert_eq!(
                    re.may_match_bytes(text.as_bytes()),
                    re.native_match(text).unwrap(),
                    "{pattern:?} {text:?}"
                );
            }
        }
    }

    #[test]
    fn unicode_table_proves_literal_shortcut_folding_assumptions() {
        // Verify against the exact compiled native table, not Rust's unrelated Unicode version.
        for c in 0..=0x10ffff {
            let folded = unsafe { prts_re_fold(c) } as u32;
            if c >= 128 && folded < 128 {
                assert!(matches!((c, folded), (0x17f, 0x73) | (0x212a, 0x6b)));
            }
            if (0x4e00..=0x9fff).contains(&c) || (0x4e00..=0x9fff).contains(&folded) {
                assert_eq!(c, folded);
            }
        }
    }

    #[test]
    fn mandatory_prefix_shortcut_keeps_native_results() {
        let patterns = [
            "阿米娅",
            "阿米娅(?=。)",
            "阿米娅|罗德岛",
            "阿米?娅",
            "(阿)米娅",
            "(阿米娅)?",
            "阿{0,2}米娅",
            "阿{1,2}米娅",
            "PRTS_BENCH",
            "ask",
            "sk",
            "S",
            "K",
            r"\x61sk",
            r"阿\u7c73娅",
            "abc(?=d)",
            "(?-i:Abc)",
            "a(?-i:B)c",
        ];
        let texts = [
            "",
            "阿米娅",
            "阿米娅。",
            "阿娅",
            "罗德岛",
            "阿阿米娅",
            "博士",
            "ASK",
            "aſK",
            "aſk",
            "asK",
            "ſK",
            "ſ",
            "K",
            "abCd",
            "aBc",
            "Abc",
            "A😀",
            "😀阿米娅",
        ];
        for pattern in patterns {
            let re = JsRegex::compile(pattern).unwrap();
            for text in texts {
                if re.native_match(text).unwrap() {
                    let mut block = vec![0, 255, 0, 0, 0, 0, 0, 0, 0];
                    block.extend_from_slice(text.as_bytes());
                    block.extend_from_slice(&[0, 255, 0]);
                    assert!(
                        re.may_match_bytes(&block),
                        "block prefilter lost {pattern:?}: {text:?}"
                    );
                }
                assert_eq!(
                    re.is_match(text).unwrap(),
                    re.native_match(text).unwrap(),
                    "unsafe shortcut for pattern={pattern:?}, text={text:?}"
                );
            }
        }
    }

    #[test]
    fn deeply_nested_patterns_fail_without_overflowing_the_native_stack() {
        assert!(JsRegex::compile(&"(".repeat(10_000)).is_err());
    }

    #[test]
    fn basic_iu_matching() {
        let re = JsRegex::compile("amiya").expect("compile");
        assert!(re.is_match("阿米娅 Amiya").expect("match"));
        assert!(!re.is_match("陈").expect("match"));
    }

    #[test]
    fn empty_pattern_matches_everything() {
        let re = JsRegex::compile("").expect("compile");
        assert!(re.is_match("").expect("match"));
        assert!(re.is_match("任意").expect("match"));
    }

    #[test]
    fn invalid_pattern_rejected() {
        assert!(JsRegex::compile("(").is_err());
        assert!(JsRegex::compile("[").is_err());
    }

    #[test]
    fn unicode_and_lookaround_supported() {
        // R8: Unicode property escapes.
        let re = JsRegex::compile("\\p{Script=Han}+").expect("compile");
        assert!(re.is_match("龙门近卫局").expect("match"));
        assert!(!re.is_match("Rhodes Island").expect("match"));
        // R9/R10: look-around (beyond the Rust regex crate).
        let la = JsRegex::compile("娅(?=塔)").expect("compile");
        assert!(la.is_match("阿米娅塔").expect("match"));
        assert!(!la.is_match("阿米娅").expect("match"));
        let lb = JsRegex::compile("(?<=阿米)娅").expect("compile");
        assert!(lb.is_match("阿米娅").expect("match"));
        assert!(!lb.is_match("凯尔希娅").expect("match"));
    }

    #[test]
    fn backreference_and_digit_semantics() {
        let re = JsRegex::compile("(?<name>阿米娅)\\k<name>").expect("compile");
        assert!(re.is_match("阿米娅阿米娅").expect("match"));
        // JS \d is ASCII-only even with the u flag.
        let digit = JsRegex::compile("\\d").expect("compile");
        assert!(digit.is_match("第2章").expect("match"));
        assert!(!digit.is_match("２０００").expect("match"));
    }
}
