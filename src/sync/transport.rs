//! HTTP transport for GitHub Release sync: mirrors, headers, cascading fetch.
//!
//! Port of TS `sync/transport.ts` with one sanctioned deviation (docs/02):
//! release archives stream to a temp file with an incremental SHA-256 instead
//! of buffering the whole body (TS `arrayBuffer`) before writing. The
//! candidate cascade, per-candidate timeouts, and the typed direct-404
//! semantics are the oracle contract.

use std::path::Path;
use std::time::Duration;

use crate::storage::digest::Sha256;
use async_trait::async_trait;
use serde_json::Value;

pub const GITHUB_UA: &str = "PRTS-MCP-Bot/0.1 (Arknights fan-creation helper)";

/// Errors distinguishable by the state machine: a direct-404 is a typed
/// "asset confirmed absent", a direct 4xx stops the cascade, everything else
/// (network, 5xx, mirror exhaustion) is retryable-elsewhere.
#[derive(Debug, thiserror::Error)]
pub enum TransportError {
    #[error("HTTP 404: {0}")]
    AssetNotFound(String),
    #[error("HTTP {0}")]
    Http(u16),
    #[error("{0}")]
    Network(String),
    #[error("invalid JSON: {0}")]
    InvalidJson(String),
}

/// Streaming download result: byte count plus the incremental SHA-256 of the
/// body, computed while writing (no second pass over the file).
#[derive(Debug, Clone)]
pub struct DownloadStats {
    pub bytes: u64,
    pub sha256: String,
}

/// `parseMirrors`: split on commas, trim, strip ALL trailing slashes, drop
/// empty entries.
pub fn parse_mirrors(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|s| s.trim().trim_end_matches('/'))
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

/// The transport surface the sync state machine depends on. Production uses
/// `ReqwestTransport`; tests inject scriptable fakes at this boundary
/// (docs/06: harness injection at construction, no global fetch mocking).
#[async_trait]
pub trait Transport: Send + Sync {
    /// fetchCascading + `res.json()` — an ok response whose body fails to
    /// parse is `InvalidJson` (TS callers see the json() rejection).
    async fn fetch_json(&self, url: &str, timeout_ms: u64) -> Result<Value, TransportError>;

    /// fetchCascading + stream-to-file + incremental hash. The destination is
    /// written directly (the caller already chose a temp path).
    async fn download(
        &self,
        url: &str,
        dest: &Path,
        timeout_ms: u64,
    ) -> Result<DownloadStats, TransportError>;

    /// Stream a file when the caller has no expected container digest.
    async fn download_file(
        &self,
        url: &str,
        dest: &Path,
        timeout_ms: u64,
    ) -> Result<u64, TransportError> {
        self.download(url, dest, timeout_ms)
            .await
            .map(|stats| stats.bytes)
    }

    /// Database downloads stop before writing bytes beyond the manifest.
    /// Fakes may use this fallback; the network implementation enforces the
    /// limit before each write.
    async fn download_limited(
        &self,
        url: &str,
        dest: &Path,
        timeout_ms: u64,
        limit: u64,
    ) -> Result<DownloadStats, TransportError> {
        let stats = self.download(url, dest, timeout_ms).await?;
        if stats.bytes > limit {
            return Err(TransportError::Network(
                "download exceeds declared length".into(),
            ));
        }
        Ok(stats)
    }

    /// `parseMirrors()` at construction time — the blind-download fallback
    /// only exists when mirrors are configured.
    fn mirrors(&self) -> Vec<String>;

    /// GitHub request headers. Implementations must never log the token.
    fn github_headers(&self) -> Vec<(String, String)>;
}

pub struct ReqwestTransport {
    client: reqwest::Client,
    mirrors: Vec<String>,
    token: Option<String>,
}

impl ReqwestTransport {
    /// Proxy behavior comes from the ambient HTTP(S)_PROXY env (reqwest
    /// default) — the same sources Bun/undici honor in the oracle.
    pub fn new(mirrors: Vec<String>, token: Option<String>) -> Self {
        Self {
            client: reqwest::Client::builder()
                .build()
                .expect("reqwest client builds"),
            mirrors,
            token,
        }
    }

    /// Candidates: `[url, mirror1/url, mirror2/url, …]`.
    fn candidates(&self, url: &str) -> Vec<String> {
        let mut out = vec![url.to_string()];
        for mirror in &self.mirrors {
            out.push(format!("{mirror}/{url}"));
        }
        out
    }

    /// One attempt with its own timeout budget (an earlier candidate's
    /// timeout never eats a later candidate's budget).
    async fn attempt(
        &self,
        url: &str,
        timeout_ms: u64,
    ) -> Result<reqwest::Response, TransportError> {
        let mut request = self.client.get(url);
        for (name, value) in self.github_headers() {
            request = request.header(name, value);
        }
        let timeout = Duration::from_millis(timeout_ms.max(1));
        tokio::time::timeout(timeout, request.send())
            .await
            .map_err(|_| TransportError::Network(format!("timeout after {timeout_ms}ms: {url}")))?
            .map_err(|e| TransportError::Network(e.to_string()))
    }

