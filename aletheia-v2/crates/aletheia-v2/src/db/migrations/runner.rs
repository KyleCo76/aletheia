//! Migration runner design — atomicity vs resumability tradeoff (intentional).
//!
//! The per-scope migration loop runs WITHOUT an explicit cross-scope transaction.
//! If the process dies mid-loop, the registry will have partial
//! `migration_scope_progress` rows in `applying` state and no failure record.
//! This is INTENTIONAL: the framework favors RESUMABILITY (the runner can pick
//! up where it left off across process restarts) over ATOMICITY (all-scopes-or-none).
//!
//! Phase 4 (TL-server) is responsible for handling `applying`-state orphans on
//! registry attach: stale rows from crashed processes look identical to in-progress
//! rows; the resume path must check process liveness (PID + hostname + heartbeat)
//! or use a lock convention to distinguish.
//!
//! See `.tl-handoff/2026-05-11-tl-foundation-w1-handoff.md` §6.2 caveat #17 for
//! the full architectural note.

// Phase 2 sub-task B5 — Paused-rollover migration state machine.
//
// The `MigrationRunner` is the Phase-2 contract that Phase 4's
// `start_migration` MCP tool wires through to. It implements the
// paused-rollover state machine documented at plan lines 1180-1209:
//
//     queued → paused_for_writes → applying → (completed | failed)
//
// The `is_applying` flag flips ON at `paused_for_writes` (so concurrent
// tool calls observing the registry block per the C9/IS-8 contract) and
// stays ON through `applying`. On `completed`, `is_applying` flips OFF.
// On `failed`, `is_applying` STAYS ON — safe-hold for manual intervention
// via `force_unlock` (master-key only, audited).
//
// Phase 4 will additionally:
//   - Verify the caller holds a master key before reaching this runner.
//   - Broadcast OS-level "writes paused" alerts via Phase 3's session
//     hooks at the `paused_for_writes` transition.
//   - Drain in-flight writers (≈30s wait window) before flipping to
//     `applying`.
// Those wiring concerns live at the MCP tool layer, not here.

use std::collections::HashMap;
use std::path::Path;
use std::time::Instant;

use chrono::Utc;
use rusqlite::{Connection, params};
use uuid::Uuid;

use crate::db::migrations::scripts::migration_for_version;
use crate::db::migrations::state::{MigrationState, MigrationStatus};
use crate::db::pragmas;
use crate::error::{AletheiaError, Result};

/// Filename for the registry DB inside the configured data dir. Kept as a
/// module-private constant rather than re-exported from `connection.rs`
/// (B4) to avoid creating a cross-worker compile-time dependency in
/// Phase 2; B4's `ConnectionManager::open_registry` will become the
/// canonical entry point in a later phase. See the TODO inside
/// `open_registry`.
const REGISTRY_DB_FILENAME: &str = "scope_registry.db";

/// Open the registry connection at `data_dir/scope_registry.db` with the
/// standard PRAGMA set applied.
///
/// TODO(phase-2-followup): switch to `ConnectionManager::open_registry`
/// once B4 lands. The direct `Connection::open` + `pragmas::apply` here is
/// equivalent for the migration runner's needs (single writer, no scope
/// ATTACHes) and keeps B5 independent of B4 at compile time.
fn open_registry(data_dir: &Path) -> Result<Connection> {
    let path = data_dir.join(REGISTRY_DB_FILENAME);
    let conn = Connection::open(&path)?;
    pragmas::apply(&conn)?;
    Ok(conn)
}

/// Result returned from `MigrationRunner::run`. The runner records each
/// scope's wall-clock duration in `durations_ms` keyed by `scope_id`.
#[derive(Debug, Clone, Default)]
pub struct MigrationReport {
    pub scopes_processed: usize,
    pub scopes_failed: usize,
    pub durations_ms: HashMap<String, u64>,
}

/// Drives the paused-rollover state machine for a `current → target`
/// version step. Phase 4's `start_migration` MCP tool constructs this
/// after verifying the caller holds a master key.
pub struct MigrationRunner<'a> {
    pub data_dir: &'a Path,
    pub current_version: u32,
    pub target_version: u32,
}

