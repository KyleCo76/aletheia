//! Aletheia V2 — Authentication and Sessions (Phase 3).
//!
//! Module hierarchy follows the plan §"Module structure" (plan lines 1351-1370).
//! Wave A populates `keys` + `permissions` + `sessions` + `locks`; Wave B
//! populates `claim`; Wave C ships SessionStart hook scripts under
//! `aletheia-v2/hooks/{unix,windows}/` (outside `src/`).

pub mod claim;
pub mod keys;
pub mod locks;
pub mod permissions;
pub mod sessions;

// `PermissionSet` is defined in `crate::types::scope` (Phase 1) and re-exported
// here so downstream code can write `crate::auth::PermissionSet`. See plan IS-3
// — every Phase 5 write handler reads this type from `ClaimedSession`.
pub use crate::types::scope::PermissionSet;

// `ClaimedSession` is the value Phase 4 (TL-server) returns to MCP clients on
// successful `claim`; re-exported for ergonomics so callers write
// `crate::auth::ClaimedSession` rather than `crate::auth::claim::ClaimedSession`.
pub use claim::ClaimedSession;
