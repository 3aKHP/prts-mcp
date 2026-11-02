//! Register process signals before starting workers; drain publishers on exit.
use crate::sync::jobs::Coordinator;
use std::sync::{
    atomic::{AtomicBool, AtomicI32, Ordering},
    Arc,
};
use tokio::sync::watch;

pub struct Signals {
    task: tokio::task::JoinHandle<()>,
    pub receiver: watch::Receiver<bool>,
}
impl Drop for Signals {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Signals {
    pub fn new(
        jobs: Arc<Coordinator>,
        ready: Arc<AtomicBool>,
        reason: Arc<AtomicI32>,
    ) -> std::io::Result<Self> {
        let (sender, receiver) = watch::channel(false);
        #[cfg(unix)]
        let signal = {
            let mut term =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
            let mut interrupt =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
            let mut hangup =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::hangup())?;
            async move {
                tokio::select! { _=term.recv()=>15, _=interrupt.recv()=>2, _=hangup.recv()=>1 }
            }
        };
        #[cfg(windows)]
        let signal = {
            let mut interrupt = tokio::signal::windows::ctrl_c()?;
            let mut close = tokio::signal::windows::ctrl_close()?;
            async move {
                tokio::select! { _=interrupt.recv()=>2, _=close.recv()=>15 }
            }
        };
        let task = tokio::spawn(async move {
            reason.store(signal.await, Ordering::Release);
            ready.store(false, Ordering::Release);
            jobs.stop();
            sender.send_replace(true);
        });
        Ok(Self { task, receiver })
    }
}
pub async fn wait(mut receiver: watch::Receiver<bool>) {
    while !*receiver.borrow_and_update() {
        if receiver.changed().await.is_err() {
            return;
        }
    }
}
pub async fn drain(jobs: &Coordinator) {
    jobs.stop();
    if tokio::time::timeout(std::time::Duration::from_secs(20), jobs.drain())
        .await
        .is_err()
    {
        crate::log_warn(
            "Sync shutdown exceeded 20 seconds; service manager timeout remains authoritative",
        );
    }
}

/// Preserve native signal termination after cleanup (including container 143).
pub fn finish(reason: &AtomicI32) {
    let signal = reason.load(Ordering::Acquire);
    if signal != 0 {
        #[cfg(unix)]
        let _ = signal_hook::low_level::emulate_default_handler(signal);
        std::process::exit(128 + signal);
    }
}
