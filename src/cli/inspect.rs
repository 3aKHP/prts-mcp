//! Offline observations never initialize a server or adopt a data directory.
use crate::{
    config::{DataBackend, RuntimeConfig},
    storage::{database, identity::path_token},
    sync::source_guard,
};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub fn check(name: &str, state: &str, message: &str, path: Option<&Path>) -> Value {
    json!({"name":name,"status":state,"message":message,"path":super::report::path_value(path)})
}
pub fn successful(checks: &[Value]) -> bool {
    checks.iter().all(|v| v["status"] != "error")
}
fn pointers(cfg: &RuntimeConfig) -> Vec<PathBuf> {
    let mut paths = vec![
        cfg.database_dir.join("active"),
        cfg.database_dir.join("previous"),
        crate::storage::gamedata_pair_path_for_read(&cfg.gamedata_path, &cfg.levels_path),
        cfg.gamedata_path.join("archives/extract_meta.json"),
        cfg.levels_path.join("archives/extract_meta.json"),
        cfg.images_path.join(".images_meta.json"),
        cfg.storyjson_zip.clone(),
    ];
    paths.extend(
        source_guard::sync_roots(cfg)
            .iter()
            .map(|p| p.join(".prts-data-source.json")),
    );
    if let Some(bundle) = &cfg.bundle_root {
        let b = crate::config::BundleRoots::of(bundle);
        paths.extend([
            crate::storage::gamedata_pair_path_for_read(&b.gamedata, &b.levels),
            b.gamedata.join("archives/extract_meta.json"),
            b.levels.join("archives/extract_meta.json"),
            b.storyjson_zip,
        ]);
    }
    paths
}
fn generations(cfg: &RuntimeConfig) -> Vec<Value> {
    ["active","previous"].iter().map(|name|{
        let path=cfg.database_dir.join(name);
        match std::fs::read_to_string(&path){
            Ok(text)=>match database::ActiveDatabase::parse(&text){
                Ok(p)=>json!({"name":name,"status":"present","path":super::report::path_value(Some(&p.path(&cfg.database_dir))),"source_version":p.source_version,"revision":p.revision,"sha256":p.sha256}),
                Err(_)=>json!({"name":name,"status":"invalid","path":super::report::path_value(Some(&path))}),
            },
            Err(e)=>json!({"name":name,"status":if e.kind()==std::io::ErrorKind::NotFound{"missing"}else{"unreadable"},"path":super::report::path_value(Some(&path))}),
        }
    }).collect()
}

