//! Directory/ZIP/fallback stores, generation pointers, snapshots.

pub(crate) mod frozen;
pub mod generation;
pub(crate) mod identity;
pub(crate) mod json_view;
pub(crate) mod projection;
mod store;

pub use generation::{activated_pair, activated_root, excel_path_of, gamedata_pair_path_for_read};
pub use store::{
    write_zip_entries, DirectoryStore, FallbackStore, JsonStore, StoreError, ZipStore,
};
