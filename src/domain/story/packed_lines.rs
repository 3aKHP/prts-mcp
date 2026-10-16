//! Immutable chapter text with one backing buffer and chapter-local speakers.
//! Byte offsets are recorded at UTF-8 string boundaries during construction.

use std::collections::HashMap;
use std::num::NonZeroUsize;
use std::ops::Range;

use super::reader::StoryLine;

#[derive(Clone, Copy)]
enum Kind {
    Dialog,
    Narration,
    Choice,
}

struct PackedLine {
    text: Range<usize>,
    role: Option<NonZeroUsize>,
    kind: Kind,
}

pub struct PackedLines {
    text: Box<str>,
    roles: Box<[Box<str>]>,
    lines: Box<[PackedLine]>,
}

/// Borrowed view of one indexed line; rendering never materializes an owned row.
pub struct LineRef<'a> {
    pub line_type: &'static str,
    pub role: Option<&'a str>,
    pub text: &'a str,
}

impl PackedLines {
    pub fn new(source: Vec<StoryLine>) -> Self {
        let mut text = String::with_capacity(source.iter().map(|line| line.text.len()).sum());
        let mut roles = Vec::new();
        let mut role_ids: HashMap<String, NonZeroUsize> = HashMap::new();
        let mut lines = Vec::with_capacity(source.len());
        for line in source {
            let start = text.len();
            text.push_str(&line.text);
            let role = line.role.map(|role| {
                *role_ids.entry(role).or_insert_with_key(|name| {
                    roles.push(name.clone().into_boxed_str());
                    NonZeroUsize::new(roles.len()).expect("one-based speaker index")
                })
            });
            let kind = match line.line_type {
                "dialog" => Kind::Dialog,
                "narration" => Kind::Narration,
                "choice" => Kind::Choice,
                _ => unreachable!("story reader emits the three supported line types"),
            };
            lines.push(PackedLine {
                text: start..text.len(),
                role,
                kind,
            });
        }
        Self {
            text: text.into_boxed_str(),
            roles: roles.into_boxed_slice(),
            lines: lines.into_boxed_slice(),
        }
    }

    pub fn len(&self) -> usize {
        self.lines.len()
    }
    pub fn is_empty(&self) -> bool {
        self.lines.is_empty()
    }

    fn view(&self, line: &PackedLine) -> LineRef<'_> {
        LineRef {
            line_type: match line.kind {
                Kind::Dialog => "dialog",
                Kind::Narration => "narration",
                Kind::Choice => "choice",
            },
            role: line.role.map(|id| self.roles[id.get() - 1].as_ref()),
            text: &self.text[line.text.clone()],
        }
    }

    pub fn get(&self, index: usize) -> Option<LineRef<'_>> {
        self.lines.get(index).map(|line| self.view(line))
    }
    pub fn iter(&self) -> impl ExactSizeIterator<Item = LineRef<'_>> {
        self.lines.iter().map(|line| self.view(line))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::story::reader::{format_line, format_line_parts};

    #[test]
    fn preserves_unicode_empty_roles_context_and_formatting() {
        let mut original = Vec::new();
        for kind in ["dialog", "narration", "choice"] {
            for role in [None, Some(""), Some("阿米娅"), Some("阿米娅"), Some("🙂é")] {
                for text in ["", "跨行\n文本", "🙂e\u{301}中文"] {
                    original.push(StoryLine {
                        line_type: kind,
                        role: role.map(str::to_owned),
                        text: text.to_owned(),
                    });
                }
            }
        }
        let packed = PackedLines::new(original.clone());
        assert_eq!(packed.len(), original.len());
        assert_eq!(packed.roles.len(), 3);
        assert!(packed.get(original.len()).is_none());
        for (index, (expected, actual)) in original.iter().zip(packed.iter()).enumerate() {
            assert_eq!(expected.line_type, actual.line_type);
            assert_eq!(expected.role.as_deref(), actual.role);
            assert_eq!(expected.text, actual.text);
            assert_eq!(packed.get(index).unwrap().text, expected.text);
            assert_eq!(
                format_line(expected),
                format_line_parts(actual.line_type, actual.role, actual.text)
            );
        }
        assert!(PackedLines::new(Vec::new()).is_empty());
    }
}
