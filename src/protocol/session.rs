//! HTTP legacy session table with idle eviction (server.ts semantics):
//! last-activity refresh on every request, timer re-armed for the remaining
//! idle budget (#193), eviction removes the session exactly once.
//!
//! Lock discipline: the mutex only guards the map; message dispatch runs
//! outside it on cloned state, and results are written back afterwards.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Mutex;
use tokio::time::Instant;

use crate::diagnostics::RuntimeMetrics;
use crate::protocol::dispatch::ConnectionState;
use crate::tools::output::OutputChannel;

pub struct Session {
    pub state: ConnectionState,
    pub channel: OutputChannel,
    last_activity: Instant,
    /// (created, last_activity) epoch ms — the /debug/metrics observations.
    observed: (u64, std::sync::atomic::AtomicU64),
}

fn epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Clone)]
pub struct SessionTable {
    timeout: Option<Duration>,
    timeout_ms: Option<f64>,
    inner: Arc<Mutex<HashMap<String, Session>>>,
    metrics: Option<Arc<RuntimeMetrics>>,
}

impl SessionTable {
    pub fn new(timeout_ms: Option<f64>) -> Self {
        Self::with_metrics(timeout_ms, None)
    }

    pub fn with_metrics(timeout_ms: Option<f64>, metrics: Option<Arc<RuntimeMetrics>>) -> Self {
        Self {
            timeout: timeout_ms
                .filter(|t| *t > 0.0)
                .map(|t| Duration::from_millis(t.max(0.0) as u64)),
            // Snapshot echoes null when disabled (server.ts passes
            // SESSION_IDLE_TIMEOUT_MS > 0 ? value : null).
            timeout_ms: timeout_ms.filter(|t| *t > 0.0),
            inner: Arc::new(Mutex::new(HashMap::new())),
            metrics,
        }
    }

    /// Register a fresh session for an arriving initialize; spawns the idle
    /// watchdog when eviction is enabled.
    pub async fn create(self: &Arc<Self>, channel: OutputChannel) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let now = epoch_ms();
        self.inner.lock().await.insert(
            id.clone(),
            Session {
                state: ConnectionState::default(),
                channel,
                last_activity: Instant::now(),
                observed: (now, std::sync::atomic::AtomicU64::new(now)),
            },
        );
        if let Some(metrics) = &self.metrics {
            metrics.session_initialized();
        }
        if let Some(timeout) = self.timeout {
            tokio::spawn(idle_watchdog(Arc::clone(self), id.clone(), timeout));
        }
        id
    }

    /// Touch the session and clone its protocol state + channel.
    pub async fn touch(&self, id: &str) -> Option<(ConnectionState, OutputChannel)> {
        let mut guard = self.inner.lock().await;
        let session = guard.get_mut(id)?;
        session.last_activity = Instant::now();
        session
            .observed
            .1
            .store(epoch_ms(), std::sync::atomic::Ordering::Relaxed);
        Some((session.state.clone(), session.channel))
    }

    /// Channel only (used when re-resolving per-request state is not needed).
    pub async fn channel_of(&self, id: &str) -> Option<OutputChannel> {
        self.inner.lock().await.get(id).map(|s| s.channel)
    }

    pub async fn set_state(&self, id: &str, state: ConnectionState) {
        if let Some(session) = self.inner.lock().await.get_mut(id) {
            session.state = state;
        }
    }

    pub async fn contains(&self, id: &str) -> bool {
        self.inner.lock().await.contains_key(id)
    }

    pub async fn remove(&self, id: &str) {
        if self.inner.lock().await.remove(id).is_some() {
            if let Some(metrics) = &self.metrics {
                metrics.session_closed();
            }
        }
    }

    /// The configured idle timeout (ms), for the metrics snapshot's
    /// `sessions.idle_timeout_ms` (null when eviction is disabled).
    pub fn idle_timeout_ms(&self) -> Option<f64> {
        self.timeout_ms
    }

    /// (created_ms, last_activity_ms) for every live session — the
    /// /debug/metrics session observations (no ids, no payloads).
    pub async fn observations(&self) -> Vec<(u64, u64)> {
        self.inner
            .lock()
            .await
            .values()
            .map(|s| {
                (
                    s.observed.0,
                    s.observed.1.load(std::sync::atomic::Ordering::Relaxed),
                )
            })
            .collect()
    }
}

/// Fire at most `timeout` after the last activity; on wake, either evict or
/// re-arm for whatever budget remains.
async fn idle_watchdog(table: Arc<SessionTable>, id: String, timeout: Duration) {
    let mut delay = timeout;
    loop {
        tokio::time::sleep(delay).await;
        let mut guard = table.inner.lock().await;
        let Some(session) = guard.get_mut(&id) else {
            break;
        };
        let idle = session.last_activity.elapsed();
        if idle >= timeout {
            crate::log_info(&format!(
                "Session {id} idle for {}s — evicting.",
                ((idle.as_secs_f64() * 1000.0).round() / 1000.0).round()
            ));
            guard.remove(&id);
            if let Some(metrics) = &table.metrics {
                // TS: evict fires sessionEvicted, then transport.close fires
                // onclose → sessionClosed; both count.
                metrics.session_evicted();
                metrics.session_closed();
            }
            break;
        }
        delay = timeout - idle;
    }
}
