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

/// Map reqwest failures onto the oracle runtime's phrasing (bun 1.3.14
/// collapses its fetch rejection to this message regardless of the
/// underlying socket cause; verified against the dead-proxy golden).
fn map_network_error(_e: &reqwest::Error) -> String {
    "Unable to connect. Is the computer able to access the url?".to_string()
}

#[async_trait]
impl WikiTransport for ReqwestWikiTransport {
    async fn get(&self, params: &[(String, String)]) -> Result<Value, String> {
        self.request(reqwest::Method::GET, params).await
    }

    async fn post(&self, params: &[(String, String)]) -> Result<Value, String> {
        self.request(reqwest::Method::POST, params).await
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
