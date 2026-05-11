//! PRAGMA setup for every fresh SQLite connection.
//!
//! CRITICAL CONTRACT (C12, plan lines 1123-1138): every `Connection`
//! opened by Aletheia — registry, per-scope, or temporary — MUST run
//! through `apply()` immediately after open. PRAGMAs are
//! connection-scoped, NOT database-scoped: a freshly opened connection
//! that skips `apply()` will operate in SQLite defaults
//! (`synchronous = FULL`, `journal_mode = DELETE`, `foreign_keys = OFF`,
//! no busy timeout). That mismatch produces corruption-on-crash
//! divergence, FK-constraint silent failures, and `SQLITE_BUSY` errors
//! that the rest of the system isn't prepared for.
//!
//! Concrete settings (matching plan lines 1129-1136):
//! - `journal_mode = WAL` — concurrent readers + writer; required for
//!   the multi-session daemon architecture.
//! - `synchronous = NORMAL` — WAL-safe durability vs. throughput
//!   tradeoff (the SQLite-recommended WAL pairing).
//! - `foreign_keys = ON` — without this, `REFERENCES` clauses parse but
//!   are unenforced. Phase 2 schemas rely on FK cascades.
//! - `busy_timeout = 5000` (ms) — graceful wait under writer contention
//!   instead of immediate `SQLITE_BUSY`. The reconciler and `claim()`
//!   protocols assume this window.
//! - `temp_store = MEMORY` — keeps SQLite tempfiles off disk; both a
//!   perf win and a hygiene win (no stray `etilqs_*` files).

use crate::error::Result;
use rusqlite::Connection;

/// Apply the standard Aletheia PRAGMA set to `conn`.
///
/// Idempotent per connection. Safe to call more than once; SQLite
/// silently re-applies the same values. MUST be called immediately
/// after `Connection::open*` for every connection the crate opens.
pub fn apply(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 5000;
        PRAGMA temp_store = MEMORY;
        "#,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::path::PathBuf;

    /// Generate a unique temp file path for a per-test SQLite DB.
    ///
    /// We avoid the `tempfile` crate (not in workspace deps; see worker
    /// dispatch note) and instead synthesize a path under the OS temp
    /// dir keyed by a uuid. Tests clean up explicitly at the end.
    fn unique_db_path(label: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "aletheia-v2-pragma-test-{}-{}.db",
            label,
            uuid::Uuid::new_v4()
        ));
        p
    }

    fn cleanup(p: &PathBuf) {
        let _ = std::fs::remove_file(p);
        // WAL/SHM sidecars that SQLite may create:
        let _ = std::fs::remove_file(format!("{}-wal", p.display()));
        let _ = std::fs::remove_file(format!("{}-shm", p.display()));
    }

    #[test]
    fn apply_sets_wal_journal_mode() {
        // In-memory connections cannot use WAL (SQLite returns "memory"
        // for `PRAGMA journal_mode = WAL;` on a `:memory:` DB). Use a
        // real file so the WAL setting actually sticks.
        let path = unique_db_path("wal");
        let conn = Connection::open(&path).expect("open file db");
        apply(&conn).expect("pragmas apply");
        let mode: String = conn
            .query_row("PRAGMA journal_mode;", [], |r| r.get(0))
            .expect("query journal_mode");
        assert_eq!(
            mode.to_lowercase(),
            "wal",
            "journal_mode should be WAL on file-backed DB, got {mode}"
        );
        drop(conn);
        cleanup(&path);
    }

    #[test]
    fn apply_sets_foreign_keys_on() {
        let path = unique_db_path("fk");
        let conn = Connection::open(&path).expect("open file db");
        apply(&conn).expect("pragmas apply");
        let fk: i64 = conn
            .query_row("PRAGMA foreign_keys;", [], |r| r.get(0))
            .expect("query foreign_keys");
        assert_eq!(fk, 1, "foreign_keys should be ON (1)");
        drop(conn);
        cleanup(&path);
    }

    #[test]
    fn apply_sets_busy_timeout() {
        let path = unique_db_path("busy");
        let conn = Connection::open(&path).expect("open file db");
        apply(&conn).expect("pragmas apply");
        let timeout: i64 = conn
            .query_row("PRAGMA busy_timeout;", [], |r| r.get(0))
            .expect("query busy_timeout");
        assert_eq!(timeout, 5000, "busy_timeout should be 5000ms");
        drop(conn);
        cleanup(&path);
    }
}
