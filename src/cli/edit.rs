//! Serialize configuration edits and preserve unrelated TOML formatting.
use super::{error::Failure, schema, settings};
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
};
pub enum Change<'a> {
    Init { force: bool },
    Set(&'a str, &'a str),
    Unset(&'a str),
}
pub fn apply(path: Option<&Path>, change: Change<'_>, dry_run: bool) -> Result<Value, Failure> {
    let mut path = path
        .map(Path::to_path_buf)
        .map(Ok)
        .unwrap_or_else(settings::default_path)?;
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("配置编辑不接受符号链接；请明确指定目标文件".into());
    }
    // Invalid edit requests must not create directories or lock files.
    if let Change::Set(key, value) = &change {
        let key = key.strip_prefix("runtime.").unwrap_or(key);
        let field = schema::field(key)?;
        if schema::sensitive(key) {
            return Err("敏感配置请通过环境变量或手工编辑文件设置".into());
        }
        field.parse(value)?;
    }
    if let Change::Unset(key) = &change {
        schema::field(key.strip_prefix("runtime.").unwrap_or(key))?;
    }
    if !matches!(change, Change::Init { .. }) && !path.is_file() {
        return Err("配置文件不存在或不是普通文件；请先 config init".into());
    }
    let parent = parent.to_path_buf();
    if !dry_run {
        fs::create_dir_all(&parent).map_err(Failure::operation)?;
        let name = path.file_name().ok_or("配置路径必须包含文件名")?.to_owned();
        path = fs::canonicalize(&parent)
            .map_err(Failure::operation)?
            .join(name);
    }
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let _lock = if dry_run {
        None
    } else {
        fs::create_dir_all(parent).map_err(Failure::operation)?;
        let mut lock_name = path.as_os_str().to_owned();
        lock_name.push(".lock");
        let lock_path = std::path::PathBuf::from(lock_name);
        if fs::symlink_metadata(&lock_path).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err("配置锁不能是符号链接".into());
        }
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(lock_path)
            .map_err(Failure::operation)?;
        lock.lock().map_err(Failure::operation)?;
        Some(lock)
    };
    if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("配置目标已变为符号链接".into());
    }
    let original = crate::storage::identity::path_token(&path);
    let mut doc = match change {
        Change::Init { force } => {
            if path.exists() && !force {
                return Err("配置文件已存在；覆盖须使用 --force".into());
            }
            schema::template()
                .parse::<toml_edit::DocumentMut>()
                .expect("schema template")
        }
        _ => settings::document(&path, true)?,
    };
    settings::values(&doc, &path)?;
    let key = match change {
        Change::Set(k, _) | Change::Unset(k) => Some(k.strip_prefix("runtime.").unwrap_or(k)),
        _ => None,
    };
    if let Some(key) = key {
        let field = schema::field(key)?;
        match change {
            Change::Set(_, value) => {
                if schema::sensitive(key) {
                    return Err("敏感配置请通过环境变量或手工编辑文件设置".into());
                }
                doc["runtime"][key] = toml_edit::Item::Value(field.parse(value)?);
            }
            Change::Unset(_) => {
                if let Some(table) = doc.get_mut("runtime").and_then(|v| v.as_table_mut()) {
                    table.remove(key);
                }
            }
            _ => (),
        }
    }
    let values = settings::values(&doc, &path)?;
    crate::config::RuntimeConfig::try_from_lookup(|key| values.get(key).cloned())?;
    if !dry_run {
        let temp = parent.join(format!(".prts-config-{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temp).map_err(Failure::operation)?;
            file.write_all(doc.to_string().as_bytes())
                .map_err(Failure::operation)?;
            if let Ok(meta) = fs::metadata(&path) {
                file.set_permissions(meta.permissions())
                    .map_err(Failure::operation)?;
            }
            file.sync_all().map_err(Failure::operation)?;
            drop(file);
            if crate::storage::identity::path_token(&path) != original {
                return Err(Failure::operation("配置文件被其他编辑器修改，请重试"));
            }
            fs::rename(&temp, &path).map_err(Failure::operation)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temp);
        }
        result?;
    }
    let proposed = key.map(|key| {
        let item = doc.get("runtime").and_then(|v| v.get(key));
        if item.is_none() {
            Value::Null
        } else if schema::redacted(key) {
            json!("[redacted]")
        } else if let Some(v) = item.and_then(|v| v.as_bool()) {
            json!(v)
        } else if let Some(v) = item.and_then(|v| v.as_integer()) {
            json!(v)
        } else if let Some(v) = item.and_then(|v| v.as_float()) {
            json!(v)
        } else {
            json!(item.and_then(|v| v.as_str()))
        }
    });
    Ok(
        json!({"schema_version":1,"path":super::report::path_value(Some(&path)),"dry_run":dry_run,"changed_key":key,"proposed":proposed,
        "template":if dry_run&&matches!(change,Change::Init{..}){Some(doc.to_string())}else{None},
        "overridden_by_environment":key.is_some_and(|k|std::env::var_os(k).is_some())}),
    )
}
