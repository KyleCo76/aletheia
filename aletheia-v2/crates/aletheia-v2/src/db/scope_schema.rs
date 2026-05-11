// Per-scope SQLite DB schema (V2 baseline).
//
// One `.db` file lives in each scope directory (e.g. `~/.aletheia/scopes/<scope>/db.sqlite`).
// `install_all` is invoked when a fresh scope is minted (Phase 3 bootstrap) and when the
// Phase 8 V1→V2 migration partitions a V1 namespace into its own per-scope DB.
//
// Forward-compat seams (do not strip without a migration):
// - `entries.valid_from` / `entries.valid_to` enable point-in-time + soft-delete semantics.
// - `memory_journal_provenance` keeps V3 KG `derived_from` edges representable from day one.
// - `entries.content_hash` (+ `idx_entries_content_hash`) is required for Phase 5 dedup.
// - `entries.tags` is TEXT (JSON array) — no normalized tags table.

pub const SCHEMA_USER_VERSION: u32 = 1; // V2.0.0 baseline; bumped per migration.

pub const ENTRIES_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS entries (
  internal_id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  entry_class TEXT NOT NULL CHECK(entry_class IN ('journal', 'memory', 'status', 'handoff')),
  content TEXT,
  content_hash TEXT NOT NULL,
  tags TEXT,                              -- JSON array
  valid_from TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  valid_to TIMESTAMP,
  invalidation_reason TEXT,
  supersedes_entry_id TEXT,
  reasoning_trace TEXT,
  critical_flag INTEGER NOT NULL DEFAULT 0,
  digested_at TIMESTAMP,
  feature_id TEXT REFERENCES features(feature_id) ON DELETE SET NULL,
  created_by_key_hash TEXT,
  UNIQUE(entry_id, version)
);
CREATE INDEX IF NOT EXISTS idx_entries_entry_id_current ON entries(entry_id, valid_to);
CREATE INDEX IF NOT EXISTS idx_entries_class_valid ON entries(entry_class, valid_to);
CREATE INDEX IF NOT EXISTS idx_entries_content_hash ON entries(content_hash);
CREATE INDEX IF NOT EXISTS idx_entries_journal_digested ON entries(entry_class, digested_at) WHERE entry_class = 'journal';
CREATE INDEX IF NOT EXISTS idx_entries_feature ON entries(feature_id);
"#;

pub const STATUS_SECTIONS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS status_sections (
  internal_id INTEGER PRIMARY KEY AUTOINCREMENT,
  status_entry_id TEXT NOT NULL,
  section_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT,
  state TEXT,
  position INTEGER,
  valid_from TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  valid_to TIMESTAMP,
  invalidation_reason TEXT CHECK(invalidation_reason IS NULL OR invalidation_reason IN ('updated', 'state_changed', 'removed')),
  changed_by_key_hash TEXT,
  UNIQUE(status_entry_id, section_id, version)
);
CREATE INDEX IF NOT EXISTS idx_status_current ON status_sections(status_entry_id, section_id, valid_to);
"#;

pub const FEATURES_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS features (
  feature_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  state TEXT NOT NULL CHECK(state IN ('active', 'tabled', 'wrapped_up', 'abandoned')),
  initiated_at TIMESTAMP NOT NULL,
  tabled_at TIMESTAMP,
  wrapped_at TIMESTAMP,
  abandoned_at TIMESTAMP,
  abandonment_reason TEXT,
  initiated_by_key_hash TEXT,
  last_tabled_by_key_hash TEXT,
  last_tabled_by_session_id TEXT,
  wrapped_by_key_hash TEXT,
  feature_tags TEXT,                      -- JSON array
  metadata TEXT                            -- JSON object
);
CREATE INDEX IF NOT EXISTS idx_features_state ON features(state);
"#;

pub const MEMORY_JOURNAL_PROVENANCE_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS memory_journal_provenance (
  memory_entry_id TEXT NOT NULL,
  journal_entry_id TEXT NOT NULL,
  PRIMARY KEY(memory_entry_id, journal_entry_id)
);
CREATE INDEX IF NOT EXISTS idx_provenance_memory ON memory_journal_provenance(memory_entry_id);
CREATE INDEX IF NOT EXISTS idx_provenance_journal ON memory_journal_provenance(journal_entry_id);
"#;

