//! Internal npm-launcher lifetime bridge. Windows force-kills do not deliver
//! Unix signals to Node, so the child also watches the launcher's OS handle.

#[cfg(not(windows))]
pub fn watch_parent() {}

#[cfg(windows)]
pub fn watch_parent() {
    use std::ffi::c_void;
    type Handle = *mut c_void;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
        fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
        fn CloseHandle(handle: Handle) -> i32;
    }
    let args: Vec<_> = std::env::args().collect();
    let Some(index) = args.iter().position(|arg| arg == "--launcher-parent-pid") else {
        return;
    };
    let pid = args.get(index + 1).and_then(|raw| raw.parse::<u32>().ok());
    let Some(pid) = pid.filter(|pid| *pid != 0 && *pid != std::process::id()) else {
        crate::log_err("Invalid internal npm launcher parent PID");
        std::process::exit(1);
    };
    let watch = std::thread::Builder::new()
        .name("npm-parent".into())
        .spawn(move || {
            // Only wait access is requested. The OS handle pins this process
            // identity, avoiding PID reuse after it has been opened. Ownership is
            // local to this thread; the handle is closed before process exit.
            let result = unsafe {
                let handle = OpenProcess(0x0010_0000, 0, pid); // SYNCHRONIZE
                if handle.is_null() {
                    0xffff_ffff
                } else {
                    let result = WaitForSingleObject(handle, 0xffff_ffff); // INFINITE
                    CloseHandle(handle);
                    result
                }
            };
            if result != 0 {
                crate::log_err("npm launcher parent is unavailable; stopping native server");
            }
            std::process::exit(1);
        });
    if let Err(error) = watch {
        crate::log_err(&format!("Cannot monitor npm launcher parent: {error}"));
        std::process::exit(1);
    }
}
