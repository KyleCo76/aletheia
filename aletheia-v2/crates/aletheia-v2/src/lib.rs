//! Aletheia V2 — structured memory MCP server (library root).
//!
//! Phase 1 establishes the type system, error infrastructure, and
//! settings module. Subsequent phases attach storage (Phase 2), auth
//! (Phase 3), MCP server (Phase 4), and onward.

pub mod error;
pub mod settings;
pub mod types;
pub mod version;

// Note (Worker A1 deviation, documented in report): the plan's module
// diagram shows `src/lib/{settings,version}` as nested submodules under
// a `lib` namespace. Rust 2018+ reserves the bare module name `lib`
// (it conflicts with the `lib.rs` crate root file — `pub mod lib;`
// triggers E0761 "file for module `lib` found at both lib.rs and
// lib/mod.rs"). Rather than introducing an awkward rename
// (`lib_inner`, etc.), settings and version are promoted to direct
// submodules of the crate root. The downstream API
// (`crate::settings::Settings`, `crate::version::VERSION`) is shorter
// and idiomatic Rust.

/// Initialize the global tracing subscriber.
///
/// CRITICAL CONTRACT (C2): writes to **stderr only**. From Phase 4
/// onward the binary speaks JSON-RPC over stdout via rmcp; any logger
/// that writes to stdout would corrupt the MCP transport and crash the
/// session. This helper is the single chokepoint — call it once from
/// `main()` and never construct an alternative subscriber that targets
/// stdout.
///
/// Idempotent in the sense that a second call is a no-op (the global
/// subscriber can only be set once); subsequent calls return without
/// error so tests that exercise the binary's startup path do not panic.
pub fn init_tracing() {
    use tracing_subscriber::EnvFilter;

    // try_init returns Err if a subscriber is already installed (e.g.
    // from a prior call in the same test binary). We swallow that
    // error deliberately — installation is best-effort idempotent.
    let _ = tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .try_init();
}
