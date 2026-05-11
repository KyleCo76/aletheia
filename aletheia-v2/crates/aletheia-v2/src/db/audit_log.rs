// Phase 2 sub-task B3 — audit log helpers (`emit_event`, `purge_audit_log`).
//
// Implements the helpers specified at plan lines 1141-1178. The append-only
// invariant on `sys_audit_log` is enforced at the DB layer by triggers
// installed in Worker B2's `registry_schema::SYS_AUDIT_LOG_TRIGGERS`. The
// helpers below cooperate with those triggers; the inline tests validate
// the trigger behavior (defense-in-depth).

use chrono::{DateTime, Utc};
use rusqlite::Connection;
use serde::Serialize;

use crate::error::Result;
use crate::types::audit::AuditEventCategory;

/// Append a row to `sys_audit_log`.
///
/// Captures the calling process's PID and hostname automatically and
/// serializes `details` to JSON via serde_json. The insert flows through
/// the standard SQLite path; the immutability triggers do not affect
/// INSERTs (they only fire on UPDATE / DELETE).
pub fn emit_event(
    conn: &Connection,
    category: AuditEventCategory,
    event_type: &str,
    scope_id: Option<&str>,
    actor_key_hash: Option<&str>,
    subject_key_hash: Option<&str>,
    details: Option<&impl Serialize>,
) -> Result<()> {
    let pid = std::process::id();
    let hostname = hostname::get()
        .ok()
        .and_then(|s| s.into_string().ok())
        .unwrap_or_default();
    let details_json = details.map(serde_json::to_string).transpose()?;
    conn.execute(
        "INSERT INTO sys_audit_log \
            (event_category, event_type, scope_id, actor_key_hash, subject_key_hash, pid, hostname, details) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        rusqlite::params![
            category.as_str(),
            event_type,
            scope_id,
            actor_key_hash,
            subject_key_hash,
            pid,
            hostname,
            details_json,
        ],
    )?;
    Ok(())
}

