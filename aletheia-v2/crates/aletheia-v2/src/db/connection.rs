//! Per-session SQLite connection manager + ATTACH lifecycle.
//!
//! The `ConnectionManager` owns a single rusqlite `Connection` whose
//! `main` schema is the per-installation registry (`scope_registry.db`),
//! and lazily ATTACHes per-scope DB files based on a `PermissionSet`
//! computed by `claim()` in Phase 3. Writable scopes attach as
//! `w_<short>` and readonly scopes as `r_<short>`; the `mode=ro` URI
//! is paired with a `PRAGMA <alias>.query_only = ON` belt-and-suspenders
//! so unwanted writes fail at the SQLite layer even if the URI route
//! ever regressed.
//
// WAL+ATTACH cross-DB atomicity caveat: ATTACHed cross-DB writes are NOT atomic on
// hardware crash. Each ATTACHed scope DB has its own WAL; cross-DB transactions
// commit per-DB but not atomically across DBs. The reconciler (Phase 9) detects
// and reconciles drift. See arranger-handoff.md Finding 5.

use crate::error::Result;
use crate::types::scope::{PermissionSet, ScopeId};
use rusqlite::{Connection, OpenFlags};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Manages the per-session SQLite connection and its ATTACHed scope DBs.
///
/// Invariants:
/// - `conn` is opened against `<data_dir>/scope_registry.db` with WAL +
///   the standard PRAGMA set ([`crate::db::pragmas::apply`]).
/// - `attached[scope_id]` reflects the *currently* ATTACHed state for
///   `scope_id`; `attach_scope` is idempotent (re-attaching the same
///   scope is a no-op).
/// - Aliases are deterministic per (scope_id, writable) and short enough
///   to embed in SQL identifiers.
pub struct ConnectionManager {
    pub conn: Connection,
    data_dir: PathBuf,
    attached: HashMap<ScopeId, AttachedScope>,
}

#[derive(Debug)]
struct AttachedScope {
    alias: String,
    writable: bool,
}

impl ConnectionManager {
    /// Open the per-installation registry DB and apply the standard
    /// PRAGMA set.
    //
    // Per-connection PRAGMA discipline: PRAGMAs are connection-scoped, NOT database-scoped.
    // Every fresh Connection::open() in later phases MUST call pragmas::apply() — otherwise
    // that connection runs in default mode (synchronous=FULL, journal_mode=DELETE on a
    // non-WAL DB; foreign_keys=OFF). CR-2 known risk #1.
    pub fn open_registry(data_dir: &Path) -> Result<Self> {
        let registry_path = data_dir.join("scope_registry.db");
        let conn = Connection::open_with_flags(
            &registry_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
        )?;
        crate::db::pragmas::apply(&conn)?;
        Ok(Self {
            conn,
            data_dir: data_dir.to_path_buf(),
            attached: HashMap::new(),
        })
    }

    /// ATTACH every scope referenced by `perms`. Writable scopes are
    /// attached first (so the `w_*` aliases win the dedup if the same
    /// scope ever appears in both lists — defensive; `claim()` should
    /// never produce overlap), then readonly.
    pub fn attach_for_permissions(&mut self, perms: &PermissionSet) -> Result<()> {
        for scope_id in &perms.writable_scope_ids {
            self.attach_scope(scope_id, /* writable */ true)?;
        }
        for scope_id in &perms.readonly_scope_ids {
            self.attach_scope(scope_id, /* writable */ false)?;
        }
        Ok(())
    }

    fn attach_scope(&mut self, scope_id: &ScopeId, writable: bool) -> Result<()> {
        if self.attached.contains_key(scope_id) {
            return Ok(());
        }
        let scope_db_path = self
            .data_dir
            .join("scopes")
            .join(format!("{}.db", scope_id.0));
        let alias = self.compute_alias(scope_id, writable);
        let uri = if writable {
            format!("file:{}", scope_db_path.display())
        } else {
            format!("file:{}?mode=ro", scope_db_path.display())
        };
        self.conn
            .execute(&format!("ATTACH DATABASE '{}' AS {}", uri, alias), [])?;
        if !writable {
            // Belt-and-suspenders: PRAGMA query_only on the attached schema
            self.conn
                .execute_batch(&format!("PRAGMA {}.query_only = ON;", alias))?;
        }
        self.attached
            .insert(scope_id.clone(), AttachedScope { alias, writable });
        Ok(())
    }

