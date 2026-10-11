//! Wikitext sanitiser — port of TS `utils/sanitizer.ts`.
//!
//! Six sequential regex passes in the oracle's exact order; each is
//! reimplemented as a linear scan over the same character classes (all
//! patterns are ASCII-anchored except the literal namespace words).

/// Remove common wikitext markup and return plain text.
pub fn strip_wikitext(text: &str) -> String {
    let text = remove_templates(text);
    let text = remove_media_links(&text);
    let text = keep_link_display(&text);
    let text = unwrap_links(&text);
    let text = remove_html_tags(&text);
    let text = remove_category_links(&text);
    collapse_blank_lines(&text).trim().to_string()
}

/// `/\{\{[^}]*\}\}/g` — non-greedy single-level template blocks.
fn remove_templates(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '{' && chars.get(i + 1) == Some(&'{') {
            // Match {{ [^}]* }} — scan for the first '}' followed by '}'.
            if let Some(close) = find_double_close(&chars, i + 2) {
                i = close + 2;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// Position of the '}' that starts a '}}' at/after `from`, per `[^}]*}}`:
/// the run between must contain no '}'.
fn find_double_close(chars: &[char], from: usize) -> Option<usize> {
    let mut i = from;
    while i < chars.len() {
        if chars[i] == '}' {
            if chars.get(i + 1) == Some(&'}') {
                return Some(i);
            }
            return None; // [^}]* cannot cross a lone '}'
        }
        i += 1;
    }
    None
}

/// `\[\[(File|文件|Image|图像):[^\]]*\]\]` — image/media links vanish.
fn remove_media_links(text: &str) -> String {
    replace_prefixed_links(text, &["File", "文件", "Image", "图像"], |_, _| {
        String::new()
    })
}

/// `\[\[[^|\]]*\|([^\]]+)\]\]` → `$1` — piped links keep the display text.
fn keep_link_display(text: &str) -> String {
    replace_prefixed_links(text, &[], |inner, _| {
        // inner is "target|display"; `[^|\]]*` may be empty, `([^\]]+)` may
        // not — an empty display falls through to the unwrap pass.
        match inner.find('|') {
            Some(idx) if idx + 1 < inner.len() => inner[idx + 1..].to_string(),
            _ => inner.to_string(), // no (valid) pipe: leave for the next pass
        }
    })
}

/// `\[\[([^\]]+)\]\]` → `$1`.
fn unwrap_links(text: &str) -> String {
    replace_prefixed_links(text, &[], |inner, _| inner.to_string())
}

/// `\[\[(Category|分类):[^\]]*\]\]`.
fn remove_category_links(text: &str) -> String {
    replace_prefixed_links(text, &["Category", "分类"], |_, _| String::new())
}

/// Shared scanner for `\[\[(prefixes)?:…\]\]`-shaped passes: walks the
/// string, and for each `[[…]]` span whose content has no ']' calls `render`
/// with the inner text and the offset of the first ':' when a prefix matched.
/// With empty `prefixes` every span is rewritten through `render`.
fn replace_prefixed_links(
    text: &str,
    prefixes: &[&str],
    render: impl Fn(&str, bool) -> String,
) -> String {
    let mut out = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '[' && chars.get(i + 1) == Some(&'[') {
            if let Some(close) = find_link_close(&chars, i + 2) {
                let inner: String = chars[i + 2..close].iter().collect();
                if prefixes.is_empty() {
                    out.push_str(&render(&inner, false));
                    i = close + 2;
                    continue;
                }
                // Prefix match: "Prefix:" at the start of the inner text.
                let matched = prefixes.iter().any(|p| {
                    inner
                        .strip_prefix(p)
                        .is_some_and(|rest| rest.starts_with(':'))
                });
                if matched {
                    out.push_str(&render(&inner, true));
                    i = close + 2;
                    continue;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// Position of the ']' starting `]]` at/after `from`; `[^\]]*` cannot cross
/// any ']'.
fn find_link_close(chars: &[char], from: usize) -> Option<usize> {
    let mut i = from;
    while i < chars.len() {
        if chars[i] == ']' {
            if chars.get(i + 1) == Some(&']') {
                return Some(i);
            }
            return None;
        }
        i += 1;
    }
    None
}

/// `<[^>]+>` — HTML-ish tags. Public: the building-skill description cleaner
/// applies this pass alone (without the rest of the wikitext passes).
pub fn strip_html_tags(text: &str) -> String {
    remove_html_tags(text)
}

/// `<[^>]+>` — HTML-ish tags.
fn remove_html_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '<' {
            if let Some(close) = chars[i + 1..].iter().position(|&c| c == '>') {
                if close >= 1 {
                    i = i + 1 + close + 1;
                    continue;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// `\n{3,}` → `\n\n`.
fn collapse_blank_lines(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut run = 0usize;
    for ch in text.chars() {
        if ch == '\n' {
            run += 1;
            if run <= 2 {
                out.push(ch);
            }
        } else {
            run = 0;
            out.push(ch);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_templates_and_links() {
        assert_eq!(strip_wikitext("{{cba|50}}纯文本"), "纯文本");
        assert_eq!(strip_wikitext("[[文件:icon.png]]描述"), "描述");
        assert_eq!(strip_wikitext("[[源石|源石晶体]]材料"), "源石晶体材料");
        assert_eq!(strip_wikitext("[[罗德岛]]"), "罗德岛");
        assert_eq!(strip_wikitext("<@ba.kw>法术伤害</>"), "法术伤害");
        // The category pass is dead code in the oracle: the earlier
        // [[x]]→x unwrap consumes those spans first (probed on the frozen
        // oracle — behavior wins over the pass's name).
        assert_eq!(strip_wikitext("[[Category:干员]]卡片"), "Category:干员卡片");
        assert_eq!(strip_wikitext("[[分类:材料]]物品"), "分类:材料物品");
        assert_eq!(
            strip_wikitext("攻击回复技力<@ba.talpu>（+2）</>"),
            "攻击回复技力（+2）"
        );
    }

    #[test]
    fn collapses_and_trims() {
        assert_eq!(strip_wikitext("a\n\n\n\nb"), "a\n\nb");
        assert_eq!(strip_wikitext("  边距  "), "边距");
        // Non-greedy template: inner '}}' of a nested pair closes the first.
        assert_eq!(strip_wikitext("{{a{{b}}c}}x"), "c}}x");
        // Empty pipe target still matches `[^|\]]*\|([^\]]+)`.
        assert_eq!(strip_wikitext("[[|显示]]文本"), "显示文本");
        // Empty display falls to the unwrap pass and keeps the pipe.
        assert_eq!(strip_wikitext("[[目标|]]"), "目标|");
    }

    #[test]
    fn keeps_unterminated_spans() {
        assert_eq!(strip_wikitext("{{未闭合"), "{{未闭合");
        assert_eq!(strip_wikitext("[[未闭合"), "[[未闭合");
        assert_eq!(strip_wikitext("a<b"), "a<b");
    }
}
