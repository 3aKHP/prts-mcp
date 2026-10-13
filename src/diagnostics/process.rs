//! OS measurements via a small C adapter using the actual platform SDK types.

#[cfg(any(windows, target_os = "macos"))]
pub(super) fn memory() -> (u64, u64) {
    extern "C" {
        fn prts_process_memory(resident: *mut u64, peak: *mut u64) -> i32;
    }
    let (mut resident, mut peak) = (0, 0);
    // SAFETY: the adapter receives two valid initialized writable integers
    // for this synchronous call and does not retain their pointers. OS-query
    // failure is returned explicitly and leaves the public fallback at zero.
    if unsafe { prts_process_memory(&mut resident, &mut peak) } == 0 {
        (0, 0)
    } else {
        (resident, peak)
    }
}

#[cfg(target_os = "linux")]
pub(super) fn page_size() -> u64 {
    extern "C" {
        fn prts_page_size() -> u64;
    }
    static SIZE: std::sync::OnceLock<u64> = std::sync::OnceLock::new();
    *SIZE.get_or_init(|| {
        // SAFETY: no pointers/ownership cross the boundary; sysconf only
        // reads the OS page size. Cache it to avoid repeated native calls.
        unsafe { prts_page_size() }
    })
}
