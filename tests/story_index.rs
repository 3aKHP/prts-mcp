//! Story index lifecycle (docs/07 P4): identity covers zip replacement, a
//! swap rebuilds exactly once, concurrent callers share one build, and the
//! old index releases with its last reader.

use std::path::PathBuf;
use std::sync::Arc;

use prts_mcp_rust::domain::story::search::{
    build_story_search, index_build_count, story_search_index,
};
use prts_mcp_rust::storage::{write_zip_entries, ZipStore};

/// The index build counter is process-global and the test harness runs
/// tests in parallel — serialize the counter-observing tests.
static COUNTER_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn review_entry(event_id: &str, marker: &str) -> String {
    format!(
        r#""{event_id}": {{"name": "活动{marker}", "entryType": "ACTIVITY", "infoUnlockDatas": [
            {{"storyTxt": "ch/one", "storyCode": "C1", "storyName": "一章{marker}", "avgTag": null, "storySort": 1}}
        ]}}"#
    )
}

fn zip_bytes(marker: &str) -> Vec<(String, Vec<u8>)> {
    let review = format!("{{{}}}", review_entry("act_swap", marker));
    let chapter = format!(
        r#"{{"storyCode": "C1", "storyName": "一章{marker}", "avgTag": null, "eventName": "活动{marker}", "storyInfo": "", "storyList": [
            {{"prop": "name", "attributes": {{"name": "阿米娅", "content": "标记{marker}的台词。"}}}}
        ]}}"#
    );
    vec![
        (
            "zh_CN/gamedata/excel/story_review_table.json".to_string(),
            review.into_bytes(),
        ),
        (
            "zh_CN/gamedata/story/ch/one.json".to_string(),
            chapter.into_bytes(),
        ),
    ]
}

fn write_zip(path: &std::path::Path, marker: &str) {
    let owned = zip_bytes(marker);
    let entries: Vec<(&str, &[u8])> = owned
        .iter()
        .map(|(p, b)| (p.as_str(), b.as_slice()))
        .collect();
    write_zip_entries(path, &entries).expect("zip written");
}

