//! eMudhra/emSign 信任回归测试 — RUSTSEC-2026-0383 / CVE-2026-111943。
//!
//! 钉住 3.1.2 修复的两个层面：
//! 1. webpki-roots 1.0.10 已从内嵌根库移除 emSign ECC Root CA - G3（T1）；
//! 2. rustls-webpki 0.103.16 对被攻破中间证书的 SPKI 路径拒绝仍然生效（T5）；
//! 3. 锁文件解析不存在旁路信任库或版本回退（T2）。
//!
//! 材料全部为公开数据（CT/CCADB/披露站可得）。junk 叶子的签名来自一把与链上
//! 任何公钥都不匹配的废弃密钥——该链在任何客户端下都不可能通过验证，零攻击能力。
//! junk 叶子生成方式（可第三方复核）：新生成 P-384 废钥对，issuer DN 复制真实
//! EM-DV-TLS-CA-G3B 的 subject，用该废钥签名（cryptography 库不校验 issuer 证书
//! 与签名钥的匹配）——签名公钥即叶证书自身 SPKI，与链上任何证书公钥均不同。
//!
//! 参考：https://rustsec.org/advisories/RUSTSEC-2026-0383.html
//! （事件背景：eMudhra 8 个中间证书私钥可从公开数据恢复，2026-10-17 披露。）

use std::error::Error;
use std::time::Duration;

/// emSign ECC Root CA - G3 的公开 SPKI SHA-256 指纹
/// （来源：披露站 roots.json，RUSTSEC-2026-0383 涉及的同一致性标识）。
const EMSIGN_ECC_G3_SPKI_SHA256: &str =
    "8d417db2dd8bf5e3084d1e3f196d583849d81bdd4c00c70b9d39369e96b8c782";

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");

/// `TrustAnchor.subject_public_key_info` 存的是去掉外层 SEQ 头的 SPKI 内容；
/// 公开指纹（CCADB/Mozilla 口径）是对完整 SPKI DER 的哈希，故先重建外壳。
fn full_spki_der(content: &[u8]) -> Vec<u8> {
    let mut out = vec![0x30];
    let n = content.len();
    if n < 0x80 {
        out.push(n as u8);
    } else {
        let bytes = n.to_be_bytes();
        let skip = bytes.iter().position(|b| *b != 0).unwrap();
        out.push(0x80 | (8 - skip) as u8);
        out.extend_from_slice(&bytes[skip..]);
    }
    out.extend_from_slice(content);
    out
}

