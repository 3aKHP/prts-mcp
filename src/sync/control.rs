//! Invocation-local wait budgets and cooperative cancellation for one-shot sync.
//! Background tasks have no scope and retain their historical lock behavior.
use std::{
    future::Future,
    sync::{
        atomic::{AtomicBool, AtomicI32, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::sync::Notify;

pub struct Control {
    remaining: Mutex<Duration>,
    cancelled: AtomicI32,
    timeout: AtomicBool,
    wake: Notify,
}
tokio::task_local! { static CURRENT: Arc<Control>; }
impl Control {
    pub fn new(wait: Duration) -> Arc<Self> {
        Arc::new(Self {
            remaining: Mutex::new(wait),
            cancelled: AtomicI32::new(0),
            timeout: AtomicBool::new(false),
            wake: Notify::new(),
        })
    }
    pub async fn scope<T>(self: &Arc<Self>, future: impl Future<Output = T>) -> T {
        CURRENT.scope(self.clone(), future).await
    }
    pub fn cancel(&self, code: i32) {
        self.cancelled.store(code, Ordering::Release);
        self.wake.notify_waiters();
    }
    pub fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire) != 0
    }
    pub fn exit_code(&self) -> Option<i32> {
        let code = self.cancelled.load(Ordering::Acquire);
        if code != 0 {
            Some(code)
        } else if self.timeout.load(Ordering::Acquire) {
            Some(3)
        } else {
            None
        }
    }
    pub async fn cancellation(&self) {
        loop {
            let notified = self.wake.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.cancelled() {
                return;
            }
            notified.await;
        }
    }
    pub async fn transfer<T>(
        &self,
        operation: impl Future<Output = Result<T, super::transport::TransportError>>,
    ) -> Result<T, super::transport::TransportError> {
        if self.timeout.load(Ordering::Acquire) {
            return Err(super::transport::TransportError::Network(
                "sync lock wait timed out".into(),
            ));
        }
        tokio::select! {biased; _=self.cancellation()=>Err(super::transport::TransportError::Network("sync cancelled".into())), value=operation=>value}
    }
}
pub fn current() -> Option<Arc<Control>> {
    CURRENT.try_with(Arc::clone).ok()
}
pub fn checkpoint() -> Result<(), String> {
    match current().and_then(|c| c.exit_code()) {
        Some(3) => Err("sync lock wait timed out".into()),
        Some(_) => Err("sync cancelled".into()),
        None => Ok(()),
    }
}

/// Measure only time spent acquiring a lock. Drop before running protected work.
pub struct Wait {
    control: Option<Arc<Control>>,
    start: Instant,
    limit: Duration,
}
impl Wait {
    pub fn new(default: Duration) -> Self {
        let control = current();
        let limit = control
            .as_ref()
            .map(|c| *c.remaining.lock().expect("wait budget"))
            .unwrap_or(default);
        Self {
            control,
            start: Instant::now(),
            limit,
        }
    }
    pub fn check(&self) -> Result<(), String> {
        checkpoint()?;
        if self.start.elapsed() >= self.limit {
            if let Some(control) = &self.control {
                control.timeout.store(true, Ordering::Release);
            }
            Err("sync lock wait timed out".into())
        } else {
            Ok(())
        }
    }
}
impl Drop for Wait {
    fn drop(&mut self) {
        if let Some(c) = &self.control {
            let mut remaining = c.remaining.lock().expect("wait budget");
            *remaining = remaining.saturating_sub(self.start.elapsed());
        }
    }
}
pub async fn lock_async(file: &std::fs::File, default: Duration) -> Result<(), String> {
    let wait = Wait::new(default);
    loop {
        checkpoint()?;
        match file.try_lock() {
            Ok(()) => return Ok(()),
            Err(std::fs::TryLockError::WouldBlock) => {
                wait.check()?;
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}
pub fn lock_source(file: &std::fs::File) -> Result<(), String> {
    if current().is_none() {
        return file.lock().map_err(|e| e.to_string());
    }
    let wait = Wait::new(Duration::ZERO);
    loop {
        checkpoint()?;
        match file.try_lock() {
            Ok(()) => return Ok(()),
            Err(std::fs::TryLockError::WouldBlock) => {
                wait.check()?;
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}
