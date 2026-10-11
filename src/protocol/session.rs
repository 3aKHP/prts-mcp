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

use crate::protocol::dispatch::ConnectionState;
use crate::tools::output::OutputChannel;

pub struct Session {
    pub state: ConnectionState,
    pub channel: OutputChannel,
    last_activity: Instant,
}

#[derive(Clone)]
pub struct SessionTable {
    timeout: Option<Duration>,
    inner: Arc<Mutex<HashMap<String, Session>>>,
}

impl SessionTable {
    pub fn new(timeout_ms: Option<f64>) -> Self {
        Self {
            timeout: timeout_ms
                .filter(|t| *t > 0.0)
                .map(|t| Duration::from_millis(t.max(0.0) as u64)),
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Register a fresh session for an arriving initialize; spawns the idle
    /// watchdog when eviction is enabled.
    pub async fn create(self: &Arc<Self>, channel: OutputChannel) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        self.inner.lock().await.insert(
            id.clone(),
            Session {
                state: ConnectionState::default(),
                channel,
                last_activity: Instant::now(),
            },
        );
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
        self.inner.lock().await.remove(id);
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
            break;
        }
        delay = timeout - idle;
    }
}
