// Phase 2 sub-task B5 — Public surface for the migration framework.
//
// Submodules:
//   - `state`   — `MigrationState`, `MigrationScopeProgress`, `MigrationStatus`
//   - `scripts` — embedded SQL scripts + `migration_for_version` dispatch
//   - `runner`  — `MigrationRunner` + `MigrationReport` (state machine)
//
// The thin public-API wrappers below (`start_migration`,
// `get_migration_status`, `force_unlock`, `resume_migration`) are what
// Phase 4's MCP tool layer wires into. Each wrapper constructs the
// minimum scaffolding around the runner so the tool layer is concerned
// only with auth/argument decoding, not with state-machine plumbing.
// Master-key gating for `force_unlock` is enforced at the MCP tool layer
// (per the IS-8 contract), NOT here.

pub mod runner;
pub mod scripts;
pub mod state;

pub use runner::{MigrationReport, MigrationRunner};
pub use state::{MigrationScopeProgress, MigrationState, MigrationStatus};

use std::path::Path;

use rusqlite::Connection;

use crate::db::pragmas;
use crate::error::Result;

/// Filename for the registry DB inside the configured data dir. Mirrors
/// the constant in `runner.rs`; kept private here so the duplication is
/// confined to the two call sites that need it before B4's
/// `ConnectionManager` lands.
const REGISTRY_DB_FILENAME: &str = "scope_registry.db";

fn open_registry(data_dir: &Path) -> Result<Connection> {
    let path = data_dir.join(REGISTRY_DB_FILENAME);
    let conn = Connection::open(&path)?;
    pragmas::apply(&conn)?;
    Ok(conn)
}

/// Start a migration from the current registry-recorded version to
/// `target_version`. Phase 4's `start_migration` MCP tool calls this
/// after verifying the caller holds a master key.
///
/// The current version is read from the registry's `PRAGMA user_version`
/// (set by `registry_schema::install_all`). The runner short-circuits
/// when `current_version == target_version`, so callers can invoke this
/// idempotently against an already-current data dir.
pub fn start_migration(
    data_dir: &Path,
    target_version: u32,
    dry_run: bool,
) -> Result<MigrationReport> {
    let current_version: u32 = {
        let conn = open_registry(data_dir)?;
        conn.query_row("PRAGMA user_version", [], |row| row.get(0))?
    };

    let runner = MigrationRunner {
        data_dir,
        current_version,
        target_version,
    };
    runner.run(dry_run)
}

/// Read the most recent migration state row from the registry, if any.
/// Returns `Ok(None)` when no migration has ever been started against
/// this data dir.
pub fn get_migration_status(data_dir: &Path) -> Result<Option<MigrationState>> {
    let conn = open_registry(data_dir)?;
    runner::load_latest_migration_state(&conn)
}

/// Clear the safe-hold lock left behind by a failed migration. The
/// master-key gating for this operation is enforced at the MCP tool
/// layer (Phase 4); this helper assumes the caller has already
/// authorized the unlock.
pub fn force_unlock(data_dir: &Path) -> Result<()> {
    let conn = open_registry(data_dir)?;
    runner::clear_safe_hold(&conn)
}

/// Resume a previously paused/failed migration. Phase 2 leaves this as a
/// stub — resume semantics depend on Phase 4's drain/broadcast wiring
/// and Phase 3's session-hook integration, both of which need to land
/// before a resumable runner can be implemented.
pub fn resume_migration(_data_dir: &Path) -> Result<MigrationReport> {
    unimplemented!("resume_migration is wired in Phase 4 after drain/broadcast support lands")
}
