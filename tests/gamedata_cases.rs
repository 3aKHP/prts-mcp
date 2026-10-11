//! Layer-1 corpora for the GameData domain: the oracle's
//! operator-query-cases / operator-talent-cases / tool-bounds parity
//! fixtures, driven against an inline fixture that mirrors
//! tests/fixtures/operatorData.ts @ e0ba360. The process-level differential
//! (P3 manifest cases) covers the same surface end-to-end; these pin the
//! numeric/wording cores at unit level.

use std::path::PathBuf;
use std::sync::Arc;

use prts_mcp_rust::app::{DataState, DataView};
use prts_mcp_rust::config::RuntimeConfig;
use prts_mcp_rust::tools::output::OutputChannel;
use prts_mcp_rust::tools::{registry, AppHandle};

const QUERY_CASES: &str = include_str!("../contracts/cases/operator-query-cases.json");
const TALENT_CASES: &str = include_str!("../contracts/cases/operator-talent-cases.json");
const TOOL_BOUNDS: &str = include_str!("../contracts/cases/tool-bounds.json");

/// The Amiya-shaped minimal volume (character/handbook/charword/skill/
/// building tables) written into a temp dir.
fn write_amiya_fixture(root: &std::path::Path) {
    let excel = root.join("zh_CN/gamedata/excel");
    std::fs::create_dir_all(&excel).unwrap();
    for f in [
        "handbook_info_table.json",
        "charword_table.json",
        "story_review_table.json",
    ] {
        std::fs::write(excel.join(f), "{}").unwrap();
    }
    let character_table = r#"{
      "char_002_amiya": {
        "name": "阿米娅", "appellation": "Amiya", "displayNumber": "R001",
        "description": "<@ba.kw>法术伤害</>", "rarity": "TIER_5",
        "profession": "CASTER", "subProfessionId": "corecaster", "position": "RANGED",
        "nationId": "rhodes", "groupId": "", "teamId": "", "tagList": ["输出", "支援"],
        "itemUsage": "罗德岛的公开领袖。", "itemDesc": "阿米娅的信物。", "itemObtainApproach": "主线获得",
        "talents": [{"candidates": [
          {"name": "？？？", "description": ""},
          {"name": "情绪吸收", "description": "攻击回复技力", "unlockCondition": {"phase": "PHASE_1", "level": 1}, "requiredPotentialRank": 0},
          {"name": "情绪吸收", "description": "攻击回复技力<@ba.talpu>（+2）</>", "unlockCondition": {"phase": "PHASE_2", "level": 1}, "requiredPotentialRank": 4}
        ]}],
        "skills": [{"skillId": "skchr_amiya_1"}, {"skillId": "skchr_amiya_2"}, {"skillId": "skchr_amiya_3"}],
        "phases": [
          {"maxLevel": 50, "attributesKeyFrames": [
            {"level": 1, "data": {"maxHp": 699, "atk": 276, "def": 48, "magicResistance": 10.0, "cost": 18, "blockCnt": 1, "attackSpeed": 100.0, "baseAttackTime": 1.6, "respawnTime": 70}},
            {"level": 50, "data": {"maxHp": 958, "atk": 390, "def": 81, "magicResistance": 10.0, "cost": 18, "blockCnt": 1, "attackSpeed": 100.0, "baseAttackTime": 1.6, "respawnTime": 70}}]},
          {"maxLevel": 70, "attributesKeyFrames": [
            {"level": 1, "data": {"maxHp": 958, "atk": 390, "def": 81, "magicResistance": 15.0, "cost": 19, "blockCnt": 1, "attackSpeed": 100.0, "baseAttackTime": 1.6, "respawnTime": 70}},
            {"level": 70, "data": {"maxHp": 1198, "atk": 514, "def": 110, "magicResistance": 15.0, "cost": 20, "blockCnt": 1, "attackSpeed": 100.0, "baseAttackTime": 2.0, "respawnTime": 70}}]},
          {"maxLevel": 80, "attributesKeyFrames": [
            {"level": 1, "data": {"maxHp": 1198, "atk": 514, "def": 110, "magicResistance": 20.0, "cost": 20, "blockCnt": 1, "attackSpeed": 100.0, "baseAttackTime": 1.6, "respawnTime": 70}},
            {"level": 80, "data": {"maxHp": 1480, "atk": 612, "def": 121, "magicResistance": 20.0, "cost": 20, "blockCnt": 1, "attackSpeed": 100.0, "baseAttackTime": 1.6, "respawnTime": 70}}]}
        ],
        "favorKeyFrames": [
          {"level": 0, "data": {"maxHp": 0, "atk": 0, "def": 0}},
          {"level": 50, "data": {"maxHp": 200, "atk": 70}}
        ],
        "potentialRanks": [
          {"type": "BUFF", "description": "部署费用-2"},
          {"type": "BUFF", "description": "攻击力+25"}
        ]
      },
      "trap_012_lynx": {"name": "阿米娅", "appellation": "Lynx"}
    }"#;
    std::fs::write(excel.join("character_table.json"), character_table).unwrap();
    std::fs::write(
        excel.join("handbook_info_table.json"),
        r#"{"handbookDict": {"char_002_amiya": {"storyTextAudio": [
            {"storyTitle": "档案资料一", "stories": [{"storyText": "阿米娅的档案文本。"}]}
        ]}}}"#,
    )
    .unwrap();
    std::fs::write(
        excel.join("charword_table.json"),
        r#"{"charWords": {"amiya_001": {"charId": "char_002_amiya", "voiceTitle": "任命助理", "voiceText": "博士，今天也请多指教。"}}}"#,
    )
    .unwrap();
    let skill_levels = |attack_speed: f64, sp_cost: i64, init_sp: i64| {
        format!(
            r#"{{"name": "战术咏唱", "description": "攻击速度<@ba.vup>+{{attack_speed}}</>，持续{{duration}}秒", "skillType": "MANUAL", "durationType": "NONE", "duration": 30.0, "spData": {{"spType": "INCREASE_WITH_TIME", "spCost": {sp_cost}, "initSp": {init_sp}, "maxChargeTime": 1}}, "blackboard": [{{"key": "attack_speed", "value": {attack_speed}, "valueStr": null}}, {{"key": "duration", "value": 30.0, "valueStr": null}}]}}"#
        )
    };
    let progression: Vec<(f64, i64, i64)> = vec![
        (30.0, 40, 0),
        (35.0, 40, 0),
        (40.0, 40, 0),
        (45.0, 35, 5),
        (50.0, 35, 5),
        (55.0, 35, 5),
        (60.0, 32, 10),
        (70.0, 32, 10),
        (80.0, 32, 10),
        (90.0, 30, 15),
    ];
    let levels: Vec<String> = progression
        .into_iter()
        .map(|(a, s, i)| skill_levels(a, s, i))
        .collect();
    std::fs::write(
        excel.join("skill_table.json"),
        format!(
            r#"{{"skchr_amiya_1": {{"skillId": "skchr_amiya_1", "levels": [{}]}}}}"#,
            levels.join(",")
        ),
    )
    .unwrap();
    std::fs::write(
        excel.join("building_data.json"),
        r#"{"chars": {"char_002_amiya": {"buffChar": [
            {"buffData": [{"buffId": "control", "cond": {"phase": "PHASE_0", "level": 1}}]},
            {"buffData": [
              {"buffId": "dorm0", "cond": {"phase": "PHASE_0", "level": 1}},
              {"buffId": "dorm2", "cond": {"phase": "PHASE_2", "level": 1}}
            ]}
        ]}}, "buffs": {
            "control": {"buffName": "合作协议", "roomType": "CONTROL", "description": "进驻控制中枢时，所有贸易站订单效率<@cc.vup>+7%</>"},
            "dorm0": {"buffName": "热情", "roomType": "DORMITORY", "description": "进驻宿舍时，恢复<@cc.vup>+0.1</>"},
            "dorm2": {"buffName": "热情", "roomType": "DORMITORY", "description": "进驻宿舍时，恢复<@cc.vup>+0.25</>"}
        }}"#,
    )
    .unwrap();
}