fn temp_zip(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("prts-story-index-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("zh_CN.zip")
}

/// A swapped zip (same path, new bytes) rebuilds the index exactly once and
/// the next reads see the new content without any restart.
#[test]
fn swap_rebuilds_once_and_reads_new_content() {
    let _guard = COUNTER_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let zip = temp_zip("swap");
    write_zip(&zip, "AA");

    // Per-call store semantics (TS withStoryStore constructs a fresh store
    // per call; reusing one would pin the old file handle).
    let first = story_search_index(&zip, &ZipStore::new(&zip)).expect("index A");
    assert_eq!(
        first.chapters[0].lines.get(0).unwrap().text,
        "标记AA的台词。",
        "first generation content"
    );
    // Hold the old index alive across the swap (an in-flight reader).
    let held = Arc::clone(&first);
    let builds_before = index_build_count();

    // Atomic swap: write a new file and rename over the path (the sync
    // layer's publish style). Markers differ in length so the stat-based
    // descriptor (size/mtime) observes the change.
    let staging = zip.with_extension("zip.staging");
    write_zip(&staging, "B");
    std::fs::rename(&staging, &zip).unwrap();

    let rebuilt = story_search_index(&zip, &ZipStore::new(&zip)).expect("index B");
    assert_eq!(
        rebuilt.chapters[0].lines.get(0).unwrap().text,
        "标记B的台词。",
        "swap is visible without restart"
    );
    assert_eq!(
        index_build_count(),
        builds_before + 1,
        "exactly one rebuild"
    );

    // A third call with no further change reuses the cache.
    let again = story_search_index(&zip, &ZipStore::new(&zip)).expect("index B reuse");
    assert_eq!(index_build_count(), builds_before + 1);
    assert!(Arc::ptr_eq(&rebuilt, &again), "same cached index Arc");

    // The old generation is only retained by the in-flight reader; once it
    // finishes, nothing keeps the previous index alive.
    drop(held);
    drop(first);
    let _ = std::fs::remove_dir_all(zip.parent().unwrap());
}

/// The shared index is dataset-scoped: concurrent first callers share one
/// build (single-flight), evidenced by the build counter moving once while
/// both threads resolve chapters.
#[test]
fn concurrent_first_calls_share_one_build() {
    let _guard = COUNTER_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let zip = temp_zip("singleflight");
    write_zip(&zip, "S");

    let builds_before = index_build_count();
    let barrier = Arc::new(std::sync::Barrier::new(4));
    let misses_before = prts_mcp_rust::diagnostics::cache_snapshot()["story_search"]
        ["story_search_index"]["misses"]
        .as_u64()
        .unwrap();
    let mut handles = Vec::new();
    for _ in 0..4 {
        let barrier = Arc::clone(&barrier);
        let zip = zip.clone();
        handles.push(std::thread::spawn(move || {
            barrier.wait();
            let index = story_search_index(&zip, &ZipStore::new(&zip)).expect("index");
            index.chapters[0].story_key.clone()
        }));
    }
    let keys: Vec<String> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    assert!(keys.iter().all(|k| k == "ch/one"));
    // One build for the whole concurrent burst (counter is process-global,
    // so assert the delta).
    assert_eq!(
        index_build_count(),
        builds_before + 1,
        "single-flight shared build"
    );
    assert_eq!(
        prts_mcp_rust::diagnostics::cache_snapshot()["story_search"]["story_search_index"]
            ["misses"]
            .as_u64()
            .unwrap(),
        misses_before + 1,
        "one actual build attempt, not several builds with one winning publication"
    );

    let _ = std::fs::remove_dir_all(zip.parent().unwrap());
}

#[test]
fn repeated_swaps_release_old_readers_and_share_each_rebuild() {
    let _guard = COUNTER_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let zip = temp_zip("repeated-swaps");
    write_zip(&zip, "initial");
    let mut current = story_search_index(&zip, &ZipStore::new(&zip)).unwrap();
    for generation in 0..20 {
        let previous_text = current.chapters[0].lines.get(0).unwrap().text.to_owned();
        let old = Arc::downgrade(&current);
        let count = index_build_count();
        let marker = format!("generation-{generation}-{}", "不同长度".repeat(generation));
        let staging = zip.with_extension("staging");
        write_zip(&staging, &marker);
        std::fs::rename(&staging, &zip).unwrap();
        let barrier = std::sync::Barrier::new(4);
        let readers = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..4)
                .map(|_| {
                    scope.spawn(|| {
                        barrier.wait();
                        story_search_index(&zip, &ZipStore::new(&zip)).unwrap()
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|h| h.join().unwrap())
                .collect::<Vec<_>>()
        });
        assert_eq!(index_build_count(), count + 1);
        assert!(readers.iter().all(|r| Arc::ptr_eq(r, &readers[0])));
        assert_eq!(
            readers[0].chapters[0].lines.get(0).unwrap().text,
            format!("标记{marker}的台词。")
        );
        assert_eq!(
            current.chapters[0].lines.get(0).unwrap().text,
            previous_text
        );
        current = Arc::clone(&readers[0]);
        assert!(
            old.upgrade().is_none(),
            "old generation retained after final reader dropped"
        );
    }
    let _ = std::fs::remove_dir_all(zip.parent().unwrap());
}

/// The search path itself observes the swap (identity coverage end to end).
#[test]
fn search_results_follow_zip_identity() {
    let zip = temp_zip("search-identity");
    write_zip(&zip, "XX");
    let _guard = COUNTER_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let hit_x =
        build_story_search(&zip, "标记X", None, None, 1, 10, Some("act_swap")).expect("search X");
    assert_eq!(hit_x["total"], 1, "{hit_x}");

    let staging = zip.with_extension("zip.staging");
    write_zip(&staging, "Y");
    std::fs::rename(&staging, &zip).unwrap();

    let hit_y =
        build_story_search(&zip, "标记Y", None, None, 1, 10, Some("act_swap")).expect("search Y");
    assert_eq!(hit_y["total"], 1, "{hit_y}");
    let stale = build_story_search(&zip, "标记X", None, None, 1, 10, Some("act_swap"))
        .expect("stale search");
    assert_eq!(stale["total"], 0, "old content no longer indexed: {stale}");

    let _ = std::fs::remove_dir_all(zip.parent().unwrap());
}

/// Independent parsing must preserve insertion/stable-sort order, and keep
/// skipping corrupt/missing chapters without dropping subsequent good ones.
#[test]
fn parallel_build_preserves_chapter_order_and_skip_semantics() {
    use serde_json::json;
    let _guard = COUNTER_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let zip = temp_zip("parallel-order");
    let mut entries = Vec::new();
    let mut datas = Vec::new();
    for n in 0..32 {
        let key = format!("ch/{n}");
        datas.push(
            json!({"storyTxt":key,"storyCode":format!("C{n}"),"storyName":key,"storySort":n/2}),
        );
        if n == 7 {
            continue;
        } // Missing chapter.
        let contents = if n == 13 {
            b"{bad".to_vec()
        } else {
            serde_json::to_vec(&json!({"storyList":[{"prop":"name","attributes":{"name":"角色","content":format!("line{n}")}}]})).unwrap()
        };
        entries.push((format!("zh_CN/gamedata/story/{key}.json"), contents));
    }
    entries.push((
        "zh_CN/gamedata/excel/story_review_table.json".to_owned(),
        serde_json::to_vec(&json!({"event":{"entryType":"ACTIVITY","infoUnlockDatas":datas}}))
            .unwrap(),
    ));
    let borrowed: Vec<_> = entries
        .iter()
        .map(|(p, b)| (p.as_str(), b.as_slice()))
        .collect();
    write_zip_entries(&zip, &borrowed).unwrap();
    let index = story_search_index(&zip, &ZipStore::new(&zip)).unwrap();
    let expected: Vec<_> = (0..32)
        .filter(|&n| n != 7 && n != 13)
        .map(|n| format!("ch/{n}"))
        .collect();
    assert_eq!(
        index
            .chapters
            .iter()
            .map(|c| c.story_key.clone())
            .collect::<Vec<_>>(),
        expected
    );
    assert_eq!(
        index.records().collect::<Vec<_>>(),
        (0..30).map(|n| (n, 0)).collect::<Vec<_>>()
    );
    let _ = std::fs::remove_dir_all(zip.parent().unwrap());
}
