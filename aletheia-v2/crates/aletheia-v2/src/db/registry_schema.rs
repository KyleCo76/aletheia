// Phase 2 sub-task B2 — LOCKED registry DB DDL per IS-2 contract.
//
// This module owns the DDL for `scope_registry.db`, the global control-plane
// database that per-scope DBs ATTACH against. The schema is LOCKED in Phase 2:
// no subsequent phase modifies this file. Phases 3, 7, and 9 query these tables
// but never alter their DDL. CR-2 verifies the lock via grep.
//
// Contents:
//   - 10 main registry tables (scopes, keys, session_bindings, session_locks,
//     digest_queue, mass_ingest_requests, mass_ingest_checkpoints, sys_audit_log,
//     shadow_comparison_log, migration_state, migration_scope_progress).
//   - `_audit_log_unlock` table (co-located with `sys_audit_log`).
//   - `sys_audit_log` append-only triggers (BEFORE UPDATE / BEFORE DELETE).
//   - `install_all()` helper that runs all DDL idempotently and sets
//     `PRAGMA user_version = REGISTRY_USER_VERSION`.

pub const REGISTRY_USER_VERSION: u32 = 1;

pub const SCOPES_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS scopes (
  scope_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  display_name TEXT,
  parent_scope_id TEXT REFERENCES scopes(scope_id) ON DELETE RESTRICT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  archived_at TIMESTAMP,
  digest_pending_v1_migration INTEGER NOT NULL DEFAULT 0,  -- Q5 lazy first-claim trigger marker
  metadata TEXT                                            -- JSON object
);
CREATE INDEX IF NOT EXISTS idx_scopes_parent ON scopes(parent_scope_id);
CREATE INDEX IF NOT EXISTS idx_scopes_archived ON scopes(archived_at);
"#;

pub const KEYS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS keys (
  key_id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,                          -- SHA-256 of raw key value
  name TEXT,                                              -- human label, e.g., "pm-aletheia"
  permissions TEXT NOT NULL CHECK(permissions IN ('read-only', 'read-write', 'create-sub-entries', 'maintenance')),
  created_by_key_id TEXT REFERENCES keys(key_id) ON DELETE SET NULL,
  primary_scope_id TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE RESTRICT,
  writable_scope_ids TEXT NOT NULL,                       -- JSON array of scope_ids (includes primary)
  readonly_scope_ids TEXT NOT NULL DEFAULT '[]',          -- JSON array
  is_master_key INTEGER NOT NULL DEFAULT 0,
  is_digest_key INTEGER NOT NULL DEFAULT 0,
  digest_for_scope_id TEXT REFERENCES scopes(scope_id),   -- non-NULL only when is_digest_key=1
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TIMESTAMP,
  CHECK ((is_digest_key = 0 AND digest_for_scope_id IS NULL) OR (is_digest_key = 1 AND digest_for_scope_id IS NOT NULL)),
  CHECK (NOT (is_master_key = 1 AND is_digest_key = 1))
);
CREATE INDEX IF NOT EXISTS idx_keys_hash ON keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_keys_revoked ON keys(revoked_at);
CREATE INDEX IF NOT EXISTS idx_keys_digest_scope ON keys(digest_for_scope_id) WHERE is_digest_key = 1;
"#;

