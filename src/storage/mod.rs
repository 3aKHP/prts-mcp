//! Directory/ZIP/fallback stores, generation pointers, snapshots.
//! P1: DirectoryStore read path only; ZIP/fallback and generations are P2.

mod store;

pub use store::{DirectoryStore, JsonStore, StoreError};
