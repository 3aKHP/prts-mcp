//! Lenient XML parser shaped like fast-xml-parser's `preserveOrder` output —
//! the consumption contract of TS `templateRenderer.ts`.
//!
//! Leniency is pinned to the frozen oracle's engine, probed directly:
//! mismatched close tags are accepted (inner element closed), unterminated
//! elements auto-close at EOF, `garbage <<<<` throws, empty input parses to
//! an empty document. A strict parser would diverge on the first two.

#[derive(Debug, Clone, PartialEq)]
pub enum XmlNode {
    /// `{ "#text": s }` — raw (untrimmed) text with entities decoded.
    Text(String),
    /// `{ "#comment": s }`.
    Comment(String),
    /// `{ tag: children, ":@": attrs }`.
    Element {
        tag: String,
        attrs: Vec<(String, String)>,
        children: Vec<XmlNode>,
    },
}

/// Open element on the parser stack: tag, attributes, children so far.
type OpenElement = (String, Vec<(String, String)>, Vec<XmlNode>);

/// Parse failure marker → the caller maps it to 页面模板数据格式无效。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct XmlParseError;
pub fn parse_lenient(xml: &str) -> Result<Vec<XmlNode>, XmlParseError> {
    let chars: Vec<char> = xml.chars().collect();
    let mut i = 0usize;
    // Stack of open elements (index into `nodes` arenas via paths).
    let mut root: Vec<XmlNode> = Vec::new();
    let mut stack: Vec<OpenElement> = Vec::new();
    let mut text = String::new();

    macro_rules! flush_text {
        () => {
            if !text.is_empty() {
                let decoded = decode_entities(&text);
                if let Some((_, _, children)) = stack.last_mut() {
                    children.push(XmlNode::Text(decoded));
                } else {
                    root.push(XmlNode::Text(decoded));
                }
                text.clear();
            }
        };
    }

    while i < chars.len() {
        if chars[i] == '<' {
            // Comment?
            if starts_with(&chars, i, "<!--") {
                flush_text!();
                match find_seq(&chars, i + 4, "-->") {
                    Some(end) => {
                        push_node(
                            &mut stack,
                            &mut root,
                            XmlNode::Comment(chars[i + 4..end].iter().collect()),
                        );
                        i = end + 3;
                        continue;
                    }
                    None => {
                        // Unterminated comment consumes the rest (FXP does
                        // not error here either).
                        push_node(
                            &mut stack,
                            &mut root,
                            XmlNode::Comment(chars[i + 4..].iter().collect()),
                        );
                        i = chars.len();
                        continue;
                    }
                }
            }
            // CDATA?
            if starts_with(&chars, i, "<![CDATA[") {
                match find_seq(&chars, i + 9, "]]>") {
                    Some(end) => {
                        text.push_str(&chars[i + 9..end].iter().collect::<String>());
                        i = end + 3;
                        continue;
                    }
                    None => {
                        text.push_str(&chars[i + 9..].iter().collect::<String>());
                        i = chars.len();
                        continue;
                    }
                }
            }
            // Processing instruction or doctype → dropped (FXP default).
            if starts_with(&chars, i, "<?") || starts_with(&chars, i, "<!") {
                match find_seq(&chars, i + 2, ">") {
                    Some(end) => {
                        flush_text!();
                        i = end + 1;
                        continue;
                    }
                    None => {
                        i = chars.len();
                        continue;
                    }
                }
            }
            // Closing tag?
            if starts_with(&chars, i, "</") {
                let Some((name, after_name)) = read_tag_name(&chars, i + 2) else {
                    return Err(XmlParseError);
                };
                let mut j = after_name;
                skip_ws(&chars, &mut j);
                if chars.get(j) == Some(&'>') {
                    j += 1;
                } else if chars.get(j) == Some(&'/') && chars.get(j + 1) == Some(&'>') {
                    j += 2;
                } else {
                    return Err(XmlParseError);
                }
                flush_text!();
                // Close the innermost matching open element; everything
                // opened after it is implicitly closed (probed FXP rule).
                if let Some(pos) = stack.iter().rposition(|(t, _, _)| *t == name) {
                    while stack.len() > pos {
                        let (tag, attrs, children) = stack.pop().expect("nonempty");
                        push_node(
                            &mut stack,
                            &mut root,
                            XmlNode::Element {
                                tag,
                                attrs,
                                children,
                            },
                        );
                    }
                }
                // No matching open element → ignore the stray close tag.
                i = j;
                continue;
            }
            // Opening tag.
            let Some((name, after)) = read_tag_name(&chars, i + 1) else {
                // A bare '<' that starts no construct — probed FXP behavior:
                // input like `<<<<` throws; a lone '<' followed by a space or
                // text is kept as text by FXP, but `<` + tag-name chars that
                // never close is a throw.
                return Err(XmlParseError);
            };
            flush_text!();
            let mut j = after;
            let mut attrs = Vec::new();
            let mut self_closing = false;
            loop {
                skip_ws(&chars, &mut j);
                if j >= chars.len() {
                    return Err(XmlParseError);
                }
                if chars[j] == '>' {
                    j += 1;
                    break;
                }
                if chars[j] == '/' && chars.get(j + 1) == Some(&'>') {
                    self_closing = true;
                    j += 2;
                    break;
                }
                // attribute
                let Some((attr_name, after_name)) = read_attr_name(&chars, j) else {
                    return Err(XmlParseError);
                };
                j = after_name;
                skip_ws(&chars, &mut j);
                let value = if j < chars.len() && chars[j] == '=' {
                    j += 1;
                    skip_ws(&chars, &mut j);
                    let Some((v, after_v)) = read_attr_value(&chars, j) else {
                        return Err(XmlParseError);
                    };
                    j = after_v;
                    v
                } else {
                    String::new()
                };
                attrs.push((attr_name, decode_entities(&value)));
            }
            if self_closing {
                push_node(
                    &mut stack,
                    &mut root,
                    XmlNode::Element {
                        tag: name,
                        attrs,
                        children: Vec::new(),
                    },
                );
            } else {
                stack.push((name, attrs, Vec::new()));
            }
            i = j;
            continue;
        }
        text.push(chars[i]);
        i += 1;
    }
    flush_text!();
    while let Some((tag, attrs, children)) = stack.pop() {
        push_node(
            &mut stack,
            &mut root,
            XmlNode::Element {
                tag,
                attrs,
                children,
            },
        );
    }
    Ok(root)
}

