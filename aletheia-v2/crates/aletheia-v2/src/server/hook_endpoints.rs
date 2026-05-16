//! HTTP hook endpoint server (Phase 4 S4).
//!
//! Serves six well-known endpoints over the Unix socket / named pipe bound
//! by [`crate::server::transport::bind_listener`]:
//!
//! | Method | Path              | Phase-4 body                              | Phase-6 plan                |
//! |--------|-------------------|-------------------------------------------|-----------------------------|
//! | GET    | `/health`         | `{"status":"ok","pid":<pid>}`              | unchanged                   |
//! | GET    | `/state`          | `{}`                                       | L1 builder payload          |
//! | GET    | `/context`        | `{}`                                       | L2 builder payload          |
//! | GET    | `/handoff`        | `{}`                                       | handoff-peek payload        |
//! | GET    | `/session-info`   | claim status JSON                          | unchanged                   |
//! | POST   | `/reset-frequency`| `{}` (resets `call_count` atomic to 0)     | unchanged                   |
//!
//! ## Design notes
//!
//! - **JSON payloads** (settled in Q2 of the plan errata): V1's hook clients
//!   consume JSON, despite the original design doc proposing YAML-in-XML.
//! - **No `hyper` dep**: a single-line HTTP request parser ("METHOD /path HTTP/1.1")
//!   is sufficient for these six well-known endpoints, none of which inspect
//!   request bodies. Deferred per plan guidance — add `hyper` only if a future
//!   endpoint genuinely needs body parsing or HTTP/1.1 keepalive semantics.
//! - **CRITICAL CONTRACT (C-S4):** no `println!`/`print!`/`dbg!`. All logging
//!   flows through [`tracing`], which `init_tracing` routes to stderr (C2).
//!   stdout is reserved for rmcp JSON-RPC on the MCP transport — a stray
//!   println would corrupt the parent process's protocol stream.
//! - The Phase 6 stub responses (`/state`, `/context`, `/handoff`) intentionally
//!   return `{}` so V1 hook clients can connect, see a 200, and treat the
//!   empty object as "no enrichment available yet" without crashing.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;

use rusqlite::Connection;
use tokio::sync::Mutex;

use crate::error::Result;
use crate::settings::Settings;

/// In-memory per-session state shared between the MCP server and the hook
/// endpoint server. Cloned (cheaply — all fields are `Arc`/`Option`) into
/// each accepted connection.
///
/// Phase 6 will extend this with the actual L1/L2 builder inputs; for now
/// the only field the endpoint server reads or writes is `call_count`
/// (via `POST /reset-frequency`) and `claimed_key_hash`/`primary_scope_id`
/// (via `GET /session-info`).
#[derive(Clone)]
pub struct SessionState {
    /// SHA-256 hex of the claimed master key, or `None` if the session has
    /// not claimed yet. `Option<String>` (not `Option<KeyHash>`) so this
    /// module stays decoupled from `auth::keys`.
    pub claimed_key_hash: Option<String>,
    /// Primary scope ID for the claimed session (e.g. `"ceo-system"`),
    /// resolved at claim time from the key's manifest.
    pub primary_scope_id: Option<String>,
    /// Running count of MCP tool calls in this session, used by hook
    /// frequency-trigger logic. Reset by `POST /reset-frequency` after the
    /// hook fires.
    pub call_count: Arc<AtomicU64>,
    /// Per-entry access counts for the recency/frequency injection signal.
    /// Phase 6 populates; Phase 4 just holds the slot.
    pub access_counts: Arc<Mutex<HashMap<String, u64>>>,
}

