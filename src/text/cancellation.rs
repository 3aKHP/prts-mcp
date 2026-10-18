//! Cooperative cancellation for synchronous query workers and native regex.
use std::{
    cell::RefCell,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
thread_local! {
    static CURRENT: RefCell<Option<Arc<AtomicBool>>> = const { RefCell::new(None) };
}
pub(crate) struct Scope(Option<Arc<AtomicBool>>);
impl Scope {
    pub(crate) fn enter(token: Arc<AtomicBool>) -> Self {
        Self(CURRENT.with(|current| current.replace(Some(token))))
    }
}
impl Drop for Scope {
    fn drop(&mut self) {
        CURRENT.with(|current| {
            current.replace(self.0.take());
        });
    }
}
pub(crate) fn check() -> Result<(), String> {
    if cancelled(std::ptr::null_mut()) != 0 {
        Err("Query cancelled".into())
    } else {
        Ok(())
    }
}
pub(crate) extern "C" fn cancelled(_: *mut std::ffi::c_void) -> std::ffi::c_int {
    CURRENT.with(|current| {
        i32::from(
            current
                .borrow()
                .as_ref()
                .is_some_and(|token| token.load(Ordering::Relaxed)),
        )
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn interrupted_native_regex_stops_and_scope_does_not_leak() {
        let token = Arc::new(AtomicBool::new(false));
        let scope = Scope::enter(Arc::clone(&token));
        let cancel = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(20));
            token.store(true, Ordering::Relaxed);
        });
        let regex = super::super::regex_compat::JsRegex::compile("(a+)+$").unwrap();
        let result = regex.is_match(&("a".repeat(100) + "!"));
        cancel.join().unwrap();
        assert!(result.is_err());
        assert!(check().is_err());
        drop(scope);
        assert!(check().is_ok());
    }
}
