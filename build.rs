fn main() {
    println!("cargo:rerun-if-changed=vendor/quickjs-regexp");
    println!("cargo:rerun-if-changed=native/regexp.c");
    cc::Build::new()
        .include("vendor/quickjs-regexp")
        .file("vendor/quickjs-regexp/libregexp.c")
        .file("vendor/quickjs-regexp/libunicode.c")
        .file("native/regexp.c")
        .define("_GNU_SOURCE", None)
        .flag_if_supported("-std=c11")
        .warnings(false)
        .compile("prts_ecma_regexp");
}
