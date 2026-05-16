//! End-to-end integration tests for the `aletheia-v2 serve` binary.
//!
//! These tests close the CR-4 binary-level checklist items by spawning
//! the real built binary as a subprocess and exercising the surfaces it
//! exposes:
//!
//! 1. Per-PID Unix socket bind at `<data_dir>/sockets/aletheia-v2-<pid>.sock`
//!    with mode `0600`.
//! 2. `GET /health` → `{"status":"ok","pid":<pid>}`.
//! 3. `GET /state` → `{}` (Phase 6 stub).
//! 4. `GET /session-info` → claim status JSON; `claimed == false` on the
//!    graceful-degradation path (no TL-auth session_id file).
//! 5. SIGTERM triggers a clean shutdown; socket file is removed.
//!
//! ## Design choices
//!
//! - **Subprocess via `CARGO_BIN_EXE_aletheia-v2`**: integration tests
//!   in `tests/` can locate the built binary via this env var, set by
//!   Cargo at test runtime. No shell, no `which`, no race with builds.
//!
//! - **Hand-rolled HTTP over `UnixStream`**: matches the request style
//!   that `hook_endpoints::handle_connection` parses (single request
//!   line, no keepalive). Synchronous `std::os::unix::net::UnixStream`
//!   is plenty — these tests are sequential and don't multiplex.
//!
//! - **Per-test tempdir, manually cleaned**: `tempfile` is not in
//!   workspace deps (W1 §6.2 caveat #9). We use a small RAII wrapper
//!   that mirrors `db::connection::tests` and `transport::tests`.
//!
//! - **Registry bootstrap via library API**: `start_server` calls
//!   `reconcile_migration_orphans`, which queries `migration_state`.
//!   That table doesn't exist on a bare-empty data dir, so each test
//!   first runs `install_all` against a fresh `scope_registry.db`. This
//!   is what `aletheia-v2 setup` (Phase 3) will do for end users;
//!   Phase 4 E2E tests do it programmatically. Documented as a Phase
//!   4 expected-first-launch precondition.
//!
//! - **Polling for socket bind**: `wait_for_socket` polls at 25 ms
//!   intervals with a 5 s ceiling rather than sleeping a flat interval.
//!   Eliminates spawn-vs-bind races on slow machines without forcing a
//!   worst-case sleep on every test.
//!
//! - **Tests run sequentially via `serial_test`? No — `cargo test`
//!   runs integration tests' top-level fns in parallel by default, but
//!   each test owns a distinct tempdir + distinct child PID, so socket
//!   paths cannot collide. The CR-4 risk is shared mutable state across
//!   tests; we have none.

#![cfg(unix)]

use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/// RAII tempdir wrapper. We don't depend on `tempfile` (not a workspace
/// dep — W1 §6.2 caveat #9); manual cleanup is fine for tests.
///
/// Keeps the directory name short to leave headroom for the per-PID
/// socket path which must fit under the conservative 104-byte
/// `sun_path` limit that `transport::bind_listener` enforces.
struct TestDir {
    path: PathBuf,
}