    fn compute_alias(&self, scope_id: &ScopeId, writable: bool) -> String {
        // Short, sanitized; pulled from scope's name in registry. For
        // Phase 2 we use a `w_` / `r_` prefix + the first 8 chars of the
        // scope id (which is a UUID in practice).
        let short = &scope_id.0[..8.min(scope_id.0.len())];
        format!("{}_{}", if writable { "w" } else { "r" }, short)
    }

    /// Return the SQL alias for an attached scope, or `None` if not
    /// attached. Used by query builders that need to address a specific
    /// scope's table (e.g. `<alias>.entries`).
    pub fn alias_for(&self, scope_id: &ScopeId) -> Option<&str> {
        self.attached.get(scope_id).map(|a| a.alias.as_str())
    }

    /// `true` iff the scope is attached writable. Returns `false` when
    /// not attached at all (callers should pair with `alias_for` if they
    /// need to distinguish "absent" from "readonly").
    pub fn is_writable(&self, scope_id: &ScopeId) -> bool {
        self.attached
            .get(scope_id)
            .map(|a| a.writable)
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::scope_schema;
    use rusqlite::Connection;
    use std::path::PathBuf;
    use std::sync::Arc;

    /// Make a unique per-test data dir under `std::env::temp_dir()`.
    /// The `tempfile` crate is not in workspace deps; we manage cleanup
    /// manually via the `TempDir` RAII wrapper below.
    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(label: &str) -> Self {
            let mut p = std::env::temp_dir();
            p.push(format!(
                "aletheia-v2-conn-test-{}-{}",
                label,
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&p).expect("create tempdir");
            std::fs::create_dir_all(p.join("scopes")).expect("create scopes dir");
            Self { path: p }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    /// Create an empty scope `.db` file (registered as a valid SQLite
    /// DB by opening + closing a writable connection, with the standard
    /// PRAGMA set applied).
    fn create_empty_scope_db(data_dir: &Path, scope_id: &ScopeId) {
        let p = data_dir.join("scopes").join(format!("{}.db", scope_id.0));
        let conn = Connection::open(&p).expect("open scope db file");
        crate::db::pragmas::apply(&conn).expect("pragmas apply on scope db");
        drop(conn);
    }

    /// Create a scope `.db` file with the full per-scope schema
    /// installed. Used by readonly/writable INSERT tests.
    fn create_scope_db_with_schema(data_dir: &Path, scope_id: &ScopeId) {
        let p = data_dir.join("scopes").join(format!("{}.db", scope_id.0));
        let conn = Connection::open(&p).expect("open scope db file");
        crate::db::pragmas::apply(&conn).expect("pragmas apply on scope db");
        scope_schema::install_all(&conn).expect("install scope schema");
        drop(conn);
    }

    fn fresh_scope_id() -> ScopeId {
        ScopeId(uuid::Uuid::new_v4().to_string())
    }

    #[test]
    fn open_registry_applies_pragmas() {
        let dir = TempDir::new("open-registry-pragmas");
        let mgr = ConnectionManager::open_registry(dir.path()).expect("open_registry");
        let mode: String = mgr
            .conn
            .query_row("PRAGMA journal_mode;", [], |r| r.get(0))
            .expect("query journal_mode");
        assert_eq!(
            mode.to_lowercase(),
            "wal",
            "registry connection should be in WAL mode after open_registry"
        );
    }

    #[test]
    fn attach_5_scopes_mix_writable_and_readonly() {
        // C13: 5 distinct scopes, 3 writable + 2 readonly, all attach
        // successfully and show up in PRAGMA database_list.
        let dir = TempDir::new("c13-five-scopes");
        let mut mgr = ConnectionManager::open_registry(dir.path()).expect("open_registry");

        let w_ids: Vec<ScopeId> = (0..3).map(|_| fresh_scope_id()).collect();
        let r_ids: Vec<ScopeId> = (0..2).map(|_| fresh_scope_id()).collect();
        for id in w_ids.iter().chain(r_ids.iter()) {
            create_empty_scope_db(dir.path(), id);
        }

        let perms = PermissionSet {
            primary_scope_id: w_ids[0].clone(),
            writable_scope_ids: w_ids.clone(),
            readonly_scope_ids: r_ids.clone(),
        };
        mgr.attach_for_permissions(&perms)
            .expect("attach_for_permissions");

        // Collect attached aliases from PRAGMA database_list.
        let mut stmt = mgr
            .conn
            .prepare("PRAGMA database_list;")
            .expect("prepare database_list");
        let names: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query_map")
            .map(|r| r.expect("row"))
            .collect();

        for id in &w_ids {
            let expected = mgr
                .alias_for(id)
                .expect("writable alias present")
                .to_string();
            assert!(
                names.contains(&expected),
                "expected writable alias {expected} in database_list {names:?}"
            );
            assert!(mgr.is_writable(id), "scope {} should be writable", id.0);
        }
        for id in &r_ids {
            let expected = mgr
                .alias_for(id)
                .expect("readonly alias present")
                .to_string();
            assert!(
                names.contains(&expected),
                "expected readonly alias {expected} in database_list {names:?}"
            );
            assert!(!mgr.is_writable(id), "scope {} should be readonly", id.0);
        }
    }

    #[test]
    fn readonly_attach_blocks_writes() {
        let dir = TempDir::new("readonly-blocks-writes");
        let scope_id = fresh_scope_id();
        // Install schema on the scope DB BEFORE attach — otherwise the
        // readonly attach would find an empty file and the INSERT would
        // fail for "no such table" rather than the SQLITE_READONLY we
        // want to assert.
        create_scope_db_with_schema(dir.path(), &scope_id);

        let mut mgr = ConnectionManager::open_registry(dir.path()).expect("open_registry");
        let perms = PermissionSet {
            primary_scope_id: scope_id.clone(),
            writable_scope_ids: vec![],
            readonly_scope_ids: vec![scope_id.clone()],
        };
        mgr.attach_for_permissions(&perms).expect("attach readonly");
        let alias = mgr
            .alias_for(&scope_id)
            .expect("readonly alias present")
            .to_string();

        let sql = format!(
            "INSERT INTO {alias}.entries (entry_id, version, entry_class, content, content_hash) \
             VALUES ('e1', 1, 'journal', 'hi', 'h1')"
        );
        let err = mgr
            .conn
            .execute(&sql, [])
            .expect_err("INSERT into readonly-attached scope must fail");
        let msg = format!("{err}").to_lowercase();
        assert!(
            msg.contains("readonly") || msg.contains("read-only") || msg.contains("read only"),
            "expected SQLITE_READONLY-flavoured error, got: {err}"
        );
    }

    #[test]
    fn writable_attach_allows_writes() {
        let dir = TempDir::new("writable-allows-writes");
        let scope_id = fresh_scope_id();
        create_scope_db_with_schema(dir.path(), &scope_id);

        let mut mgr = ConnectionManager::open_registry(dir.path()).expect("open_registry");
        let perms = PermissionSet {
            primary_scope_id: scope_id.clone(),
            writable_scope_ids: vec![scope_id.clone()],
            readonly_scope_ids: vec![],
        };
        mgr.attach_for_permissions(&perms).expect("attach writable");
        let alias = mgr
            .alias_for(&scope_id)
            .expect("writable alias present")
            .to_string();
        assert!(mgr.is_writable(&scope_id));

        let sql = format!(
            "INSERT INTO {alias}.entries (entry_id, version, entry_class, content, content_hash) \
             VALUES ('e1', 1, 'journal', 'hi', 'h1')"
        );
        mgr.conn
            .execute(&sql, [])
            .expect("INSERT into writable-attached scope should succeed");

        // Sanity: row is actually there.
        let count: i64 = mgr
            .conn
            .query_row(&format!("SELECT COUNT(*) FROM {alias}.entries"), [], |r| {
                r.get(0)
            })
            .expect("count");
        assert_eq!(count, 1);
    }

    #[test]
    fn wal_concurrent_writes_no_busy_within_timeout() {
        // Two threads each open their OWN ConnectionManager against the
        // same data_dir and perform a write transaction against the
        // registry. With WAL + busy_timeout=5000ms, neither should
        // observe SQLITE_BUSY.
        let dir = Arc::new(TempDir::new("wal-concurrent"));
        // Pre-create the registry + a `scopes` table on the registry so
        // each thread has a row to INSERT into. We need a minimal table
        // because the registry_schema worker owns the real DDL.
        {
            let mgr = ConnectionManager::open_registry(dir.path()).expect("open_registry init");
            mgr.conn
                .execute_batch(
                    "CREATE TABLE IF NOT EXISTS wal_test (id TEXT PRIMARY KEY, payload TEXT);",
                )
                .expect("create wal_test table");
        }

        let n_threads = 2;
        let mut handles = Vec::with_capacity(n_threads);
        for i in 0..n_threads {
            let dir = Arc::clone(&dir);
            handles.push(std::thread::spawn(move || -> Result<()> {
                let mgr = ConnectionManager::open_registry(dir.path())?;
                let id = format!("t{i}-{}", uuid::Uuid::new_v4());
                mgr.conn.execute(
                    "INSERT INTO wal_test (id, payload) VALUES (?1, ?2)",
                    rusqlite::params![id, format!("thread-{i}")],
                )?;
                Ok(())
            }));
        }
        for h in handles {
            let res = h.join().expect("thread join");
            res.expect(
                "concurrent INSERT under WAL + busy_timeout=5000ms should not return SQLITE_BUSY",
            );
        }

        // Verify both rows landed.
        let mgr = ConnectionManager::open_registry(dir.path()).expect("open_registry verify");
        let count: i64 = mgr
            .conn
            .query_row("SELECT COUNT(*) FROM wal_test", [], |r| r.get(0))
            .expect("count rows");
        assert_eq!(count as usize, n_threads);
    }

    #[test]
    fn attach_lifts_above_default_10() {
        // C14 verification (TL dispatch directive 2026-05-10): the
        // bundled libsqlite3-sys build must lift SQLITE_MAX_ATTACHED
        // above the default 10. If the build-script mechanism does not
        // actually push `-DSQLITE_MAX_ATTACHED=125` into the C build,
        // the 11th ATTACH will fail with "too many attached databases".
        //
        // This test ATTACHes 12 empty scope DBs via raw SQL (bypassing
        // the PermissionSet path so the assertion is unambiguous) and
        // either passes (mechanism honored) or FAILS with a directive
        // message pointing the next worker at the right docs.
        let dir = TempDir::new("c14-attach-12");
        let mgr = ConnectionManager::open_registry(dir.path()).expect("open_registry");

        // Create 12 empty scope DB files.
        let mut aliases = Vec::with_capacity(12);
        let mut paths = Vec::with_capacity(12);
        for i in 0..12u32 {
            let scope_id = fresh_scope_id();
            create_empty_scope_db(dir.path(), &scope_id);
            let p = dir.path().join("scopes").join(format!("{}.db", scope_id.0));
            // Distinct aliases independent of the manager's
            // compute_alias logic — keeps this test resilient to alias
            // refactors and makes the "too many attached" failure mode
            // unambiguous.
            let alias = format!("w_c14_{i:02}");
            aliases.push(alias);
            paths.push(p);
        }

        for (i, (alias, p)) in aliases.iter().zip(paths.iter()).enumerate() {
            let sql = format!("ATTACH DATABASE 'file:{}' AS {}", p.display(), alias);
            let res = mgr.conn.execute(&sql, []);
            if let Err(e) = res {
                let msg = format!("{e}");
                let lower = msg.to_lowercase();
                if lower.contains("too many attached") || lower.contains("max_attached") {
                    panic!(
                        "C14 SQLITE_MAX_ATTACHED ceiling is still at the default 10. The \
                         build-script mechanism does not push the define into the bundled \
                         SQLite C build. Mechanism switch required. See arranger-journal.md \
                         Finding 5 or shutdown-handoff §4 caveat #3. (Failed at ATTACH #{i} \
                         (alias {alias}) with: {e})"
                    );
                } else {
                    panic!("unexpected ATTACH failure at #{i} (alias {alias}): {e}");
                }
            }
        }

        // All 12 ATTACHed successfully — C14 mechanism is honored.
        // Sanity-check via PRAGMA database_list (main + 12 = 13 rows).
        let mut stmt = mgr
            .conn
            .prepare("PRAGMA database_list;")
            .expect("prepare database_list");
        let names: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query_map")
            .map(|r| r.expect("row"))
            .collect();
        for alias in &aliases {
            assert!(
                names.contains(alias),
                "expected alias {alias} in database_list {names:?}"
            );
        }
    }
}