fn push_node(stack: &mut [OpenElement], root: &mut Vec<XmlNode>, node: XmlNode) {
    if let Some((_, _, children)) = stack.last_mut() {
        children.push(node);
    } else {
        root.push(node);
    }
}

fn starts_with(chars: &[char], at: usize, pat: &str) -> bool {
    let pat: Vec<char> = pat.chars().collect();
    if at + pat.len() > chars.len() {
        return false;
    }
    chars[at..at + pat.len()] == pat[..]
}

fn find_seq(chars: &[char], from: usize, pat: &str) -> Option<usize> {
    let pat: Vec<char> = pat.chars().collect();
    let mut i = from;
    while i + pat.len() <= chars.len() {
        if chars[i..i + pat.len()] == pat[..] {
            return Some(i);
        }
        i += 1;
    }
    None
}

fn skip_ws(chars: &[char], i: &mut usize) {
    while *i < chars.len() && chars[*i].is_whitespace() {
        *i += 1;
    }
}

/// Tag/attribute name chars: FXP accepts anything up to whitespace, `/`, `=`
/// or `>`. A name that starts with an invalid char (e.g. another `<`) is a
/// parse failure — matching the probed `<<<<` throw.
fn read_tag_name(chars: &[char], from: usize) -> Option<(String, usize)> {
    let mut i = from;
    while i < chars.len() && !chars[i].is_whitespace() && chars[i] != '>' && chars[i] != '/' {
        if chars[i] == '<' {
            return None;
        }
        i += 1;
    }
    if i == from {
        return None;
    }
    Some((chars[from..i].iter().collect(), i))
}

fn read_attr_name(chars: &[char], from: usize) -> Option<(String, usize)> {
    let mut i = from;
    while i < chars.len()
        && !chars[i].is_whitespace()
        && chars[i] != '='
        && chars[i] != '>'
        && chars[i] != '/'
    {
        i += 1;
    }
    if i == from {
        return None;
    }
    Some((chars[from..i].iter().collect(), i))
}

