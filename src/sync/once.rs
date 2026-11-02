//! One explicit synchronization cycle, with no scheduled retries or polling.
use super::{
    control::Control,
    controlled_transport::Controlled,
    datasets,
    transport::Transport,
    types::{SyncResult, SyncStatus},
};
use crate::config::{DataBackend, RuntimeConfig};
use serde::Serialize;
use std::sync::Arc;

#[derive(Serialize)]
pub struct Outcome {
    pub target: &'static str,
    pub status: &'static str,
    pub ok: bool,
    pub version: Option<String>,
    pub message: &'static str,
}
impl Outcome {
    fn skipped(target: &'static str, message: &'static str) -> Self {
        Self {
            target,
            status: "skipped",
            ok: true,
            version: None,
            message,
        }
    }
    fn result(target: &'static str, result: SyncResult) -> Self {
        let ok = matches!(result.status, SyncStatus::Updated | SyncStatus::UpToDate);
        Self {
            target,
            status: result.status.as_str(),
            ok,
            version: result.commit_sha,
            message: if ok {
                "同步完成"
            } else if result.status == SyncStatus::OfflineFallback {
                "同步失败；已有数据仍可使用"
            } else {
                "同步失败，未获得可用数据"
            },
        }
    }
    fn failed(target: &'static str) -> Self {
        Self {
            target,
            status: "failed",
            ok: false,
            version: None,
            message: "同步操作失败；请检查网络、数据源、磁盘空间和权限",
        }
    }
}
#[derive(Serialize)]
pub struct Report {
    pub schema_version: u32,
    pub ok: bool,
    pub cancelled: bool,
    pub lock_timeout: bool,
    pub results: Vec<Outcome>,
}
impl Report {
    pub fn exit_code(&self) -> i32 {
        if self.lock_timeout {
            3
        } else if self.ok {
            0
        } else {
            1
        }
    }
}

/// Validate selection before any directory creation or network access.
pub fn validate(cfg: &RuntimeConfig, target: &str) -> Result<(), String> {
    if !["game", "images", "all"].contains(&target) {
        return Err("未知同步目标".into());
    }
    let images = target != "game";
    if images && (!cfg.images_enabled || !cfg.local_image) {
        return Err("图片同步要求 IMAGES_ENABLED=true 和 LOCAL_IMAGE=true".into());
    }
    let game = match cfg.data_backend {
        DataBackend::Sqlite => cfg.custom_database.is_none(),
        DataBackend::Json => !cfg.is_custom_gamedata || cfg.story_sync_enabled,
    };
    if !images && !game {
        return Err("当前配置没有可同步目标；自定义只读数据不会被覆盖".into());
    }
    Ok(())
}
pub async fn run(
    cfg: &RuntimeConfig,
    target: &str,
    transport: &dyn Transport,
    control: Arc<Control>,
) -> Result<Report, String> {
    validate(cfg, target)?;
    control
        .scope(async {
            let t = Controlled {
                inner: transport,
                control: control.clone(),
            };
            let mut results = Vec::new();
            if target != "images" && !control.cancelled() {
                match cfg.data_backend {
                    DataBackend::Sqlite if cfg.custom_database.is_none() => {
                        match super::database::sync_with_source(
                            &t,
                            &cfg.database_dir,
                            cfg.validation_mode,
                            &cfg.data_source,
                        )
                        .await
                        {
                            Ok(updated) => results.push(Outcome {
                                target: "database",
                                status: if updated { "updated" } else { "up_to_date" },
                                ok: true,
                                version: None,
                                message: "数据库同步完成",
                            }),
                            Err(_) => results.push(Outcome::failed("database")),
                        }
                    }
                    DataBackend::Sqlite => {
                        results.push(Outcome::skipped("database", "显式只读数据库不参与同步"))
                    }
                    DataBackend::Json => {
                        if cfg.is_custom_gamedata {
                            results.push(Outcome::skipped(
                                "game",
                                "自定义 JSON 路径关闭游戏表与关卡同步",
                            ));
                        } else {
                            let excel = datasets::excel_archive_spec_with_source(
                                &cfg.gamedata_path,
                                &cfg.data_source,
                            );
                            let levels = datasets::levels_archive_spec_with_source(
                                &cfg.levels_path,
                                &cfg.data_source,
                            );
                            match super::pair::sync_release_archive_pair(&t, &excel, &levels, true)
                                .await
                            {
                                Ok((a, b)) => {
                                    results.push(Outcome::result("excel", a));
                                    results.push(Outcome::result("levels", b));
                                }
                                Err(_) => results.push(Outcome::failed("game")),
                            }
                        }
                        if !cfg.story_sync_enabled {
                            results.push(Outcome::skipped("story", "自定义剧情 ZIP 不参与同步"));
                        } else if control.exit_code().is_none() {
                            let spec = datasets::story_release_spec_with_source(
                                &cfg.storyjson_zip,
                                &cfg.data_source,
                            );
                            results.push(Outcome::result(
                                "story",
                                super::release::sync_release_with_source(
                                    &t,
                                    &spec,
                                    true,
                                    &cfg.data_source,
                                )
                                .await,
                            ));
                        }
                    }
                }
            }
            if target != "game" && control.exit_code().is_none() {
                results.push(Outcome::result(
                    "images",
                    super::images_sync::sync_images_with_source(
                        &cfg.images_path,
                        &t,
                        super::images_sync::ImagesSyncOpts {
                            include_original: cfg.original_image,
                            force_check: true,
                        },
                        &cfg.data_source,
                    )
                    .await,
                ));
            }
            let cancelled = control.cancelled();
            let lock_timeout = control.exit_code() == Some(3);
            let ok = !cancelled && !lock_timeout && results.iter().all(|r| r.ok);
            Ok(Report {
                schema_version: 1,
                ok,
                cancelled,
                lock_timeout,
                results,
            })
        })
        .await
}