impl<'a> MigrationRunner<'a> {
    /// Run the migration.
    ///
    /// State machine (matches plan lines 1180-1209):
    ///
    /// 1. **No-op short-circuit.** If `current_version == target_version`,
    ///    return an empty `MigrationReport` immediately — no DB writes,
    ///    no state-row insertion. Behavior is identical under `dry_run`.
    /// 2. **Queue.** Open the registry DB and INSERT a `migration_state`
    ///    row with `status='queued'`, `is_applying=0`.
    /// 3. **Pause for writes.** UPDATE → `status='paused_for_writes'`,
    ///    `is_applying=1`. (Broadcast and 30s drain are Phase 4 wiring;
    ///    a TODO marks the call site.)
    /// 4. **Apply.** UPDATE → `status='applying'`. Then iterate scopes:
    ///    open a writable per-scope connection, apply the embedded SQL
    ///    script from `migration_for_version(target_version)`, bump
    ///    `PRAGMA user_version`, INSERT a `migration_scope_progress` row.
    /// 5. **Settle.** On all-scopes-success: UPDATE → `status='completed'`,
    ///    `is_applying=0`, populate `completed_at`. On any scope failure:
    ///    UPDATE → `status='failed'`, populate `failed_at` and
    ///    `error_message`. `is_applying` STAYS TRUE on failure
    ///    (safe-hold; clear via `force_unlock`).
    ///
    /// Under `dry_run`, the runner still inserts the `migration_state`
    /// rows (so the audit trail records a dry-run attempt) but does NOT
    /// open per-scope DBs or apply scripts; it short-circuits to
    /// `completed` immediately after the `applying` transition.
    pub fn run(&self, dry_run: bool) -> Result<MigrationReport> {
        // (1) No-op short-circuit. Both dry-run and normal runs return an
        // empty report when versions already match — no DB writes, no
        // state-row insertion. This is the load-bearing contract that
        // lets Phase 4's `start_migration` tool be idempotent w.r.t.
        // already-current data dirs.
        if self.current_version == self.target_version {
            return Ok(MigrationReport::default());
        }

        let conn = open_registry(self.data_dir)?;
        let migration_id = Uuid::new_v4().to_string();
        let source = self.current_version.to_string();
        let target = self.target_version.to_string();

        // (2) Insert queued row.
        conn.execute(
            "INSERT INTO migration_state \
                (migration_id, source_version, target_version, status, is_applying, started_at) \
             VALUES (?1, ?2, ?3, ?4, 0, ?5)",
            params![
                migration_id,
                source,
                target,
                MigrationStatus::Queued.as_str(),
                Utc::now().to_rfc3339(),
            ],
        )?;

        // (3) Pause for writes. Phase 4 inserts the OS-alert broadcast
        // and 30s drain wait between the SQL transition below and the
        // subsequent `applying` transition.
        // TODO(phase-4): broadcast paused-for-writes via Phase 3 session
        // hooks; wait up to 30s for in-flight writers to drain.
        conn.execute(
            "UPDATE migration_state SET status = ?1, is_applying = 1 WHERE migration_id = ?2",
            params![MigrationStatus::PausedForWrites.as_str(), migration_id],
        )?;

        // (4) Apply.
        conn.execute(
            "UPDATE migration_state SET status = ?1 WHERE migration_id = ?2",
            params![MigrationStatus::Applying.as_str(), migration_id],
        )?;

        let mut report = MigrationReport::default();

        // Look up the embedded script for this target. In Phase 2 every
        // target returns `None` (the V2.0.0 baseline has no script). When
        // a future migration registers its script in `scripts.rs`, the
        // per-scope loop below will exercise the apply path.
        let script: Option<&'static str> = migration_for_version(self.target_version);

        if dry_run {
            // Dry-run: skip per-scope apply, record success on the
            // state row, and short-circuit. Per-scope progress rows are
            // not inserted under dry-run (nothing was applied).
            mark_completed(&conn, &migration_id)?;
            return Ok(report);
        }

        // Enumerate scopes. The registry's `scopes` table is the source
        // of truth for which per-scope DBs exist. Archived scopes are
        // skipped — they no longer admit writes.
        let scope_ids: Vec<String> = {
            let mut stmt = conn.prepare(
                "SELECT scope_id FROM scopes WHERE archived_at IS NULL ORDER BY scope_id",
            )?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };

        for scope_id in &scope_ids {
            let started = Instant::now();

            // Insert a per-scope progress row in 'applying' state.
            conn.execute(
                "INSERT INTO migration_scope_progress \
                    (migration_id, scope_id, status, started_at) \
                 VALUES (?1, ?2, 'applying', ?3)",
                params![migration_id, scope_id, Utc::now().to_rfc3339()],
            )?;

            // Apply the script to the per-scope DB (if any).
            // TODO(phase-2-followup): once B4's `ConnectionManager` is
            // available, open the per-scope DB through it (so attach /
            // PRAGMA discipline goes through the canonical entry point).
            let scope_result: Result<()> = (|| {
                if let Some(sql) = script {
                    let scope_db_path = self.data_dir.join("scopes").join(format!("{scope_id}.db"));
                    let scope_conn = Connection::open(&scope_db_path)?;
                    pragmas::apply(&scope_conn)?;
                    scope_conn.execute_batch(sql)?;
                    scope_conn
                        .execute_batch(&format!("PRAGMA user_version = {}", self.target_version))?;
                }
                Ok(())
            })();

            let elapsed_ms = started.elapsed().as_millis() as u64;
            report.durations_ms.insert(scope_id.clone(), elapsed_ms);

            match scope_result {
                Ok(()) => {
                    conn.execute(
                        "UPDATE migration_scope_progress \
                         SET status = 'completed', completed_at = ?1 \
                         WHERE migration_id = ?2 AND scope_id = ?3",
                        params![Utc::now().to_rfc3339(), migration_id, scope_id],
                    )?;
                    report.scopes_processed += 1;
                }
                Err(e) => {
                    let err_msg = e.to_string();
                    conn.execute(
                        "UPDATE migration_scope_progress \
                         SET status = 'failed', error_message = ?1 \
                         WHERE migration_id = ?2 AND scope_id = ?3",
                        params![err_msg, migration_id, scope_id],
                    )?;
                    report.scopes_failed += 1;
                    // Visible-failure principle: if bookkeeping itself fails, log it and propagate
                    // the ORIGINAL scope error. Never swallow the original failure in a cleanup path.
                    if let Err(bk) = mark_failed(&conn, &migration_id, &err_msg) {
                        tracing::error!(
                            migration_id = %migration_id,
                            bookkeeping_error = %bk,
                            "scope migration failed and bookkeeping update also failed; \
                             propagating original scope error"
                        );
                    }
                    return Err(e);
                }
            }
        }

        // (5) Settle on success.
        mark_completed(&conn, &migration_id)?;
        Ok(report)
    }
}

