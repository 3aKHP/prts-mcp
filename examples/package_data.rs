//! Build-time preparation of a pinned read-only release bundle. This example
//! is not shipped as a management CLI or required on an installed system.
use std::collections::BTreeMap;
use std::error::Error;
use std::fs;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};

use prts_mcp_rust::sync::{activation, datasets, validation};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

fn hash(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buf = [0_u8; 65536];
    loop {
        let count = file.read(&mut buf)?;
        if count == 0 {
            break;
        }
        hash.update(&buf[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| format!("Missing {key}").into())
}

fn inventory(root: &Path, dir: &Path, files: &mut BTreeMap<String, String>) -> Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let kind = entry.file_type()?;
        if kind.is_dir() {
            inventory(root, &path, files)?;
        } else if kind.is_file() {
            let rel = path
                .strip_prefix(root)?
                .to_string_lossy()
                .replace('\\', "/");
            files.insert(rel, hash(&path)?);
        } else {
            return Err(format!("Unexpected bundle file: {}", path.display()).into());
        }
    }
    Ok(())
}

fn check_json_entries(path: &Path) -> Result<usize> {
    let mut archive = zip::ZipArchive::new(fs::File::open(path)?)?;
    let mut count = 0;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        if !entry.is_dir() && entry.name().ends_with(".json") {
            // serde_json's reader requests individual bytes. Buffer the
            // decompressor while retaining full Value/EOF/CRC validation.
            let _: Value = serde_json::from_reader(BufReader::with_capacity(64 * 1024, &mut entry))
                .map_err(|e| format!("Invalid JSON in {}: {e}", entry.name()))?;
            count += 1;
        }
    }
    Ok(count)
}

fn prepare(pin_path: &Path, downloads: &Path, dest: &Path) -> Result<()> {
    if dest.exists() {
        return Err("Bundle output must be a new directory".into());
    }
    let pin: Value = serde_json::from_slice(&fs::read(pin_path)?)?;
    let expected = [
        "manifest.json",
        "zh_CN-excel.zip",
        "zh_CN-levels.zip",
        "zh_CN.zip",
    ];
    let assets = pin["assets"].as_array().ok_or("Missing assets")?;
    if assets.len() != expected.len() {
        return Err("Bundle pin must describe exactly four assets".into());
    }
    for name in expected {
        let matches: Vec<_> = assets
            .iter()
            .filter(|a| a["name"].as_str() == Some(name))
            .collect();
        if matches.len() != 1 {
            return Err(format!("Missing/duplicate pinned asset: {name}").into());
        }
        let asset = matches[0];
        let path = downloads.join(name);
        let size = asset["bytes"].as_u64().ok_or("Missing asset size")?;
        if fs::metadata(&path)?.len() != size || hash(&path)? != text(asset, "sha256")? {
            return Err(format!("Pinned asset checksum/size mismatch: {name}").into());
        }
    }
    let manifest: Value = serde_json::from_slice(&fs::read(downloads.join("manifest.json"))?)?;
    if manifest["contractVersion"] != "prts-mcp-data/v1"
        || manifest["source"]["versionId"] != pin["source_version"]
    {
        return Err("Manifest contract/source version mismatch".into());
    }
    for asset in assets.iter().filter(|a| a["name"] != "manifest.json") {
        let name = text(asset, "name")?;
        if manifest["assets"][name]["sha256"] != asset["sha256"]
            || manifest["assets"][name]["size"] != asset["bytes"]
        {
            return Err(format!("Manifest asset mismatch: {name}").into());
        }
    }
    let excel = downloads.join("zh_CN-excel.zip");
    let levels = downloads.join("zh_CN-levels.zip");
    let story = downloads.join("zh_CN.zip");
    for (path, required) in [
        (&excel, datasets::gamedata_excel().required_files),
        (&levels, datasets::gamedata_levels().required_files),
    ] {
        let missing = validation::validate_archive_zip(path, &required)?;
        if !missing.is_empty() {
            return Err(format!("Invalid {}: {missing:?}", path.display()).into());
        }
    }
    let missing = validation::validate_storyjson_zip(&story)?;
    if !missing.is_empty() {
        return Err(format!("Invalid story archive: {missing:?}").into());
    }
    let json_counts = json!({
        "excel": check_json_entries(&excel)?,
        "levels": check_json_entries(&levels)?,
        "story": check_json_entries(&story)?,
    });
    fs::create_dir_all(dest)?;
    activation::safe_extract_zip(&excel, &dest.join("gamedata"))?;
    activation::safe_extract_zip(&levels, &dest.join("gamedata-levels"))?;
    fs::create_dir_all(dest.join("storyjson"))?;
    fs::copy(story, dest.join("storyjson/zh_CN.zip"))?;
    fs::copy(downloads.join("manifest.json"), dest.join("manifest.json"))?;
    let receipt = json!({
        "schema": "prts-mcp-bundle/v1",
        "productVersion": prts_mcp_rust::SERVER_VERSION,
        "repo": text(&pin, "repo")?,
        "releaseTag": text(&pin, "release_tag")?,
        "sourceVersion": text(&pin, "source_version")?,
        "assets": assets,
        "validatedJsonEntries": json_counts,
    });
    fs::write(
        dest.join("BUNDLE.json"),
        serde_json::to_string_pretty(&receipt)? + "\n",
    )?;
    let mut files = BTreeMap::new();
    inventory(dest, dest, &mut files)?;
    let sums: String = files
        .iter()
        .map(|(p, sha)| format!("{sha}  {p}\n"))
        .collect();
    fs::write(dest.join("SHA256SUMS"), sums)?;
    println!(
        "Validated release bundle: {} files, source {}",
        files.len(),
        text(&pin, "source_version")?
    );
    Ok(())
}

