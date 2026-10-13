//! Shared sync spec/result types — port of TS `sync/types.ts` plus the
//! archive spec from `data/datasets.ts` (required-file lists live in
//! `datasets.rs`, sourced from the P0 declaration extraction).

use std::path::PathBuf;

pub const DATA_CONTRACT_VERSION: &str = "prts-mcp-data/v1";
/// Skip the upstream SHA check if cached data is fresher than this (seconds).
pub const CACHE_TTL_SECONDS: u64 = 3600;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncStatus {
    Updated,
    UpToDate,
    OfflineFallback,
    NoData,
}

impl SyncStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            SyncStatus::Updated => "updated",
            SyncStatus::UpToDate => "up_to_date",
            SyncStatus::OfflineFallback => "offline_fallback",
            SyncStatus::NoData => "no_data",
        }
    }
}

#[derive(Debug, Clone)]
pub struct SyncResult {
    pub status: SyncStatus,
    pub commit_sha: Option<String>,
    pub error: Option<String>,
}

impl SyncResult {
    pub fn new(status: SyncStatus, commit_sha: Option<String>, error: Option<String>) -> Self {
        Self {
            status,
            commit_sha,
            error,
        }
    }
}

/// The per-dataset zip validator (TS `validateZip` closure): story packs walk
/// the review table chapters; archives check their required files.
#[derive(Debug, Clone)]
pub enum ZipValidator {
    None,
    StoryJson,
    Archive(Vec<String>),
}

/// Describes a GitHub Release zip asset downloaded as a local zip.
#[derive(Debug, Clone)]
pub struct ReleaseSpec {
    pub owner: String,
    pub repo: String,
    /// Asset filename in the release, e.g. "zh_CN.zip".
    pub asset_name: String,
    /// Absolute destination path for the downloaded zip.
    pub local_zip: PathBuf,
    /// Verify the optional factory manifest when the release provides it.
    pub verify_manifest: bool,
    pub validator: ZipValidator,
}

impl ReleaseSpec {
    /// `<owner>/<repo>` as persisted into release_meta.json.
    pub fn repo_slug(&self) -> String {
        format!("{}/{}", self.owner, self.repo)
    }

    /// A no-validation spec (tests / legacy callers).
    pub fn bare(owner: &str, repo: &str, asset_name: &str, local_zip: PathBuf) -> Self {
        Self {
            owner: owner.to_string(),
            repo: repo.to_string(),
            asset_name: asset_name.to_string(),
            local_zip,
            verify_manifest: false,
            validator: ZipValidator::None,
        }
    }
}

/// Describes a release archive that is extracted and activated as a
/// generation tree under `local_root`.
#[derive(Debug, Clone)]
pub struct ReleaseArchiveSpec {
    pub owner: String,
    pub repo: String,
    pub asset_name: String,
    pub local_zip: PathBuf,
    pub local_root: PathBuf,
    pub required_files: Vec<String>,
    pub verify_manifest: bool,
}

impl ReleaseArchiveSpec {
    /// The `ReleaseSpec` used for the zip download itself.
    pub fn release_spec(&self) -> ReleaseSpec {
        ReleaseSpec {
            owner: self.owner.clone(),
            repo: self.repo.clone(),
            asset_name: self.asset_name.clone(),
            local_zip: self.local_zip.clone(),
            verify_manifest: self.verify_manifest,
            validator: ZipValidator::Archive(self.required_files.clone()),
        }
    }

    /// Directory that holds the zip and its metadata files.
    pub fn archives_dir(&self) -> PathBuf {
        self.local_zip
            .parent()
            .unwrap_or(&self.local_root)
            .to_path_buf()
    }
}

/// TS `errorMessage(err)`: the message text of an unknown error.
pub fn error_message(err: &SyncError) -> String {
    err.to_string()
}

/// Errors that escape the sync state machine (lock failures, IO, injected
/// faults). The state machine converts these into `SyncResult` fallback
/// statuses at the same catch points as TS.
#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    #[error("{0}")]
    Message(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    /// Duplicate data release identity — fail closed, no blind fallback.
    #[error("duplicate data release identity")]
    DuplicateReleaseIdentity,
}

impl SyncError {
    pub fn message(text: impl Into<String>) -> Self {
        SyncError::Message(text.into())
    }
}