/// Mark the migration row as completed: `status='completed'`,
/// `is_applying=0`, `completed_at=now`.
fn mark_completed(conn: &Connection, migration_id: &str) -> Result<()> {
    conn.execute(
        "UPDATE migration_state \
         SET status = ?1, is_applying = 0, completed_at = ?2 \
         WHERE migration_id = ?3",
        params![
            MigrationStatus::Completed.as_str(),
            Utc::now().to_rfc3339(),
            migration_id,
        ],
    )?;
    Ok(())
}

/// Mark the migration row as failed: `status='failed'`, `is_applying`
/// stays at 1 (safe-hold for manual intervention), `failed_at=now`,
/// `error_message` populated.
fn mark_failed(conn: &Connection, migration_id: &str, error_message: &str) -> Result<()> {
    conn.execute(
        "UPDATE migration_state \
         SET status = ?1, failed_at = ?2, error_message = ?3 \
         WHERE migration_id = ?4",
        params![
            MigrationStatus::Failed.as_str(),
            Utc::now().to_rfc3339(),
            error_message,
            migration_id,
        ],
    )?;
    Ok(())
}

/// Decode the single in-progress (or last-known) migration row from the
/// registry. Returns `None` if the table is empty. Used by the public
/// `get_migration_status` wrapper in `mod.rs`.
pub(crate) fn load_latest_migration_state(conn: &Connection) -> Result<Option<MigrationState>> {
    let mut stmt = conn.prepare(
        "SELECT migration_id, source_version, target_version, status, is_applying, \
                started_at, completed_at, failed_at, error_message, \
                initiated_by_key_hash, details \
         FROM migration_state \
         ORDER BY COALESCE(failed_at, completed_at, started_at) DESC \
         LIMIT 1",
    )?;
    let mut rows = stmt.query([])?;
    let Some(row) = rows.next()? else {
        return Ok(None);
    };

    let status_str: String = row.get(3)?;
    let status: MigrationStatus = status_str
        .parse()
        .map_err(|e: AletheiaError| AletheiaError::Other(e.to_string()))?;
    let is_applying: i64 = row.get(4)?;

    // Timestamp columns are stored as RFC3339 strings (see `started_at`
    // bindings in `run`); decode tolerantly so legacy/manual rows in
    // CURRENT_TIMESTAMP form don't blow up reads.
    fn parse_ts(s: Option<String>) -> Option<chrono::DateTime<chrono::Utc>> {
        s.as_deref()
            .and_then(|raw| chrono::DateTime::parse_from_rfc3339(raw).ok())
            .map(|dt| dt.with_timezone(&chrono::Utc))
    }

    Ok(Some(MigrationState {
        migration_id: row.get(0)?,
        source_version: row.get(1)?,
        target_version: row.get(2)?,
        status,
        is_applying: is_applying != 0,
        started_at: parse_ts(row.get::<_, Option<String>>(5)?),
        completed_at: parse_ts(row.get::<_, Option<String>>(6)?),
        failed_at: parse_ts(row.get::<_, Option<String>>(7)?),
        error_message: row.get(8)?,
        initiated_by_key_hash: row.get(9)?,
        details: row.get(10)?,
    }))
}

