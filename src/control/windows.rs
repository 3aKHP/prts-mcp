//! Native named-pipe security boundary; all protocol handling remains safe Rust.
use std::{
    io,
    path::{Path, PathBuf},
};
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use windows_sys::Win32::{
    Foundation::LocalFree,
    Security::{
        Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW, SECURITY_ATTRIBUTES,
    },
};

fn create(path: &Path, first: bool) -> io::Result<NamedPipeServer> {
    // Protected DACL: object owner (the service identity), administrators, SYSTEM.
    let sddl: Vec<u16> = "D:P(A;;GA;;;OW)(A;;GA;;;BA)(A;;GA;;;SY)"
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut descriptor = std::ptr::null_mut();
    // SAFETY: the terminated UTF-16 input and output pointer remain valid for
    // the call. Windows allocates descriptor with LocalAlloc, freed below.
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let mut attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor,
        bInheritHandle: 0,
    };
    // SAFETY: attributes and its Windows-allocated descriptor live throughout
    // pipe creation, which copies the security descriptor into the kernel object.
    let result = unsafe {
        ServerOptions::new()
            .first_pipe_instance(first)
            .reject_remote_clients(true)
            .create_with_security_attributes_raw(
                path,
                (&mut attributes as *mut SECURITY_ATTRIBUTES).cast(),
            )
    };
    // SAFETY: exactly the allocation returned by the conversion above; no
    // retained Rust reference or kernel operation uses this allocation now.
    unsafe {
        LocalFree(descriptor);
    }
    result
}

pub struct Listener {
    next: NamedPipeServer,
    path: PathBuf,
}
impl Listener {
    pub fn bind(path: &Path) -> io::Result<Self> {
        if !super::instances::valid_endpoint(path) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "expected local prts-mcp named pipe",
            ));
        }
        Ok(Self {
            next: create(path, true)?,
            path: path.to_owned(),
        })
    }
    pub async fn accept(&mut self) -> io::Result<NamedPipeServer> {
        self.next.connect().await?;
        let next = create(&self.path, false)?;
        Ok(std::mem::replace(&mut self.next, next))
    }
}
