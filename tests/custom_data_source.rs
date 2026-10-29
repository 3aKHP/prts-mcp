//! Exercise configured JSON sources through the actual startup scheduler.
use async_trait::async_trait;
use prts_mcp_rust::{
    config::RuntimeConfig,
    storage::write_zip_entries,
    sync::{
        datasets,
        scheduler::run_startup_sync,
        source_guard,
        transport::{DownloadStats, Transport, TransportError},
    },
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("prts-custom-{}", uuid::Uuid::new_v4())))
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
struct Fixture {
    slug: String,
    assets: HashMap<String, Vec<u8>>,
    requests: Mutex<Vec<String>>,
    offline: bool,
}
#[async_trait]
impl Transport for Fixture {
    async fn fetch_json(&self, url: &str, _: u64) -> Result<Value, TransportError> {
        self.requests.lock().unwrap().push(url.into());
        if self.offline {
            return Err(TransportError::Network("offline".into()));
        }
        if url.starts_with("https://api.github.com/") {
            assert_eq!(
                url,
                format!(
                    "https://api.github.com/repos/{}/releases?per_page=100",
                    self.slug
                )
            );
            return Ok(
                json!([{"tag_name":"data-26-10-22-14-02-11_51447808", "assets": self.assets.keys().map(|name| json!({"name": name,"browser_download_url":format!("https://github.com/{}/releases/download/data-26-10-22-14-02-11_51447808/{name}", self.slug)})).collect::<Vec<_>>()}]),
            );
        }
        assert!(url.starts_with(&format!("https://github.com/{}/", self.slug)));
        assert!(url.ends_with("manifest.json"));
        Ok(
            json!({"contractVersion":"prts-mcp-data/v1", "assets":self.assets.iter().map(|(name,bytes)| (name.clone(),json!({"size":bytes.len(),"sha256":format!("{:x}",Sha256::digest(bytes))}))).collect::<serde_json::Map<_,_>>()}),
        )
    }
    async fn download(
        &self,
        url: &str,
        dest: &Path,
        _: u64,
    ) -> Result<DownloadStats, TransportError> {
        self.requests.lock().unwrap().push(url.into());
        assert!(url.starts_with(&format!("https://github.com/{}/", self.slug)));
        let bytes = &self.assets[url.rsplit('/').next().unwrap()];
        std::fs::write(dest, bytes).unwrap();
        Ok(DownloadStats {
            bytes: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(bytes)),
        })
    }
    fn mirrors(&self) -> Vec<String> {
        vec![]
    }
    fn github_headers(&self) -> Vec<(String, String)> {
        vec![]
    }
}
fn config(root: &Path, slug: &str) -> RuntimeConfig {
    let mut config = RuntimeConfig::from_lookup(|key| match key {
        "PRTS_DATA_SOURCE_REPO" => Some(slug.into()),
        _ => None,
    });
    let root = config.data_source.data_root(root);
    config.gamedata_path = root.join("gamedata");
    config.excel_path = config.gamedata_path.join("zh_CN/gamedata/excel");
    config.levels_path = root.join("gamedata-levels");
    config.storyjson_zip = root.join("storyjson/zh_CN.zip");
    config
}
fn fixture(root: &Path, slug: &str) -> Fixture {
    let mut assets = HashMap::new();
    for dataset in [
        datasets::gamedata_excel(),
        datasets::gamedata_levels(),
        datasets::story_zh_cn(),
    ] {
        let zip = root.join(&dataset.asset_name);
        let entries: Vec<_> = dataset
            .required_files
            .iter()
            .map(|name| (name.as_str(), b"{}".as_slice()))
            .collect();
        write_zip_entries(&zip, &entries).unwrap();
        assets.insert(dataset.asset_name, std::fs::read(zip).unwrap());
    }
    Fixture {
        slug: slug.into(),
        assets,
        requests: Mutex::new(vec![]),
        offline: false,
    }
}
#[tokio::test]
async fn json_pair_and_story_are_isolated_even_with_identical_version_ids() {
    let temp = Temp::new();
    let mut paths = Vec::new();
    for slug in ["team/source-a", "team/source-b"] {
        let config = Arc::new(config(&temp.0.join("runtime"), slug));
        let mut default_config = (*config).clone();
        default_config.data_source = Default::default();
        let default_app = prts_mcp_rust::app::App::try_with_config(default_config).unwrap();
        assert!(default_app.data.snapshot().excel_root.is_none());
        source_guard::prepare(&config).unwrap();
        let fixture = Arc::new(fixture(&temp.0.join("fixtures"), slug));
        run_startup_sync(config.clone(), fixture.clone(), true).await;
        assert!(config
            .gamedata_path
            .parent()
            .unwrap()
            .join(".gamedata_pair.json")
            .exists());
        assert!(config.storyjson_zip.exists());
        for _ in 0..2 {
            let view = default_app.data.snapshot();
            assert!(view.excel_root.is_none());
            assert!(view.levels_root.is_none());
            assert!(view.story_zip.is_none());
        }
        let requests = fixture.requests.lock().unwrap().clone();
        for name in ["zh_CN-excel.zip", "zh_CN-levels.zip", "zh_CN.zip"] {
            assert!(requests.iter().any(|url| url.ends_with(name)), "{name}");
        }
        let before = std::fs::read(
            config
                .gamedata_path
                .parent()
                .unwrap()
                .join(".gamedata_pair.json"),
        )
        .unwrap();
        let offline = Arc::new(Fixture {
            slug: slug.into(),
            assets: HashMap::new(),
            requests: Mutex::new(vec![]),
            offline: true,
        });
        run_startup_sync(config.clone(), offline, true).await;
        assert_eq!(
            std::fs::read(
                config
                    .gamedata_path
                    .parent()
                    .unwrap()
                    .join(".gamedata_pair.json")
            )
            .unwrap(),
            before
        );
        paths.push(config.gamedata_path.clone());
    }
    assert_ne!(paths[0], paths[1]);
}
#[test]
fn default_and_explicit_default_have_identical_paths() {
    let unset = RuntimeConfig::from_lookup(|_| None);
    let explicit = RuntimeConfig::from_lookup(|key| {
        (key == "PRTS_DATA_SOURCE_REPO").then(|| "3AKHP/ARKNIGHTS-DATA-PIPELINE".into())
    });
    assert_eq!(unset.gamedata_path, explicit.gamedata_path);
    assert_eq!(unset.images_path, explicit.images_path);
    assert_eq!(unset.database_dir, explicit.database_dir);
    let custom = RuntimeConfig::from_lookup(|key| {
        (key == "PRTS_DATA_SOURCE_REPO").then(|| "team/assets".into())
    });
    assert_eq!(
        custom.gamedata_path,
        unset
            .gamedata_path
            .parent()
            .unwrap()
            .join("sources/team/assets/gamedata")
    );
    assert_eq!(
        custom.levels_path,
        custom
            .gamedata_path
            .parent()
            .unwrap()
            .join("gamedata-levels")
    );
}
#[test]
fn disabled_sync_leaves_explicit_local_inputs_alone() {
    let temp = Temp::new();
    let root = temp.0.to_string_lossy().to_string();
    let cfg = RuntimeConfig::from_lookup(|key| match key {
        "PRTS_DATA_SOURCE_REPO" => Some("team/assets".into()),
        "GAMEDATA_PATH" | "STORYJSON_PATH" => Some(root.clone()),
        _ => None,
    });
    source_guard::prepare(&cfg).unwrap();
    assert!(!temp.0.exists());
}