pub fn data(cfg: &RuntimeConfig, full: bool) -> (Value, i32) {
    let watched = pointers(cfg);
    let before: Vec<_> = watched.iter().map(|p| path_token(p)).collect();
    let mut checks = Vec::new();
    for root in source_guard::sync_roots(cfg) {
        if root.exists() {
            let result = source_guard::verify(&root, &cfg.data_source);
            let empty = std::fs::read_dir(&root)
                .ok()
                .is_some_and(|mut it| it.next().is_none());
            checks.push(check(
                "source_ownership",
                if result.is_ok() {
                    "ok"
                } else if empty && !full {
                    "warning"
                } else {
                    "error"
                },
                if result.is_ok() {
                    "数据源归属匹配"
                } else if empty {
                    "空目录尚未绑定数据源"
                } else {
                    "数据源标记缺失、损坏或不匹配"
                },
                Some(&root),
            ));
        }
    }
    let generations = generations(cfg);
    if cfg.data_backend == DataBackend::Sqlite && cfg.custom_database.is_none() {
        for p in &generations {
            if p["status"] == "invalid" || p["status"] == "unreadable" {
                checks.push(check(
                    "database_pointer",
                    "error",
                    "数据库代次指针无效或不可读",
                    Some(&cfg.database_dir),
                ));
            }
        }
    }
    let candidates = database::candidates(
        cfg.custom_database.as_deref(),
        &cfg.database_dir,
        cfg.bundle_root.as_deref(),
    );
    let mut database_reports = Vec::new();
    let mut database_available = false;
    if cfg.data_backend == DataBackend::Sqlite {
        for candidate in candidates {
            if !candidate.path.exists() {
                database_reports
                    .push(json!({"path":super::report::path_value(Some(&candidate.path)),"status":"missing","verified":false}));
                continue;
            }
            let result = if full {
                crate::storage::inspection::database(&candidate)
            } else {
                crate::storage::sqlite::GameDb::for_inspection(&candidate.path).and_then(|db| {
                    if db.derived_ready() {
                        Ok(db)
                    } else {
                        Err("派生查询数据未就绪".into())
                    }
                })
            };
            let result = result.and_then(|db| {
                if cfg.custom_database.is_some() {
                    return Ok(true);
                }
                // Match server admission: a managed, structurally valid empty
                // database does not suppress the JSON fallback.
                let view = crate::app::DataView::from_database(
                    db,
                    cfg.excel_path.clone(),
                    cfg.levels_path.clone(),
                )?;
                Ok(view.excel_root.is_some()
                    || view.levels_root.is_some()
                    || view.story_zip.is_some())
            });
            let ok = result.is_ok();
            let usable = result.as_ref().is_ok_and(|usable| *usable);
            database_available |= usable;
            if let Err(error) = &result {
                checks.push(check("database", "error", error, Some(&candidate.path)));
            }
            database_reports.push(json!({"path":super::report::path_value(Some(&candidate.path)),"status":if ok{if full{"verified"}else{"present_unverified"}}else{"invalid"},"verified":ok&&full,"usable":usable}));
        }
    }
    // Reuse only the JSON path resolver, never SQLite admission (which may write a stamp).
    let json_allowed = cfg.data_backend == DataBackend::Json || cfg.allow_json_fallback;
    let view = crate::app::json::resolve_view(cfg);
    let json_paths = json!({"excel":super::report::path_value(view.excel_root.as_deref()),"levels":super::report::path_value(view.levels_root.as_deref()),"story":super::report::path_value(view.story_zip.as_deref())});
    let json_available = json_allowed
        && (view.excel_root.is_some() || view.levels_root.is_some() || view.story_zip.is_some());
    if full && json_allowed && !database_available {
        let excel = crate::sync::datasets::gamedata_excel();
        let levels = crate::sync::datasets::gamedata_levels();
        for (name, root, required) in [
            (
                "excel",
                view.excel_root.as_deref(),
                excel
                    .required_files
                    .iter()
                    .map(|p| {
                        p.strip_prefix("zh_CN/gamedata/excel/")
                            .unwrap_or(p)
                            .to_owned()
                    })
                    .collect::<Vec<_>>(),
            ),
            ("levels", view.levels_root.as_deref(), levels.required_files),
        ] {
            let result = root
                .ok_or_else(|| "数据不可用".to_string())
                .and_then(|p| crate::storage::inspection::json_tree(p, &required));
            checks.push(check(
                name,
                if result.is_ok() { "ok" } else { "error" },
                &result
                    .map(|n| format!("已检查 {n} 个 JSON 文件"))
                    .unwrap_or_else(|e| e),
                root,
            ));
        }
        let result = view
            .story_zip
            .as_deref()
            .ok_or_else(|| "剧情数据不可用".to_string())
            .and_then(crate::storage::inspection::story);
        checks.push(check(
            "story",
            if result.is_ok() { "ok" } else { "error" },
            &result
                .map(|n| format!("已检查 {n} 个剧情 JSON 条目"))
                .unwrap_or_else(|e| e),
            view.story_zip.as_deref(),
        ));
    }
    let backend = if database_available {
        "sqlite"
    } else if json_available {
        "json"
    } else {
        "unavailable"
    };
    if backend == "unavailable" {
        checks.push(check(
            "data_availability",
            if full { "error" } else { "warning" },
            "无可用本地游戏数据；首次使用可能需要同步",
            None,
        ));
    }
    let image_root = if cfg.images_enabled && cfg.local_image {
        crate::sync::images_meta::active_generation(&cfg.images_path)
    } else {
        None
    };
    if full && cfg.images_enabled && cfg.local_image {
        let result = crate::storage::inspection::artwork(&cfg.images_path, cfg.original_image);
        checks.push(check(
            "images",
            if result.is_ok() { "ok" } else { "error" },
            &result
                .map(|n| format!("已检查 {n} 个立绘文件"))
                .unwrap_or_else(|e| e),
            Some(&cfg.images_path),
        ));
    }
    let after: Vec<_> = watched.iter().map(|p| path_token(p)).collect();
    if before != after {
        checks.push(check(
            "snapshot",
            "error",
            "检查期间激活代次发生变化，请重试",
            None,
        ));
    }
    let ok = successful(&checks);
    (
        json!({"schema_version":1,"scope":"local","ok":ok,"verification":if full{"full"}else{"metadata_only"},"source":cfg.data_source.slug(),"preferred_backend":super::report::backend(cfg),"available_backend":backend,"allow_json_fallback":cfg.allow_json_fallback,"database_generations":generations,"database_candidates":database_reports,"json_paths":json_paths,"images_generation":super::report::path_value(image_root.as_deref()),"checks":checks}),
        if ok { 0 } else { 1 },
    )
}