// FTS5 full-text search over entries.content (consumed by Phase 5's `search` tool).
// Per-scope (lives in each scope's `.db`); sync triggers fire on every INSERT/UPDATE of entries.
// Trigger overhead is minor for normal writes; Phase 8's V1→V2 bulk migration disables triggers
// during INSERT then issues a single FTS5 rebuild for performance.
pub const ENTRIES_FTS_TABLE: &str = r#"
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(content, content=entries, content_rowid=internal_id);

CREATE TRIGGER IF NOT EXISTS trg_entries_fts_insert AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, content) VALUES (new.internal_id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS trg_entries_fts_update AFTER UPDATE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, content) VALUES ('delete', old.internal_id, old.content);
  INSERT INTO entries_fts(rowid, content) VALUES (new.internal_id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS trg_entries_fts_delete AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, content) VALUES ('delete', old.internal_id, old.content);
END;
"#;

pub const ALL_TABLES: &[&str] = &[
    ENTRIES_TABLE,
    STATUS_SECTIONS_TABLE,
    FEATURES_TABLE,
    MEMORY_JOURNAL_PROVENANCE_TABLE,
    ENTRIES_FTS_TABLE,
];

/// Install the full per-scope schema on a fresh `.db` file. Called by:
/// - Phase 3's bootstrap flow when `aletheia-v2 setup` mints a new scope.
/// - Phase 8's `migrate_from_v1` orchestrator when partitioning a V1 namespace into a V2 scope DB.
///
/// Idempotent (each table uses `CREATE TABLE IF NOT EXISTS`).
pub fn install_all(conn: &rusqlite::Connection) -> crate::error::Result<()> {
    for ddl in ALL_TABLES {
        conn.execute_batch(ddl)?;
    }
    conn.execute_batch(&format!("PRAGMA user_version = {}", SCHEMA_USER_VERSION))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn fresh_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory DB");
        install_all(&conn).expect("install_all should succeed on fresh DB");
        conn
    }

    #[test]
    fn install_all_creates_all_tables_and_indexes_and_triggers() {
        let conn = fresh_conn();

        let mut stmt = conn
            .prepare(
                "SELECT name, type FROM sqlite_master \
                 WHERE type IN ('table', 'index', 'trigger') ORDER BY type, name",
            )
            .expect("prepare sqlite_master query");
        let rows: Vec<(String, String)> = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .expect("query_map")
            .map(|r| r.expect("row"))
            .collect();

        let names: Vec<&str> = rows.iter().map(|(n, _)| n.as_str()).collect();

        // Tables
        for required in [
            "entries",
            "status_sections",
            "features",
            "memory_journal_provenance",
            "entries_fts",
        ] {
            assert!(
                names.contains(&required),
                "missing required table/virtual-table: {required}; saw: {names:?}"
            );
        }

        // Indexes
        for required in [
            "idx_entries_entry_id_current",
            "idx_entries_class_valid",
            "idx_entries_content_hash",
            "idx_entries_journal_digested",
            "idx_entries_feature",
            "idx_status_current",
            "idx_features_state",
            "idx_provenance_memory",
            "idx_provenance_journal",
        ] {
            assert!(
                names.contains(&required),
                "missing required index: {required}; saw: {names:?}"
            );
        }

        // Triggers
        for required in [
            "trg_entries_fts_insert",
            "trg_entries_fts_update",
            "trg_entries_fts_delete",
        ] {
            assert!(
                names.contains(&required),
                "missing required trigger: {required}; saw: {names:?}"
            );
        }
    }

    fn insert_entry(
        conn: &Connection,
        entry_id: &str,
        version: i64,
        entry_class: &str,
        content: &str,
        content_hash: &str,
    ) -> i64 {
        conn.execute(
            "INSERT INTO entries (entry_id, version, entry_class, content, content_hash) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![entry_id, version, entry_class, content, content_hash],
        )
        .expect("insert entry");
        conn.last_insert_rowid()
    }

    #[test]
    fn fts_sync_on_insert() {
        let conn = fresh_conn();
        let internal_id = insert_entry(&conn, "e1", 1, "journal", "hello world journaling", "abc");

        let mut stmt = conn
            .prepare("SELECT rowid FROM entries_fts WHERE entries_fts MATCH 'hello'")
            .expect("prepare fts match");
        let row_ids: Vec<i64> = stmt
            .query_map([], |row| row.get::<_, i64>(0))
            .expect("query_map")
            .map(|r| r.expect("row"))
            .collect();

        assert_eq!(row_ids, vec![internal_id]);
    }

    #[test]
    fn fts_sync_on_update() {
        let conn = fresh_conn();
        let _ = insert_entry(&conn, "e1", 1, "journal", "hello world journaling", "abc");

        conn.execute(
            "UPDATE entries SET content = 'totally different text' WHERE entry_id = 'e1'",
            [],
        )
        .expect("update content");

        let count_old: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM entries_fts WHERE entries_fts MATCH 'hello'",
                [],
                |row| row.get(0),
            )
            .expect("count old");
        assert_eq!(count_old, 0, "old token should no longer be indexed");

        let count_new: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM entries_fts WHERE entries_fts MATCH 'totally'",
                [],
                |row| row.get(0),
            )
            .expect("count new");
        assert_eq!(count_new, 1, "new token should be indexed");
    }

    #[test]
    fn fts_sync_on_delete() {
        let conn = fresh_conn();
        let _ = insert_entry(&conn, "e1", 1, "journal", "hello world journaling", "abc");

        conn.execute("DELETE FROM entries WHERE entry_id = 'e1'", [])
            .expect("delete entry");

        for term in ["hello", "world", "journaling"] {
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM entries_fts WHERE entries_fts MATCH ?1",
                    [term],
                    |row| row.get(0),
                )
                .expect("count after delete");
            assert_eq!(count, 0, "term {term} should be gone from FTS");
        }
    }

    #[test]
    fn content_hash_index_queryable() {
        let conn = fresh_conn();
        let _ = insert_entry(&conn, "e1", 1, "memory", "anything", "unique_hash_xyz");

        let mut stmt = conn
            .prepare(
                "EXPLAIN QUERY PLAN SELECT * FROM entries WHERE content_hash = 'unique_hash_xyz'",
            )
            .expect("prepare EQP");
        let plan_rows: Vec<String> = stmt
            .query_map([], |row| {
                // EQP columns: id, parent, notused, detail. We want `detail` (column 3).
                row.get::<_, String>(3)
            })
            .expect("query_map EQP")
            .map(|r| r.expect("row"))
            .collect();

        let joined = plan_rows.join("\n");
        assert!(
            joined.contains("idx_entries_content_hash"),
            "expected planner to consult idx_entries_content_hash; EQP detail:\n{joined}"
        );
    }

    #[test]
    fn pragma_user_version_set_to_1() {
        let conn = fresh_conn();
        let version: u32 = conn
            .pragma_query_value(None, "user_version", |row| row.get::<_, u32>(0))
            .expect("read user_version");
        assert_eq!(version, SCHEMA_USER_VERSION);
        assert_eq!(version, 1);
    }

    #[test]
    fn entry_class_check_rejects_invalid() {
        let conn = fresh_conn();
        let err = conn.execute(
            "INSERT INTO entries (entry_id, version, entry_class, content, content_hash) \
             VALUES ('e1', 1, 'invalid', 'x', 'h')",
            [],
        );
        let err = err.expect_err("INSERT with invalid entry_class must fail");
        let msg = format!("{err}");
        assert!(
            msg.to_lowercase().contains("check"),
            "expected CHECK constraint error, got: {msg}"
        );
    }

    #[test]
    fn features_state_check_rejects_invalid() {
        let conn = fresh_conn();
        let err = conn.execute(
            "INSERT INTO features (feature_id, name, state, initiated_at) \
             VALUES ('f1', 'feature-one', 'wrong', CURRENT_TIMESTAMP)",
            [],
        );
        let err = err.expect_err("INSERT with invalid features.state must fail");
        let msg = format!("{err}");
        assert!(
            msg.to_lowercase().contains("check"),
            "expected CHECK constraint error, got: {msg}"
        );
    }
}
