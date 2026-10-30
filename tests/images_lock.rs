use prts_mcp_rust::sync::images_lock::with_images_lock;
use std::{
    process::{Command, Stdio},
    time::{Duration, Instant},
};

#[test]
#[ignore = "subprocess helper invoked by killed_image_writer_recovers_immediately"]
fn image_lease_child() {
    let root = std::env::var_os("PRTS_TEST_IMAGE_LEASE_ROOT").expect("helper root");
    let root = std::path::PathBuf::from(root);
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        with_images_lock(&root, || async {
            std::fs::write(root.join("ready"), b"ready").unwrap();
            std::future::pending::<()>().await;
        })
        .await
        .unwrap();
    });
}

#[tokio::test]
async fn killed_image_writer_recovers_immediately() {
    let root = std::env::temp_dir().join(format!("image-killed-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--exact", "image_lease_child"])
        .env("PRTS_TEST_IMAGE_LEASE_ROOT", &root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !root.join("ready").exists() {
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("child did not acquire image lease");
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(root.join(".images.lock/kernel-owner").is_file());
    let result = tokio::time::timeout(
        Duration::from_secs(2),
        with_images_lock(&root, || async { 42 }),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(result, 42);
    assert!(!root.join(".images.lock").exists());
    std::fs::remove_dir_all(root).unwrap();
}
