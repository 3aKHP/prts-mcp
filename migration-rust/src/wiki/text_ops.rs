//! Rust implementations of TS Wiki text helpers. Fixed ECMAScript expressions
//! are executed by the standalone native regex component, without a JS VM.

use crate::text::regex_compat::{JsRegex, DOT_ALL, IGNORE_CASE};

struct Rules {
    clean: Vec<(JsRegex, &'static str, bool)>,
    html: Vec<(JsRegex, &'static str, bool)>,
    named: JsRegex,
    redirect: JsRegex,
    technical: Vec<JsRegex>,
}

impl Rules {
    fn new() -> Result<Self, String> {
        let compile = |p: &str, flags| JsRegex::compile_flags(p, flags);
        let redirect = r"#\s*(?:重定向|REDIRECT)";
        let clean = [
            (r#"\s*"[^"]*"\s*:\s*"[^"]*"\s*,?\s*"#, " ", true, 0),
            (r"\|[一-鿿\w]+\s*=[^\n]*", "", true, 0),
            (redirect, "", false, IGNORE_CASE),
            (r"[ \t]+", " ", true, 0),
            (r",{2,}", "", true, 0),
            (r"\n{2,}", "\n", true, 0),
            (r"^[ ,\n]+|[ ,\n]+$", "", true, 0),
        ]
        .into_iter()
        .map(|(p, replacement, global, flags)| Ok((compile(p, flags)?, replacement, global)))
        .collect::<Result<_, String>>()?;
        let html = [
            (r"@(font-face|keyframes|media|import|charset|namespace|supports|page)[^{]*\{[^}]*\}|\(window\.RLQ\s*\|\|\s*\[\]\)\.push\([^)]*\)|<style[^>]*>.*?</style>|<script[^>]*>.*?</script>", "", true, IGNORE_CASE | DOT_ALL),
            (r"<[^>]+>", "", true, 0),
            (r"[ \t]+", " ", true, 0),
            (r"\n{3,}", "\n\n", true, 0),
        ].into_iter().map(|(p, replacement, global, flags)|
            Ok((compile(p, flags)?, replacement, global))).collect::<Result<_, String>>()?;
        let technical = [
            r"/(?:spine|data|db|lua|json|module)(?:$|[/:._-])",
            r"\.(?:json|lua)$",
            r"^(?:Widget|Template|Module|MediaWiki|模块|模板):",
        ]
        .into_iter()
        .map(|p| compile(p, IGNORE_CASE))
        .collect::<Result<_, _>>()?;
        Ok(Self {
            clean,
            html,
            technical,
            named: compile(r"&([a-zA-Z]+);", 0)?,
            redirect: compile(redirect, IGNORE_CASE)?,
        })
    }
}

thread_local! { static RULES: Result<Rules, String> = Rules::new(); }

fn with_rules<T>(f: impl FnOnce(&Rules) -> Result<T, String>) -> Result<T, String> {
    RULES.with(|r| match r {
        Ok(r) => f(r),
        Err(e) => Err(e.clone()),
    })
}

fn replace_rules(text: &str, rules: &[(JsRegex, &str, bool)]) -> Result<String, String> {
    let mut out = text.to_owned();
    for (regex, replacement, global) in rules {
        out = regex.replace(&out, *global, |_| Ok((*replacement).to_owned()))?;
    }
    Ok(out)
}

/// Preserve intermediate UTF-16 surrogate units until both numeric passes
/// finish: adjacent surrogate entities can produce a valid astral character.
fn numeric_entities(text: &[u16], hex: bool) -> Result<Vec<u16>, String> {
    let mut out = Vec::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        let start = i;
        if text.get(i..i + 2) == Some(&[b'&' as u16, b'#' as u16]) {
            let mut p = i + 2;
            if hex {
                if !text
                    .get(p)
                    .is_some_and(|&c| c == b'x' as u16 || c == b'X' as u16)
                {
                    out.push(text[i]);
                    i += 1;
                    continue;
                }
                p += 1;
            }
            let digits = p;
            let mut codepoint: Option<u32> = Some(0);
            while let Some(&c) = text.get(p) {
                let digit =
                    char::from_u32(c as u32).and_then(|c| c.to_digit(if hex { 16 } else { 10 }));
                let Some(digit) = digit else {
                    break;
                };
                codepoint = codepoint
                    .and_then(|v| v.checked_mul(if hex { 16 } else { 10 }))
                    .and_then(|v| v.checked_add(digit));
                p += 1;
            }
            if p > digits && text.get(p) == Some(&(b';' as u16)) {
                let value = codepoint
                    .filter(|&v| v <= 0x10ffff)
                    .ok_or_else(|| "Invalid code point in HTML entity".to_owned())?;
                if value < 0x10000 {
                    out.push(value as u16);
                } else {
                    out.push(0xd800 + ((value - 0x10000) >> 10) as u16);
                    out.push(0xdc00 + ((value - 0x10000) & 1023) as u16);
                }
                i = p + 1;
                continue;
            }
        }
        out.push(text[start]);
        i += 1;
    }
    Ok(out)
}

fn unescape_with_rules(text: &str, rules: &Rules) -> Result<String, String> {
    let decimal = numeric_entities(&text.encode_utf16().collect::<Vec<_>>(), false)?;
    let hex = numeric_entities(&decimal, true)?;
    let decoded = String::from_utf16(&hex).map_err(|_| "Invalid string encoding in HTML entity")?;
    rules.named.replace(&decoded, true, |entity| {
        let name = &entity[1..entity.len() - 1];
        // The frozen helper's entity table is an ordinary JS object: these
        // inherited names also resolve, and replace() coerces them to text.
        // Preserve that observable output without executing any JS.
        if name == "constructor" {
            return Ok("function Object() { [native code] }".to_owned());
        }
        if matches!(
            name,
            "toString"
                | "toLocaleString"
                | "valueOf"
                | "hasOwnProperty"
                | "isPrototypeOf"
                | "propertyIsEnumerable"
        ) {
            return Ok(format!("function {name}() {{\n    [native code]\n}}"));
        }
        let value = match name {
            "quot" => "\"",
            "amp" => "&",
            "lt" => "<",
            "gt" => ">",
            "apos" => "'",
            "nbsp" => " ",
            "mdash" => "—",
            "ndash" => "–",
            "hellip" => "…",
            "lsquo" => "‘",
            "rsquo" => "’",
            "ldquo" => "“",
            "rdquo" => "”",
            "copy" => "©",
            "reg" => "®",
            "trade" => "™",
            "times" => "×",
            "divide" => "÷",
            "plusmn" => "±",
            "bull" => "•",
            "middot" => "·",
            "shy" => "\u{ad}",
            _ => entity,
        };
        Ok(value.to_owned())
    })
}

pub fn unescape_html_entities(text: &str) -> Result<String, String> {
    with_rules(|r| unescape_with_rules(text, r))
}

pub fn clean_snippet(snippet: &str) -> Result<String, String> {
    with_rules(|r| replace_rules(snippet, &r.clean))
}

pub fn strip_html(text: &str) -> Result<String, String> {
    with_rules(|r| {
        let out = replace_rules(text, &r.html[..2])?;
        let out = unescape_with_rules(&out, r)?;
        let out = replace_rules(&out, &r.html[2..])?;
        Ok(out.trim_matches(js_whitespace).to_owned())
    })
}

fn js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

pub fn is_technical_page(title: &str) -> Result<bool, String> {
    with_rules(|r| {
        for pattern in &r.technical {
            if pattern.is_match(title)? {
                return Ok(true);
            }
        }
        Ok(false)
    })
}

pub fn is_redirect_like(snippet: &str) -> Result<bool, String> {
    with_rules(|r| r.redirect.is_match(snippet))
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entities_decode_like_the_oracle() {
        assert_eq!(unescape_html_entities("&amp;&lt;&gt;").unwrap(), "&<>");
        assert_eq!(unescape_html_entities("&#65;&#x4e2d;").unwrap(), "A中");
        // Unknown named entities survive verbatim.
        assert_eq!(unescape_html_entities("&nope;").unwrap(), "&nope;");
        assert_eq!(unescape_html_entities("&mdash;").unwrap(), "—");
        assert_eq!(unescape_html_entities("&nbsp;x").unwrap(), " x");
    }

    #[test]
    fn snippet_cleanup_drops_json_and_pipe_fragments() {
        assert_eq!(clean_snippet(r#"  "key": "value", rest"#).unwrap(), "rest");
        assert_eq!(clean_snippet("|参数=值\n正文").unwrap(), "正文");
        // The REDIRECT marker is removed but the target link stays; the
        // doubled commas collapse and edges trim.
        assert_eq!(
            clean_snippet("#REDIRECT [[阿米娅]],, x ,\n ").unwrap(),
            "[[阿米娅]] x"
        );
        assert_eq!(clean_snippet("A\n\n\nB").unwrap(), "A\nB");
    }

    #[test]
    fn strip_html_removes_css_js_blocks_and_tags() {
        let html = "<style>a{color:red}</style><p>正文</p><script>evil()</script>尾";
        assert_eq!(strip_html(html).unwrap(), "正文尾");
        // Entity decode happens after tag stripping.
        assert_eq!(strip_html("<p>&#20013;</p>").unwrap(), "中");
        // Three or more newlines collapse to two; horizontal space squeezes.
        assert_eq!(strip_html("a \t b\n\n\n\nc").unwrap(), "a b\n\nc");
        // The RLQ pattern consumes up to the FIRST ')' (like the oracle's
        // [^)]*), leaving the tail of the expression behind.
        assert_eq!(
            strip_html("(window.RLQ || []).push(function(){});after").unwrap(),
            "{});after"
        );
    }

    #[test]
    fn technical_page_patterns() {
        assert!(is_technical_page("干员/spine/阿米娅").unwrap());
        assert!(!is_technical_page("干员/spine阿米娅").unwrap()); // spine must end the segment
        assert!(is_technical_page("关卡/data/1-7").unwrap());
        assert!(is_technical_page("Something.json").unwrap());
        assert!(is_technical_page("Template:干员").unwrap());
        assert!(is_technical_page("模块:数据").unwrap());
        assert!(!is_technical_page("阿米娅").unwrap());
        assert!(!is_technical_page("主流战术/datax").unwrap()); // data must end the segment
    }

    #[test]
    fn redirect_like_detection() {
        assert!(is_redirect_like("#REDIRECT [[阿米娅]]").unwrap());
        assert!(is_redirect_like("# 重定向 [[x]]").unwrap());
        assert!(!is_redirect_like("普通文本").unwrap());
    }
}
