//! rmcp integration + `AletheiaServer` impl + Phase 4 2-tool spike (C-S2).
//!
//! Phase 4 S1 ships:
//!   * `AletheiaServer` — the rmcp `ServerHandler` impl that Phase 5
//!     extends with the full ~30-tool surface via the `#[tool]` macro.
//!   * Two trivial spike tools — `whoami` and `health` — that validate
//!     the `#[tool_router]` / `#[tool_handler]` macro chain end-to-end
//!     BEFORE Phase 5 scales (CR-4 known risk: rmcp macro debugging is
//!     opaque; cheaper to discover signature mismatches with 2 tools
//!     than 30).
//!   * `run_mcp_stdio` — the entry point S2's `start_server()`
//!     `tokio::spawn`s after the registry + claim plumbing.
//!
//! ## rmcp 1.5.0 macro API
//!
//! The plan's snippet at lines 2115-2170 was written against an earlier
//! rmcp patch that used `#[tool(tool_box)]` on the impl block. rmcp
//! 1.5.0 split that into two macros (CHANGELOG entry #785):
//!
//!   * `#[tool_router(...)]` on the inherent impl block holding the
//!     tool methods. Generates a `tool_router()` constructor that
//!     returns a `ToolRouter<Self>`. The struct must hold a
//!     `tool_router: ToolRouter<Self>` field that the constructor
//!     populates.
//!   * `#[tool_handler]` on the `impl ServerHandler for Self` block.
//!     Generates the `list_tools` + `call_tool` ServerHandler wiring
//!     against `self.tool_router`. Other ServerHandler methods
//!     (`get_info`, `ping`, etc.) we provide explicitly.
//!
//! Both macros are re-exported at `rmcp::{tool_router, tool_handler, tool}`
//! when the `macros` feature is enabled — which it is on our workspace
//! pin (`features = ["transport-io", "server", "macros", "schemars"]`).
//!
//! ## stdout discipline
//!
//! rmcp speaks JSON-RPC on stdout when run via `rmcp::transport::stdio()`.
//! Any println / print / dbg invocation in this module would be a
//! shipping bug — they all write to stdout (println / print) or stderr
//! with debug formatting (dbg) and corrupt the JSON-RPC framing. CR-4
//! contract C-S4 enforces zero hits via grep. All logging here goes
//! through `tracing::*` which `crate::init_tracing()` configures to
//! write stderr only (C-S11).

use std::path::PathBuf;
use std::sync::Arc;

use rmcp::{
    ServerHandler, ServiceExt,
    handler::server::router::tool::ToolRouter,
    model::{ServerCapabilities, ServerInfo},
    tool, tool_handler, tool_router,
};
use rusqlite::Connection;
use tokio::sync::Mutex;

// NOTE: we deliberately do NOT `use crate::error::Result;` at module scope.
// The `#[tool_handler]` macro expands to ServerHandler method impls whose
// generated bodies reference `Result<T, McpError>` UNQUALIFIED. Bringing
// our 1-arg `Result<T>` alias into scope shadows the std import the macro
// implicitly relies on, producing E0107 / E0271 errors on the macro
// invocation line. The fix is to import `AletheiaError` only and write
// `crate::error::Result<T>` longhand for our own functions; the macro then
// resolves `Result` to `core::result::Result` via the prelude.
use crate::error::AletheiaError;
use crate::settings::Settings;

use super::response_format::XmlElement;

// TODO(tl-auth-integration): swap `Option<()>` → `Option<crate::auth::ClaimedSession>`
//   when TL-auth ships Phase 3 task 4 (claim flow). See decomposition §3.3
//   "Plan B" rationale + §7.1 cross-TL coordination note. The swap is a
//   small mechanical edit:
//     1. Drop the type alias below.
//     2. Replace `Option<ClaimedSessionPlaceholder>` in `AletheiaServer`
//        and `run_mcp_stdio` with `Option<crate::auth::claim::ClaimedSession>`.
//     3. Update the `whoami` tool body to read real fields off
//        `ClaimedSession` (key_hash, primary_scope_id, …) instead of the
//        bool-only placeholder branch.
//   S2's `start_server()` body is the second swap site (already has a
//   matching TODO marker at the `claimed: Option<()> = None` line).
type ClaimedSessionPlaceholder = ();