pub fn local_doctor(cfg: &RuntimeConfig) -> Value {
    let (data, _) = data(cfg, false);
    let mut checks = data["checks"].as_array().cloned().unwrap_or_default();
    checks.push(check(
        "configuration",
        "ok",
        "配置已解析；当前检查不代表运行中实例",
        None,
    ));
    for root in source_guard::sync_roots(cfg) {
        let ancestor = root.ancestors().find(|p| p.exists());
        match ancestor.and_then(|p| std::fs::metadata(p).ok()) {
            Some(meta) if !meta.is_dir() => checks.push(check(
                "sync_directory",
                "error",
                "同步路径或祖先不是目录",
                Some(&root),
            )),
            #[cfg(unix)]
            Some(meta) if meta.permissions().readonly() => checks.push(check(
                "sync_permissions",
                "error",
                "目录权限位不允许写入",
                Some(&root),
            )),
            Some(_) => checks.push(check(
                "sync_permissions",
                "unknown",
                "未执行写入探测；实际可写性由运行身份与 ACL 决定",
                Some(&root),
            )),
            None => checks.push(check(
                "sync_directory",
                "error",
                "无法读取同步目录或其祖先",
                Some(&root),
            )),
        }
    }
    if let Some(path) = &cfg.custom_database {
        if !path.is_file() {
            checks.push(check(
                "custom_database",
                "error",
                "显式只读数据库不存在",
                Some(path),
            ));
        }
    }
    if cfg.data_backend == DataBackend::Json {
        if cfg.is_custom_gamedata && data["json_paths"]["excel"].is_null() {
            checks.push(check(
                "custom_gamedata",
                "error",
                "显式游戏数据路径没有完整游戏表",
                Some(&cfg.gamedata_path),
            ));
        }
        if !cfg.story_sync_enabled && !cfg.storyjson_zip.is_file() {
            checks.push(check(
                "custom_story",
                "error",
                "显式剧情 ZIP 不存在",
                Some(&cfg.storyjson_zip),
            ));
        }
    }
    if let Some(path) = &cfg.network.extra_ca {
        let valid = std::fs::read(path)
            .ok()
            .and_then(|pem| reqwest::Certificate::from_pem(&pem).ok())
            .is_some();
        checks.push(check(
            "wiki_ca",
            if valid { "ok" } else { "error" },
            if valid {
                "Wiki CA 文件可读取"
            } else {
                "Wiki CA 文件不可读取或不是有效 PEM"
            },
            Some(path),
        ));
    }
    json!({"schema_version":1,"scope":"local","ok":successful(&checks),"checks":checks,"data":data})
}
