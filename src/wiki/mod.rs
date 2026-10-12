//! PRTS Wiki domain: HTTP client (rate limit + timeouts), text cleanup,
//! search/page actions, the template renderer (docs/03 Wiki 清单), and the
//! MediaWiki image discovery/download surface for the artwork backend.

pub mod client;
pub mod images_api;
pub mod page;
pub mod search;
pub mod template;
pub mod template_xml;
pub mod text_ops;
