use prts_mcp_rust::sync::transport::{ReqwestTransport, Transport};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::test]
async fn bounded_download_checks_headers_and_stream_before_writing() {
    let root = std::env::temp_dir().join(format!("image-transfer-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let transport = ReqwestTransport::new(vec![], None);
    for (i, response, success) in [
        (0, "HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nabcdef", false),
        (1, "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n3\r\nabc\r\n3\r\ndef\r\n0\r\n\r\n", false),
        (2, "HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nabcd", true),
        (3, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nab", true),
    ] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/asset", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            let count = stream.read(&mut request).await.unwrap();
            assert!(count > 0);
            let _ = stream.write_all(response.as_bytes()).await;
        });
        let dest = root.join(i.to_string());
        let result = transport.download_file_limited(&url, &dest, 5000, 4).await;
        assert_eq!(result.is_ok(), success, "{result:?}");
        assert!(std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0) <= 4);
        server.await.unwrap();
    }
    std::fs::remove_dir_all(root).unwrap();
}
