//! PRTS Wiki API client — port of TS `api/prtsWiki.ts` request half.
//!
//! Contract: global 1.5 s rate limiter whose slot is reserved BEFORE any
//! await (concurrent callers get distinct slots), 15 s per-request timeout,
//! `PRTS API error: HTTP <status>` for non-2xx, JSON bodies. Proxy and CA
//! behavior come from the ambient environment exactly like the oracle
//! runtime: Bun reads lowercase `https_proxy` and `NODE_EXTRA_CA_CERTS`;
//! reqwest reads the proxy env itself, and the extra CA file is honored for
//! parity.

use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;

pub const PRTS_API_ENDPOINT: &str = "https://prts.wiki/api.php";
pub const USER_AGENT: &str = "PRTS-MCP-Bot/0.1 (Arknights fan-creation helper)";
pub const RATE_LIMIT_INTERVAL_MS: i64 = 1500;
pub const REQUEST_TIMEOUT_MS: u64 = 15_000;

/// The slot reservation from TS `rateLimit()`: each caller immediately takes
/// `max(now, next_allowed)` and bumps the cursor, THEN sleeps until its slot.
/// Sharing one limiter across transports would let a test fake bypass the
/// production throttle, so each transport owns its limiter instance.
pub struct RateLimiter {
    next_allowed_ms: Mutex<i64>,
    interval_ms: i64,
}

impl RateLimiter {
    pub fn new(interval_ms: i64) -> Self {
        Self {
            next_allowed_ms: Mutex::new(0),
            interval_ms,
        }
    }

    /// Reserve the next slot; returns how long to sleep before firing.
    pub fn reserve(&self, now_ms: i64) -> i64 {
        let mut next = self.next_allowed_ms.lock().expect("rate limiter lock");
        let slot = now_ms.max(*next);
        *next = slot + self.interval_ms;
        slot - now_ms
    }
}

/// Errors surface as bare message strings — the tool layer prefixes them
/// (`搜索 PRTS 失败：…`); wording parity is pinned by the differential
/// corpus (bun 1.3.14 phrasing for network failures and JSON rejects).
#[async_trait]
pub trait WikiTransport: Send + Sync {
    async fn get(&self, params: &[(String, String)]) -> Result<Value, String>;
    async fn post(&self, params: &[(String, String)]) -> Result<Value, String>;
    /// `downloadImageSafe` raw path: same rate limiter, UA, redirect-follow,
    /// 30 s timeout; all boundary checks (host/MIME/cap/magic) run inside —
    /// the message strings are the pinned oracle wordings.
    async fn download_image(&self, url: &str) -> Result<Vec<u8>, String>;
}

