//! Graceful shutdown signal handling. SIGTERM / SIGINT on Unix; Ctrl+C on Windows.
//!
//! `wait_for_shutdown_signal()` returns when the first qualifying OS signal
//! arrives. Callers (currently `crate::server::index::start_server`) treat the
//! return as the trigger to abort background tasks, run shutdown hooks, and
//! release the session lock.

/// Block until SIGTERM / SIGINT (Unix) or Ctrl+C (Windows) arrives, then
/// return. Logs which signal was received via `tracing::info!` (stderr only —
/// stdout is reserved for the rmcp JSON-RPC channel).
///
/// On Unix, both SIGTERM and SIGINT are watched; whichever fires first wins.
/// On Windows, only Ctrl+C is portable; native service termination would use
/// a different mechanism that's out of scope for Phase 4.
///
/// Failing to install a signal handler at startup is treated as an
/// unrecoverable error — the `.expect(...)` calls panic in that case rather
/// than silently degrade to a server that ignores SIGTERM (which would leave
/// session locks dangling on `kill -TERM`).
pub async fn wait_for_shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut sigterm = signal(SignalKind::terminate()).expect("install SIGTERM handler");
        let mut sigint = signal(SignalKind::interrupt()).expect("install SIGINT handler");
        tokio::select! {
            _ = sigterm.recv() => tracing::info!(target: "server.shutdown", "SIGTERM received; shutting down"),
            _ = sigint.recv() => tracing::info!(target: "server.shutdown", "SIGINT received; shutting down"),
        }
    }
    #[cfg(windows)]
    {
        let _ = tokio::signal::ctrl_c().await;
        tracing::info!(target: "server.shutdown", "Ctrl+C received; shutting down");
    }
}
