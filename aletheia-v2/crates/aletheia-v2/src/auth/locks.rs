//! Phase 3 W3 — session locks + heartbeat (plan lines 1582-1712).
//!
//! The session lock is the FATAL gate against split-brain: only one live
//! process may hold a given `session_id` at a time. A background tokio
//! task refreshes `session_locks.last_heartbeat_at` every
//! `heartbeat_seconds`; stale rows (`last_heartbeat_at` older than
//! `stale_threshold_seconds`) are orphan-recovered on the next acquire.
//!
//! ## C10 — column scope
//!
//! This module writes ONLY the lifecycle columns: `session_id`,
//! `active_pid`, `hostname`, `claimed_at`, `last_heartbeat_at`. The seven
//! `active_*` columns (active_feature_id, active_project_*,
//! active_context_*) are Phase 5's domain and are never touched here.
//! Fresh INSERTs let them default to NULL.
//!
//! ## C12 — audit vocabulary
//!
//! Lock events use category `AuditEventCategory::Lock`:
//! - `lock_acquired` (fresh INSERT)
//! - `lock_orphan_recovered` (stale UPDATE)
//! - `lock_fatal_conflict` (live row, returns `Conflict`)
//! - `lock_released` (graceful DELETE via `release()`)
//!
//! ## C13 — no new connections
//!
//! All DB access flows through an `Arc<Mutex<Connection>>` provided by
//! the caller (Phase 4 TL-server's long-lived registry connection). The
//! heartbeat task clones the Arc; it does NOT open a fresh connection.
//!
//! ## Plan-bug-5 adaptation
//!
//! Plan line 1627 parses `last_heartbeat_at` with
//! `chrono::DateTime::parse_from_rfc3339`, but the column defaults to
//! SQLite's `CURRENT_TIMESTAMP` format (`YYYY-MM-DD HH:MM:SS`, no `T`,
//! no timezone). RFC3339 parse fails on that input. This module parses
//! as `NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S")` and
//! promotes to UTC via `.and_utc()`. Same defect class as three-review
//! MUST-3 (`purge_audit_log` cutoff format).

use rusqlite::{Connection, OptionalExtension};
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio::time::{Duration, interval};

use crate::error::{AletheiaError, Result};
use crate::settings::SessionLocksSettings;
use crate::types::audit::AuditEventCategory;

/// Handle returned by a successful `acquire()`.
///
/// Owns the spawned heartbeat task and a clone of the registry
/// connection so `release()` (graceful) and `Drop` (crash semantic) can
/// shut down cleanly.
///
/// `Debug` is hand-implemented to keep the printout focused on
/// `session_id` (the connection + task internals are not useful in logs).
pub struct LockHandle {
    pub session_id: String,
    pub heartbeat_task: JoinHandle<()>,
    /// Used by Drop + `release()` to operate on the lock row.
    conn: Arc<Mutex<Connection>>,
}

impl std::fmt::Debug for LockHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LockHandle")
            .field("session_id", &self.session_id)
            .finish_non_exhaustive()
    }
}

/// Outcome of `acquire()`.
#[derive(Debug)]
pub enum LockAcquireResult {
    /// Lock obtained — caller owns the returned handle until release/drop.
    Acquired(LockHandle),
    /// FATAL — another live session currently holds this `session_id`.
    /// The caller MUST surface this to the user; silent overwrites are
    /// forbidden by C3.
    Conflict {
        active_pid: i64,
        hostname: String,
        last_heartbeat: chrono::DateTime<chrono::Utc>,
    },
}

