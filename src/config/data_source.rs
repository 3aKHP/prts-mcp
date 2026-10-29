//! GitHub source identity, parsed once at startup.
use std::path::{Path, PathBuf};

pub const DEFAULT_OWNER: &str = "3aKHP";
pub const DEFAULT_REPO: &str = "arknights-data-pipeline";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataSource {
    owner: String,
    repo: String,
}

impl Default for DataSource {
    fn default() -> Self {
        Self {
            owner: DEFAULT_OWNER.into(),
            repo: DEFAULT_REPO.into(),
        }
    }
}

impl DataSource {
    pub fn parse(raw: Option<&str>) -> Result<Self, String> {
        let raw = raw.unwrap_or("").trim();
        if raw.is_empty() {
            return Ok(Self::default());
        }
        let invalid = || "PRTS_DATA_SOURCE_REPO must be owner/repo (not a URL or path)".to_string();
        let (owner, repo) = raw.split_once('/').ok_or_else(invalid)?;
        if owner.is_empty()
            || owner.len() > 39
            || !owner
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            || owner.starts_with('-')
            || owner.ends_with('-')
            || owner.contains("--")
            || repo.is_empty()
            || repo.len() > 100
            || repo == "."
            || repo == ".."
            || !repo
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        {
            return Err(invalid());
        }
        if owner.eq_ignore_ascii_case(DEFAULT_OWNER) && repo.eq_ignore_ascii_case(DEFAULT_REPO) {
            return Ok(Self::default());
        }
        Ok(Self {
            owner: owner.to_ascii_lowercase(),
            repo: repo.to_ascii_lowercase(),
        })
    }
    pub fn owner(&self) -> &str {
        &self.owner
    }
    pub fn repo(&self) -> &str {
        &self.repo
    }
    pub fn slug(&self) -> String {
        format!("{}/{}", self.owner, self.repo)
    }
    pub fn log_label(&self) -> String {
        if self.is_default() {
            self.repo.clone()
        } else {
            self.slug()
        }
    }
    pub fn is_default(&self) -> bool {
        self == &Self::default()
    }
    pub fn data_root(&self, root: &Path) -> PathBuf {
        if self.is_default() {
            root.into()
        } else {
            root.join("sources")
                .join(path_component(&self.owner))
                .join(path_component(&self.repo))
        }
    }
    pub fn download_url(&self, tag: &str, asset: &str) -> String {
        format!(
            "https://github.com/{}/{}/releases/download/{tag}/{asset}",
            self.owner, self.repo
        )
    }
}

// GitHub names can be Windows device names or end in a dot. Escape those
// on every platform so source paths remain portable and collision-free.
fn path_component(name: &str) -> String {
    let stem = name.split('.').next().unwrap_or("");
    let device = matches!(stem, "con" | "prn" | "aux" | "nul")
        || (stem.len() == 4
            && (stem.starts_with("com") || stem.starts_with("lpt"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'));
    if device || name.ends_with('.') {
        format!(
            "~{}",
            name.bytes().map(|b| format!("{b:02x}")).collect::<String>()
        )
    } else {
        name.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_and_normalizes_identity() {
        for raw in [
            None,
            Some(""),
            Some("  "),
            Some("3AKHP/ARKNIGHTS-DATA-PIPELINE"),
        ] {
            assert_eq!(DataSource::parse(raw).unwrap(), DataSource::default());
        }
        assert_eq!(
            DataSource::parse(Some(" Team/Assets.v1 ")).unwrap().slug(),
            "team/assets.v1"
        );
        for raw in [
            "x",
            "https://github.com/a/b",
            "a/b/c",
            "a/..",
            "a/b?x",
            "a/b#x",
            "a\\b/c",
            "-a/b",
            "a/b%2f",
            "a/ b",
        ] {
            assert!(DataSource::parse(Some(raw)).is_err(), "{raw}");
        }
    }
    #[test]
    fn escapes_windows_names_without_collisions() {
        assert_eq!(path_component("con"), "~636f6e");
        assert_eq!(path_component("com1.zip"), "~636f6d312e7a6970");
        assert_eq!(path_component("repo."), "~7265706f2e");
        assert_eq!(path_component("normal-repo"), "normal-repo");
    }
    #[test]
    fn isolates_platform_roots() {
        let source = DataSource::parse(Some("team/assets")).unwrap();
        for root in [
            "/data",
            "/home/test/.local/share/prts-mcp",
            "C:/Users/test/AppData/Local/prts-mcp",
        ] {
            assert_eq!(
                source.data_root(Path::new(root)),
                Path::new(root).join("sources/team/assets")
            );
            assert_eq!(
                DataSource::default().data_root(Path::new(root)),
                Path::new(root)
            );
        }
    }
}
