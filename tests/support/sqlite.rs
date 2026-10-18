//! Build-time fixture compilation shared by integration tests.
#[allow(dead_code)]
#[path = "../../examples/data_compiler.rs"]
pub mod compiler;
#[allow(dead_code)]
pub fn compile(root: &std::path::Path) {
    let staging = root.with_file_name(format!("fixture-build-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&staging).unwrap();
    compiler::compile(&compiler::Options {
        input: Some(root.to_owned()),
        output: staging.join("zh_CN.sqlite"),
        version: "fixture".into(),
        revision: 1,
        allow_incomplete: true,
        ..Default::default()
    })
    .unwrap();
    std::fs::create_dir_all(root.join("database")).unwrap();
    std::fs::copy(
        staging.join("zh_CN.sqlite"),
        root.join("database/zh_CN.sqlite"),
    )
    .unwrap();
    std::fs::remove_dir_all(staging).unwrap();
}