    async fn consume(
        &self,
        url: &str,
        timeout_ms: u64,
    ) -> Result<reqwest::Response, TransportError> {
        {
            let candidates = self.candidates(url);
            let mut last_error = TransportError::Network("All URL candidates failed".to_string());
            for (index, candidate) in candidates.iter().enumerate() {
                match self.attempt(candidate, timeout_ms).await {
                    Ok(response) => {
                        let status = response.status().as_u16();
                        if (200..300).contains(&status) {
                            return Ok(response);
                        }
                        if index == 0 && status == 404 {
                            // Direct 404 — the asset genuinely does not
                            // exist; mirrors cannot help. Typed, stop.
                            last_error = TransportError::AssetNotFound(candidate.clone());
                            break;
                        }
                        last_error = TransportError::Http(status);
                        // Other direct 4xx — the resource does not exist.
                        if index == 0 && (400..500).contains(&status) {
                            break;
                        }
                    }
                    Err(err) => {
                        last_error = err;
                    }
                }
            }
            Err(last_error)
        }
    }
    async fn stream_file(
        &self,
        url: &str,
        dest: &Path,
        timeout_ms: u64,
        limit: u64,
        mut hasher: Option<Sha256>,
    ) -> Result<(u64, Option<String>), TransportError> {
        let mut response = self.consume(url, timeout_ms).await?;
        if response
            .content_length()
            .is_some_and(|length| length > limit)
        {
            return Err(TransportError::Network(
                "download exceeds declared length".into(),
            ));
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| TransportError::Network(e.to_string()))?;
        }
        use tokio::io::AsyncWriteExt as _;
        let mut file = tokio::io::BufWriter::new(
            tokio::fs::File::create(dest)
                .await
                .map_err(|e| TransportError::Network(e.to_string()))?,
        );
        let mut bytes: u64 = 0;
        loop {
            let chunk = response
                .chunk()
                .await
                .map_err(|e| TransportError::Network(e.to_string()))?;
            let Some(chunk) = chunk else { break };
            bytes = bytes
                .checked_add(chunk.len() as u64)
                .filter(|bytes| *bytes <= limit)
                .ok_or_else(|| {
                    TransportError::Network("download exceeds declared length".into())
                })?;
            file.write_all(&chunk)
                .await
                .map_err(|e| TransportError::Network(e.to_string()))?;
            if let Some(hasher) = &mut hasher {
                hasher.update(&chunk);
            }
        }
        file.flush()
            .await
            .map_err(|e| TransportError::Network(e.to_string()))?;
        drop(file);
        Ok((bytes, hasher.map(Sha256::finish)))
    }
}

#[async_trait]
impl Transport for ReqwestTransport {
    async fn fetch_json(&self, url: &str, timeout_ms: u64) -> Result<Value, TransportError> {
        let response = self.consume(url, timeout_ms).await?;
        let text = response
            .text()
            .await
            .map_err(|e| TransportError::InvalidJson(e.to_string()))?;
        serde_json::from_str(&text).map_err(|e| TransportError::InvalidJson(e.to_string()))
    }

    async fn download(
        &self,
        url: &str,
        dest: &Path,
        timeout_ms: u64,
    ) -> Result<DownloadStats, TransportError> {
        self.download_limited(url, dest, timeout_ms, u64::MAX).await
    }

    async fn download_limited(
        &self,
        url: &str,
        dest: &Path,
        timeout_ms: u64,
        limit: u64,
    ) -> Result<DownloadStats, TransportError> {
        let (bytes, sha256) = self
            .stream_file(url, dest, timeout_ms, limit, Some(Sha256::new()))
            .await?;
        Ok(DownloadStats {
            bytes,
            sha256: sha256.expect("requested SHA-256"),
        })
    }

    async fn download_file(
        &self,
        url: &str,
        dest: &Path,
        timeout_ms: u64,
    ) -> Result<u64, TransportError> {
        self.stream_file(url, dest, timeout_ms, u64::MAX, None)
            .await
            .map(|(bytes, _)| bytes)
    }

    fn mirrors(&self) -> Vec<String> {
        self.mirrors.clone()
    }

    fn github_headers(&self) -> Vec<(String, String)> {
        let mut headers = vec![("User-Agent".to_string(), GITHUB_UA.to_string())];
        if let Some(token) = &self.token {
            headers.push(("Authorization".to_string(), format!("Bearer {token}")));
        }
        headers
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_mirrors_matches_the_oracle_rules() {
        assert!(parse_mirrors("").is_empty());
        assert!(parse_mirrors("   ").is_empty());
        assert_eq!(
            parse_mirrors("https://ghproxy.net/"),
            vec!["https://ghproxy.net"]
        );
        assert_eq!(
            parse_mirrors("https://ghproxy.net//"),
            vec!["https://ghproxy.net"]
        );
        assert_eq!(
            parse_mirrors(" https://a.example , https://b.example "),
            vec!["https://a.example", "https://b.example"]
        );
        assert_eq!(
            parse_mirrors(" https://a.example/ , https://b.example// "),
            vec!["https://a.example", "https://b.example"]
        );
        assert_eq!(
            parse_mirrors("https://a,,https://b"),
            vec!["https://a", "https://b"]
        );
        assert_eq!(
            parse_mirrors("https://a,///,https://b"),
            vec!["https://a", "https://b"]
        );
    }
}
