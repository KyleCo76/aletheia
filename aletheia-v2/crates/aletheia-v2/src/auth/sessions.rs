//! Aletheia V2 — Session bindings + session-id discovery (Phase 3 W2).
//!
//! This module owns the `session_bindings` registry table (CRUD + sweep) and
//! the filesystem-level handshake that lets the MCP server auto-reclaim a
//! prior session_id on startup. The `session_locks` table is W3's domain;
//! nothing here touches it.
//!
//! Module surface (plan lines 1527-1580 + 1846-1888):
//! - synchronous DB ops: `bind`, `lookup`, `touch_last_seen`, `sweep_orphans`
//! - async filesystem discovery: `discover_session_id_via_ppid`
//! - filesystem sweep helpers: `sweep_session_id_orphans`, `pid_alive`
//!
//! Per C13 (Phase 2 substrate caveat #3 — PRAGMAs are per-connection), this
//! module NEVER opens its own `rusqlite::Connection` outside `#[cfg(test)]`
//! fixtures. Callers (Phase 4 TL-server's long-lived registry connection)
//! provide an `&Connection`.

use rusqlite::{Connection, OptionalExtension};
use std::path::Path;

use crate::error::{AletheiaError, Result};
use crate::types::key::KeyHash;
use crate::types::scope::ScopeId;

// ---------------------------------------------------------------------------
// session_bindings CRUD (plan lines 1527-1580)
// ---------------------------------------------------------------------------

/// Insert or update a session_bindings row keyed by `session_id`.
///
/// Uses SQLite UPSERT (`ON CONFLICT ... DO UPDATE`) rather than `INSERT OR REPLACE`:
/// REPLACE delete-then-inserts the parent row, which cascade-deletes any live
/// `session_locks` row (FK `ON DELETE CASCADE` per W1 §2.2.4). That would render
/// the FATAL conflict gate in `locks::acquire` unreachable — plan-bug-6 per
/// `.tl-handoff/2026-05-11-tl-auth-decomposition.md` §9. UPSERT updates the row
/// in place, preserving lock children for legitimate conflict detection.
///
/// `claim::claim()` also pre-peeks `session_locks` before calling `bind`
/// (belt-and-suspenders defense-in-depth — that peek catches the conflict one
/// round-trip earlier).
pub fn bind(
    conn: &Connection,
    session_id: &str,
    key_hash: &KeyHash,
    primary_scope_id: &ScopeId,
) -> Result<()> {
    conn.execute(
        "INSERT INTO session_bindings (session_id, key_hash, primary_scope_id, last_seen_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(session_id) DO UPDATE SET
             key_hash = excluded.key_hash,
             primary_scope_id = excluded.primary_scope_id,
             last_seen_at = CURRENT_TIMESTAMP",
        rusqlite::params![session_id, key_hash.0, primary_scope_id.as_str()],
    )?;
    Ok(())
}

/// A row read from `session_bindings`. The three fields here are the trio
/// Phase 4 needs at auto-reclaim time (session_id from PPID file → key_hash
/// to verify the key on disk → primary_scope_id to seed the connection).
#[derive(Debug)]
pub struct SessionBinding {
    pub session_id: String,
    pub key_hash: KeyHash,
    pub primary_scope_id: ScopeId,
}