fn main() -> Result<()> {
    let args: Vec<PathBuf> = std::env::args_os().skip(1).map(PathBuf::from).collect();
    if args.len() != 3 {
        return Err(
            "Usage: cargo run --example package_data -- <pin.json> <downloads> <new-output>".into(),
        );
    }
    prepare(&args[0], &args[1], &args[2])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};
    use zip::write::SimpleFileOptions;

    #[test]
    fn buffered_json_validation_rejects_invalid_content_and_crc() -> Result<()> {
        let path = std::env::temp_dir().join(format!("prts-bundle-{}.zip", uuid::Uuid::new_v4()));
        let cases: &[(&[u8], bool)] = &[
            (
                r#"{"text":"中文","values":[null,true,1.5]}"#.as_bytes(),
                true,
            ),
            (b"{} \n\t", true),
            (b"{", false),
            (b"{} []", false),
            (b"1e9999", false),
            (b"\"\xff\"", false),
        ];
        let result = (|| -> Result<()> {
            for (content, valid) in cases {
                let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
                let options =
                    SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
                zip.start_file("data.json", options)?;
                zip.write_all(content)?;
                zip.start_file("ignored.txt", options)?;
                zip.write_all(b"not JSON")?;
                let mut bytes = zip.finish()?.into_inner();
                fs::write(&path, &bytes)?;
                if *valid {
                    assert_eq!(check_json_entries(&path)?, 1);
                } else {
                    let error = check_json_entries(&path).unwrap_err().to_string();
                    assert!(error.contains("Invalid JSON in data.json"), "{error}");
                }
                if content == &b"{} \n\t" {
                    // Change only legal whitespace, leaving syntactically valid
                    // JSON but breaking the ZIP entry's original CRC.
                    let offset = bytes
                        .windows(content.len())
                        .position(|b| b == *content)
                        .unwrap();
                    bytes[offset + 2] = b'\t';
                    fs::write(&path, bytes)?;
                    assert!(check_json_entries(&path).is_err());
                }
            }
            Ok(())
        })();
        fs::remove_file(path)?;
        result
    }
}
