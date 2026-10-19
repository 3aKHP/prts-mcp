//! Change tokens for activation pointer files. Unix uses stat inode/times;
//! Windows uses the file ID so an atomic same-size replacement is observable.

use std::{fs::File, path::Path};

pub(crate) fn path_token(path: &Path) -> Option<String> {
    #[cfg(unix)]
    {
        let meta = std::fs::metadata(path).ok()?;
        Some(unix_token(&meta))
    }
    #[cfg(windows)]
    {
        file_token(&File::open(path).ok()?)
    }
}

#[cfg(unix)]
fn unix_token(meta: &std::fs::Metadata) -> String {
    use std::os::unix::fs::MetadataExt;
    format!(
        "{}|{}|{}|{}|{}|{}|{}",
        meta.dev(),
        meta.ino(),
        meta.len(),
        meta.mtime(),
        meta.mtime_nsec(),
        meta.ctime(),
        meta.ctime_nsec()
    )
}

pub(crate) fn file_token(file: &File) -> Option<String> {
    #[cfg(unix)]
    {
        Some(unix_token(&file.metadata().ok()?))
    }
    #[cfg(windows)]
    {
        windows_token(file)
    }
}

#[cfg(windows)]
fn windows_token(file: &File) -> Option<String> {
    use std::os::windows::io::AsRawHandle;
    // BY_HANDLE_FILE_INFORMATION from the Windows SDK. All fields are DWORDs
    // (FILETIME is two DWORDs); the kernel fills the initialized output buffer.
    #[repr(C)]
    #[derive(Default)]
    struct FileInformation {
        attributes: u32,
        creation_low: u32,
        creation_high: u32,
        access_low: u32,
        access_high: u32,
        write_low: u32,
        write_high: u32,
        volume: u32,
        size_high: u32,
        size_low: u32,
        links: u32,
        index_high: u32,
        index_low: u32,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetFileInformationByHandle(
            handle: *mut std::ffi::c_void,
            information: *mut FileInformation,
        ) -> i32;
    }
    let mut information = FileInformation::default();
    // SAFETY: the File owns a live Windows handle for the duration of this
    // call. The repr(C) buffer matches the SDK structure and is writable;
    // no pointer or handle escapes. Failure is reported before reading it.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) } == 0 {
        return None;
    }
    let pair = |high: u32, low: u32| (u64::from(high) << 32) | u64::from(low);
    Some(format!(
        "{}|{}|{}|{}|{}",
        information.volume,
        pair(information.index_high, information.index_low),
        pair(information.size_high, information.size_low),
        pair(information.write_high, information.write_low),
        pair(information.creation_high, information.creation_low)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_size_replacement_with_preserved_mtime_changes_identity() {
        let dir = std::env::temp_dir().join(format!("prts-file-identity-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let pointer = dir.join("pointer.json");
        let staging = dir.join("staging.json");
        std::fs::write(&pointer, b"old").unwrap();
        let mtime =
            filetime::FileTime::from_last_modification_time(&std::fs::metadata(&pointer).unwrap());
        let before = path_token(&pointer).unwrap();
        assert_eq!(
            path_token(&pointer).unwrap(),
            before,
            "stable reads reuse identity"
        );
        std::fs::write(&staging, b"new").unwrap();
        filetime::set_file_mtime(&staging, mtime).unwrap();
        std::fs::rename(&staging, &pointer).unwrap();
        assert_ne!(
            path_token(&pointer).unwrap(),
            before,
            "replacement must invalidate the data view"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
