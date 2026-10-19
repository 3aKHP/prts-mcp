//! Incremental SHA-256 for large sync bodies, using the linked TLS backend.
//! Digest bytes and lowercase encoding stay identical to the asset contract.
use ring::digest::{Context, SHA256};

pub(crate) struct Sha256(Context);

impl Sha256 {
    pub(crate) fn new() -> Self {
        Self(Context::new(&SHA256))
    }

    pub(crate) fn update(&mut self, bytes: &[u8]) {
        self.0.update(bytes);
    }

    pub(crate) fn finish(self) -> String {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut encoded = String::with_capacity(64);
        for byte in self.0.finish().as_ref() {
            encoded.push(char::from(HEX[usize::from(byte >> 4)]));
            encoded.push(char::from(HEX[usize::from(byte & 15)]));
        }
        encoded
    }
}

/// Hash a complete file using the same bounded buffer as sync readback.
pub(crate) fn hash_file(path: &std::path::Path) -> Result<String, String> {
    use std::io::Read;
    let mut input = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let count = input.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(hash.finish())
}

#[cfg(test)]
mod tests {
    use super::Sha256;

    #[test]
    fn standard_sha256_vectors_keep_manifest_encoding() {
        for (message, wanted) in [
            (
                "",
                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            ),
            (
                "abc",
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            ),
            (
                "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
                "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
            ),
        ] {
            let mut hash = Sha256::new();
            hash.update(message.as_bytes());
            assert_eq!(hash.finish(), wanted);
        }
    }

    #[test]
    fn chunk_boundaries_match_independent_rust_implementation() {
        use sha2::Digest;
        let bytes: Vec<_> = (0..131_073).map(|index| (index % 251) as u8).collect();
        let wanted = format!("{:x}", sha2::Sha256::digest(&bytes));
        for chunk in [1, 63, 64, 65, 65_535, 65_536, 65_537] {
            let mut hash = Sha256::new();
            for bytes in bytes.chunks(chunk) {
                hash.update(bytes);
            }
            assert_eq!(hash.finish(), wanted, "chunk size {chunk}");
        }
    }
}
