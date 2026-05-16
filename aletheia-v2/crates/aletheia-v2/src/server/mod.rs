//! MCP server core + hook endpoint server.
//!
//! Phase 4 ships this module structure with the lifecycle scaffolding (`index.rs`),
//! rmcp integration (`mcp.rs`), cross-platform IPC (`transport.rs`), and the HTTP
//! endpoint server (`hook_endpoints.rs`). Later phases fill in:
//! - `tools/*` — Phase 5 (TL-tools) adds `#[tool]` methods to `AletheiaServer`.
//! - `deprecation.rs` — Phase 9 (TL-polish) replaces the no-op with real deprecation logging.

pub mod deprecation;
pub mod hook_endpoints;
pub mod index;
pub mod mcp;
pub mod response_format;
pub mod shutdown;
pub mod tools;
pub mod transport;
