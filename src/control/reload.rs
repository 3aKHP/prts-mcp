//! Validate a complete file candidate, then atomically publish allowed fields.
use crate::{
    cli::settings::Context,
    config::RuntimeConfig,
    sync::{jobs::Coordinator, transport::ReqwestTransport},
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

const ALLOWED: &[&str] = &[
    "PRTS_AUTO_SYNC_INTERVAL_SECONDS",
    "GITHUB_TOKEN",
    "GITHUB_MIRRORS",
];
struct Applied {
    report: Value,
    config: Arc<RuntimeConfig>,
    revision: u64,
}

pub struct Configuration {
    context: Context,
    transport: &'static str,
    jobs: Arc<Coordinator>,
    applied: Mutex<Applied>,
}
impl Configuration {
    pub fn new(
        context: Context,
        report: Value,
        transport: &'static str,
        config: Arc<RuntimeConfig>,
        jobs: Arc<Coordinator>,
    ) -> Self {
        Self {
            context,
            transport,
            jobs,
            applied: Mutex::new(Applied {
                report,
                config,
                revision: 1,
            }),
        }
    }
    pub fn show(&self) -> Value {
        let applied = self.applied.lock().expect("runtime configuration");
        let mut report = applied.report.clone();
        report["revision"] = json!(applied.revision);
        report
    }
    /// Holding this lock across candidate parsing serializes diff/reload/show.
    /// Workers take their snapshots at admission under the coordinator lock.
    pub fn evaluate(&self, expected: Option<u64>) -> Result<Value, String> {
        let mut applied = self.applied.lock().expect("runtime configuration");
        if expected.is_some_and(|revision| revision != applied.revision) {
            return Err("配置 revision 已变化，请重新 diff".into());
        }
        let mut candidate = self.context.read()?;
        candidate.config.bundle_root = applied.config.bundle_root.clone();
        let mut changes = Vec::new();
        let before = applied.report["fields"]
            .as_array()
            .ok_or("配置快照缺少 fields")?;
        let after = candidate.report["fields"]
            .as_array()
            .ok_or("候选配置缺少 fields")?;
        for (old, new) in before.iter().zip(after) {
            let key = old["key"].as_str().ok_or("配置字段缺少 key")?;
            let changed = match key {
                "GITHUB_TOKEN" => applied.config.github_token != candidate.config.github_token,
                "GITHUB_MIRRORS" => {
                    applied.config.github_mirrors != candidate.config.github_mirrors
                }
                "PRTS_DEBUG_TOKEN" => applied.config.debug_token != candidate.config.debug_token,
                _ => old["value"] != new["value"],
            };
            if changed {
                changes.push(json!({"key":key,"before":old["value"],"after":new["value"],"action":if ALLOWED.contains(&key){"reload"}else{"restart"}}));
            }
        }
        // Compare the actual typed configuration too: redacted values and
        // derived flags (e.g. explicit SQLite disabling fallback) matter.
        let mut immutable = candidate.config.clone();
        immutable.auto_sync_interval_ms = applied.config.auto_sync_interval_ms;
        immutable.github_token = applied.config.github_token.clone();
        immutable.github_mirrors = applied.config.github_mirrors.clone();
        // HTTP port spellings that bind the same port are equivalent.
        if crate::config::ts_bind_port(
            immutable
                .port_raw
                .as_deref()
                .map(crate::config::js_parse_number)
                .unwrap_or(3000.0),
        ) == crate::config::ts_bind_port(
            applied
                .config
                .port_raw
                .as_deref()
                .map(crate::config::js_parse_number)
                .unwrap_or(3000.0),
        ) {
            immutable.port_raw = applied.config.port_raw.clone();
        }
        let restart = immutable != *applied.config || candidate.transport != self.transport;
        if restart && !changes.iter().any(|v| v["action"] == "restart") {
            changes.push(json!({"key":"derived_configuration","action":"restart"}));
        }
        // Reject malformed auth and mirror URLs without reporting secret text.
        if candidate.config.github_token.as_ref().is_some_and(|token| {
            reqwest::header::HeaderValue::from_str(&format!("Bearer {token}")).is_err()
        }) {
            return Err("GITHUB_TOKEN 不能用作 HTTP 请求头".into());
        }
        for mirror in &candidate.config.github_mirrors {
            let url =
                reqwest::Url::parse(mirror).map_err(|_| "GITHUB_MIRRORS 必须为有效 HTTP(S) URL")?;
            if !["http", "https"].contains(&url.scheme()) || url.host_str().is_none() {
                return Err("GITHUB_MIRRORS 必须为有效 HTTP(S) URL".into());
            }
        }
        if expected.is_some() && restart {
            return Err(
                "候选配置包含需要重启的变更；整批未应用，请先运行 runtime config diff".into(),
            );
        }
        let mut report = json!({"schema_version":1,"revision":applied.revision,"restart_required":restart,"changes":changes,"applied":false});
        if expected.is_some() {
            let transport = ReqwestTransport::try_new(
                candidate.config.github_mirrors.clone(),
                candidate.config.github_token.clone(),
            )?;
            let config = Arc::new(candidate.config);
            let revision =
                self.jobs
                    .replace(applied.revision, config.clone(), Arc::new(transport))?;
            candidate.report["scope"] = json!("runtime");
            *applied = Applied {
                report: candidate.report,
                config,
                revision,
            };
            report["revision"] = json!(revision);
            report["applied"] = json!(true);
        }
        Ok(report)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::BTreeMap, path::PathBuf};
    struct Fixture {
        path: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            Self {
                path: std::env::temp_dir()
                    .join(format!("prts-reload-{}.toml", uuid::Uuid::new_v4())),
            }
        }
        fn write(&self, fields: &str) {
            std::fs::write(&self.path, format!("schema_version=1\n[runtime]\n{fields}")).unwrap();
        }
        fn load(
            &self,
            env: BTreeMap<String, String>,
            args: BTreeMap<String, String>,
        ) -> (Configuration, Arc<Coordinator>) {
            let settings = Context::isolated(self.path.clone(), env, args)
                .read()
                .unwrap();
            let config = Arc::new(settings.config);
            let jobs = Coordinator::new(
                config.clone(),
                Arc::new(ReqwestTransport::new(
                    config.github_mirrors.clone(),
                    config.github_token.clone(),
                )),
            );
            (
                Configuration::new(
                    settings.context,
                    settings.report,
                    "http",
                    config,
                    jobs.clone(),
                ),
                jobs,
            )
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.path);
        }
    }
    #[tokio::test]
    async fn reload_is_atomic_revision_checked_and_redacted() {
        let fixture = Fixture::new();
        fixture.write("GITHUB_TOKEN='old-secret'\nPRTS_AUTO_SYNC_INTERVAL_SECONDS=60\n");
        let (configuration, jobs) = fixture.load(BTreeMap::new(), BTreeMap::new());
        let active = jobs.snapshot();
        fixture.write("GITHUB_TOKEN='new-secret'\nPRTS_AUTO_SYNC_INTERVAL_SECONDS=120\n");
        let diff = configuration.evaluate(None).unwrap();
        assert_eq!(diff["restart_required"], false);
        assert!(!diff.to_string().contains("secret"));
        assert_eq!(configuration.evaluate(Some(1)).unwrap()["revision"], 2);
        assert_eq!(
            jobs.snapshot().config.github_token.as_deref(),
            Some("new-secret")
        );
        assert_eq!(active.config.github_token.as_deref(), Some("old-secret"));
        assert!(!Arc::ptr_eq(&active.transport, &jobs.snapshot().transport));
        assert!(configuration.evaluate(Some(1)).is_err());
        fixture.write("GITHUB_TOKEN='third-secret'\nPORT=1234\n");
        assert_eq!(
            configuration.evaluate(None).unwrap()["restart_required"],
            true
        );
        assert!(configuration.evaluate(Some(2)).is_err());
        assert_eq!(
            jobs.snapshot().config.github_token.as_deref(),
            Some("new-secret")
        );
        assert_eq!(configuration.show()["revision"], 2);
        fixture.write("GITHUB_TOKEN='third-secret'\nGITHUB_MIRRORS='not a url'\n");
        assert!(configuration.evaluate(Some(2)).is_err());
        assert_eq!(jobs.snapshot().revision, 2);
    }
    #[tokio::test]
    async fn environment_arguments_and_derived_startup_policy_are_preserved() {
        let fixture = Fixture::new();
        fixture.write("GITHUB_TOKEN='file-secret'\nPRTS_AUTO_SYNC_INTERVAL_SECONDS=60\n");
        let (configuration, jobs) = fixture.load(
            BTreeMap::from([("GITHUB_TOKEN".into(), "env-secret".into())]),
            BTreeMap::from([("PRTS_AUTO_SYNC_INTERVAL_SECONDS".into(), "120".into())]),
        );
        fixture.write("GITHUB_TOKEN='changed-file-secret'\nPRTS_AUTO_SYNC_INTERVAL_SECONDS=240\n");
        assert_eq!(configuration.evaluate(None).unwrap()["changes"], json!([]));
        configuration.evaluate(Some(1)).unwrap();
        assert_eq!(
            jobs.snapshot().config.github_token.as_deref(),
            Some("env-secret")
        );
        assert_eq!(jobs.snapshot().config.auto_sync_interval_ms, 120000);
        // Same displayed backend, different fallback and sync policy.
        fixture.write("PRTS_DATA_BACKEND='sqlite'\n");
        assert_eq!(
            configuration.evaluate(None).unwrap()["restart_required"],
            true
        );
        assert!(configuration.evaluate(Some(2)).is_err());
    }
    #[tokio::test]
    async fn changed_debug_secret_requires_restart_even_when_both_values_are_redacted() {
        let fixture = Fixture::new();
        fixture.write("PRTS_DEBUG_TOKEN='before'\n");
        let (configuration, _) = fixture.load(BTreeMap::new(), BTreeMap::new());
        fixture.write("PRTS_DEBUG_TOKEN='after'\n");
        let diff = configuration.evaluate(None).unwrap();
        assert_eq!(diff["restart_required"], true);
        assert_eq!(diff["changes"][0]["key"], "PRTS_DEBUG_TOKEN");
        assert!(configuration.evaluate(Some(1)).is_err());
    }
}