/// Master-key gated purge of old `sys_audit_log` rows.
///
/// Per the IS-2 contract (plan line 663): the unlock row insertion MUST be
/// the first statement in the transaction and its deletion MUST be the
/// last. Returns the number of rows deleted from `sys_audit_log`.
pub fn purge_audit_log(conn: &mut Connection, older_than: DateTime<Utc>) -> Result<usize> {
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT OR REPLACE INTO _audit_log_unlock (key, value) VALUES ('unlocked', 1)",
        [],
    )?;
    // sys_audit_log.event_at defaults to SQLite's CURRENT_TIMESTAMP
    // ("YYYY-MM-DD HH:MM:SS"). TEXT comparison is lexicographic; using
    // RFC3339 here would mis-sort because space (0x20) < 'T' (0x54),
    // causing same-day rows to compare incorrectly.
    let cutoff = older_than.format("%Y-%m-%d %H:%M:%S").to_string();
    let rows = tx.execute(
        "DELETE FROM sys_audit_log WHERE event_at < ?",
        rusqlite::params![cutoff],
    )?;
    tx.execute("DELETE FROM _audit_log_unlock WHERE key = 'unlocked'", [])?;
    tx.commit()?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::registry_schema;
    use chrono::Utc;
    use rusqlite::Connection;

    fn fresh_registry_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        registry_schema::install_all(&conn).expect("install registry schema");
        conn
    }

    #[test]
    fn emit_event_writes_all_fields() {
        let conn = fresh_registry_conn();

        let details = serde_json::json!({ "key": "value" });
        emit_event(
            &conn,
            AuditEventCategory::Auth,
            "test_event",
            Some("scope-xyz"),
            Some("actor-hash-1"),
            Some("subject-hash-2"),
            Some(&details),
        )
        .expect("emit_event ok");

        let (
            event_category,
            event_type,
            scope_id,
            actor_key_hash,
            subject_key_hash,
            pid,
            hostname,
            details_text,
        ): (String, String, String, String, String, i64, String, String) = conn
            .query_row(
                "SELECT event_category, event_type, scope_id, actor_key_hash, \
                        subject_key_hash, pid, hostname, details \
                 FROM sys_audit_log \
                 ORDER BY audit_id DESC LIMIT 1",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                    ))
                },
            )
            .expect("row exists");

        assert_eq!(event_category, "auth");
        assert_eq!(event_type, "test_event");
        assert_eq!(scope_id, "scope-xyz");
        assert_eq!(actor_key_hash, "actor-hash-1");
        assert_eq!(subject_key_hash, "subject-hash-2");
        assert!(pid > 0, "pid should be non-zero, got {pid}");
        assert!(!hostname.is_empty(), "hostname should be non-empty");

        let parsed: serde_json::Value =
            serde_json::from_str(&details_text).expect("details parses as json");
        assert_eq!(parsed, serde_json::json!({ "key": "value" }));
    }

    #[test]
    fn update_on_sys_audit_log_blocked_by_trigger() {
        let conn = fresh_registry_conn();

        emit_event(
            &conn,
            AuditEventCategory::Auth,
            "test_event",
            None,
            None,
            None,
            None::<&serde_json::Value>,
        )
        .expect("emit_event ok");

        let err = conn
            .execute(
                "UPDATE sys_audit_log SET event_type = 'changed' WHERE audit_id = 1",
                [],
            )
            .expect_err("UPDATE must be blocked by trigger");

        match err {
            rusqlite::Error::SqliteFailure(_, Some(ref msg)) => {
                assert!(
                    msg.contains("append-only") || msg.contains("UPDATE forbidden"),
                    "expected trigger ABORT message, got: {msg}"
                );
            }
            other => panic!("expected SqliteFailure, got: {other:?}"),
        }
    }

    #[test]
    fn delete_on_sys_audit_log_blocked_by_trigger() {
        let conn = fresh_registry_conn();

        emit_event(
            &conn,
            AuditEventCategory::Auth,
            "test_event",
            None,
            None,
            None,
            None::<&serde_json::Value>,
        )
        .expect("emit_event ok");

        let err = conn
            .execute("DELETE FROM sys_audit_log WHERE audit_id = 1", [])
            .expect_err("DELETE must be blocked by trigger");

        match err {
            rusqlite::Error::SqliteFailure(_, Some(ref msg)) => {
                assert!(
                    msg.contains("append-only") || msg.contains("DELETE forbidden"),
                    "expected trigger ABORT message, got: {msg}"
                );
            }
            other => panic!("expected SqliteFailure, got: {other:?}"),
        }
    }

    #[test]
    fn purge_audit_log_roundtrip() {
        let mut conn = fresh_registry_conn();

        // Insert 5 ancient rows (event_at = 2020-01-01). These are direct
        // INSERTs since emit_event always uses CURRENT_TIMESTAMP.
        for _ in 0..5 {
            conn.execute(
                "INSERT INTO sys_audit_log \
                    (event_at, event_category, event_type) \
                 VALUES ('2020-01-01', 'auth', 'old_event')",
                [],
            )
            .expect("insert old row ok");
        }

        let cutoff = chrono::DateTime::parse_from_rfc3339("2025-01-01T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let deleted = purge_audit_log(&mut conn, cutoff).expect("purge ok");
        assert_eq!(deleted, 5, "expected to delete all 5 ancient rows");

        let remaining: i64 = conn
            .query_row("SELECT COUNT(*) FROM sys_audit_log", [], |r| r.get(0))
            .unwrap();
        assert_eq!(remaining, 0, "sys_audit_log should be empty after purge");

        // Post-purge: insert a new row, then verify the trigger has been
        // re-armed (the unlock row was cleaned up at end of purge txn).
        emit_event(
            &conn,
            AuditEventCategory::Auth,
            "post_purge",
            None,
            None,
            None,
            None::<&serde_json::Value>,
        )
        .expect("emit_event after purge ok");

        let err = conn
            .execute("UPDATE sys_audit_log SET event_type = 'changed'", [])
            .expect_err("UPDATE must still be blocked after purge");
        match err {
            rusqlite::Error::SqliteFailure(_, Some(ref msg)) => {
                assert!(
                    msg.contains("append-only") || msg.contains("UPDATE forbidden"),
                    "expected trigger ABORT message, got: {msg}"
                );
            }
            other => panic!("expected SqliteFailure, got: {other:?}"),
        }
    }

    #[test]
    fn audit_log_unlock_row_cleaned_after_purge() {
        let mut conn = fresh_registry_conn();

        for _ in 0..5 {
            conn.execute(
                "INSERT INTO sys_audit_log \
                    (event_at, event_category, event_type) \
                 VALUES ('2020-01-01', 'auth', 'old_event')",
                [],
            )
            .expect("insert old row ok");
        }

        let cutoff = chrono::DateTime::parse_from_rfc3339("2025-01-01T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        purge_audit_log(&mut conn, cutoff).expect("purge ok");

        let unlock_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM _audit_log_unlock", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            unlock_count, 0,
            "_audit_log_unlock must be empty after purge transaction"
        );
    }

    #[test]
    fn purge_audit_log_same_day_boundary() {
        // Regression guard for the timestamp-format mismatch bug:
        // sys_audit_log.event_at is stored in SQLite's CURRENT_TIMESTAMP
        // format ("YYYY-MM-DD HH:MM:SS"), so the purge cutoff binding
        // MUST be formatted to match. RFC3339 (with 'T' separator) would
        // mis-sort same-day rows because space (0x20) < 'T' (0x54).
        let mut conn = fresh_registry_conn();

        // Row A: two hours before cutoff — should be purged.
        conn.execute(
            "INSERT INTO sys_audit_log (event_at, event_category, event_type) \
             VALUES ('2026-05-11 12:00:00', 'auth', 'old_event')",
            [],
        )
        .expect("insert row A");

        // Row B: one hour after cutoff — should remain.
        conn.execute(
            "INSERT INTO sys_audit_log (event_at, event_category, event_type) \
             VALUES ('2026-05-11 14:00:00', 'auth', 'new_event')",
            [],
        )
        .expect("insert row B");

        let cutoff = chrono::DateTime::parse_from_rfc3339("2026-05-11T13:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let deleted = purge_audit_log(&mut conn, cutoff).expect("purge ok");
        assert_eq!(deleted, 1, "only row A (before cutoff) should be purged");

        // Confirm row B is the only survivor.
        let remaining: String = conn
            .query_row("SELECT event_at FROM sys_audit_log", [], |r| r.get(0))
            .expect("read remaining row");
        assert_eq!(
            remaining, "2026-05-11 14:00:00",
            "row B (after cutoff) must remain"
        );
    }

    #[test]
    fn purge_with_no_matching_rows_returns_zero() {
        let mut conn = fresh_registry_conn();

        // Three current-day rows via emit_event (uses CURRENT_TIMESTAMP).
        for _ in 0..3 {
            emit_event(
                &conn,
                AuditEventCategory::Auth,
                "current_event",
                None,
                None,
                None,
                None::<&serde_json::Value>,
            )
            .expect("emit_event ok");
        }

        let cutoff = chrono::DateTime::parse_from_rfc3339("1970-01-01T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let deleted = purge_audit_log(&mut conn, cutoff).expect("purge ok");
        assert_eq!(deleted, 0, "no rows should match cutoff 1970-01-01");

        let remaining: i64 = conn
            .query_row("SELECT COUNT(*) FROM sys_audit_log", [], |r| r.get(0))
            .unwrap();
        assert_eq!(remaining, 3, "all 3 current rows should remain");
    }
}