/// Clear the safe-hold lock left behind by a failed migration. Sets
/// `is_applying=0` on every row whose status is `failed`. Master-key
/// gating is enforced at the MCP tool layer (Phase 4), not here.
pub(crate) fn clear_safe_hold(conn: &Connection) -> Result<()> {
    conn.execute(
        "UPDATE migration_state SET is_applying = 0 WHERE status = ?1 AND is_applying = 1",
        params![MigrationStatus::Failed.as_str()],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::registry_schema;
    use std::path::PathBuf;

    /// Generate a unique temp dir path for a per-test data dir. Tests
    /// clean up explicitly at the end. Mirrors the convention in
    /// `pragmas.rs` since `tempfile` is not in workspace deps.
    fn unique_data_dir(label: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "aletheia-v2-runner-test-{}-{}",
            label,
            Uuid::new_v4()
        ));
        std::fs::create_dir_all(&p).expect("create temp data dir");
        p
    }

    fn cleanup(p: &PathBuf) {
        let _ = std::fs::remove_dir_all(p);
    }

    /// Create `scope_registry.db` inside `data_dir` with the full registry
    /// schema installed. Used by the no-op tests to set up just enough
    /// state for the runner to find a valid registry (or, in the no-op
    /// case, to verify the runner *doesn't* touch it).
    fn make_registry(data_dir: &Path) {
        let path = data_dir.join(REGISTRY_DB_FILENAME);
        let conn = Connection::open(&path).expect("open registry db");
        pragmas::apply(&conn).expect("apply pragmas");
        registry_schema::install_all(&conn).expect("install_all");
    }

    /// When `current_version == target_version`, dry-run is a no-op:
    /// returns an empty report and writes nothing to `migration_state`.
    /// This is the load-bearing idempotency contract for Phase 4's
    /// `start_migration` tool — it can be called against an
    /// already-current data dir without any side effects.
    #[test]
    fn dry_run_no_op_when_current_equals_target() {
        let data_dir = unique_data_dir("dry-noop");
        make_registry(&data_dir);

        let runner = MigrationRunner {
            data_dir: &data_dir,
            current_version: 1,
            target_version: 1,
        };
        let report = runner.run(true).expect("run should succeed");

        assert_eq!(report.scopes_processed, 0, "no scopes touched");
        assert_eq!(report.scopes_failed, 0, "no failures");
        assert!(report.durations_ms.is_empty(), "no durations recorded");

        // Confirm no DB writes occurred.
        let conn = Connection::open(data_dir.join(REGISTRY_DB_FILENAME)).expect("reopen registry");
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM migration_state", [], |r| r.get(0))
            .expect("count migration_state");
        assert_eq!(count, 0, "no migration_state rows written under no-op");

        cleanup(&data_dir);
    }

    /// Non-dry-run also short-circuits to no-op when versions match. The
    /// runner must not write a `queued` row just to immediately mark it
    /// `completed` — the contract is "no work to do, no audit trail."
    #[test]
    fn dry_run_no_op_when_current_equals_target_non_dry() {
        let data_dir = unique_data_dir("real-noop");
        make_registry(&data_dir);

        let runner = MigrationRunner {
            data_dir: &data_dir,
            current_version: 1,
            target_version: 1,
        };
        let report = runner.run(false).expect("run should succeed");

        assert_eq!(report.scopes_processed, 0, "no scopes touched");
        assert_eq!(report.scopes_failed, 0, "no failures");
        assert!(report.durations_ms.is_empty(), "no durations recorded");

        let conn = Connection::open(data_dir.join(REGISTRY_DB_FILENAME)).expect("reopen registry");
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM migration_state", [], |r| r.get(0))
            .expect("count migration_state");
        assert_eq!(count, 0, "no migration_state rows written under no-op");

        cleanup(&data_dir);
    }
}
