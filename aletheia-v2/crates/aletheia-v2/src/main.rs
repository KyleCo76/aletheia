//! `aletheia-v2` binary entry point.
//!
//! Phase 4 (CR-4) wires the `serve` subcommand to
//! [`aletheia_v2::server::index::start_server`]. The other subcommands
//! (`setup`, `migrate-from-v1`) remain `unimplemented!` markers and are
//! filled in by Phase 3 / Phase 8 respectively.
//!
//! ## stdout discipline (C-S4 / C-S11)
//!
//! ZERO `println!` / `print!` / `dbg!` macros may appear in this file.
//! rmcp speaks JSON-RPC on stdout once `start_server` reaches its MCP
//! spawn step; any stdout write outside that channel corrupts the
//! protocol. All diagnostics flow through `tracing::*`, which
//! `init_tracing()` configures to stderr only. The CR-4 grep enforces
//! this contract.
//!
//! ## Runtime flavor
//!
//! We build the multi-thread tokio runtime explicitly (rather than via
//! `#[tokio::main]`) so we can call `shutdown_timeout` on it after the
//! top-level future returns. See the comment block in `main` for the
//! full rationale — short version: rmcp's stdio transport pins a
//! blocking thread inside `stdin.read(2)`, and `Runtime::drop`'s
//! default 10 s wait would blow the CR-4 5-second SIGTERM acceptance
//! window. The multi-thread flavor is required either way because
//! `start_server` uses `tokio::spawn` extensively.

use clap::Parser;
use std::path::PathBuf;

#[derive(Parser)]
#[command(
    name = "aletheia-v2",
    version,
    about = "Aletheia V2 — structured memory MCP server"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
    /// Override the data directory (default: `$HOME/.aletheia-v2`).
    #[arg(long, global = true)]
    data_dir: Option<PathBuf>,
}

#[derive(clap::Subcommand)]
enum Commands {
    /// Run the MCP server (default mode).
    Serve,
    /// First-time installation setup.
    Setup,
    /// Migrate from V1 (one-shot, master-key required).
    MigrateFromV1 {
        /// Path to the V1 SQLite database file.
        v1_db_path: PathBuf,
    },
}

fn main() -> ! {
    // Install the tracing subscriber BEFORE clap parsing so any
    // error-path log lines flow through the configured stderr writer.
    aletheia_v2::init_tracing();

    let cli = Cli::parse();
    let data_dir = cli.data_dir.unwrap_or_else(default_data_dir);

    // Build the multi-thread runtime explicitly (rather than via
    // `#[tokio::main]`) so we can call `shutdown_timeout` after the
    // top-level future completes. Rationale: `run_mcp_stdio` adapts
    // tokio's `Stdin`, which issues blocking `read(2)` syscalls on a
    // runtime blocking thread. When `start_server` aborts the rmcp
    // task on SIGTERM, the future is dropped but the blocking thread
    // is still parked inside the syscall — `Runtime::drop`'s default
    // wait is 10 seconds, which would blow the CR-4 5-second SIGTERM
    // acceptance window.
    //
    // We `block_on` the top-level future, then call
    // `shutdown_timeout(Duration::ZERO)` so any orphaned blocking
    // threads are abandoned immediately. The blocking syscalls hold
    // no resources we own (stdin/stdout are inherited and the parent
    // process closes them) — abandoning them is safe.
    //
    // The multi-thread runtime is required because `start_server`
    // uses `tokio::spawn` extensively (hook endpoint accept loop +
    // rmcp stdio service + Phase 5-9 background tasks).
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("build tokio multi-thread runtime");

    let result = rt.block_on(async {
        match cli.command.unwrap_or(Commands::Serve) {
            Commands::Serve => {
                // Phase 4 accepts `Settings::default()`. TOML loading
                // from `<data_dir>/config.toml` is a Phase 10 polish
                // concern. `start_server` is itself responsible for
                // the bootstrap chain (registry open via
                // ConnectionManager, migration-orphan reconciliation,
                // hook endpoint server, rmcp stdio spawn, shutdown
                // signal wait, graceful release).
                let settings = aletheia_v2::settings::Settings::default();
                aletheia_v2::server::index::start_server(settings, data_dir).await
            }
            Commands::Setup => unimplemented!("Phase 3"),
            Commands::MigrateFromV1 { .. } => unimplemented!("Phase 8"),
        }
    });

    // CRITICAL: drop the runtime with a short shutdown timeout so we
    // give aborted async tasks a moment to run their destructors (the
    // hook-endpoint-server task owns the `Listener` whose Drop impl
    // unlinks the per-PID socket — name reclamation per interprocess
    // 2.4's `ReclaimGuard`). A zero-duration timeout would skip that
    // and leak the socket file on shutdown.
    //
    // 250 ms is comfortably above the wakeup latency of an aborted
    // tokio task (microseconds in practice) but well under the CR-4
    // SIGTERM acceptance window of 5 s. The trade-off: we abandon
    // any blocking thread still parked inside stdin's `read(2)`
    // after 250 ms (tokio's `Stdin` is the only blocking-thread user
    // here, and its read holds no resources we own — the parent
    // closes stdin on exit), keeping the SIGTERM round-trip fast.
    rt.shutdown_timeout(std::time::Duration::from_millis(250));

    match result {
        Ok(()) => std::process::exit(0),
        Err(e) => {
            tracing::error!(target: "main", error = %e, "aletheia-v2 exited with error");
            std::process::exit(1);
        }
    }
}

/// Default data-directory resolver: `$HOME/.aletheia-v2`, falling back
/// to `./.aletheia-v2` if `HOME` is unset. Mirrors the helper used
/// inside `crate::server::mcp::run_mcp_stdio` (avoiding a separate
/// `dirs` crate dependency for one home-dir lookup — the workspace
/// already has no such dep and we keep it that way).
fn default_data_dir() -> PathBuf {
    std::env::var("HOME")
        .map(|h| PathBuf::from(h).join(".aletheia-v2"))
        .unwrap_or_else(|_| PathBuf::from(".aletheia-v2"))
}