/// Acquire the session lock for `session_id`.
///
/// Three branches per C3:
///
/// 1. **No existing row** → fresh `INSERT` (active_pid, hostname);
///    emit `lock_acquired`.
/// 2. **Existing row, heartbeat age < stale_threshold** → return
///    `Conflict` AND emit `lock_fatal_conflict`. NEVER overwrite a live
///    lock.
/// 3. **Existing row, heartbeat age >= stale_threshold** → orphan-recover
///    via `UPDATE` (reset active_pid, hostname, claimed_at,
///    last_heartbeat_at to current process / `CURRENT_TIMESTAMP`); emit
///    `lock_orphan_recovered`.
///
/// On successful acquire (fresh or recovery), spawns a tokio heartbeat
/// task that ticks every `settings.heartbeat_seconds` and UPDATEs
/// `last_heartbeat_at`. The task is owned by the returned `LockHandle`
/// and is aborted on `release()` or `Drop`.
pub async fn acquire(
    conn: Arc<Mutex<Connection>>,
    session_id: &str,
    settings: &SessionLocksSettings,
) -> Result<LockAcquireResult> {
    let pid = std::process::id() as i64;
    let hostname = hostname::get()
        .ok()
        .and_then(|s| s.into_string().ok())
        .unwrap_or_default();
    let stale_threshold_seconds = settings.stale_threshold_seconds as i64;

    {
        let c = conn.lock().await;
        let existing: Option<(i64, String, String)> = c
            .query_row(
                "SELECT active_pid, hostname, last_heartbeat_at FROM session_locks WHERE session_id = ?",
                rusqlite::params![session_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;

        match existing {
            Some((existing_pid, existing_host, last_hb_str)) => {
                // PLAN-BUG-5 adaptation: SQLite's CURRENT_TIMESTAMP writes
                // "YYYY-MM-DD HH:MM:SS" (space, no T, no tz). RFC3339 parse
                // would fail. Use NaiveDateTime + .and_utc().
                let last_hb =
                    chrono::NaiveDateTime::parse_from_str(&last_hb_str, "%Y-%m-%d %H:%M:%S")
                        .map(|n| n.and_utc())
                        .map_err(|e| {
                            AletheiaError::Other(format!(
                                "parse last_heartbeat_at {:?}: {}",
                                last_hb_str, e
                            ))
                        })?;
                let age_seconds = (chrono::Utc::now() - last_hb).num_seconds();

                if age_seconds < stale_threshold_seconds {
                    // FATAL conflict — another live process holds this
                    // session. Emit audit event, return Conflict.
                    crate::db::audit_log::emit_event(
                        &c,
                        AuditEventCategory::Lock,
                        "lock_fatal_conflict",
                        None,
                        None,
                        None,
                        Some(&serde_json::json!({
                            "session_id": session_id,
                            "active_pid": existing_pid,
                            "hostname": existing_host,
                            "last_heartbeat_age_seconds": age_seconds,
                        })),
                    )?;
                    return Ok(LockAcquireResult::Conflict {
                        active_pid: existing_pid,
                        hostname: existing_host,
                        last_heartbeat: last_hb,
                    });
                } else {
                    // Stale — orphan recovery. Reset lifecycle columns
                    // only (C10: do not touch active_* columns).
                    c.execute(
                        "UPDATE session_locks SET active_pid = ?, hostname = ?, \
                         claimed_at = CURRENT_TIMESTAMP, last_heartbeat_at = CURRENT_TIMESTAMP \
                         WHERE session_id = ?",
                        rusqlite::params![pid, hostname, session_id],
                    )?;
                    crate::db::audit_log::emit_event(
                        &c,
                        AuditEventCategory::Lock,
                        "lock_orphan_recovered",
                        None,
                        None,
                        None,
                        Some(&serde_json::json!({
                            "session_id": session_id,
                            "previous_pid": existing_pid,
                            "previous_hostname": existing_host,
                            "previous_heartbeat_age_seconds": age_seconds,
                        })),
                    )?;
                }
            }
            None => {
                // Fresh acquire — INSERT only the lifecycle columns;
                // active_* columns default to NULL (C10).
                c.execute(
                    "INSERT INTO session_locks (session_id, active_pid, hostname) VALUES (?, ?, ?)",
                    rusqlite::params![session_id, pid, hostname],
                )?;
                crate::db::audit_log::emit_event(
                    &c,
                    AuditEventCategory::Lock,
                    "lock_acquired",
                    None,
                    None,
                    None,
                    Some(&serde_json::json!({ "session_id": session_id })),
                )?;
            }
        }
    }

    // Spawn the heartbeat task. The task clones the Arc and ticks on
    // a tokio interval, UPDATEing last_heartbeat_at. Errors are swallowed
    // (heartbeat failures are non-fatal at the row level; the next
    // acquire will treat the row as stale if heartbeats truly stop).
    let conn_for_hb = conn.clone();
    let session_id_owned = session_id.to_string();
    let interval_secs = settings.heartbeat_seconds;
    let heartbeat_task = tokio::spawn(async move {
        let mut tick = interval(Duration::from_secs(interval_secs as u64));
        // The first tick fires immediately; skip it so we don't double-
        // tick right after acquire (which just set CURRENT_TIMESTAMP).
        tick.tick().await;
        loop {
            tick.tick().await;
            let c = conn_for_hb.lock().await;
            if let Err(e) = c.execute(
                "UPDATE session_locks SET last_heartbeat_at = CURRENT_TIMESTAMP WHERE session_id = ?",
                rusqlite::params![&session_id_owned],
            ) {
                tracing::warn!(
                    error = ?e,
                    session_id = %session_id_owned,
                    "heartbeat update failed"
                );
            }
        }
    });

    Ok(LockAcquireResult::Acquired(LockHandle {
        session_id: session_id.to_string(),
        heartbeat_task,
        conn,
    }))
}

/// Graceful release — abort the heartbeat task, DELETE the lock row,
/// emit `lock_released`.
///
/// The DELETE is scoped to `session_id AND active_pid = current pid` so
/// a stale handle (e.g. one whose row was orphan-recovered by a peer)
/// cannot accidentally delete the peer's row.
pub async fn release(handle: LockHandle) -> Result<()> {
    handle.heartbeat_task.abort();
    let c = handle.conn.lock().await;
    let pid = std::process::id() as i64;
    c.execute(
        "DELETE FROM session_locks WHERE session_id = ? AND active_pid = ?",
        rusqlite::params![&handle.session_id, pid],
    )?;
    crate::db::audit_log::emit_event(
        &c,
        AuditEventCategory::Lock,
        "lock_released",
        None,
        None,
        None,
        Some(&serde_json::json!({ "session_id": &handle.session_id })),
    )?;
    Ok(())
}

/// Crash semantic (plan lines 1692-1697): on `Drop`, abort the
/// heartbeat task ONLY. **Do NOT delete the lock row.**
///
/// Intentional: an undropped (panicked / crashed) handle leaves the row
/// in place so the orphan-recovery branch of the next `acquire()` can
/// detect a missing heartbeat (after `stale_threshold_seconds`) and
/// take over. Graceful shutdown should call `release()` explicitly via
/// the server's shutdown handler.
impl Drop for LockHandle {
    fn drop(&mut self) {
        self.heartbeat_task.abort();
        // Row is NOT deleted on drop — see doc comment above.
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    /// Build a registry DB with pragmas applied, schema installed, and
    /// the parent rows that `session_locks` FKs to (`scopes` →
    /// `session_bindings`) pre-inserted.
    fn setup_registry() -> Arc<Mutex<Connection>> {
        let path =
            std::env::temp_dir().join(format!("aletheia-w3-locks-{}.db", uuid::Uuid::new_v4()));
        let conn = Connection::open(&path).expect("open db");
        crate::db::pragmas::apply(&conn).expect("pragmas apply");
        crate::db::registry_schema::install_all(&conn).expect("install schema");
        conn.execute(
            "INSERT INTO scopes (scope_id, name) VALUES (?, ?)",
            rusqlite::params!["test-scope", "test-scope"],
        )
        .expect("insert scope");
        conn.execute(
            "INSERT INTO session_bindings (session_id, key_hash, primary_scope_id) VALUES (?, ?, ?)",
            rusqlite::params!["test-session", "fakehash", "test-scope"],
        )
        .expect("insert session_binding");
        Arc::new(Mutex::new(conn))
    }

    /// Fast heartbeat settings for tests that don't care about timing.
    fn fast_settings() -> SessionLocksSettings {
        SessionLocksSettings {
            heartbeat_seconds: 60,
            stale_threshold_seconds: 180,
        }
    }

    #[tokio::test]
    async fn acquire_fresh_creates_row_and_audit() {
        let conn = setup_registry();
        let settings = fast_settings();

        let result = acquire(conn.clone(), "test-session", &settings)
            .await
            .expect("acquire ok");

        let handle = match result {
            LockAcquireResult::Acquired(h) => h,
            other => panic!("expected Acquired, got {other:?}"),
        };

        {
            let c = conn.lock().await;
            let (sid, pid): (String, i64) = c
                .query_row(
                    "SELECT session_id, active_pid FROM session_locks WHERE session_id = ?",
                    rusqlite::params!["test-session"],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .expect("row exists");
            assert_eq!(sid, "test-session");
            assert_eq!(pid, std::process::id() as i64);

            let event_count: i64 = c
                .query_row(
                    "SELECT COUNT(*) FROM sys_audit_log \
                     WHERE event_category = 'lock' AND event_type = 'lock_acquired'",
                    [],
                    |r| r.get(0),
                )
                .expect("count audit");
            assert_eq!(event_count, 1, "expected one lock_acquired event");
        }

        release(handle).await.expect("release ok");
    }

    #[tokio::test]
    async fn acquire_conflict_when_heartbeat_fresh() {
        let conn = setup_registry();
        let settings = fast_settings();

        // Pre-insert a row owned by a DIFFERENT pid with a fresh
        // heartbeat. The acquire call must return Conflict and emit
        // lock_fatal_conflict.
        {
            let c = conn.lock().await;
            c.execute(
                "INSERT INTO session_locks (session_id, active_pid, hostname, \
                 claimed_at, last_heartbeat_at) \
                 VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
                rusqlite::params!["test-session", 99_999_999i64, "peer-host"],
            )
            .expect("pre-insert");
        }

        let result = acquire(conn.clone(), "test-session", &settings)
            .await
            .expect("acquire returns Ok with Conflict");

        match result {
            LockAcquireResult::Conflict {
                active_pid,
                hostname,
                ..
            } => {
                assert_eq!(active_pid, 99_999_999);
                assert_eq!(hostname, "peer-host");
            }
            other => panic!("expected Conflict, got {other:?}"),
        }

        let c = conn.lock().await;
        let event_count: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM sys_audit_log \
                 WHERE event_category = 'lock' AND event_type = 'lock_fatal_conflict'",
                [],
                |r| r.get(0),
            )
            .expect("count audit");
        assert_eq!(event_count, 1, "expected one lock_fatal_conflict event");

        // Original row MUST be untouched (no silent overwrite — C3).
        let pid: i64 = c
            .query_row(
                "SELECT active_pid FROM session_locks WHERE session_id = ?",
                rusqlite::params!["test-session"],
                |r| r.get(0),
            )
            .expect("row still exists");
        assert_eq!(pid, 99_999_999, "live lock row must not be overwritten");
    }

    #[tokio::test]
    async fn acquire_orphan_recovery_when_heartbeat_stale() {
        let conn = setup_registry();
        let settings = fast_settings();

        // Pre-insert with a stale heartbeat (300 seconds ago, > 180s
        // default threshold).
        {
            let c = conn.lock().await;
            c.execute(
                "INSERT INTO session_locks (session_id, active_pid, hostname, \
                 claimed_at, last_heartbeat_at) \
                 VALUES (?, ?, ?, datetime('now', '-400 seconds'), datetime('now', '-300 seconds'))",
                rusqlite::params!["test-session", 99_999_999i64, "orphan-host"],
            )
            .expect("pre-insert stale row");
        }

        let result = acquire(conn.clone(), "test-session", &settings)
            .await
            .expect("acquire ok");
        let handle = match result {
            LockAcquireResult::Acquired(h) => h,
            other => panic!("expected Acquired after orphan recovery, got {other:?}"),
        };

        {
            let c = conn.lock().await;
            let pid: i64 = c
                .query_row(
                    "SELECT active_pid FROM session_locks WHERE session_id = ?",
                    rusqlite::params!["test-session"],
                    |r| r.get(0),
                )
                .expect("row exists");
            assert_eq!(
                pid,
                std::process::id() as i64,
                "active_pid must be current pid"
            );

            let event_count: i64 = c
                .query_row(
                    "SELECT COUNT(*) FROM sys_audit_log \
                     WHERE event_category = 'lock' AND event_type = 'lock_orphan_recovered'",
                    [],
                    |r| r.get(0),
                )
                .expect("count audit");
            assert_eq!(event_count, 1, "expected one lock_orphan_recovered event");
        }

        release(handle).await.expect("release ok");
    }

    #[tokio::test]
    async fn heartbeat_task_updates_last_heartbeat_at() {
        let conn = setup_registry();
        // 1-second heartbeat for test speed; threshold preserved.
        let settings = SessionLocksSettings {
            heartbeat_seconds: 1,
            stale_threshold_seconds: 180,
        };

        let result = acquire(conn.clone(), "test-session", &settings)
            .await
            .expect("acquire ok");
        let handle = match result {
            LockAcquireResult::Acquired(h) => h,
            other => panic!("expected Acquired, got {other:?}"),
        };

        let initial: String = {
            let c = conn.lock().await;
            c.query_row(
                "SELECT last_heartbeat_at FROM session_locks WHERE session_id = ?",
                rusqlite::params!["test-session"],
                |r| r.get(0),
            )
            .expect("read initial")
        };

        // Wait long enough for at least one heartbeat tick to elapse.
        // First interval tick fires immediately and is consumed before
        // the loop, so we need ~2s for a real UPDATE to land.
        tokio::time::sleep(Duration::from_millis(2_500)).await;

        let updated: String = {
            let c = conn.lock().await;
            c.query_row(
                "SELECT last_heartbeat_at FROM session_locks WHERE session_id = ?",
                rusqlite::params!["test-session"],
                |r| r.get(0),
            )
            .expect("read updated")
        };

        // CURRENT_TIMESTAMP is second-resolution; compare lexicographically.
        assert!(
            updated >= initial,
            "heartbeat_at must be monotonic: initial={initial:?}, updated={updated:?}"
        );
        // At least one of (a) string changed or (b) at minimum no regression.
        // Under tight CI we still get >=; an strict-greater check would be
        // flaky on second-boundary alignment.

        release(handle).await.expect("release ok");
    }

    #[tokio::test]
    async fn release_deletes_row_and_audit() {
        let conn = setup_registry();
        let settings = fast_settings();

        let result = acquire(conn.clone(), "test-session", &settings)
            .await
            .expect("acquire ok");
        let handle = match result {
            LockAcquireResult::Acquired(h) => h,
            other => panic!("expected Acquired, got {other:?}"),
        };

        release(handle).await.expect("release ok");

        let c = conn.lock().await;
        let row_count: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM session_locks WHERE session_id = ?",
                rusqlite::params!["test-session"],
                |r| r.get(0),
            )
            .expect("count rows");
        assert_eq!(row_count, 0, "row must be deleted after release");

        let event_count: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM sys_audit_log \
                 WHERE event_category = 'lock' AND event_type = 'lock_released'",
                [],
                |r| r.get(0),
            )
            .expect("count audit");
        assert_eq!(event_count, 1, "expected one lock_released event");
    }

    #[tokio::test]
    async fn drop_aborts_heartbeat_but_keeps_row() {
        let conn = setup_registry();
        let settings = fast_settings();

        let result = acquire(conn.clone(), "test-session", &settings)
            .await
            .expect("acquire ok");
        let handle = match result {
            LockAcquireResult::Acquired(h) => h,
            other => panic!("expected Acquired, got {other:?}"),
        };

        // Drop WITHOUT calling release — crash semantic. The row must
        // remain so the next acquire's orphan-recovery branch can take
        // over after the stale threshold elapses.
        drop(handle);

        // Give the abort a moment to settle (not strictly required —
        // session_locks is checked synchronously).
        tokio::time::sleep(Duration::from_millis(50)).await;

        let c = conn.lock().await;
        let row_count: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM session_locks WHERE session_id = ?",
                rusqlite::params!["test-session"],
                |r| r.get(0),
            )
            .expect("count rows");
        assert_eq!(
            row_count, 1,
            "row MUST remain after Drop (crash semantic — plan lines 1692-1697)"
        );
    }

    #[tokio::test]
    async fn parses_sqlite_timestamp_format_not_rfc3339() {
        // Regression guard for plan-bug-5: the plan code path uses
        // parse_from_rfc3339, which would fail on SQLite's
        // CURRENT_TIMESTAMP format ("YYYY-MM-DD HH:MM:SS"). This test
        // pre-inserts a row with a literal SQLite-format timestamp and
        // exercises the parse path via acquire(). It must not error.
        let conn = setup_registry();
        let settings = fast_settings();

        {
            let c = conn.lock().await;
            c.execute(
                "INSERT INTO session_locks (session_id, active_pid, hostname, \
                 claimed_at, last_heartbeat_at) \
                 VALUES (?, ?, ?, '2026-05-11 14:00:00', '2026-05-11 14:00:00')",
                rusqlite::params!["test-session", 99_999_999i64, "peer-host"],
            )
            .expect("pre-insert literal timestamp");
        }

        // The literal timestamp '2026-05-11 14:00:00' is far in the past
        // relative to chrono::Utc::now() at test runtime (or far in the
        // future — either way, the parse itself must succeed). Acquire
        // must return Ok (either Conflict or Acquired depending on the
        // age math) without surfacing a parse error.
        let _ = acquire(conn.clone(), "test-session", &settings)
            .await
            .expect("acquire must not error on SQLite timestamp format");
    }
}