pub struct ReqwestWikiTransport {
    client: reqwest::Client,
    limiter: RateLimiter,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl Default for ReqwestWikiTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl ReqwestWikiTransport {
    pub fn new() -> Self {
        let mut builder = reqwest::Client::builder();
        // Bun honors NODE_EXTRA_CA_CERTS; the replay differential relies on
        // the same env here, and production deployments behind TLS
        // interception get corporate roots for free.
        if let Ok(path) = std::env::var("NODE_EXTRA_CA_CERTS") {
            if let Ok(pem) = std::fs::read(&path) {
                if let Ok(cert) = reqwest::Certificate::from_pem(&pem) {
                    builder = builder.add_root_certificate(cert);
                }
            }
        }
        Self {
            client: builder.build().expect("reqwest client builds"),
            limiter: RateLimiter::new(RATE_LIMIT_INTERVAL_MS),
        }
    }

    async fn sleep_until_slot(&self) {
        let wait = self.limiter.reserve(now_ms());
        if wait > 0 {
            tokio::time::sleep(Duration::from_millis(wait as u64)).await;
        }
    }

    async fn request(
        &self,
        method: reqwest::Method,
        params: &[(String, String)],
    ) -> Result<Value, String> {
        self.sleep_until_slot().await;
        let request = match method {
            reqwest::Method::POST => {
                let form = params
                    .iter()
                    .map(|(k, v)| (k.as_str(), v.as_str()))
                    .collect::<Vec<_>>();
                self.client
                    .post(PRTS_API_ENDPOINT)
                    .header("User-Agent", USER_AGENT)
                    .header("Content-Type", "application/x-www-form-urlencoded")
                    .form(&form)
            }
            _ => {
                let query = params
                    .iter()
                    .map(|(k, v)| (k.as_str(), v.as_str()))
                    .collect::<Vec<_>>();
                self.client
                    .get(PRTS_API_ENDPOINT)
                    .header("User-Agent", USER_AGENT)
                    .query(&query)
            }
        };
        let response =
            tokio::time::timeout(Duration::from_millis(REQUEST_TIMEOUT_MS), request.send())
                .await
                .map_err(|_| TIMEOUT_MESSAGE.to_string())?
                .map_err(|e| map_network_error(&e))?;
        let status = response.status();
        if !status.is_success() {
            // `res.ok` is false for any non-2xx → HTTP <status>.
            return Err(format!("PRTS API error: HTTP {}", status.as_u16()));
        }
        let bytes = response.bytes().await.map_err(|e| map_network_error(&e))?;
        serde_json::from_slice::<Value>(&bytes).map_err(|_| INVALID_JSON_MESSAGE.to_string())
    }
}

/// Bun 1.3.14 `fetch` rejection phrasing — pinned by corpus goldens
/// (runtime-specific wording, same category as the QuickJS regex detail).
const TIMEOUT_MESSAGE: &str = "The operation timed out.";
const INVALID_JSON_MESSAGE: &str = "Failed to parse JSON";

/// `downloadImageSafe` boundary set (prtsWiki.ts): HTTPS only, the single
/// allowed image host, final-URL recheck after redirects, MIME allow-list,
/// and the 1 MiB cap counted on the HTTP response body bytes.
const ALLOWED_IMAGE_HOSTS: [&str; 1] = ["media.prts.wiki"];
const ALLOWED_IMAGE_MIMES: [&str; 3] = ["image/png", "image/jpeg", "image/webp"];
const MAX_IMAGE_BYTES: usize = 1024 * 1024;
const IMAGE_TIMEOUT_MS: u64 = 30_000;

/// `imageMagicOk`: PNG/JPEG/WebP signature bytes.
pub fn image_magic_ok(data: &[u8], mime: &str) -> bool {
    match mime {
        "image/png" => data.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        "image/jpeg" => data.len() >= 3 && data[..3] == [0xff, 0xd8, 0xff],
        "image/webp" => data.len() >= 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP",
        _ => false,
    }
}

/// Map reqwest failures onto the oracle runtime's phrasing (bun 1.3.14
/// collapses its fetch rejection to this message regardless of the
/// underlying socket cause; verified against the dead-proxy golden).
fn map_network_error(_e: &reqwest::Error) -> String {
    "Unable to connect. Is the computer able to access the url?".to_string()
}

impl ReqwestWikiTransport {
    /// `downloadImageSafe` — full boundary chain with the pinned messages.
    pub async fn download_image_safe(&self, url: &str) -> Result<Vec<u8>, String> {
        let parsed = reqwest::Url::parse(url).map_err(|_| {
            format!(
                "image URL host not allowed: {}",
                url.split('/').nth(2).unwrap_or("")
            )
        })?;
        let host = parsed.host_str().unwrap_or("");
        if parsed.scheme() != "https" || !ALLOWED_IMAGE_HOSTS.contains(&host) {
            return Err(format!("image URL host not allowed: {host}"));
        }
        self.sleep_until_slot().await;
        let request = self.client.get(url).header("User-Agent", USER_AGENT);
        let response =
            tokio::time::timeout(Duration::from_millis(IMAGE_TIMEOUT_MS), request.send())
                .await
                .map_err(|_| TIMEOUT_MESSAGE.to_string())?
                .map_err(|e| map_network_error(&e))?;
        if !response.status().is_success() {
            return Err(format!("image fetch HTTP {}", response.status().as_u16()));
        }
        let final_url = response.url().clone();
        let final_host = final_url.host_str().unwrap_or("");
        if final_url.scheme() != "https" || !ALLOWED_IMAGE_HOSTS.contains(&final_host) {
            return Err(format!("redirected to disallowed URL: {final_url}"));
        }
        let ctype = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_lowercase();
        if !ALLOWED_IMAGE_MIMES.contains(&ctype.as_str()) {
            return Err(format!("bad content-type: {}\"", ctype));
        }
        // The cap counts the response body bytes as they stream in.
        let mut stream = response;
        let mut body: Vec<u8> = Vec::new();
        while let Some(chunk) = stream.chunk().await.map_err(|e| map_network_error(&e))? {
            body.extend_from_slice(&chunk);
            if body.len() > MAX_IMAGE_BYTES {
                return Err(format!("image exceeds {MAX_IMAGE_BYTES} byte cap"));
            }
        }
        if !image_magic_ok(&body, &ctype) {
            return Err(format!("magic bytes mismatch for \"{ctype}\""));
        }
        Ok(body)
    }
}

#[async_trait]
impl WikiTransport for ReqwestWikiTransport {
    async fn get(&self, params: &[(String, String)]) -> Result<Value, String> {
        self.request(reqwest::Method::GET, params).await
    }

    async fn post(&self, params: &[(String, String)]) -> Result<Value, String> {
        self.request(reqwest::Method::POST, params).await
    }

    async fn download_image(&self, url: &str) -> Result<Vec<u8>, String> {
        self.download_image_safe(url).await
    }
}

static SHARED: OnceLock<ReqwestWikiTransport> = OnceLock::new();

/// Process-wide transport (TS module state is process-global too).
pub fn shared_transport() -> &'static ReqwestWikiTransport {
    SHARED.get_or_init(ReqwestWikiTransport::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limiter_reserves_distinct_slots_before_waiting() {
        let limiter = RateLimiter::new(1500);
        // Three concurrent reservations at t=0 → slots 0/1500/3000.
        assert_eq!(limiter.reserve(0), 0);
        assert_eq!(limiter.reserve(0), 1500);
        assert_eq!(limiter.reserve(0), 3000);
        // Now at the cursor: the next slot is immediate, then the next one
        // is a full interval later.
        assert_eq!(limiter.reserve(4500), 0);
        assert_eq!(limiter.reserve(4500), 1500);
    }

    #[tokio::test]
    async fn concurrent_reservations_never_overlap() {
        // Real-clock check that reserved fire times keep the interval even
        // when futures race (the check-then-act race the TS comment names).
        let limiter = std::sync::Arc::new(RateLimiter::new(120));
        let mut handles = Vec::new();
        for _ in 0..6 {
            let l = limiter.clone();
            handles.push(tokio::spawn(async move {
                let start = now_ms();
                let wait = l.reserve(start);
                if wait > 0 {
                    tokio::time::sleep(Duration::from_millis(wait as u64)).await;
                }
                now_ms()
            }));
        }
        let mut times: Vec<i64> = Vec::new();
        for h in handles {
            times.push(h.await.expect("join"));
        }
        times.sort_unstable();
        for pair in times.windows(2) {
            let gap = pair[1] - pair[0];
            assert!(gap >= 100, "fired too close: {times:?}");
        }
    }
}
