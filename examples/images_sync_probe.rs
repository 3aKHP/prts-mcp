//! P6 measurement probe: one full-scale images sync against the real
//! upstream, printing the SyncResult plus VmHWM/VmRSS from /proc.
//! Usage: images_sync_probe <image_dir> [include_original]

use prts_mcp_rust::sync::images_sync::{sync_images, ImagesSyncOpts};
use prts_mcp_rust::sync::transport::ReqwestTransport;

fn proc_status() -> (u64, u64) {
    let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    let grab = |key: &str| -> u64 {
        status
            .lines()
            .find(|l| l.starts_with(key))
            .and_then(|l| l.split_whitespace().nth(1).and_then(|v| v.parse().ok()))
            .unwrap_or(0)
    };
    (grab("VmHWM:"), grab("VmRSS:"))
}

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let dir = args.next().expect("image dir");
    let include_original = args.next().as_deref() == Some("true");
    let transport = ReqwestTransport::new(Vec::new(), None);
    let started = std::time::Instant::now();
    let result = sync_images(
        std::path::Path::new(&dir),
        &transport,
        ImagesSyncOpts {
            include_original,
            force_check: false,
        },
    )
    .await;
    let (hwm, rss) = proc_status();
    println!(
        "{}",
        serde_json::json!({
            "status": result.status.as_str(),
            "commitSha": result.commit_sha,
            "error": result.error,
            "durationMs": started.elapsed().as_millis() as u64,
            "vmHwmKb": hwm,
            "vmRssKb": rss,
        })
    );
}
