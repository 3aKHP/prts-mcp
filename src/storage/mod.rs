//! Directory/ZIP/fallback stores, generation pointers, snapshots.

pub mod database;
pub(crate) mod frozen;
pub mod generation;
pub(crate) mod identity;
pub(crate) mod json_view;
mod objects;
pub(crate) mod projection;
pub mod sqlite;
mod store;
pub(crate) mod validation;

pub use generation::{activated_pair, activated_root, excel_path_of, gamedata_pair_path_for_read};
pub use store::{
    write_zip_entries, DirectoryStore, FallbackStore, JsonStore, StoreError, ZipStore,
};

pub(crate) mod digest;