fn sha256_hex(data: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(data)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

// ---------------------------------------------------------------------------
// T1：被移除的根不得重新出现在实际解析进二进制的根库中
// ---------------------------------------------------------------------------

#[test]
fn t1_emsign_g3_root_absent_from_embedded_store() {
    let anchors = webpki_roots::TLS_SERVER_ROOTS;
    assert!(
        anchors.len() > 100,
        "根库异常缩小（仅 {} 个锚点），疑似构建/解析回归",
        anchors.len()
    );
    for anchor in anchors {
        let spki = sha256_hex(&full_spki_der(anchor.subject_public_key_info.as_ref()));
        assert_ne!(
            spki, EMSIGN_ECC_G3_SPKI_SHA256,
            "emSign ECC Root CA - G3 的 SPKI 重新出现在 webpki-roots 根库：\
             该根下属 8 个中间证书私钥已公开（RUSTSEC-2026-0383），必须保持移除"
        );
    }
}

// ---------------------------------------------------------------------------
// T2：锁文件绊线——版本地板、单版本、无旁路信任库
// ---------------------------------------------------------------------------

#[test]
fn t2_lock_pins_fixed_trust_stack() {
    let lock = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.lock")).unwrap();
    for (name, floor) in [
        ("webpki-roots", (1, 0, 10)),
        ("rustls-webpki", (0, 103, 16)),
    ] {
        let mut versions: Vec<(u32, u32, u32)> = Vec::new();
        let mut pending = false;
        for line in lock.lines() {
            let line = line.trim();
            if line.starts_with("name = ") {
                pending = line == format!("name = \"{name}\"");
            } else if pending && line.starts_with("version = ") {
                // 假设三段纯数字版本号；两目标包历史上从未发过 -rc 预发布版，
                // 遇到时会在此 unwrap 失败变红，属可接受的绊线行为。
                let v: Vec<u32> = line
                    .trim_matches(|c: char| c == '"' || !c.is_ascii_digit() || c == '.')
                    .split('.')
                    .map(|p| p.parse().unwrap())
                    .collect();
                versions.push((v[0], v[1], v[2]));
                pending = false;
            }
        }
        assert_eq!(
            versions.len(),
            1,
            "{name} 在 Cargo.lock 中出现 {} 次（应恰好 1 次，多版本共存意味着存在绕过修复的解析路径）",
            versions.len()
        );
        let (maj, min, patch) = versions[0];
        assert!(
            (maj, min, patch) >= floor,
            "{name} 解析为 {maj}.{min}.{patch}，低于修复地板 {}.{}.{}",
            floor.0,
            floor.1,
            floor.2
        );
    }
    for banned in [
        "rustls-native-certs",
        "native-tls",
        "openssl-sys",
        "openssl",
    ] {
        assert!(
            !lock.contains(&format!("name = \"{banned}\"")),
            "Cargo.lock 出现 {banned}：出站 TLS 可能改走系统信任库，\
             内嵌根库断言（T1）将失去意义；若确需系统信任库须经维护者评审并同步修订本测试"
        );
    }
}

// ---------------------------------------------------------------------------
// T5：SPKI 阻断行为探针——废叶子（签名永远无效）+ 真实被吊销中间证书
// ---------------------------------------------------------------------------

async fn serve_poisoned_probe(listener: tokio::net::TcpListener) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let chain = std::fs::read(format!("{FIXTURES}/junk-chain.pem")).unwrap();
    let key_pem = std::fs::read(format!("{FIXTURES}/junk.key")).unwrap();
    let certs: Vec<rustls::pki_types::CertificateDer<'static>> =
        rustls_pemfile::certs(&mut &chain[..])
            .collect::<Result<_, _>>()
            .unwrap();
    let key = rustls_pemfile::private_key(&mut &key_pem[..])
        .unwrap()
        .unwrap();
    let mut sc = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .unwrap();
    sc.alpn_protocols = vec![b"http/1.1".to_vec()];
    let acceptor = std::sync::Arc::new(tokio_rustls::TlsAcceptor::from(std::sync::Arc::new(sc)));
    loop {
        let Ok((tcp, _)) = listener.accept().await else {
            continue;
        };
        let a = acceptor.clone();
        tokio::spawn(async move {
            if let Ok(mut tls) = a.accept(tcp).await {
                let mut buf = [0u8; 1024];
                let _ = tls.read(&mut buf).await;
                let _ = tls
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                    )
                    .await;
                let _ = tls.shutdown().await;
            }
        });
    }
}

#[tokio::test]
async fn t5_spki_blocklist_rejects_compromised_intermediate() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(serve_poisoned_probe(listener));

    // 最坏情况模拟：emSign G3 根被重新加入信任库（等价于有人在
    // NODE_EXTRA_CA_CERTS 指向的文件里塞回了该根）。根移除之外，
    // rustls-webpki 0.103.16 的 SPKI 阻断必须独立挡住这条路径。
    let root_pem = std::fs::read(format!("{FIXTURES}/emsign-ecc-root-ca-g3.pem")).unwrap();
    let root = reqwest::Certificate::from_pem(&root_pem).unwrap();
    let client = reqwest::Client::builder()
        .add_root_certificate(root)
        // no_proxy：环境代理会接管连接目标，使 resolve() 失效（实测踩坑）
        .no_proxy()
        .resolve("prts.wiki", addr)
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();

    let err = client
        .get("https://prts.wiki/api.php?action=query&format=json")
        .send()
        .await
        .expect_err("含被通缉中间证书的链必须被拒绝");

    let mut chain = format!("{err}");
    let mut src: Option<&dyn std::error::Error> = err.source();
    while let Some(s) = src {
        chain.push_str(&format!(" | {s}"));
        src = s.source();
    }
    let chain_lower = chain.to_lowercase();
    assert!(
        chain_lower.contains("distrust"),
        "拒绝原因不是\"不信任\"（CertDistrusted）而是：{chain}。\
         SPKI 阻断（rustls-webpki >= 0.103.16 的通缉机制）疑似失效——\
         回退到 BadSignature 意味着路径拒绝层已回退",
    );
}

// ---------------------------------------------------------------------------
// T3（可选金丝雀，默认跳过）：研究者线上测试站必须握手失败
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "网络测试：cargo test -- --ignored 手动运行；站点失效时可能假阴性"]
async fn t3_live_canary_compromised_chain_must_fail() {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap();
    let result = client
        .get("https://dv-g3b-emudhra.we-have-a-problem.com/")
        .send()
        .await;
    assert!(
        result.is_err(),
        "研究者测试主机（真实被攻破中间证书链）握手成功——信任库回归实锤"
    );
}
