//! Immutable proxy selection shared by every outbound client.
use base64::Engine;
use hyper_util::client::proxy::matcher::Matcher;
use std::{collections::BTreeMap, fmt, path::PathBuf, sync::Arc};

pub const PROXY_KEYS: [&str; 4] = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"];

#[derive(Clone)]
pub struct NetworkConfig {
    pub values: BTreeMap<String, String>,
    pub extra_ca: Option<PathBuf>,
    resolver: Arc<Matcher>,
    system_discovery: bool,
}
impl fmt::Debug for NetworkConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("NetworkConfig")
            .field("extra_ca", &self.extra_ca)
            .finish_non_exhaustive()
    }
}
impl PartialEq for NetworkConfig {
    fn eq(&self, other: &Self) -> bool {
        self.values == other.values
            && self.extra_ca == other.extra_ca
            && self.system_discovery == other.system_discovery
    }
}
impl NetworkConfig {
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Self {
        let values: BTreeMap<_, _> = PROXY_KEYS
            .iter()
            .filter_map(|key| {
                lookup(key)
                    .or_else(|| lookup(&key.to_ascii_lowercase()))
                    .map(|v| ((*key).into(), v))
            })
            .collect();
        let value = |key: &str| values.get(key).cloned().unwrap_or_default();
        let resolver = if lookup("REQUEST_METHOD").is_some() {
            Matcher::builder().build()
        } else {
            Matcher::builder()
                .http(value("HTTP_PROXY"))
                .https(value("HTTPS_PROXY"))
                .all(value("ALL_PROXY"))
                .no(value("NO_PROXY"))
                .build()
        };
        Self {
            values,
            extra_ca: lookup("NODE_EXTRA_CA_CERTS").map(PathBuf::from),
            resolver: Arc::new(resolver),
            system_discovery: false,
        }
    }
    /// Capture platform discovery once; no client performs its own environment lookup.
    pub fn from_env() -> Self {
        let mut result = Self::from_lookup(|key| std::env::var(key).ok());
        result.resolver = Arc::new(Matcher::from_system());
        result.system_discovery = true;
        result
    }
    pub fn retain_system_resolver(&mut self, startup: &Self) {
        self.resolver = startup.resolver.clone();
        self.system_discovery = true;
    }
    pub fn uses_system_discovery(&self) -> bool {
        self.system_discovery
    }
    pub fn valid_proxy(value: &str) -> bool {
        Matcher::builder()
            .all(value)
            .build()
            .intercept(&"http://validation.invalid".parse().expect("static URI"))
            .and_then(proxy_url)
            .is_some()
    }
    pub fn client_builder(&self) -> reqwest::ClientBuilder {
        let resolver = self.resolver.clone();
        reqwest::Client::builder()
            .no_proxy()
            .proxy(reqwest::Proxy::custom(move |url| {
                let target = resolver.intercept(&url.as_str().parse().ok()?)?;
                proxy_url(target)
            }))
    }
}

fn proxy_url(target: hyper_util::client::proxy::matcher::Intercept) -> Option<reqwest::Url> {
    let mut proxy = reqwest::Url::parse(&target.uri().to_string()).ok()?;
    if let Some(auth) = target.basic_auth() {
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(auth.to_str().ok()?.strip_prefix("Basic ")?)
            .ok()?;
        let decoded = String::from_utf8(decoded).ok()?;
        let (user, password) = decoded.split_once(':')?;
        proxy.set_username(&user.replace('%', "%25")).ok()?;
        proxy
            .set_password(Some(&password.replace('%', "%25")))
            .ok()?;
    } else if let Some((user, password)) = target.raw_auth() {
        proxy.set_username(&user.replace('%', "%25")).ok()?;
        proxy
            .set_password(Some(&password.replace('%', "%25")))
            .ok()?;
    }
    Some(proxy)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    fn settings(pairs: &[(&str, &str)]) -> NetworkConfig {
        NetworkConfig::from_lookup(|key| {
            pairs
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| v.to_string())
        })
    }
    #[test]
    fn aliases_fallback_bypass_and_cgi_match_existing_rules() {
        let cfg = settings(&[
            ("HTTP_PROXY", "http://upper:8080"),
            ("http_proxy", "http://lower:8081"),
            ("ALL_PROXY", "http://fallback:8082"),
            ("NO_PROXY", "localhost,.example.com,127.0.0.0/8"),
        ]);
        assert_eq!(
            cfg.resolver
                .intercept(&"http://remote.invalid".parse().unwrap())
                .unwrap()
                .uri()
                .host(),
            Some("upper")
        );
        assert_eq!(
            cfg.resolver
                .intercept(&"https://remote.invalid".parse().unwrap())
                .unwrap()
                .uri()
                .host(),
            Some("fallback")
        );
        for url in [
            "http://localhost",
            "https://sub.example.com",
            "http://127.0.0.2",
        ] {
            assert!(cfg.resolver.intercept(&url.parse().unwrap()).is_none());
        }
        let cgi = settings(&[
            ("REQUEST_METHOD", "GET"),
            ("HTTPS_PROXY", "http://proxy:8080"),
        ]);
        assert!(cgi
            .resolver
            .intercept(&"https://remote.invalid".parse().unwrap())
            .is_none());
    }
    #[tokio::test]
    async fn sync_client_uses_explicit_authenticated_proxy() {
        authenticated_proxy("user:password", "user:password").await;
        authenticated_proxy("user:literal%2541", "user:literal%41").await;
        authenticated_proxy("user%25:pa%25ss%3Aword", "user%:pa%ss:word").await;
    }
    async fn authenticated_proxy(encoded: &str, expected: &str) {
        use crate::sync::transport::{ReqwestTransport, Transport};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy = format!("http://{encoded}@{}", listener.local_addr().unwrap());
        let expected = format!(
            "proxy-authorization: Basic {}",
            base64::engine::general_purpose::STANDARD.encode(expected)
        )
        .to_ascii_lowercase();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = vec![0; 4096];
            let n = socket.read(&mut bytes).await.unwrap();
            let request = String::from_utf8_lossy(&bytes[..n]).to_ascii_lowercase();
            assert!(request.starts_with("get http://fixture.invalid/data "));
            assert!(request.contains(&expected));
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
                .await
                .unwrap();
        });
        let cfg = settings(&[("HTTP_PROXY", &proxy)]);
        let client = ReqwestTransport::with_network(vec![], None, &cfg).unwrap();
        client
            .fetch_json("http://fixture.invalid/data", 3000)
            .await
            .unwrap();
        server.await.unwrap();
    }
}