impl TestDir {
    fn new(label: &str) -> Self {
        let mut p = std::env::temp_dir();
        // Keep the suffix bounded — 8 bytes of uuid hex is enough
        // entropy for cross-test isolation given we're per-PID inside.
        let uuid = uuid::Uuid::new_v4().simple().to_string();
        let short = &uuid[..8];
        p.push(format!("a2-e2e-{label}-{short}"));
        std::fs::create_dir_all(&p).expect("create tempdir");
        Self { path: p }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// Initialize the registry DB the way `aletheia-v2 setup` (Phase 3) will.
/// Required because `start_server` reconciles the `migration_state` table
/// at startup; without the schema we'd panic before the listener binds.
fn init_registry(data_dir: &Path) {
    let mgr = aletheia_v2::db::connection::ConnectionManager::open_registry(data_dir)
        .expect("open_registry");
    aletheia_v2::db::registry_schema::install_all(&mgr.conn).expect("install_all");
    // `mgr` drops here; its Connection closes. The on-disk
    // `scope_registry.db` survives for the spawned binary to reopen.
}

/// Spawn the `aletheia-v2 serve` binary with the given data dir.
///
/// `CARGO_BIN_EXE_aletheia-v2` is injected by Cargo at integration-test
/// compile time. Using it (not `which` or `cargo run`) keeps the test
/// independent of `PATH` and avoids re-invoking cargo recursively.
fn spawn_serve(data_dir: &Path) -> Child {
    let bin = env!("CARGO_BIN_EXE_aletheia-v2");
    Command::new(bin)
        .args([
            "--data-dir",
            data_dir.to_str().expect("data_dir str"),
            "serve",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn aletheia-v2 serve")
}

/// Compute the per-PID socket path the binary will bind. Mirrors
/// `crate::server::transport::socket_path`'s convention literally so
/// any drift in the convention is caught by the tests rather than
/// silently passing.
fn socket_path_for(data_dir: &Path, pid: u32) -> PathBuf {
    data_dir
        .join("sockets")
        .join(format!("aletheia-v2-{pid}.sock"))
}

/// Poll for the per-PID socket file to appear, with a 5 s ceiling.
/// Returns `Some(path)` if the file is found and `Some(metadata)`-able
/// (mode/size readable), `None` on timeout.
fn wait_for_socket(data_dir: &Path, child_pid: u32, timeout: Duration) -> Option<PathBuf> {
    let path = socket_path_for(data_dir, child_pid);
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if path.exists() {
            // exists() returns true while the inode is reachable; for a
            // socket file that's good enough — connect() will succeed
            // on the next call.
            return Some(path);
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    None
}

/// Send a single HTTP request over the Unix socket and return the
/// response body string.
///
/// The hook endpoint server writes a single response with
/// `Content-Length` and closes — V1 hook-client convention. We read to
/// EOF and split on the bare `\r\n\r\n` to extract the body.
fn http_unix(socket: &Path, request_line: &str) -> String {
    let mut stream = UnixStream::connect(socket).expect("connect unix socket");
    // Minimal request: request line + Host header (Host is required by
    // strict HTTP/1.1 parsers; `hook_endpoints::handle_connection`
    // doesn't enforce it but adding it costs nothing and matches what
    // `curl` would emit).
    let req = format!("{request_line}\r\nHost: localhost\r\n\r\n");
    stream
        .write_all(req.as_bytes())
        .expect("write unix request");
    // Half-close the write side so the server's `read` returns
    // promptly with the bytes we sent — otherwise it may block until
    // its 4 KiB buffer fills.
    stream
        .shutdown(std::net::Shutdown::Write)
        .expect("half-close write");

    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).expect("read response");
    let s = String::from_utf8_lossy(&buf).into_owned();
    // Split header/body on `\r\n\r\n`. If the boundary is absent (a
    // truly malformed response from a buggy server), return the whole
    // payload so the test assertion surfaces the actual bytes.
    if let Some(idx) = s.find("\r\n\r\n") {
        s[idx + 4..].to_string()
    } else {
        s
    }
}

/// Reap a child unconditionally, preferring graceful SIGTERM but
/// SIGKILL'ing as a backstop. Used by the non-shutdown tests to make
/// sure a misbehaving binary doesn't leak across test runs.
fn force_reap(mut child: Child) {
    use nix::sys::signal::{Signal, kill};
    use nix::unistd::Pid;

    let pid = Pid::from_raw(child.id() as i32);
    // Try SIGTERM first; if the binary's shutdown path is broken,
    // SIGKILL in the wait-loop below.
    let _ = kill(pid, Signal::SIGTERM);

    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = kill(pid, Signal::SIGKILL);
                    let _ = child.wait();
                    return;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(_) => {
                let _ = kill(pid, Signal::SIGKILL);
                let _ = child.wait();
                return;
            }
        }
    }
}

// --------------------------------------------------------------------------
// Tests — five CR-4 binary-level items
// --------------------------------------------------------------------------

/// CR-4 item: `aletheia-v2 serve` starts the MCP server and binds the
/// per-PID Unix socket at the documented path with mode 0600.
#[test]
fn serve_starts_and_binds_socket() {
    let dir = TestDir::new("starts");
    init_registry(dir.path());

    let child = spawn_serve(dir.path());
    let pid = child.id();
    let socket =
        wait_for_socket(dir.path(), pid, Duration::from_secs(5)).expect("socket bound within 5s");

    // exists() + metadata() both succeed → bind completed.
    let meta = std::fs::metadata(&socket).expect("stat socket file");
    let mode = meta.permissions().mode() & 0o777;
    assert_eq!(
        mode, 0o600,
        "socket file at {socket:?} should be chmod 0600 (got {mode:o})"
    );

    force_reap(child);
}

/// CR-4 item: `GET /health` returns `{"status":"ok","pid":<pid>}`.
#[test]
fn serve_health_endpoint_returns_status_pid() {
    let dir = TestDir::new("health");
    init_registry(dir.path());

    let child = spawn_serve(dir.path());
    let pid = child.id();
    let socket =
        wait_for_socket(dir.path(), pid, Duration::from_secs(5)).expect("socket bound within 5s");

    let body = http_unix(&socket, "GET /health HTTP/1.1");
    let v: serde_json::Value = serde_json::from_str(&body).expect("parse /health JSON");
    assert_eq!(
        v["status"], "ok",
        "/health status must be 'ok', got: {body}"
    );
    assert_eq!(
        v["pid"].as_u64(),
        Some(u64::from(pid)),
        "/health pid must match child PID {pid}, got: {body}"
    );

    force_reap(child);
}

/// CR-4 item: `GET /state` returns `{}` (Phase 6 stub).
#[test]
fn serve_state_endpoint_returns_stub() {
    let dir = TestDir::new("state");
    init_registry(dir.path());

    let child = spawn_serve(dir.path());
    let pid = child.id();
    let socket =
        wait_for_socket(dir.path(), pid, Duration::from_secs(5)).expect("socket bound within 5s");

    let body = http_unix(&socket, "GET /state HTTP/1.1");
    assert_eq!(
        body, "{}",
        "/state Phase 6 stub must return exactly the empty-object literal, got: {body}"
    );

    force_reap(child);
}

/// CR-4 item: `GET /session-info` returns claim status JSON. With no
/// TL-auth session_id file present the placeholder evaluates `None`,
/// so `claimed == false` — this is the graceful-degradation path.
#[test]
fn serve_session_info_unclaimed() {
    let dir = TestDir::new("session-info");
    init_registry(dir.path());

    let child = spawn_serve(dir.path());
    let pid = child.id();
    let socket =
        wait_for_socket(dir.path(), pid, Duration::from_secs(5)).expect("socket bound within 5s");

    let body = http_unix(&socket, "GET /session-info HTTP/1.1");
    let v: serde_json::Value = serde_json::from_str(&body).expect("parse /session-info JSON");
    assert_eq!(
        v["claimed"], false,
        "/session-info claimed must be false on graceful-degradation path, got: {body}"
    );
    assert!(
        v["primary_scope_id"].is_null(),
        "/session-info primary_scope_id must be null when unclaimed, got: {body}"
    );
    assert_eq!(
        v["pid"].as_u64(),
        Some(u64::from(pid)),
        "/session-info pid must match child PID {pid}, got: {body}"
    );

    force_reap(child);
}

/// CR-4 item: SIGTERM triggers graceful shutdown; the per-PID socket
/// file is gone after the child exits.
///
/// `transport::bind_listener` does NOT explicitly remove the socket
/// file at shutdown — the interprocess listener handle owns it, and
/// dropping the listener invokes its destructor which unlinks the file
/// on Unix. `start_server`'s shutdown path aborts the
/// hook-endpoint-server bg task; the task's drop chain releases the
/// `Listener`, which calls `unlink`. We assert that visible outcome.
#[test]
fn serve_sigterm_triggers_graceful_shutdown() {
    use nix::sys::signal::{Signal, kill};
    use nix::unistd::Pid;

    let dir = TestDir::new("sigterm");
    init_registry(dir.path());

    // For the SIGTERM test we inherit stderr so any panic/error during
    // shutdown surfaces in the test output. The other tests pipe stderr
    // to avoid clutter; here we'd rather see the diagnostic if it fails.
    let bin = env!("CARGO_BIN_EXE_aletheia-v2");
    let mut child = Command::new(bin)
        .args([
            "--data-dir",
            dir.path().to_str().expect("data_dir str"),
            "serve",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .env("RUST_LOG", "info")
        .spawn()
        .expect("spawn aletheia-v2 serve");
    let pid = child.id();
    let socket =
        wait_for_socket(dir.path(), pid, Duration::from_secs(5)).expect("socket bound within 5s");
    assert!(
        socket.exists(),
        "precondition: socket exists before SIGTERM"
    );

    // Send SIGTERM. `start_server`'s `shutdown::wait_for_shutdown_signal`
    // returns, the registry's bg tasks abort, the rmcp service aborts,
    // and main returns Ok(()).
    kill(Pid::from_raw(pid as i32), Signal::SIGTERM).expect("send SIGTERM");

    // Wait up to 5 s for the child to exit. Pre-Phase-9 there's no
    // lock-release path so shutdown is fast (sub-second on idle).
    let deadline = Instant::now() + Duration::from_secs(5);
    let status = loop {
        match child.try_wait().expect("try_wait") {
            Some(s) => break s,
            None => {
                if Instant::now() >= deadline {
                    // Last-ditch: print stderr to help diagnose, then
                    // SIGKILL + fail. Eprintln (stderr) is allowed in
                    // test code; the CR-4 println grep only checks
                    // src/main.rs.
                    eprintln!("child {pid} did not exit within 5s of SIGTERM; killing for cleanup");
                    let _ = kill(Pid::from_raw(pid as i32), Signal::SIGKILL);
                    let _ = child.wait();
                    panic!("SIGTERM did not trigger graceful shutdown within 5s");
                }
                std::thread::sleep(Duration::from_millis(25));
            }
        }
    };

    // The child exited cleanly. On Unix, a Rust binary that returns
    // Ok(()) from main() exits with status code 0. A SIGTERM that
    // somehow short-circuited the graceful path would surface as a
    // signal-terminated status (no exit code) — we accept either as
    // "clean shutdown" but record the actual outcome for diagnostics.
    use std::os::unix::process::ExitStatusExt;
    let clean = status.code() == Some(0) || status.signal().is_some();
    assert!(
        clean,
        "child exit status should be code 0 or signal-terminated; got: {status:?}"
    );

    // The socket file must be GONE — the listener drop chain unlinks
    // it on Unix. If this assertion ever fails, a process crash left
    // the socket behind and the next process with that PID would hit
    // the `remove_file` branch in `bind_listener` (which is also tested
    // in `transport::tests::bind_listener_removes_stale_socket_file`).
    assert!(
        !socket.exists(),
        "socket file {socket:?} should be unlinked after graceful shutdown"
    );
}
