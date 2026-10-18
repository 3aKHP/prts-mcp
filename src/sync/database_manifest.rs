//! Additive SQLite artifact contract carried by the unchanged AKDP manifest.
use crate::storage::sqlite::{CONTRACT, INDEX_VERSION, SCHEMA_VERSION};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const DATABASE_ASSET: &str = "zh_CN.sqlite.gz";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseManifest {
    pub contract_version: String,
    pub schema_version: i32,
    pub index_version: i32,
    pub language: String,
    pub compiler_version: String,
    pub source_version: String,
    pub publication_revision: u64,
    pub asset: String,
    pub sha256: String,
    pub size: u64,
    pub compressed_sha256: String,
    pub compressed_size: u64,
}

fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl DatabaseManifest {
    pub fn from_release(manifest: &Value, source: &str, revision: u64) -> Result<Self, String> {
        let manifest_revision = match manifest.get("publicationRevision") {
            None => 1,
            Some(value) => value
                .as_u64()
                .ok_or("invalid manifest publicationRevision")?,
        };
        if manifest["contractVersion"] != "prts-mcp-data/v1"
            || manifest["source"]["versionId"] != source
            || manifest_revision != revision
        {
            return Err("SQLite release manifest source/revision mismatch".into());
        }
        let value: Self =
            serde_json::from_value(manifest["sqlite"].clone()).map_err(|e| e.to_string())?;
        if value.contract_version != CONTRACT
            || value.schema_version != SCHEMA_VERSION
            || value.index_version != INDEX_VERSION
            || value.language != "zh_CN"
            || value.source_version != source
            || value.publication_revision != revision
            || revision == 0
            || value.compiler_version.is_empty()
            || value.asset != DATABASE_ASSET
            || value.size == 0
            || value.compressed_size == 0
            || !digest(&value.sha256)
            || !digest(&value.compressed_sha256)
        {
            return Err("unsupported or invalid SQLite artifact descriptor".into());
        }
        let asset = &manifest["assets"][&value.asset];
        if asset["sha256"] != value.compressed_sha256
            || asset["size"].as_u64() != Some(value.compressed_size)
        {
            return Err("SQLite asset differs from its descriptor".into());
        }
        Ok(value)
    }

    pub fn generation(&self) -> (&str, u64) {
        (&self.source_version, self.publication_revision)
    }
}
