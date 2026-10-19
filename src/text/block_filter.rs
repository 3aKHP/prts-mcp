//! Conservative two-byte membership hints for immutable story blocks.
//! False positives fall through to the existing exact regexp path.

const WORDS: usize = 64;

pub(crate) struct BlockFilter([u64; WORDS]);

// The pinned /iu table has only two non-ASCII folds into ASCII. Folding both
// the block and its mandatory literal also safely admits case-sensitive text.
struct Folded<'a>(&'a [u8]);

impl Iterator for Folded<'_> {
    type Item = u8;

    fn next(&mut self) -> Option<u8> {
        let (&first, rest) = self.0.split_first()?;
        let (byte, consumed) = if first == 0xc5 && rest.first() == Some(&0xbf) {
            (b's', 2)
        } else if first == 0xe2 && rest.starts_with(&[0x84, 0xaa]) {
            (b'k', 3)
        } else {
            (first.to_ascii_lowercase(), 1)
        };
        self.0 = &self.0[consumed..];
        Some(byte)
    }
}

fn bit(first: u8, second: u8) -> (usize, u64) {
    let pair = (u32::from(first) << 8) | u32::from(second);
    let index = (pair.wrapping_mul(0x9e37_79b1) >> 20) as usize;
    (index / 64, 1 << (index % 64))
}

impl BlockFilter {
    pub(crate) fn supports(literal: &[u8]) -> bool {
        Folded(literal).nth(1).is_some()
    }

    pub(crate) fn new(bytes: &[u8]) -> Result<Self, String> {
        let mut filter = Self([0; WORDS]);
        let mut previous = None;
        for (n, byte) in Folded(bytes).enumerate() {
            if n & 65_535 == 0 {
                super::cancellation::check()?;
            }
            if let Some(previous) = previous {
                let (word, mask) = bit(previous, byte);
                filter.0[word] |= mask;
            }
            previous = Some(byte);
        }
        Ok(filter)
    }

    pub(crate) fn may_contain(&self, literal: &[u8]) -> bool {
        let mut bytes = Folded(literal);
        let Some(mut previous) = bytes.next() else {
            return true;
        };
        for byte in bytes {
            let (word, mask) = bit(previous, byte);
            if self.0[word] & mask == 0 {
                return false;
            }
            previous = byte;
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_boundaries_and_unicode_folds_keep_present_literals() {
        for literal in ["", "Q", "ſ", "K"] {
            assert!(!BlockFilter::supports(literal.as_bytes()));
        }
        for literal in ["QQ", "博士", "ſK"] {
            assert!(BlockFilter::supports(literal.as_bytes()));
        }
        for text in ["博士阿米娅", "aſK", "ſK", "Ks", "PRTS_甲乙_0123", "😀汉字"] {
            for prefix in [&[][..], &[0xc5][..], &[0xe2, 0x84][..], &[0, 255, 0][..]] {
                let mut block = prefix.to_vec();
                block.extend_from_slice(text.as_bytes());
                block.extend_from_slice(&[0xc5, 0xe2, 255]);
                let filter = BlockFilter::new(&block).unwrap();
                for start in text.char_indices().map(|(i, _)| i) {
                    for end in text.char_indices().map(|(i, _)| i).chain([text.len()]) {
                        if end > start {
                            assert!(filter.may_contain(&text.as_bytes()[start..end]));
                        }
                    }
                }
            }
        }
        assert!(BlockFilter::new("aſK".as_bytes())
            .unwrap()
            .may_contain(b"ASK"));
        assert!(BlockFilter::new(b"ASK")
            .unwrap()
            .may_contain("aſK".as_bytes()));
        assert!(!BlockFilter::new("博士".as_bytes())
            .unwrap()
            .may_contain(b"PRTS"));
    }

    #[test]
    fn construction_observes_query_cancellation() {
        let _scope = super::super::cancellation::Scope::enter(std::sync::Arc::new(
            std::sync::atomic::AtomicBool::new(true),
        ));
        assert!(BlockFilter::new(b"some text").is_err());
    }
}