struct Fixture {
    root: PathBuf,
    handle: AppHandle,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let root =
            std::env::temp_dir().join(format!("prts-gamedata-cases-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        write_amiya_fixture(&root);
        let config = RuntimeConfig::from_lookup(|name| match name {
            "GAMEDATA_PATH" => Some(root.to_string_lossy().into_owned()),
            "STORYJSON_PATH" => Some(root.join("nope.zip").to_string_lossy().into_owned()),
            _ => None,
        });
        Self {
            root,
            handle: AppHandle::from_config(&config),
        }
    }

    fn call(&self, name: &str, args: serde_json::Value) -> String {
        let tool = registry()
            .into_iter()
            .find(|t| t.name == name)
            .unwrap_or_else(|| panic!("tool {name} registered"));
        match (tool.dispatch)(&self.handle, &args) {
            prts_mcp_rust::tools::DispatchResult::Outcome(outcome) => outcome
                .render(OutputChannel::Content)["content"][0]["text"]
                .as_str()
                .unwrap()
                .to_string(),
            prts_mcp_rust::tools::DispatchResult::RpcError(code, message) => {
                panic!("unexpected rpc error {code}: {message}")
            }
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn operator_query_corpus() {
    let cases: Vec<serde_json::Value> = serde_json::from_str(QUERY_CASES).unwrap();
    let fixture = Fixture::new("query");
    for case in cases {
        let args = case["args"].clone();
        let name = args["name"].as_str().unwrap_or_default().to_string();
        let call = || fixture.call("get_operator_basic_info", args.clone());
        let text = call();
        if let Some(expected_error) = case["error"].as_str() {
            assert_eq!(text, expected_error, "args {args}");
        } else {
            let needle = case["text"].as_str().expect("text or error");
            assert!(
                text.contains(needle),
                "args {args}: expected {needle:?} in\n{text}"
            );
            let _ = name;
        }
    }
}

#[test]
fn talent_tier_notes() {
    let cases: serde_json::Value = serde_json::from_str(TALENT_CASES).unwrap();
    // The corpus's candidates render through talentTierNote; the v2-style
    // fixture only carries Amiya, so drive the note builder directly with
    // each case's candidate tiers via the payload path: build a minimal
    // character entry per case.
    for case in cases["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let root = std::env::temp_dir().join(format!("prts-talent-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let excel = root.join("zh_CN/gamedata/excel");
        std::fs::create_dir_all(&excel).unwrap();
        for f in [
            "handbook_info_table.json",
            "charword_table.json",
            "story_review_table.json",
        ] {
            std::fs::write(excel.join(f), "{}").unwrap();
        }
        let mut candidates = case["candidates"].clone();
        // The corpus omits description emptiness — supply the raw shape the
        // builder reads.
        for c in candidates.as_array_mut().unwrap() {
            if c.get("description").is_none() {
                c["description"] = serde_json::json!("");
            }
        }
        let character = serde_json::json!({
            "name": name, "rarity": "TIER_5", "profession": "WARRIOR", "position": "MELEE",
            "talents": [{"candidates": candidates}],
            "skills": [], "phases": [], "tagList": []
        });
        std::fs::write(
            excel.join("character_table.json"),
            format!(
                r#"{{"char_1_{}": {}}}"#,
                name,
                serde_json::to_string(&character).unwrap()
            ),
        )
        .unwrap();
        let config = RuntimeConfig::from_lookup(|n| match n {
            "GAMEDATA_PATH" => Some(root.to_string_lossy().into_owned()),
            "STORYJSON_PATH" => Some(root.join("nope.zip").to_string_lossy().into_owned()),
            _ => None,
        });
        let handle = AppHandle::from_config(&config);
        let text = handle.call_basic(name);
        let note = case["note"].as_str().unwrap();
        assert!(
            text.lines().any(|l| l.trim() == note),
            "{name}: expected note {note:?} in\n{text}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}

trait CallBasic {
    fn call_basic(&self, name: &str) -> String;
}

impl CallBasic for AppHandle {
    fn call_basic(&self, name: &str) -> String {
        let view = self.snapshot();
        match prts_mcp_rust::domain::operator::build_operator_basic_info(
            &view,
            &self.excel_path(),
            name,
        ) {
            Ok(data) => prts_mcp_rust::domain::operator::render_operator_basic_info(&data),
            Err(text) => text,
        }
    }
}

#[test]
fn tool_bounds_defaults() {
    let bounds: serde_json::Value = serde_json::from_str(TOOL_BOUNDS).unwrap();
    // Representative boundary assertions from the corpus; the full accept/
    // reject surface is covered by the zodish probes and the differential
    // schema-reject cases.
    let list_enemies = &bounds["list_enemies"];
    assert_eq!(list_enemies["limit"]["min"], 1);
    assert_eq!(list_enemies["limit"]["max"], 200);
    assert_eq!(list_enemies["limit"]["default"], 50);
    let basic = &bounds["get_operator_basic_info"];
    assert_eq!(basic["phase"]["min"], 0);
    assert_eq!(basic["phase"]["max"], 2);
    assert_eq!(basic["phase"]["default"], serde_json::Value::Null);
    let search = &bounds["search"];
    assert_eq!(search["max_results"]["max"], 100);

    let fixture = Fixture::new("bounds");
    // Defaults flow through the tool layer on empty arguments.
    let text = fixture.call("list_enemies", serde_json::json!({}));
    assert!(text.contains("敌人图鉴"), "{text}");
}

/// The name→charId map keeps only `char_`-prefixed entries: the trap named
/// 阿米娅 never shadows the operator (docs/03 干员/trap 同名优先级).
#[test]
fn trap_name_collision_prefers_char_prefix() {
    let fixture = Fixture::new("trap");
    let text = fixture.call(
        "get_operator_basic_info",
        serde_json::json!({"name": "阿米娅"}),
    );
    assert!(
        text.starts_with("# 阿娅") || text.starts_with("# 阿米娅"),
        "{text}"
    );
    assert!(text.contains("R001"));
}

/// One snapshot per call, and a second call reuses the per-generation dataset
/// cache (both hits resolve the same tables without re-reading).
#[test]
fn dataset_cache_is_per_generation() {
    let fixture = Fixture::new("cache");
    let state = DataState::new(Arc::new(RuntimeConfig::from_lookup(|name| match name {
        "GAMEDATA_PATH" => Some(fixture.root.to_string_lossy().into_owned()),
        "STORYJSON_PATH" => Some(fixture.root.join("nope.zip").to_string_lossy().into_owned()),
        _ => None,
    })));
    let view: Arc<DataView> = state.snapshot();
    let first = prts_mcp_rust::domain::operator::character_table(&view).unwrap();
    let second = prts_mcp_rust::domain::operator::character_table(&view).unwrap();
    assert!(
        Arc::ptr_eq(&first, &second),
        "same generation reuses the parse"
    );
}
