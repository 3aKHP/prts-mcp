//! Filesystem permissions and peer credentials protect the local Unix endpoint.
use std::{
    io,
    os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
};
use tokio::net::{UnixListener, UnixStream};

pub struct Listener {
    inner: UnixListener,
    path: PathBuf,
    identity: (u64, u64),
    uid: u32,
}

fn identity(meta: &std::fs::Metadata) -> (u64, u64) {
    (meta.dev(), meta.ino())
}
fn denied(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, message)
}

impl Listener {
    pub async fn bind(path: &Path) -> io::Result<Self> {
        if !path.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "control endpoint must be absolute",
            ));
        }
        let (local, _peer) = UnixStream::pair()?;
        let uid = local.peer_cred()?.uid();
        let parent = path
            .parent()
            .ok_or_else(|| denied("control endpoint needs parent directory"))?;
        if !parent.exists() {
            std::fs::create_dir_all(parent)?;
            std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
        }
        let meta = std::fs::symlink_metadata(parent)?;
        if !meta.is_dir() || meta.uid() != uid || meta.mode() & 0o077 != 0 {
            return Err(denied(
                "control directory must be owned by server user with mode 0700",
            ));
        }
        match std::fs::symlink_metadata(path) {
            Ok(meta) => {
                if !meta.file_type().is_socket() || meta.uid() != uid {
                    return Err(denied("existing endpoint is not an owned socket"));
                }
                match UnixStream::connect(path).await {
                    Ok(_) => {
                        return Err(io::Error::new(
                            io::ErrorKind::AddrInUse,
                            "control endpoint already active",
                        ))
                    }
                    Err(error) if error.kind() == io::ErrorKind::ConnectionRefused => {
                        std::fs::remove_file(path)?
                    }
                    Err(error) => return Err(error),
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            Err(error) => return Err(error),
        }
        let inner = UnixListener::bind(path)?;
        let identity = identity(&std::fs::symlink_metadata(path)?);
        let listener = Self {
            inner,
            path: path.to_owned(),
            identity,
            uid,
        };
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        Ok(listener)
    }

    pub async fn accept(&self) -> io::Result<UnixStream> {
        let (stream, _) = self.inner.accept().await?;
        let peer = stream.peer_cred()?.uid();
        if peer != self.uid && peer != 0 {
            return Err(denied("control client identity not authorized"));
        }
        Ok(stream)
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        if std::fs::symlink_metadata(&self.path).is_ok_and(|m| identity(&m) == self.identity) {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn owns_socket_lifetime_and_refuses_replacement() {
        let root = std::env::temp_dir().join(format!("prts-control-{}", uuid::Uuid::new_v4()));
        let path = root.join("control.sock");
        let listener = Listener::bind(&path).await.unwrap();
        let client = UnixStream::connect(&path).await.unwrap();
        let _accepted = listener.accept().await.unwrap();
        assert!(matches!(Listener::bind(&path).await,Err(e) if e.kind()==io::ErrorKind::AddrInUse));
        drop(client);
        drop(listener);
        assert!(!path.exists());
        std::fs::write(&path, b"keep").unwrap();
        assert!(Listener::bind(&path).await.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"keep");
        std::fs::remove_dir_all(root).unwrap();
    }
}
