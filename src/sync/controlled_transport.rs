//! Cancellation interrupts network waits while allowing publishers to unwind normally.
use super::{
    control::Control,
    transport::{DownloadStats, Transport, TransportError},
};
use serde_json::Value;
use std::{path::Path, sync::Arc};
pub(super) struct Controlled<'a> {
    pub inner: &'a dyn Transport,
    pub control: Arc<Control>,
}
#[async_trait::async_trait]
impl Transport for Controlled<'_> {
    async fn fetch_json(&self, url: &str, timeout: u64) -> Result<Value, TransportError> {
        self.control
            .transfer(self.inner.fetch_json(url, timeout))
            .await
    }
    async fn download(
        &self,
        url: &str,
        dest: &Path,
        timeout: u64,
    ) -> Result<DownloadStats, TransportError> {
        self.control
            .transfer(self.inner.download(url, dest, timeout))
            .await
    }
    async fn download_file(
        &self,
        url: &str,
        dest: &Path,
        timeout: u64,
    ) -> Result<u64, TransportError> {
        self.control
            .transfer(self.inner.download_file(url, dest, timeout))
            .await
    }
    async fn download_file_limited(
        &self,
        url: &str,
        dest: &Path,
        timeout: u64,
        limit: u64,
    ) -> Result<u64, TransportError> {
        self.control
            .transfer(self.inner.download_file_limited(url, dest, timeout, limit))
            .await
    }
    async fn download_limited(
        &self,
        url: &str,
        dest: &Path,
        timeout: u64,
        limit: u64,
    ) -> Result<DownloadStats, TransportError> {
        self.control
            .transfer(self.inner.download_limited(url, dest, timeout, limit))
            .await
    }
    fn mirrors(&self) -> Vec<String> {
        self.inner.mirrors()
    }
    fn github_headers(&self) -> Vec<(String, String)> {
        self.inner.github_headers()
    }
}