/// Look up the binding for `session_id`. Returns `Ok(None)` if no row
/// matches; returns `Err` only on SQL errors or on a malformed
/// `primary_scope_id` value (C6 defense-in-depth: every ScopeId from the DB
/// is re-validated via `ScopeId::new`).
pub fn lookup(conn: &Connection, session_id: &str) -> Result<Option<SessionBinding>> {
    let row: Option<(String, String, String)> = conn
        .query_row(
            "SELECT session_id, key_hash, primary_scope_id FROM session_bindings WHERE session_id = ?",
            rusqlite::params![session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;

    match row {
        None => Ok(None),
        Some((sid, kh, scope_str)) => {
            // C6: defense-in-depth — re-validate scope_id read from DB before
            // exposing it as a `ScopeId`. The registry was validated on
            // insert, but `lookup` is the only path that hands a `ScopeId`
            // back out to Phase 4 callers; cheap to revalidate.
            let scope = ScopeId::new(scope_str.clone()).map_err(|_| {
                AletheiaError::Scope(format!(
                    "session_bindings row contains invalid primary_scope_id {scope_str:?}"
                ))
            })?;
            Ok(Some(SessionBinding {
                session_id: sid,
                key_hash: KeyHash(kh),
                primary_scope_id: scope,
            }))
        }
    }
}

/// Touch `last_seen_at` for `session_id`. No-op (zero rows affected) if the
/// session isn't bound. Phase 4 calls this on every MCP tool invocation to
/// keep active sessions out of the GC sweep window.
pub fn touch_last_seen(conn: &Connection, session_id: &str) -> Result<()> {
    conn.execute(
        "UPDATE session_bindings SET last_seen_at = CURRENT_TIMESTAMP WHERE session_id = ?",
        rusqlite::params![session_id],
    )?;
    Ok(())
}

/// Background sweep: delete bindings whose `last_seen_at` is older than
/// `gc_after_days` days ago. Returns the number of rows removed.
///
/// SQLite's `datetime('now', '-N days')` is the canonical relative-time
/// expression; we bind `-N days` as a parameter to avoid SQL interpolation.
pub fn sweep_orphans(conn: &Connection, gc_after_days: u32) -> Result<usize> {
    let rows = conn.execute(
        "DELETE FROM session_bindings WHERE last_seen_at < datetime('now', ?)",
        rusqlite::params![format!("-{} days", gc_after_days)],
    )?;
    Ok(rows)
}

// ---------------------------------------------------------------------------
// Filesystem-level discovery + sweep (plan lines 1846-1888)
// ---------------------------------------------------------------------------

/// Return the parent process's PID, or `-1` on platforms where we don't
/// implement PPID lookup (Windows; tracked as a Phase 10 follow-up).
///
/// Extracted as a private helper so tests can write the discovery file at the
/// real PPID the test process sees without needing to spawn a subprocess.
/// This is Option A from the W2 brief's testability note.
fn get_ppid() -> i32 {
    #[cfg(unix)]
    {
        nix::unistd::getppid().as_raw()
    }
    #[cfg(windows)]
    {
        -1
    }
}

/// Discover the parent CC session's `session_id` by polling for a file at
/// `<data_dir>/sessions/<ppid>.session_id`. Polls at 100ms intervals up to
/// `max_wait_ms`. Returns `Some(content.trim())` on first read, `None` on
/// timeout.
///
/// Consumed by Phase 4 (TL-server) at startup: the SessionStart hook writes
/// `<my_pid>.session_id` containing the CC `session_id` UUID; the MCP server
/// (whose PPID is the CC process) reads it back. See plan lines 1846-1859.
///
/// On Windows: PPID lookup isn't implemented yet. Returns `None`
/// immediately after emitting a `tracing::warn!`. Auto-reclaim is therefore
/// disabled on Windows until Phase 10 wires `GetCurrentProcessId` +
/// `Process32First`/`Next` (or `windows-sys`'s `NtQueryInformationProcess`).
pub async fn discover_session_id_via_ppid(data_dir: &Path, max_wait_ms: u64) -> Option<String> {
    #[cfg(windows)]
    {
        tracing::warn!(
            "discover_session_id_via_ppid not yet implemented on Windows; \
             auto-reclaim disabled — Phase 10 follow-up"
        );
        let _ = (data_dir, max_wait_ms);
        return None;
    }

    #[cfg(unix)]
    {
        let ppid = get_ppid();
        let path = data_dir
            .join("sessions")
            .join(format!("{}.session_id", ppid));
        let start = std::time::Instant::now();
        loop {
            if let Ok(content) = std::fs::read_to_string(&path) {
                return Some(content.trim().to_string());
            }
            if start.elapsed().as_millis() as u64 >= max_wait_ms {
                return None;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }
}

/// Background sweep: prune `<data_dir>/sessions/<pid>.session_id` files
/// whose `<pid>` is no longer a live process. Returns the number of files
/// removed.
///
/// Files whose names don't match the `<integer>.session_id` shape are
/// silently skipped (defensive — other files may legitimately appear in the
/// sessions directory during future phase wiring).
pub fn sweep_session_id_orphans(data_dir: &Path) -> Result<usize> {
    let dir = data_dir.join("sessions");
    if !dir.exists() {
        return Ok(0);
    }
    let mut removed = 0usize;
    let mut failures: Vec<(std::path::PathBuf, std::io::Error)> = Vec::new();

    for entry in std::fs::read_dir(&dir)? {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                tracing::warn!(error = ?e, "read_dir entry failed; continuing sweep");
                continue;
            }
        };
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if let Some(pid_str) = name_str.strip_suffix(".session_id")
            && let Ok(pid) = pid_str.parse::<i32>()
            && !pid_alive(pid)
        {
            let path = entry.path();
            match std::fs::remove_file(&path) {
                Ok(()) => {
                    removed += 1;
                }
                Err(e) => {
                    tracing::warn!(error = ?e, path = ?path, "sweep remove_file failed");
                    failures.push((path, e));
                }
            }
        }
    }

    if !failures.is_empty() {
        // SHOULD-3 visible-failure: aggregate + surface as Other error after best-effort
        // cleanup. Previously a single remove_file failure aborted mid-loop and left
        // remaining orphans on disk. Now we keep going and only surface at the end.
        let summary: Vec<String> = failures
            .iter()
            .map(|(p, e)| format!("{p:?}: {e}"))
            .collect();
        return Err(AletheiaError::Other(format!(
            "sweep_session_id_orphans removed {removed} files but {} failed: {}",
            failures.len(),
            summary.join("; ")
        )));
    }

    Ok(removed)
}

/// Check whether a PID corresponds to a live process.
///
/// On Unix: sends signal 0 to the PID. `kill(pid, 0)` performs the standard
/// permission + existence check without delivering a signal.
///
/// On Windows: stubbed to return `true` with a `tracing::warn!` on first
/// call. Tracked as a Phase 10 follow-up (will use `OpenProcess` +
/// `GetExitCodeProcess` returning `STILL_ACTIVE`).
#[cfg(unix)]
pub fn pid_alive(pid: i32) -> bool {
    nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_ok()
}

#[cfg(windows)]
pub fn pid_alive(_pid: i32) -> bool {
    tracing::warn!("pid_alive stubbed on Windows; returns true — Phase 10 follow-up");
    true
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{pragmas, registry_schema};
    use rusqlite::Connection;

    /// Open a fresh registry-shaped tempfile DB with pragmas + DDL applied.
    /// Returns (conn, path-on-disk) so the caller controls cleanup.
    fn fresh_registry() -> (Connection, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!("aletheia-w2-{}.db", uuid::Uuid::new_v4()));
        let conn = Connection::open(&path).expect("open tempfile registry");
        pragmas::apply(&conn).expect("apply pragmas");
        registry_schema::install_all(&conn).expect("install registry schema");
        (conn, path)
    }

    /// Insert a scope row so that session_bindings FK to scopes is satisfied.
    fn insert_scope(conn: &Connection, scope_id: &ScopeId, name: &str) {
        conn.execute(
            "INSERT INTO scopes (scope_id, name) VALUES (?, ?)",
            rusqlite::params![scope_id.as_str(), name],
        )
        .expect("insert scope");
    }

    #[test]
    fn bind_then_lookup_round_trip() {
        let (conn, path) = fresh_registry();
        let scope = ScopeId::new("test-scope").unwrap();
        insert_scope(&conn, &scope, "test-scope");

        let key_hash =
            KeyHash("fakehash000000000000000000000000000000000000000000000000000000ff".to_string());
        bind(&conn, "sess-1", &key_hash, &scope).expect("bind");

        let got = lookup(&conn, "sess-1").expect("lookup ok").expect("some");
        assert_eq!(got.session_id, "sess-1");
        assert_eq!(got.key_hash, key_hash);
        assert_eq!(got.primary_scope_id.as_str(), "test-scope");

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn touch_last_seen_updates_timestamp() {
        let (conn, path) = fresh_registry();
        let scope = ScopeId::new("touch-scope").unwrap();
        insert_scope(&conn, &scope, "touch-scope");
        let kh = KeyHash("a".repeat(64));
        bind(&conn, "sess-touch", &kh, &scope).expect("bind");

        let initial: String = conn
            .query_row(
                "SELECT last_seen_at FROM session_bindings WHERE session_id = ?",
                rusqlite::params!["sess-touch"],
                |row| row.get(0),
            )
            .expect("read initial");

        // SQLite CURRENT_TIMESTAMP has 1-second granularity; sleep > 1s so
        // the second-resolution timestamp is guaranteed to differ.
        std::thread::sleep(std::time::Duration::from_millis(1100));

        touch_last_seen(&conn, "sess-touch").expect("touch");

        let after: String = conn
            .query_row(
                "SELECT last_seen_at FROM session_bindings WHERE session_id = ?",
                rusqlite::params!["sess-touch"],
                |row| row.get(0),
            )
            .expect("read after");

        assert!(
            after > initial,
            "expected last_seen_at to advance: initial={initial:?}, after={after:?}"
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn sweep_orphans_removes_expired() {
        let (conn, path) = fresh_registry();
        let scope = ScopeId::new("sweep-scope").unwrap();
        insert_scope(&conn, &scope, "sweep-scope");
        let kh = KeyHash("b".repeat(64));
        bind(&conn, "fresh-1", &kh, &scope).unwrap();
        bind(&conn, "fresh-2", &kh, &scope).unwrap();
        bind(&conn, "stale", &kh, &scope).unwrap();

        // Backdate one row to 31 days ago.
        conn.execute(
            "UPDATE session_bindings SET last_seen_at = datetime('now', '-31 days') WHERE session_id = ?",
            rusqlite::params!["stale"],
        )
        .unwrap();

        let removed = sweep_orphans(&conn, 30).expect("sweep");
        assert_eq!(removed, 1, "expected exactly the backdated row to be GC'd");

        // Verify fresh rows still present.
        assert!(lookup(&conn, "fresh-1").unwrap().is_some());
        assert!(lookup(&conn, "fresh-2").unwrap().is_some());
        assert!(lookup(&conn, "stale").unwrap().is_none());

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn sweep_orphans_keeps_fresh() {
        let (conn, path) = fresh_registry();
        let scope = ScopeId::new("keep-scope").unwrap();
        insert_scope(&conn, &scope, "keep-scope");
        let kh = KeyHash("c".repeat(64));
        bind(&conn, "alive", &kh, &scope).unwrap();

        let removed = sweep_orphans(&conn, 30).expect("sweep");
        assert_eq!(removed, 0, "fresh row must not be swept");
        assert!(lookup(&conn, "alive").unwrap().is_some());

        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn discover_session_id_via_ppid_returns_some_when_file_exists() {
        // Option A: write the file at the real PPID the test process sees.
        let data_dir = std::env::temp_dir().join(format!(
            "aletheia-w2-discover-some-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let sessions_dir = data_dir.join("sessions");
        std::fs::create_dir_all(&sessions_dir).expect("mkdir sessions");

        let ppid = get_ppid();
        let path = sessions_dir.join(format!("{}.session_id", ppid));
        std::fs::write(&path, "abc123\n").expect("write session_id");

        let got = discover_session_id_via_ppid(&data_dir, 200).await;

        // Cleanup before assertions so a failure doesn't leak.
        let _ = std::fs::remove_dir_all(&data_dir);

        assert_eq!(got, Some("abc123".to_string()));
    }

    #[tokio::test]
    async fn discover_session_id_via_ppid_returns_none_after_timeout() {
        let data_dir = std::env::temp_dir().join(format!(
            "aletheia-w2-discover-none-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        // Intentionally do NOT create the sessions dir or write any file.

        let got = discover_session_id_via_ppid(&data_dir, 100).await;

        let _ = std::fs::remove_dir_all(&data_dir);

        assert_eq!(got, None);
    }

    #[test]
    fn sweep_session_id_orphans_removes_dead_pids() {
        let data_dir = std::env::temp_dir().join(format!(
            "aletheia-w2-orphans-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let sessions_dir = data_dir.join("sessions");
        std::fs::create_dir_all(&sessions_dir).expect("mkdir sessions");

        let alive_pid = std::process::id() as i32;
        // Choose a high PID that is exceedingly unlikely to be alive on a
        // 32-bit-signed PID kernel. If by cosmic chance it IS alive, bail
        // (visible failure) so the test author can pick a different sentinel.
        let dead_pid: i32 = 2_147_483_640;
        assert!(
            !pid_alive(dead_pid),
            "test precondition: pid {dead_pid} must NOT be alive on this host"
        );

        let alive_path = sessions_dir.join(format!("{}.session_id", alive_pid));
        let dead_path = sessions_dir.join(format!("{}.session_id", dead_pid));
        std::fs::write(&alive_path, "alive-session\n").expect("write alive");
        std::fs::write(&dead_path, "dead-session\n").expect("write dead");

        let removed = sweep_session_id_orphans(&data_dir).expect("sweep");

        let alive_still = alive_path.exists();
        let dead_still = dead_path.exists();
        let _ = std::fs::remove_dir_all(&data_dir);

        assert_eq!(
            removed, 1,
            "expected exactly the dead-pid file to be removed"
        );
        assert!(alive_still, "alive-pid file must be preserved");
        assert!(!dead_still, "dead-pid file must be removed");
    }

    /// Cross-process test: exercises the hook→server PPID handoff that the
    /// existing same-process test conflated. Spawns the actual hook script as a
    /// child process; the child's PPID is this test process; the hook should
    /// write at <test_pid>.session_id (the parent's PID).
    ///
    /// This is the MUST-1 regression-guard per
    /// `.pm-handoff/2026-05-11-phase-3-three-review-fixback.md`.
    #[cfg(unix)]
    #[test]
    fn hook_script_writes_at_ppid_not_own_pid_unix() {
        use std::io::Write;
        use std::process::{Command, Stdio};

        let temp_root = std::env::temp_dir().join(format!(
            "aletheia-fixback-hookppid-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&temp_root).unwrap();
        let _cleanup = scopeguard_like(|| {
            let _ = std::fs::remove_dir_all(&temp_root);
        });

        let test_pid = std::process::id();
        let session_id = "cross-process-test-uuid-abc-123";
        let hook_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap() // crates/aletheia-v2 → crates
            .parent()
            .unwrap() // crates → aletheia-v2
            .join("hooks/unix/sessionstart-bind.sh");
        assert!(hook_path.exists(), "hook script not at {hook_path:?}");

        let mut child = Command::new("bash")
            .arg(&hook_path)
            .env("ALETHEIA_DATA_DIR", &temp_root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("failed to spawn hook subprocess");

        {
            let stdin = child.stdin.as_mut().expect("child stdin");
            write!(stdin, r#"{{"session_id":"{}"}}"#, session_id).unwrap();
        }
        let output = child.wait_with_output().expect("hook subprocess wait");
        assert!(
            output.status.success(),
            "hook exited with {:?}; stderr: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );

        // The hook ran as a child of THIS test process. Its $PPID == test_pid.
        // It should have written at <test_pid>.session_id.
        let expected = temp_root
            .join("sessions")
            .join(format!("{}.session_id", test_pid));
        assert!(
            expected.exists(),
            "hook did not write at parent PID ({}); sessions dir = {:?}",
            test_pid,
            std::fs::read_dir(temp_root.join("sessions"))
                .map(|d| d.flat_map(|e| e.ok().map(|e| e.path())).collect::<Vec<_>>())
                .unwrap_or_default()
        );
        let content = std::fs::read_to_string(&expected).unwrap();
        assert_eq!(content.trim(), session_id);

        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&expected).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "file mode should be 0o600, got {:o}", mode);
    }

    // scopeguard pattern without pulling in the scopeguard crate
    #[cfg(unix)]
    fn scopeguard_like<F: FnOnce()>(f: F) -> Defer<F> {
        Defer(Some(f))
    }
    #[cfg(unix)]
    struct Defer<F: FnOnce()>(Option<F>);
    #[cfg(unix)]
    impl<F: FnOnce()> Drop for Defer<F> {
        fn drop(&mut self) {
            if let Some(f) = self.0.take() {
                f()
            }
        }
    }
}