pub const SESSION_BINDINGS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS session_bindings (
  session_id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,
  primary_scope_id TEXT NOT NULL REFERENCES scopes(scope_id),
  bound_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_session_bindings_key ON session_bindings(key_hash);
CREATE INDEX IF NOT EXISTS idx_session_bindings_last_seen ON session_bindings(last_seen_at);
"#;

pub const SESSION_LOCKS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS session_locks (
  session_id TEXT PRIMARY KEY,
  active_pid INTEGER NOT NULL,
  hostname TEXT NOT NULL,
  active_feature_id TEXT,                                       -- one active feature per session at a time
  -- Active project / active context state (Phase 5 active_context_tools reads/writes these):
  active_project_id TEXT,                                       -- scope_id of active project (per Q6)
  active_project_source TEXT,                                   -- "explicit" | "feature" | "primary" | "cwd" | "inferred"
  active_project_expires_at TIMESTAMP,                          -- TTL gate; NULL = no expiry
  active_context_tags_json TEXT,                                -- JSON array of context tags
  active_context_source TEXT,                                   -- "explicit_override" | "feature_tags" | "project_tags" | "inferred"
  active_context_expires_at TIMESTAMP,
  claimed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_heartbeat_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(session_id) REFERENCES session_bindings(session_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_session_locks_heartbeat ON session_locks(last_heartbeat_at);
"#;

pub const DIGEST_QUEUE_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS digest_queue (
  queue_id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_id TEXT NOT NULL REFERENCES scopes(scope_id),
  trigger_type TEXT NOT NULL CHECK(trigger_type IN (
    'entry_threshold', 'time_threshold', 'session_end',
    'feature_wrap', 'feature_init', 'manual',
    'mass_ingest', 'retention_purge'
  )),
  trigger_metadata TEXT,                                  -- JSON
  requested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'leased', 'committed', 'failed')),
  leased_by_pid INTEGER,
  lease_expires_at TIMESTAMP,
  started_at TIMESTAMP,
  committed_at TIMESTAMP,
  error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_digest_status_scope ON digest_queue(status, scope_id);
CREATE INDEX IF NOT EXISTS idx_digest_lease_expires ON digest_queue(lease_expires_at) WHERE status = 'leased';
"#;

pub const MASS_INGEST_REQUESTS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS mass_ingest_requests (
  request_id TEXT PRIMARY KEY,
  requester_key_hash TEXT NOT NULL,
  scope_id TEXT NOT NULL REFERENCES scopes(scope_id),
  operation TEXT NOT NULL,
  summary TEXT NOT NULL,
  justification TEXT NOT NULL,
  estimated_entry_count INTEGER,
  source_reference TEXT,
  approval_status_entry_id TEXT,                          -- the status doc holding approval state
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,                          -- created_at + approval_ttl_hours
  approved_at TIMESTAMP,
  approved_by_key_hash TEXT,
  digest_queue_id INTEGER REFERENCES digest_queue(queue_id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'denied', 'expired', 'started', 'completed', 'failed'))
);
CREATE INDEX IF NOT EXISTS idx_mass_ingest_status ON mass_ingest_requests(status);
CREATE INDEX IF NOT EXISTS idx_mass_ingest_expires ON mass_ingest_requests(expires_at) WHERE status = 'pending';
"#;

pub const MASS_INGEST_CHECKPOINTS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS mass_ingest_checkpoints (
  request_id TEXT NOT NULL REFERENCES mass_ingest_requests(request_id) ON DELETE CASCADE,
  checkpoint_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_count INTEGER NOT NULL,
  resume_state TEXT NOT NULL,                             -- JSON; SDK contract: no raw sensitive content
  PRIMARY KEY (request_id, checkpoint_at)
);
"#;

pub const SYS_AUDIT_LOG_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS sys_audit_log (
  audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  event_category TEXT NOT NULL CHECK(event_category IN ('auth', 'lock', 'scope', 'key', 'digest', 'migration', 'deprecation', 'reconciliation')),
  event_type TEXT NOT NULL,
  scope_id TEXT,                                          -- NULL for system-level events
  actor_key_hash TEXT,
  subject_key_hash TEXT,                                  -- for key mutations
  pid INTEGER,
  hostname TEXT,
  details TEXT                                            -- JSON
);
CREATE INDEX IF NOT EXISTS idx_audit_event_at ON sys_audit_log(event_at);
CREATE INDEX IF NOT EXISTS idx_audit_scope ON sys_audit_log(scope_id, event_at);
CREATE INDEX IF NOT EXISTS idx_audit_category ON sys_audit_log(event_category, event_at);

CREATE TABLE IF NOT EXISTS _audit_log_unlock (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
"#;

pub const SYS_AUDIT_LOG_TRIGGERS: &str = r#"
CREATE TRIGGER IF NOT EXISTS trg_audit_log_no_update BEFORE UPDATE ON sys_audit_log
BEGIN
  SELECT CASE
    WHEN (SELECT value FROM _audit_log_unlock WHERE key = 'unlocked') IS NULL
    THEN RAISE(ABORT, 'sys_audit_log is append-only; UPDATE forbidden')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_audit_log_no_delete BEFORE DELETE ON sys_audit_log
BEGIN
  SELECT CASE
    WHEN (SELECT value FROM _audit_log_unlock WHERE key = 'unlocked') IS NULL
    THEN RAISE(ABORT, 'sys_audit_log is append-only; DELETE forbidden')
  END;
END;
"#;

pub const SHADOW_COMPARISON_LOG_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS shadow_comparison_log (
  comparison_id INTEGER PRIMARY KEY AUTOINCREMENT,
  hook_event TEXT NOT NULL CHECK(hook_event IN ('l1', 'l2')),
  scope_id TEXT,
  session_id TEXT,
  emitted_ranking TEXT NOT NULL,                          -- JSON array of entry_ids
  comparison_ranking TEXT NOT NULL,                       -- JSON array of entry_ids (V1-equivalent or V2-baseline)
  diff_summary TEXT NOT NULL,                             -- JSON { added: [], removed: [], reordered: [] }
  recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_shadow_recorded ON shadow_comparison_log(recorded_at);
CREATE INDEX IF NOT EXISTS idx_shadow_scope ON shadow_comparison_log(scope_id, recorded_at);
"#;

pub const MIGRATION_STATE_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS migration_state (
  migration_id TEXT PRIMARY KEY,
  source_version TEXT NOT NULL,
  target_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued', 'paused_for_writes', 'applying', 'completed', 'failed')),
  is_applying INTEGER NOT NULL DEFAULT 0,                 -- the global flag tools check on every call
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  failed_at TIMESTAMP,
  error_message TEXT,
  initiated_by_key_hash TEXT,
  details TEXT                                            -- JSON
);

-- Singleton row representing "current migration in progress" — at most one row with is_applying=1 at any time
CREATE UNIQUE INDEX IF NOT EXISTS idx_migration_one_applying ON migration_state(is_applying) WHERE is_applying = 1;
"#;

pub const MIGRATION_SCOPE_PROGRESS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS migration_scope_progress (
  migration_id TEXT NOT NULL REFERENCES migration_state(migration_id),
  scope_id TEXT NOT NULL REFERENCES scopes(scope_id),
  status TEXT NOT NULL CHECK(status IN ('pending', 'applying', 'completed', 'failed')),
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  error_message TEXT,
  PRIMARY KEY (migration_id, scope_id)
);
"#;

pub const ALL_REGISTRY_TABLES: &[&str] = &[
    SCOPES_TABLE,
    KEYS_TABLE,
    SESSION_BINDINGS_TABLE,
    SESSION_LOCKS_TABLE,
    DIGEST_QUEUE_TABLE,
    MASS_INGEST_REQUESTS_TABLE,
    MASS_INGEST_CHECKPOINTS_TABLE,
    SYS_AUDIT_LOG_TABLE,
    SYS_AUDIT_LOG_TRIGGERS,
    SHADOW_COMPARISON_LOG_TABLE,
    MIGRATION_STATE_TABLE,
    MIGRATION_SCOPE_PROGRESS_TABLE,
];

/// Install the full registry schema on a fresh `scope_registry.db`. Called by:
/// - Phase 3's bootstrap flow (`aletheia-v2 setup`)
/// - Phase 8's `migrate_from_v1` orchestrator on the V2 target directory
///
/// Idempotent: every table/index/trigger uses `IF NOT EXISTS`. Sets
/// `PRAGMA user_version = REGISTRY_USER_VERSION` at the end so future migration
/// machinery can detect the registry schema generation.
pub fn install_all(conn: &rusqlite::Connection) -> crate::error::Result<()> {
    for ddl in ALL_REGISTRY_TABLES {
        conn.execute_batch(ddl)?;
    }
    conn.execute_batch(&format!("PRAGMA user_version = {REGISTRY_USER_VERSION}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::{Connection, params};

    /// Open a fresh in-memory connection with foreign keys enabled and the
    /// registry schema installed. Foreign keys must be ON for FK-dependent
    /// tests (keys → scopes, session_locks → session_bindings, etc.).
    fn fresh_registry() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory");
        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .expect("enable foreign keys");
        install_all(&conn).expect("install_all");
        conn
    }

    #[test]
    fn install_all_creates_all_registry_tables_indexes_and_triggers() {
        let conn = fresh_registry();

        // ---- 11 tables (10 main + _audit_log_unlock) ----
        let expected_tables = [
            "scopes",
            "keys",
            "session_bindings",
            "session_locks",
            "digest_queue",
            "mass_ingest_requests",
            "mass_ingest_checkpoints",
            "sys_audit_log",
            "_audit_log_unlock",
            "shadow_comparison_log",
            "migration_state",
            "migration_scope_progress",
        ];
        for table in expected_tables {
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    params![table],
                    |row| row.get(0),
                )
                .unwrap_or_else(|e| panic!("query table {table}: {e}"));
            assert_eq!(count, 1, "expected table {table} to exist exactly once");
        }

        // ---- Named indexes (every CREATE INDEX in the DDL) ----
        let expected_indexes = [
            "idx_scopes_parent",
            "idx_scopes_archived",
            "idx_keys_hash",
            "idx_keys_revoked",
            "idx_keys_digest_scope",
            "idx_session_bindings_key",
            "idx_session_bindings_last_seen",
            "idx_session_locks_heartbeat",
            "idx_digest_status_scope",
            "idx_digest_lease_expires",
            "idx_mass_ingest_status",
            "idx_mass_ingest_expires",
            "idx_audit_event_at",
            "idx_audit_scope",
            "idx_audit_category",
            "idx_shadow_recorded",
            "idx_shadow_scope",
            // Phase-9 partial unique index — explicitly checked here per IS-2 contract.
            "idx_migration_one_applying",
        ];
        for index in expected_indexes {
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?1",
                    params![index],
                    |row| row.get(0),
                )
                .unwrap_or_else(|e| panic!("query index {index}: {e}"));
            assert_eq!(count, 1, "expected index {index} to exist exactly once");
        }

        // ---- Both append-only audit log triggers ----
        for trigger in ["trg_audit_log_no_update", "trg_audit_log_no_delete"] {
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name=?1",
                    params![trigger],
                    |row| row.get(0),
                )
                .unwrap_or_else(|e| panic!("query trigger {trigger}: {e}"));
            assert_eq!(count, 1, "expected trigger {trigger} to exist");
        }

        // ---- user_version was stamped ----
        let user_version: u32 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("read user_version");
        assert_eq!(user_version, REGISTRY_USER_VERSION);
    }

    #[test]
    fn migration_state_singleton_index_enforces_at_most_one_applying() {
        let conn = fresh_registry();

        // First applying row succeeds.
        conn.execute(
            "INSERT INTO migration_state \
             (migration_id, source_version, target_version, status, is_applying) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params!["mig-1", "1.0.0", "2.0.0", "applying", 1],
        )
        .expect("first applying row should succeed");

        // Second applying row violates the partial UNIQUE index.
        let dup = conn.execute(
            "INSERT INTO migration_state \
             (migration_id, source_version, target_version, status, is_applying) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params!["mig-2", "1.0.0", "2.0.0", "applying", 1],
        );
        let err = dup.expect_err("second applying row must violate UNIQUE");
        let msg = err.to_string().to_lowercase();
        assert!(
            msg.contains("unique") || msg.contains("constraint"),
            "expected UNIQUE constraint failure, got: {err}"
        );

        // Non-applying rows are unbounded — the partial index does not index them.
        for id in ["mig-3", "mig-4", "mig-5"] {
            conn.execute(
                "INSERT INTO migration_state \
                 (migration_id, source_version, target_version, status, is_applying) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![id, "1.0.0", "2.0.0", "queued", 0],
            )
            .unwrap_or_else(|e| panic!("is_applying=0 row {id} should succeed: {e}"));
        }
    }

    #[test]
    fn keys_check_constraint_enforces_digest_key_coupling() {
        let conn = fresh_registry();

        // Seed a scope so FK constraints are satisfied.
        conn.execute(
            "INSERT INTO scopes (scope_id, name) VALUES (?1, ?2)",
            params!["scope-A", "scope-a"],
        )
        .expect("seed scope-A");

        // Helper: insert a key row with the given is_digest_key / digest_for_scope_id pair.
        let insert_key = |conn: &Connection,
                          key_id: &str,
                          key_hash: &str,
                          is_digest_key: i64,
                          digest_for_scope_id: Option<&str>|
         -> rusqlite::Result<usize> {
            conn.execute(
                "INSERT INTO keys \
                 (key_id, key_hash, permissions, primary_scope_id, writable_scope_ids, \
                  is_master_key, is_digest_key, digest_for_scope_id) \
                 VALUES (?1, ?2, 'read-write', 'scope-A', '[\"scope-A\"]', 0, ?3, ?4)",
                params![key_id, key_hash, is_digest_key, digest_for_scope_id],
            )
        };

        // Valid: is_digest_key=0 AND digest_for_scope_id IS NULL.
        insert_key(&conn, "k-normal", "hash-normal", 0, None)
            .expect("normal key (no digest binding) should succeed");

        // Valid: is_digest_key=1 AND digest_for_scope_id IS NOT NULL.
        insert_key(&conn, "k-digest", "hash-digest", 1, Some("scope-A"))
            .expect("digest key with scope binding should succeed");

        // Invalid: is_digest_key=1 but digest_for_scope_id IS NULL.
        let err = insert_key(&conn, "k-bad1", "hash-bad1", 1, None)
            .expect_err("is_digest_key=1 with NULL scope must violate CHECK");
        assert!(
            err.to_string().to_lowercase().contains("check"),
            "expected CHECK violation, got: {err}"
        );

        // Invalid: is_digest_key=0 but digest_for_scope_id IS NOT NULL.
        let err = insert_key(&conn, "k-bad2", "hash-bad2", 0, Some("scope-A"))
            .expect_err("is_digest_key=0 with non-NULL scope must violate CHECK");
        assert!(
            err.to_string().to_lowercase().contains("check"),
            "expected CHECK violation, got: {err}"
        );
    }

    #[test]
    fn keys_check_constraint_rejects_master_and_digest_key_combined() {
        let conn = fresh_registry();

        // Seed a scope so FK constraints are satisfied.
        conn.execute(
            "INSERT INTO scopes (scope_id, name) VALUES (?1, ?2)",
            params!["scope-M", "scope-m"],
        )
        .expect("seed scope-M");

        // Valid: master key, not a digest key, no digest_for_scope_id binding.
        conn.execute(
            "INSERT INTO keys \
             (key_id, key_hash, permissions, primary_scope_id, writable_scope_ids, \
              is_master_key, is_digest_key, digest_for_scope_id) \
             VALUES (?1, ?2, 'read-write', 'scope-M', '[\"scope-M\"]', 1, 0, NULL)",
            params!["k-master", "hash-master"],
        )
        .expect("master key (no digest) should succeed");

        // Valid: digest key, not a master key, with digest_for_scope_id set.
        conn.execute(
            "INSERT INTO keys \
             (key_id, key_hash, permissions, primary_scope_id, writable_scope_ids, \
              is_master_key, is_digest_key, digest_for_scope_id) \
             VALUES (?1, ?2, 'read-write', 'scope-M', '[\"scope-M\"]', 0, 1, ?3)",
            params!["k-digest2", "hash-digest2", "scope-M"],
        )
        .expect("digest key (no master) should succeed");

        // Invalid: master + digest combined — new mutex CHECK must reject.
        let err = conn
            .execute(
                "INSERT INTO keys \
                 (key_id, key_hash, permissions, primary_scope_id, writable_scope_ids, \
                  is_master_key, is_digest_key, digest_for_scope_id) \
                 VALUES (?1, ?2, 'read-write', 'scope-M', '[\"scope-M\"]', 1, 1, ?3)",
                params!["k-both", "hash-both", "scope-M"],
            )
            .expect_err("master+digest combined must violate CHECK mutex");

        // rusqlite surfaces CHECK violations as SqliteFailure with
        // "CHECK constraint failed: ..." in the extended message.
        match err {
            rusqlite::Error::SqliteFailure(_, Some(ref msg)) => {
                assert!(
                    msg.to_lowercase().contains("check"),
                    "expected CHECK constraint failure, got: {msg}"
                );
            }
            other => panic!("expected SqliteFailure(CHECK ...), got: {other:?}"),
        }
    }

    #[test]
    fn digest_queue_trigger_type_check_accepts_all_8_and_rejects_invalid() {
        let conn = fresh_registry();

        // Seed a scope so the FK is satisfied.
        conn.execute(
            "INSERT INTO scopes (scope_id, name) VALUES (?1, ?2)",
            params!["scope-D", "scope-d"],
        )
        .expect("seed scope-D");

        let valid_triggers = [
            "entry_threshold",
            "time_threshold",
            "session_end",
            "feature_wrap",
            "feature_init",
            "manual",
            "mass_ingest",
            "retention_purge",
        ];
        for trigger_type in valid_triggers {
            conn.execute(
                "INSERT INTO digest_queue (scope_id, trigger_type) VALUES (?1, ?2)",
                params!["scope-D", trigger_type],
            )
            .unwrap_or_else(|e| panic!("trigger_type {trigger_type} should be accepted: {e}"));
        }

        // Confirm all 8 inserts landed.
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM digest_queue", [], |row| row.get(0))
            .expect("count digest_queue");
        assert_eq!(count, 8, "all 8 valid trigger_types should have inserted");

        // Invalid value must be rejected by CHECK.
        let err = conn
            .execute(
                "INSERT INTO digest_queue (scope_id, trigger_type) VALUES (?1, ?2)",
                params!["scope-D", "nonexistent_type"],
            )
            .expect_err("invalid trigger_type must violate CHECK");
        assert!(
            err.to_string().to_lowercase().contains("check"),
            "expected CHECK violation, got: {err}"
        );
    }

    #[test]
    fn sys_audit_log_event_category_check_accepts_all_9_and_rejects_invalid() {
        let conn = fresh_registry();

        // All event categories accepted by the CHECK constraint per IS-2.
        // `reconciliation` is the Phase-9 forward-compat seam and MUST be in
        // the accepted set; the worker brief and the plan stanza both flag it
        // as load-bearing. (The brief says "9 categories" but enumerates 8
        // string literals — we follow the explicit enumeration, which the
        // plan stanza at line 934 also uses.)
        let valid_categories = [
            "auth",
            "lock",
            "scope",
            "key",
            "digest",
            "migration",
            "deprecation",
            "reconciliation",
        ];

        for category in valid_categories {
            conn.execute(
                "INSERT INTO sys_audit_log (event_category, event_type) VALUES (?1, ?2)",
                params![category, "test"],
            )
            .unwrap_or_else(|e| panic!("event_category {category} should be accepted: {e}"));
        }

        // Explicit redundant check: `reconciliation` must be in the set.
        assert!(
            valid_categories.contains(&"reconciliation"),
            "Phase-9 dependency: `reconciliation` must be in the accepted category set"
        );

        // Invalid category must be rejected.
        let err = conn
            .execute(
                "INSERT INTO sys_audit_log (event_category, event_type) VALUES (?1, ?2)",
                params!["invalid", "test"],
            )
            .expect_err("invalid event_category must violate CHECK");
        assert!(
            err.to_string().to_lowercase().contains("check"),
            "expected CHECK violation, got: {err}"
        );
    }
}
