//! Phase 4 S1 contract C-S2: 2-tool spike — end-to-end validation that
//! the rmcp 1.5.0 `#[tool_router]` + `#[tool_handler]` macro chain
//! actually serves `tools/list` and `tools/call` for our spike tools
//! BEFORE Phase 5 scales to ~30 tools.
//!
//! ## Approach: in-memory rmcp transport via `tokio::io::duplex`
//!
//! The brief offered two paths:
//!   (a) in-memory transport — drive the server from within the same
//!       process via rmcp's own client API.
//!   (b) subprocess — spawn `aletheia-v2 serve` as a child process,
//!       drive it via a TypeScript MCP client OR rmcp's client.
//!
//! We chose **(a)** because:
//!   * rmcp 1.5.0's `serve` accepts any `IntoTransport`, which is
//!     implemented for `(Reader, Writer)` tuples. Two
//!     `tokio::io::duplex(4096)` channels — one client→server,
//!     one server→client — give us a full-duplex byte stream with no
//!     OS-level processes, no socket files, no port conflicts.
//!   * The plan's `aletheia-v2 serve` binary is not wired yet
//!     (`main.rs` is `unimplemented!("Phase 4")`); subprocess paths
//!     would require finishing that wiring first.
//!   * In-process testing is faster, more deterministic, and surfaces
//!     macro-expansion bugs immediately at test compile time — exactly
//!     the value the brief asks the spike to deliver.
//!
//! The `client` feature on rmcp is enabled only for the test profile
//! (see `crates/aletheia-v2/Cargo.toml` `[dev-dependencies]`); the
//! production binary still ships with `["transport-io", "server",
//! "macros", "schemars"]` per C-S1.

use std::sync::Arc;

use aletheia_v2::server::mcp::AletheiaServer;
use aletheia_v2::settings::Settings;
use rmcp::ServiceExt;
use rmcp::model::CallToolRequestParams;
use rusqlite::Connection;
use tokio::sync::Mutex;

/// Minimal stub client handler — we drive the server through the
/// returned client service handle's `peer()`, so the handler itself
/// doesn't need to do anything.
#[derive(Clone, Default)]
struct StubClient;

impl rmcp::ClientHandler for StubClient {
    fn get_info(&self) -> rmcp::model::ClientInfo {
        rmcp::model::ClientInfo::default()
    }
}

/// Build a stripped-down `AletheiaServer` suitable for the spike.
/// We do NOT install schema or populate any registry rows — the spike
/// tools (`whoami`, `health`) do not touch the DB, and Phase 5 will
/// have its own per-tool fixture pattern.
fn make_test_server() -> AletheiaServer {
    let conn = Connection::open_in_memory().expect("open in-memory sqlite");
    let conn = Arc::new(Mutex::new(conn));
    let settings = Settings::default();
    let data_dir = std::env::temp_dir().join(format!("aletheia-v2-spike-{}", uuid::Uuid::new_v4()));
    AletheiaServer::new(conn, settings, None, data_dir)
}

/// End-to-end spike: handshake → tools/list (asserts 2 tools) →
/// tools/call whoami → tools/call health.
///
/// Each tools/call response's content is asserted against the XmlElement
/// shape the spike tools emit. The pid attribute on `<health/>` is
/// asserted to match `std::process::id()` (we're in-process — the
/// server tool's `std::process::id()` is the test process's pid).
#[tokio::test]
async fn two_tool_spike_end_to_end() {
    // Two duplex channels = one full-duplex byte stream. Each duplex
    // returns a pair (a, b) where bytes written to `a` are readable on
    // `b` and vice-versa. We connect them up so the server's read side
    // hears the client's writes, and the server's writes flow back to
    // the client's read side.
    let (server_read, client_write) = tokio::io::duplex(4096);
    let (client_read, server_write) = tokio::io::duplex(4096);

    let server = make_test_server();

    // Spawn the server side. `serve` consumes the transport and runs
    // until the client side disconnects (or we drop the running service).
    let server_handle = tokio::spawn(async move {
        let running = server
            .serve((server_read, server_write))
            .await
            .expect("server serve");
        // `waiting()` blocks until the client closes the transport,
        // which `client.cancel()` triggers at the end of this test.
        let _quit_reason = running.waiting().await.expect("server waiting");
    });

    // Stand up the client side. `serve` performs the MCP `initialize`
    // handshake under the hood — by the time it returns, the server has
    // accepted `initialize` and we've sent `notifications/initialized`.
    let client = StubClient
        .serve((client_read, client_write))
        .await
        .expect("client serve");

    // tools/list — expect exactly 2 tools (whoami + health).
    let tools_result = client.list_all_tools().await.expect("list_all_tools");
    assert_eq!(
        tools_result.len(),
        2,
        "expected exactly 2 spike tools registered, got: {:?}",
        tools_result
            .iter()
            .map(|t| t.name.as_ref())
            .collect::<Vec<_>>()
    );
    let names: Vec<&str> = tools_result.iter().map(|t| t.name.as_ref()).collect();
    assert!(names.contains(&"whoami"), "missing whoami: {names:?}");
    assert!(names.contains(&"health"), "missing health: {names:?}");

    // tools/call whoami — expect `<whoami claimed="false"/>` (no
    // ClaimedSession plumbed through the test).
    let whoami_result = client
        .peer()
        .call_tool(CallToolRequestParams::new("whoami"))
        .await
        .expect("whoami call");
    let whoami_text = whoami_result
        .content
        .first()
        .and_then(|c| c.raw.as_text())
        .map(|t| t.text.as_str())
        .expect("whoami response had text content");
    assert_eq!(
        whoami_text, r#"<whoami claimed="false"/>"#,
        "whoami response shape mismatch"
    );

    // tools/call health — expect `<health pid="N" status="ok"/>` where
    // N == this process's pid (we're in-process).
    let health_result = client
        .peer()
        .call_tool(CallToolRequestParams::new("health"))
        .await
        .expect("health call");
    let health_text = health_result
        .content
        .first()
        .and_then(|c| c.raw.as_text())
        .map(|t| t.text.as_str())
        .expect("health response had text content");
    let expected = format!(r#"<health pid="{}" status="ok"/>"#, std::process::id());
    assert_eq!(health_text, expected, "health response shape mismatch");

    // Gracefully shut down both sides.
    client.cancel().await.expect("client cancel");
    server_handle.await.expect("server task joined cleanly");
}

/// Sanity check: `tools/list` returns the two tools' attributes in
/// alphabetical order (rmcp's `ToolRouter::list_all` documents this in
/// `test_tool_router_list_all_is_sorted`). If a later change accidentally
/// duplicates or renames either tool, this assertion drops the count
/// mismatch out fast.
#[tokio::test]
async fn two_tool_spike_list_alphabetical() {
    let (server_read, client_write) = tokio::io::duplex(4096);
    let (client_read, server_write) = tokio::io::duplex(4096);

    let server = make_test_server();
    let server_handle = tokio::spawn(async move {
        let running = server
            .serve((server_read, server_write))
            .await
            .expect("server serve");
        let _ = running.waiting().await;
    });
    let client = StubClient
        .serve((client_read, client_write))
        .await
        .expect("client serve");

    let tools = client.list_all_tools().await.expect("list_all_tools");
    let names: Vec<&str> = tools.iter().map(|t| t.name.as_ref()).collect();
    // Alphabetical: health < whoami.
    assert_eq!(
        names,
        vec!["health", "whoami"],
        "rmcp ToolRouter::list_all must yield alphabetical order"
    );

    client.cancel().await.expect("client cancel");
    server_handle.await.expect("server task joined");
}