impl SessionState {
    /// Empty session state — no claim, zero counts. Useful at server
    /// startup before any tool call lands.
    pub fn empty() -> Self {
        Self {
            claimed_key_hash: None,
            primary_scope_id: None,
            call_count: Arc::new(AtomicU64::new(0)),
            access_counts: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl Default for SessionState {
    fn default() -> Self {
        Self::empty()
    }
}

/// Bind the hook endpoint listener and spawn its accept loop.
///
/// Returns the join handle for the accept-loop task. The caller (usually
/// `crate::server::index::start_server`) is responsible for cancelling
/// or aborting the handle on shutdown — dropping it here would
/// implicitly cancel the loop.
///
/// `conn` and `settings` are accepted (and threaded into
/// `handle_connection`) so that Phase 6 can wire them into the L1/L2
/// builder calls without a signature change. They are deliberately
/// unused in Phase 4.
pub async fn start(
    conn: Arc<Mutex<Connection>>,
    data_dir: PathBuf,
    settings: Settings,
    session_state: SessionState,
) -> Result<tokio::task::JoinHandle<Result<()>>> {
    let listener = crate::server::transport::bind_listener(&data_dir).await?;

    let handle = tokio::spawn(async move {
        // `accept` lives on the `Listener` trait; bringing it into scope
        // here keeps the use-statement co-located with its sole call site.
        use interprocess::local_socket::traits::tokio::Listener;
        loop {
            let stream = match listener.accept().await {
                Ok(s) => s,
                Err(e) => {
                    // A spurious accept error on a single connection
                    // should not tear the whole server down. Log and
                    // continue — the next accept may succeed.
                    tracing::warn!("hook endpoint accept error: {e}");
                    continue;
                }
            };
            let conn_clone = conn.clone();
            let settings_clone = settings.clone();
            let state_clone = session_state.clone();
            tokio::spawn(async move {
                if let Err(e) =
                    handle_connection(stream, conn_clone, settings_clone, state_clone).await
                {
                    tracing::warn!("hook endpoint connection error: {e}");
                }
            });
        }
    });
    Ok(handle)
}

/// Service one client connection: read a single HTTP request, route it,
/// write a single HTTP response, return. No keepalive — V1 hook clients
/// open a fresh connection per call, and matching that behavior keeps the
/// implementation trivial.
async fn handle_connection(
    mut stream: interprocess::local_socket::tokio::Stream,
    _conn: Arc<Mutex<Connection>>,
    _settings: Settings,
    state: SessionState,
) -> Result<()> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    // 4 KiB is comfortably above the size of any well-formed request to
    // our six endpoints (all bodyless; longest path is "/reset-frequency").
    // A larger request will be truncated, the parse will likely fail, and
    // the request will fall through to the `{}` default — acceptable
    // semantics for a request that's already malformed for our schema.
    let mut buf = vec![0u8; 4096];
    let n = stream.read(&mut buf).await?;
    let request = String::from_utf8_lossy(&buf[..n]);

    // Parse the request line: "METHOD /path HTTP/1.1".
    let first_line = request.lines().next().unwrap_or("");
    let mut parts = first_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("");

    let body = route(method, path, &state);
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
        body.len(),
        body
    );
    stream.write_all(response.as_bytes()).await?;
    Ok(())
}

/// Pure routing function — split out from `handle_connection` so it can
/// be unit-tested without spinning up a listener or stream.
fn route(method: &str, path: &str, state: &SessionState) -> String {
    use std::sync::atomic::Ordering;
    match (method, path) {
        ("GET", "/health") => serde_json::json!({
            "status": "ok",
            "pid": std::process::id(),
        })
        .to_string(),

        // Phase 6 fills these in with the L1/L2/handoff-peek builders.
        // Returning a syntactically valid empty object keeps V1 clients
        // (which `JSON.parse` the body unconditionally) from crashing in
        // the interim.
        ("GET", "/state") | ("GET", "/context") | ("GET", "/handoff") => "{}".to_string(),

        ("GET", "/session-info") => serde_json::json!({
            "claimed": state.claimed_key_hash.is_some(),
            "primary_scope_id": state.primary_scope_id,
            "pid": std::process::id(),
        })
        .to_string(),

        ("POST", "/reset-frequency") => {
            state.call_count.store(0, Ordering::SeqCst);
            "{}".to_string()
        }

        // Unknown method/path: empty object, still HTTP 200. Hook clients
        // treat this as "no enrichment" rather than a hard failure. If
        // future telemetry needs to distinguish unknown routes, switch
        // to a 404 here — but keep `route` total (no panics).
        _ => "{}".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    fn parse(body: &str) -> serde_json::Value {
        serde_json::from_str(body).expect("route body must be valid JSON")
    }

    #[test]
    fn session_state_empty_defaults() {
        let s = SessionState::empty();
        assert!(s.claimed_key_hash.is_none());
        assert!(s.primary_scope_id.is_none());
        assert_eq!(s.call_count.load(Ordering::SeqCst), 0);
        let counts = s.access_counts.try_lock().expect("uncontended");
        assert!(counts.is_empty());
    }

    #[test]
    fn session_state_default_matches_empty() {
        let a = SessionState::default();
        let b = SessionState::empty();
        assert_eq!(a.claimed_key_hash, b.claimed_key_hash);
        assert_eq!(a.primary_scope_id, b.primary_scope_id);
        assert_eq!(
            a.call_count.load(Ordering::SeqCst),
            b.call_count.load(Ordering::SeqCst),
        );
    }

    #[test]
    fn get_health_returns_status_and_pid() {
        let state = SessionState::empty();
        let body = route("GET", "/health", &state);
        let v = parse(&body);
        assert_eq!(v["status"], "ok");
        assert!(v["pid"].is_number(), "pid must be numeric, got {v}");
        assert_eq!(v["pid"].as_u64(), Some(u64::from(std::process::id())));
    }

    #[test]
    fn get_state_returns_empty_object_phase_6_stub() {
        let state = SessionState::empty();
        let body = route("GET", "/state", &state);
        assert_eq!(body, "{}");
        // Still valid JSON — V1 clients JSON.parse this.
        let v = parse(&body);
        assert!(v.is_object());
        assert_eq!(v.as_object().unwrap().len(), 0);
    }

    #[test]
    fn get_context_returns_empty_object_phase_6_stub() {
        let state = SessionState::empty();
        let body = route("GET", "/context", &state);
        assert_eq!(body, "{}");
        assert!(parse(&body).is_object());
    }

    #[test]
    fn get_handoff_returns_empty_object_phase_6_stub() {
        let state = SessionState::empty();
        let body = route("GET", "/handoff", &state);
        assert_eq!(body, "{}");
        assert!(parse(&body).is_object());
    }

    #[test]
    fn get_session_info_unclaimed() {
        let state = SessionState::empty();
        let body = route("GET", "/session-info", &state);
        let v = parse(&body);
        assert_eq!(v["claimed"], false);
        assert!(v["primary_scope_id"].is_null());
        assert_eq!(v["pid"].as_u64(), Some(u64::from(std::process::id())));
    }

    #[test]
    fn get_session_info_claimed() {
        let mut state = SessionState::empty();
        state.claimed_key_hash = Some("deadbeef".to_string());
        state.primary_scope_id = Some("ceo-system".to_string());
        let body = route("GET", "/session-info", &state);
        let v = parse(&body);
        assert_eq!(v["claimed"], true);
        assert_eq!(v["primary_scope_id"], "ceo-system");
        assert_eq!(v["pid"].as_u64(), Some(u64::from(std::process::id())));
    }

    #[test]
    fn post_reset_frequency_resets_atomic() {
        let state = SessionState::empty();
        state.call_count.store(42, Ordering::SeqCst);
        assert_eq!(state.call_count.load(Ordering::SeqCst), 42);

        let body = route("POST", "/reset-frequency", &state);
        assert_eq!(body, "{}");
        assert_eq!(state.call_count.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn unknown_path_returns_empty_object() {
        let state = SessionState::empty();
        assert_eq!(route("GET", "/bogus", &state), "{}");
        assert_eq!(route("GET", "/", &state), "{}");
        assert_eq!(route("GET", "", &state), "{}");
    }

    #[test]
    fn wrong_method_returns_empty_object() {
        // /health is GET-only; POST /health should not return the health
        // payload — it falls through to the default arm.
        let state = SessionState::empty();
        assert_eq!(route("POST", "/health", &state), "{}");
        // Conversely, GET /reset-frequency must not reset the counter.
        state.call_count.store(7, Ordering::SeqCst);
        let _ = route("GET", "/reset-frequency", &state);
        assert_eq!(state.call_count.load(Ordering::SeqCst), 7);
    }

    #[test]
    fn unknown_method_returns_empty_object() {
        let state = SessionState::empty();
        assert_eq!(route("PATCH", "/health", &state), "{}");
        assert_eq!(route("", "", &state), "{}");
    }
}
