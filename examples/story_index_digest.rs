//! Development-only digest of the full index, for the frozen TS comparison.
use prts_mcp_rust::{domain::story::search::story_search_index, storage::ZipStore};
use serde_json::json;
use sha2::{Digest, Sha256};

fn main() {
    let path = std::env::args().nth(1).expect("story ZIP argument");
    let path = std::path::Path::new(&path);
    let index = story_search_index(path, &ZipStore::new(path)).expect("build index");
    let mut digest = Sha256::new();
    for chapter in &index.chapters {
        digest.update(
            serde_json::to_vec(&json!([
                chapter.event_id,
                chapter.story_key,
                chapter.story_code,
                chapter.story_name
            ]))
            .unwrap(),
        );
        for line in chapter.lines.iter() {
            digest.update(
                serde_json::to_vec(&json!([line.line_type, line.role, line.text])).unwrap(),
            );
        }
    }
    for record in index.records() {
        digest.update(serde_json::to_vec(&record).unwrap());
    }
    println!(
        "{}",
        json!({"chapters":index.chapters.len(),"records":index.records().count(),
        "sha256":format!("{:x}",digest.finalize())})
    );
}