fn read_attr_value(chars: &[char], from: usize) -> Option<(String, usize)> {
    if from >= chars.len() {
        return None;
    }
    let quote = chars[from];
    if quote == '"' || quote == '\'' {
        let mut i = from + 1;
        while i < chars.len() && chars[i] != quote {
            i += 1;
        }
        if i >= chars.len() {
            return None;
        }
        Some((chars[from + 1..i].iter().collect(), i + 1))
    } else {
        let mut i = from;
        while i < chars.len() && !chars[i].is_whitespace() && chars[i] != '>' {
            i += 1;
        }
        Some((chars[from..i].iter().collect(), i))
    }
}

/// XML entity decoding (fast-xml-parser default `processEntities`):
/// the five named entities plus decimal/hex numeric references.
fn decode_entities(text: &str) -> String {
    if !text.contains('&') {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '&' {
            if let Some(end) = chars[i + 1..].iter().position(|&c| c == ';') {
                let body: String = chars[i + 1..i + 1 + end].iter().collect();
                let decoded = match body.as_str() {
                    "amp" => Some('&'),
                    "lt" => Some('<'),
                    "gt" => Some('>'),
                    "quot" => Some('"'),
                    "apos" => Some('\''),
                    _ => {
                        if let Some(hex) =
                            body.strip_prefix("#x").or_else(|| body.strip_prefix("#X"))
                        {
                            u32::from_str_radix(hex, 16).ok().and_then(char::from_u32)
                        } else if let Some(dec) = body.strip_prefix('#') {
                            dec.parse::<u32>().ok().and_then(char::from_u32)
                        } else {
                            None
                        }
                    }
                };
                if let Some(c) = decoded {
                    out.push(c);
                    i = i + 1 + end + 1;
                    continue;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn el(tag: &str, attrs: Vec<(&str, &str)>, children: Vec<XmlNode>) -> XmlNode {
        XmlNode::Element {
            tag: tag.to_string(),
            attrs: attrs
                .into_iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            children,
        }
    }

    #[test]
    fn basic_parsetree_shape() {
        let xml = "<root><template><title>干员信息</title></template></root>";
        let parsed = parse_lenient(xml).unwrap();
        assert_eq!(
            parsed,
            vec![el(
                "root",
                vec![],
                vec![el(
                    "template",
                    vec![],
                    vec![el("title", vec![], vec![XmlNode::Text("干员信息".into())])]
                )]
            )]
        );
    }

    #[test]
    fn fxp_leniency_matrix() {
        // Mismatched close: accepted, inner element closed (probed on FXP).
        assert_eq!(
            parse_lenient("<root><template><title>x</title></root>").unwrap(),
            vec![el(
                "root",
                vec![],
                vec![el(
                    "template",
                    vec![],
                    vec![el("title", vec![], vec![XmlNode::Text("x".into())])]
                )]
            )]
        );
        // Empty → empty document.
        assert_eq!(parse_lenient("").unwrap(), Vec::new());
        // Unterminated element auto-closes.
        assert_eq!(
            parse_lenient("<a><b>t").unwrap(),
            vec![el(
                "a",
                vec![],
                vec![el("b", vec![], vec![XmlNode::Text("t".into())])]
            )]
        );
        // Garbage tag openers throw.
        assert!(parse_lenient("not xml at all <<<<").is_err());
    }

    #[test]
    fn attrs_comments_and_entities() {
        let xml = "<root><part><name index=\"2\">x</name><!--c-->&#20013;</part></root>";
        let parsed = parse_lenient(xml).unwrap();
        let XmlNode::Element { children, .. } = &parsed[0] else {
            panic!("root");
        };
        let XmlNode::Element {
            children: part_children,
            ..
        } = &children[0]
        else {
            panic!("part");
        };
        let XmlNode::Element {
            tag,
            attrs,
            children: name_children,
        } = &part_children[0]
        else {
            panic!("name");
        };
        assert_eq!(tag, "name");
        assert_eq!(attrs[0].0, "index");
        assert_eq!(attrs[0].1, "2");
        assert_eq!(name_children, &vec![XmlNode::Text("x".into())]);
        assert_eq!(part_children[1], XmlNode::Comment("c".into()));
        assert_eq!(part_children[2], XmlNode::Text("中".into()));
    }
}
