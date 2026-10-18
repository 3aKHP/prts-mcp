//! AKDP build-time compiler. Installed MCP servers never invoke this program.
#[path = "data_compiler/derive.rs"]
mod derive;
#[path = "data_compiler/entities.rs"]
mod entities;
#[path = "data_compiler/sources.rs"]
mod sources;
#[path = "data_compiler/tests.rs"]
#[cfg(test)]
mod tests;

use flate2::{Compression, GzBuilder};
use rusqlite::Connection;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    env, fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

#[derive(Default)]
pub struct Options {
    pub input: Option<PathBuf>,
    pub excel_zip: Option<PathBuf>,
    pub levels_zip: Option<PathBuf>,
    pub story_zip: Option<PathBuf>,
    pub output: PathBuf,
    pub version: String,
    pub revision: u64,
    pub allow_incomplete: bool,
}

fn options() -> Result<Options> {
    let mut options = Options {
        revision: 1,
        ..Options::default()
    };
    let mut args = env::args().skip(1);
    while let Some(key) = args.next() {
        if key == "--allow-incomplete" {
            options.allow_incomplete = true;
            continue;
        }
        let value = args
            .next()
            .ok_or_else(|| format!("Missing value for {key}"))?;
        match key.as_str() {
            "--input" => options.input = Some(value.into()),
            "--excel-zip" => options.excel_zip = Some(value.into()),
            "--levels-zip" => options.levels_zip = Some(value.into()),
            "--story-zip" => options.story_zip = Some(value.into()),
            "--output" => options.output = value.into(),
            "--source-version" => options.version = value,
            "--revision" => options.revision = value.parse()?,
            _ => return Err(format!("Unknown option: {key}").into()),
        }
    }
    if options.output.as_os_str().is_empty()
        || options.version.is_empty()
        || options.revision == 0
        || (options.input.is_none()
            && options.excel_zip.is_none()
            && options.levels_zip.is_none()
            && options.story_zip.is_none())
    {
        return Err("Usage: data_compiler --input <candidate> --output <new.sqlite> --source-version <version> [--revision N]; archive inputs: --excel-zip/--levels-zip/--story-zip; fixtures: --allow-incomplete".into());
    }
    Ok(options)
}

fn hash(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    name.into()
}

struct Staging(PathBuf);
impl Drop for Staging {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub fn compile(options: &Options) -> Result<serde_json::Value> {
    let compressed = suffix(&options.output, ".gz");
    let receipt = suffix(&options.output, ".meta.json");
    if options.output.exists() || compressed.exists() || receipt.exists() {
        return Err("Compiler outputs must be new files".into());
    }
    let parent = options
        .output
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    fs::create_dir_all(parent)?;
    if let Some(input) = &options.input {
        if fs::canonicalize(parent)?.starts_with(fs::canonicalize(input)?) {
            return Err("Compiler output cannot be inside its input tree".into());
        }
    }
    let staging = Staging(parent.join(format!(".sqlite-build-{}", uuid::Uuid::new_v4().simple())));
    fs::create_dir(&staging.0)?;
    let database = staging.0.join("data.sqlite");
    let mut writer = Connection::open(&database)?;
    writer.execute_batch(include_str!("../contracts/sqlite-schema-v1.sql"))?;
    sources::capture(&mut writer, options)?;
    let (blobs, bytes) = sources::verify_sources(&writer)?;
    let aliases: i64 = writer.query_row("SELECT count(*) FROM sources", [], |r| r.get(0))?;
    drop(writer);
    derive::derive(&database, options.allow_incomplete)?;
    let mut input = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&database)?;
    input.sync_all()?;
    let gzip = staging.0.join("data.sqlite.gz");
    let mut output = GzBuilder::new()
        .mtime(0)
        .write(fs::File::create(&gzip)?, Compression::new(6));
    std::io::copy(&mut input, &mut output)?;
    drop(input);
    output.finish()?.sync_all()?;
    let metadata = json!({
        "contractVersion":"prts-mcp-sqlite/v1",
        "schemaVersion":1,"indexVersion":1,"language":"zh_CN",
        "compilerVersion":prts_mcp_rust::SERVER_VERSION,
        "sourceVersion":options.version,"publicationRevision":options.revision,
        "sha256":hash(&database)?,"size":fs::metadata(&database)?.len(),
        "asset":compressed.file_name().and_then(|p|p.to_str()).ok_or("Non-UTF8 output name")?,
        "compressedSha256":hash(&gzip)?,"compressedSize":fs::metadata(&gzip)?.len(),
        "sourceAliases":aliases,"sourceBlobs":blobs,"sourceBytes":bytes,
    });
    let control = staging.0.join("metadata.json");
    let mut file = fs::File::create(&control)?;
    writeln!(file, "{}", serde_json::to_string_pretty(&metadata)?)?;
    file.sync_all()?;
    drop(file);
    fs::rename(database, &options.output)?;
    fs::rename(gzip, compressed)?;
    fs::rename(control, receipt)?;
    Ok(metadata)
}

fn main() -> Result<()> {
    if env::args().nth(1).as_deref() == Some("--version") {
        println!(
            "prts-mcp-data-compiler {} schema=1 index=1",
            prts_mcp_rust::SERVER_VERSION
        );
        return Ok(());
    }
    println!("{}", compile(&options()?)?);
    Ok(())
}
