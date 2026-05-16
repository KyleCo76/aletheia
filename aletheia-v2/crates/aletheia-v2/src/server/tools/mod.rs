//! MCP tool implementations, organized by category. Phase 5 (TL-tools) fills these in.
//!
//! Each submodule contributes `#[tool]`-annotated methods to the `AletheiaServer`
//! impl block in `super::mcp` via Phase 5's tool-category workers.

pub mod active_context;
pub mod auth;
pub mod discovery;
pub mod entries;
pub mod features;
pub mod handoff;
pub mod journal;
pub mod memory;
pub mod query;
pub mod status;
pub mod system;
