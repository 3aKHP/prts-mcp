//! JS-compatible text semantics: UTF-16 ordering/slicing, JS number rules,
//! the standalone native ECMAScript regex component, and the wikitext sanitiser.

pub(crate) mod cancellation;
pub mod js_compat;
pub mod numbers;
pub mod regex_compat;
pub mod sanitizer;