/// Aletheia V2 MCP server handler. Phase 5 extends the inherent impl
/// block below with the production tool surface; Phase 4 ships only the
/// 2-tool spike (`whoami`, `health`) that validates the macro chain.
///
/// The `tool_router` field is populated by `#[tool_router]`-generated
/// `Self::tool_router()`. Phase 5 sub-tasks add `#[tool]` methods to
/// the inherent impl; the macro re-collects them into the router on
/// every rebuild — no manual registration list to maintain.
#[derive(Clone)]
pub struct AletheiaServer {
    /// Shared registry connection. Phase 5 tools clone the Arc and
    /// `.lock().await` per-call.
    pub conn: Arc<Mutex<Connection>>,
    /// Loaded settings tree. Cheap to clone (Default + small).
    pub settings: Settings,
    /// Claim state for this session. `None` if the auto-reclaim path
    /// found no prior binding (graceful degradation — see plan
    /// "Expected Outcomes" bullet on starting without a session_id).
    pub claimed: Arc<Mutex<Option<ClaimedSessionPlaceholder>>>,
    /// Filesystem root for keys / sockets / scope DBs. Forwarded from
    /// `start_server`'s `data_dir` argument.
    pub data_dir: PathBuf,
    /// Tool router populated by `#[tool_router]`. Phase 5 tools live
    /// in the same impl block; the macro collects all `#[tool]`-marked
    /// methods into this router at compile time.
    tool_router: ToolRouter<Self>,
}

impl std::fmt::Debug for AletheiaServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // `Connection` doesn't implement Debug; we print the data_dir
        // and claim state instead. Useful for `?`-formatted log lines.
        f.debug_struct("AletheiaServer")
            .field("data_dir", &self.data_dir)
            .field("settings_debug", &self.settings.debug)
            .finish_non_exhaustive()
    }
}

#[tool_router]
impl AletheiaServer {
    /// Construct a server with the given dependencies. The tool router
    /// is auto-populated from every `#[tool]`-marked method in this
    /// inherent impl block via the macro-generated `Self::tool_router()`
    /// constructor.
    pub fn new(
        conn: Arc<Mutex<Connection>>,
        settings: Settings,
        claimed: Option<ClaimedSessionPlaceholder>,
        data_dir: PathBuf,
    ) -> Self {
        Self {
            conn,
            settings,
            claimed: Arc::new(Mutex::new(claimed)),
            data_dir,
            tool_router: Self::tool_router(),
        }
    }

    /// Spike tool 1 (C-S2): returns the claim state as a `<whoami/>`
    /// XML element. Parameters: none. With the Plan B placeholder type
    /// `Option<()>` we can only report `claimed=true|false`; once
    /// TL-auth ships `ClaimedSession` the body will surface
    /// `key_hash` + `scope` attributes.
    #[tool(description = "Report the session's claim status.")]
    async fn whoami(&self) -> String {
        let claimed_guard = self.claimed.lock().await;
        let is_claimed = claimed_guard.is_some();
        let element = if is_claimed {
            XmlElement::new("whoami").attr("claimed", "true")
        } else {
            XmlElement::new("whoami").attr("claimed", "false")
        };
        // Logging via tracing::* keeps stdout clean for JSON-RPC (C-S4 + C-S11).
        tracing::debug!(
            target: "server.mcp.whoami",
            claimed = is_claimed,
            "whoami invoked"
        );
        element.to_string()
    }

    /// Spike tool 2 (C-S2): returns the server's health snapshot as a
    /// `<health/>` XML element. Parameters: none. The pid attribute
    /// confirms the per-session-pid socket convention referenced by V1
    /// hooks (preserved into V2 via plan §"Cross-platform IPC").
    #[tool(description = "Server health snapshot.")]
    async fn health(&self) -> String {
        let pid = std::process::id();
        let element = XmlElement::new("health")
            .attr("status", "ok")
            .attr("pid", pid.to_string());
        tracing::debug!(target: "server.mcp.health", pid, "health invoked");
        element.to_string()
    }
}

