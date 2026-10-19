//! SQLite generation pointers and read-only source selection.
use super::{
    admission::{self, Expected},
    sqlite::GameDb,
};
use crate::config::ValidationMode;
use std::path::{Path, PathBuf};
use std::sync::Arc;

const POINTER_VERSION: &str = "prts-mcp-active/v1";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActiveDatabase {
    pub file_name: String,
    pub source_version: String,
    pub revision: u64,
    pub sha256: String,
}

impl ActiveDatabase {
    pub fn parse(text: &str) -> Result<Self, String> {
        let lines: Vec<_> = text.lines().collect();
        if lines.len() != 5 || lines[0] != POINTER_VERSION {
            return Err("unsupported SQLite activation pointer".into());
        }
        let pointer = Self {
            file_name: lines[1].into(),
            source_version: lines[2].into(),
            revision: lines[3].parse::<u64>().map_err(|e| e.to_string())?,
            sha256: lines[4].into(),
        };
        pointer.validate()?;
        Ok(pointer)
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.file_name.starts_with('.')
            || !self.file_name.ends_with(".sqlite")
            || !self
                .file_name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
            || self.source_version.is_empty()
            || !self
                .source_version
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
            || self.revision == 0
            || self.sha256.len() != 64
            || !self
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("invalid SQLite activation pointer".into());
        }
        Ok(())
    }

    pub fn encode(&self) -> Result<String, String> {
        self.validate()?;
        Ok(format!(
            "{POINTER_VERSION}\n{}\n{}\n{}\n{}\n",
            self.file_name, self.source_version, self.revision, self.sha256
        ))
    }

    pub fn path(&self, root: &Path) -> PathBuf {
        root.join(&self.file_name)
    }
}

pub fn lease_path(path: &Path) -> PathBuf {
    let mut value = path.as_os_str().to_owned();
    value.push(".lease");
    value.into()
}

pub fn active(root: &Path) -> Result<Option<ActiveDatabase>, String> {
    match std::fs::read_to_string(root.join("active")) {
        Ok(text) => ActiveDatabase::parse(&text).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

/// Preserve the authority of managed pointers when selecting an offline DB.
pub struct DatabaseCandidate {
    pub path: PathBuf,
    pub pointer: Option<ActiveDatabase>,
}

pub fn candidates(
    custom: Option<&Path>,
    root: &Path,
    bundle: Option<&Path>,
) -> Vec<DatabaseCandidate> {
    if let Some(path) = custom {
        return vec![DatabaseCandidate {
            path: path.to_owned(),
            pointer: None,
        }];
    }
    let mut paths = Vec::new();
    for pointer in [
        active(root).ok().flatten(),
        std::fs::read_to_string(root.join("previous"))
            .ok()
            .and_then(|text| ActiveDatabase::parse(&text).ok()),
    ]
    .into_iter()
    .flatten()
    {
        paths.push(DatabaseCandidate {
            path: pointer.path(root),
            pointer: Some(pointer),
        });
    }
    paths.push(DatabaseCandidate {
        path: root.join("zh_CN.sqlite"),
        pointer: None,
    });
    if let Some(bundle) = bundle {
        paths.push(DatabaseCandidate {
            path: bundle.join("zh_CN.sqlite"),
            pointer: None,
        });
    }
    paths
}

pub fn open_ready(
    candidate: &DatabaseCandidate,
    mode: ValidationMode,
) -> Result<Arc<GameDb>, String> {
    let expected = candidate
        .pointer
        .as_ref()
        .map(|pointer| -> Result<Expected, String> {
            Ok(Expected {
                sha256: pointer.sha256.clone(),
                size: std::fs::metadata(&candidate.path)
                    .map_err(|e| e.to_string())?
                    .len(),
                source_version: pointer.source_version.clone(),
                revision: pointer.revision,
                compiler_version: None,
            })
        })
        .transpose()?;
    admission::admit(&candidate.path, expected.as_ref(), mode, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pointer_roundtrip_and_path_rejection() {
        let valid = ActiveDatabase {
            file_name: "generation.sqlite".into(),
            source_version: "fixture".into(),
            revision: 2,
            sha256: "a".repeat(64),
        };
        assert_eq!(
            ActiveDatabase::parse(&valid.encode().unwrap()).unwrap(),
            valid
        );
        for bad in [
            "../x.sqlite",
            "/x.sqlite",
            "a\\b.sqlite",
            "a:b.sqlite",
            ".hidden.sqlite",
            "x.zip",
        ] {
            let mut pointer = valid.clone();
            pointer.file_name = bad.into();
            assert!(pointer.encode().is_err(), "{bad}");
        }
        assert!(ActiveDatabase::parse("generation.sqlite\n").is_err());
    }
}