#[test]
fn startup_rejects_conflicting_explicit_image_directory_before_readers() {
    let temp = Temp::new();
    let mut cfg = config(&temp.0.join("runtime"), "team/assets");
    cfg.images_enabled = true;
    cfg.local_image = true;
    cfg.images_path = temp.0.join("explicit-images");
    std::fs::create_dir_all(&cfg.images_path).unwrap();
    std::fs::write(cfg.images_path.join("old.png"), b"old").unwrap();
    assert!(prts_mcp_rust::app::App::try_with_config(cfg.clone()).is_err());
    assert_eq!(
        std::fs::read(cfg.images_path.join("old.png")).unwrap(),
        b"old"
    );
}

#[tokio::test]
async fn running_default_artwork_reader_rejects_later_custom_binding() {
    use prts_mcp_rust::{app::App, config::DataSource, tools::DispatchResult};
    let temp = Temp::new();
    let image = temp.0.join("images");
    let default_config = RuntimeConfig::from_lookup(|key| match key {
        "GAMEDATA_PATH" => Some(temp.0.join("manual-data").display().to_string()),
        "STORYJSON_PATH" => Some(temp.0.join("manual-story.zip").display().to_string()),
        "PRTS_IMAGE_DIR" => Some(image.display().to_string()),
        "LOCAL_IMAGE" => Some("true".into()),
        _ => None,
    });
    let default_app = App::try_with_config(default_config.clone()).unwrap();
    let mut custom_config = default_config;
    custom_config.data_source = DataSource::parse(Some("team/assets")).unwrap();
    let custom_app = App::try_with_config(custom_config).unwrap();
    let generation = image.join(".generations/custom");
    std::fs::create_dir_all(&generation).unwrap();
    std::fs::write(generation.join("index.json"), r#"{"schemaVersion":"akdp-images/v1","artworks":{"char_1001_amiya2":{"large":{"file":"custom.png","w":1,"h":1,"bytes":1,"sha256":"custom"}}}}"#).unwrap();
    std::fs::write(
        image.join(".images_meta.json"),
        r#"{"generation_root":".generations/custom"}"#,
    )
    .unwrap();
    let tool = default_app
        .tools
        .iter()
        .find(|tool| tool.name == "operator_artwork")
        .unwrap();
    let args = json!({"operator_name":"阿米娅(近卫)","action":"list"});
    let DispatchResult::Outcome(custom) = (tool.dispatch)(&custom_app.handle, &args).await else {
        panic!("tool outcome")
    };
    assert!(custom.structured.is_some());
    for _ in 0..2 {
        let DispatchResult::Outcome(default) = (tool.dispatch)(&default_app.handle, &args).await
        else {
            panic!("tool outcome")
        };
        assert!(default.structured.is_none());
        assert!(default.image.is_none());
        assert!(default.markdown.contains("数据源与配置不一致"));
    }
}