// `router = self.tool_router` tells the macro to use the per-instance
// `tool_router` field (populated by `Self::new`) instead of the default
// `Self::tool_router()` which would rebuild the router on every call.
// This is also why the field is "read" — silences the dead-code warning
// without `#[allow(dead_code)]`.
#[tool_handler(router = self.tool_router)]
impl ServerHandler for AletheiaServer {
    fn get_info(&self) -> ServerInfo {
        // ServerInfo::new takes capabilities; we enable_tools because we
        // ship a tool router (currently 2 tools; Phase 5 scales to ~30).
        // env!("CARGO_PKG_VERSION") reads from this crate's Cargo.toml
        // at compile time — kept in lockstep with workspace.package.version.
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(rmcp::model::Implementation::new(
                "aletheia-v2",
                env!("CARGO_PKG_VERSION"),
            ))
            .with_instructions("Aletheia V2 — structured memory MCP server")
    }
}

/// Spawn the rmcp stdio server and block until the MCP client
/// disconnects (or the spawning task is aborted by `start_server`'s
/// shutdown path). Called by `crate::server::index::start_server`'s
/// step 5 (`tokio::spawn(...)`).
///
/// Errors are wrapped in `AletheiaError::Other` because rmcp's error
/// types are `non_exhaustive` enums we don't want to leak the variants
/// of through our public error surface. The string payload includes the
/// rmcp error's Display impl for debugging.
pub async fn run_mcp_stdio(
    conn: Arc<Mutex<Connection>>,
    settings: Settings,
    claimed: Option<ClaimedSessionPlaceholder>,
    data_dir: PathBuf,
) -> crate::error::Result<()> {
    // MUST-1 fix (three-review gate, Phase 4): `data_dir` is now threaded
    // from `start_server` (the CLI `--data-dir` flag or its default). The
    // prior implementation re-derived the data directory from the user-home
    // environment variable here, which silently shadowed the CLI override
    // and produced an `AletheiaServer.data_dir` mismatched against the
    // bound socket path. The bug was unobservable in Phase 4 (the 2-tool
    // spike doesn't dereference `self.data_dir`) but mandatory to fix
    // before Phase 5 tools start reading `<data_dir>/keys/`,
    // `<data_dir>/scopes/`, etc.
    let server = AletheiaServer::new(conn, settings, claimed, data_dir);

    tracing::info!(target: "server.mcp", "starting rmcp stdio service");

    // `rmcp::transport::stdio()` returns a `(Stdin, Stdout)` tuple that
    // `serve` accepts as a transport via the `IntoTransport` impl on
    // `(R, W)` tuples. The server runs until stdin EOFs or the client
    // sends a graceful shutdown.
    let service = server
        .serve(rmcp::transport::stdio())
        .await
        .map_err(|e| AletheiaError::Other(format!("MCP serve failed: {e}")))?;

    let quit_reason = service
        .waiting()
        .await
        .map_err(|e| AletheiaError::Other(format!("MCP service halted: {e}")))?;
    tracing::info!(target: "server.mcp", reason = ?quit_reason, "rmcp stdio service exited");

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::Settings;
    use rusqlite::Connection;
    use std::path::PathBuf;
    use std::sync::Arc;
    use tokio::sync::Mutex;

    #[tokio::test]
    async fn aletheia_server_new_preserves_data_dir_argument() {
        // MUST-1 fix verification (three-review gate, Phase 4):
        // AletheiaServer must receive the data_dir passed to it, NOT an
        // env-derived default. This is the unit-test proxy for the
        // integration test PM described in the fixback — we don't have a
        // tool that surfaces data_dir, so we assert at the constructor
        // layer instead. A future refactor that re-introduces the
        // env-derivation in run_mcp_stdio would still leave this test
        // green; the second guard is the grep acceptance step that
        // confirms no env-derivation tokens appear in this module.
        let explicit_data_dir = PathBuf::from("/tmp/a2-data-dir-must1-test");
        let conn = Arc::new(Mutex::new(
            Connection::open_in_memory().expect("in-memory sqlite"),
        ));
        let settings = Settings::default();
        let server = AletheiaServer::new(conn, settings, None, explicit_data_dir.clone());
        assert_eq!(
            server.data_dir, explicit_data_dir,
            "AletheiaServer must use the data_dir parameter as-is, \
             not re-derive from env (MUST-1 fix verification)"
        );
    }
}
