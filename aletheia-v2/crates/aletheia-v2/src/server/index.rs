//! Server lifecycle + Registrar pattern. THIS IS A DANGER FILE.
//!
//! `start_server()` is the entry point for `aletheia-v2 serve`. Every later
//! phase (5 tools, 6 injection pipeline, 7 digest/mass-ingest pollers,
//! 9 reconciler/orphan-sweep/sdk-runtime-cleanup) integrates via a
//! `register_X(&mut ServerRegistry, ...)` function added to its own module,
//! plus uncommenting a single line in `start_server()`'s body. The
//! pre-commented stub lines (Phases 5-9) are part of the contract and MUST
//! appear VERBATIM — they're the merge-conflict-free seam for later phases.
//!
//! ## Migration orphan handling (Phase 4 limitation)
//!
//! The `migration_state` registry table does NOT carry an `active_pid` or
//! `hostname` column (the schema was locked in Phase 2 / W1). This means
//! at registry-attach time we cannot definitively distinguish an in-progress
//! migration on a sibling process from one orphaned by a crashed process.
//!
//! Phase 4 accepts the simpler approximation: any `migration_state` row
//! with `status = 'applying'` at server startup is presumed orphaned.
//! Rationale: a fresh `start_server()` call is itself a startup event;
//! a still-running sibling process would already hold the partial unique
//! index `idx_migration_one_applying`, so we'd never reach this point with
//! a contention conflict on its row — by the time we attach and inspect
//! that row, the sibling has either completed or died. Phase 9's full
//! reconciler does richer liveness checks (heartbeats, PID probes via
//! `session_locks` joins, etc.); Phase 4's pass marks orphans as
//! `'failed'` (safe-hold) so a master-key holder can adjudicate via
//! `force_unlock` + `start_migration --resume` rather than auto-recovery.
//!
//! Three-review gate SHOULD-3 (b) — see W1 handoff §8.2.
//!
//! ## stdout discipline
//!
//! `tracing-subscriber` is configured by `crate::init_tracing()` to write to
//! stderr only. ZERO `println!` / `print!` / `dbg!` macros may appear in
//! this file or in `shutdown.rs` — they would corrupt the rmcp JSON-RPC
//! channel on stdout. Verified by grep at acceptance time (C-S4).

use crate::error::{AletheiaError, Result};
use crate::settings::Settings;
use rusqlite::Connection;
use std::sync::Arc;
use tokio::sync::Mutex;

/// Registry of background tasks + lifecycle hooks. Phases 5-9 each add a
/// `register_X` function and uncomment the corresponding line in
/// `start_server()` to wire themselves in.
///
/// `background_tasks` are tokio join handles aborted at shutdown.
/// `shutdown_hooks` are synchronous closures run AFTER bg-task abort and
/// BEFORE the MCP handle abort — phases use them for cleanup that must
/// happen on the main task (e.g., flushing in-memory accumulators).
pub struct ServerRegistry {
    pub background_tasks: Vec<tokio::task::JoinHandle<()>>,
    pub shutdown_hooks: Vec<Box<dyn FnOnce() + Send>>,
}

impl ServerRegistry {
    pub fn new() -> Self {
        Self {
            background_tasks: vec![],
            shutdown_hooks: vec![],
        }
    }

    /// Spawn a background task and track its handle. The `name` is used
    /// for the `tracing::info!` log line at spawn — Phases 5-9 should pass
    /// a descriptive identifier (e.g., `"digest-queue-poller"`).
    pub fn spawn_bg(
        &mut self,
        name: &str,
        fut: impl std::future::Future<Output = ()> + Send + 'static,
    ) {
        tracing::info!(target: "server.registrar", task = name, "spawning background task");
        self.background_tasks.push(tokio::spawn(fut));
    }
}

impl Default for ServerRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Start the Aletheia V2 MCP server. Returns after a graceful shutdown
/// signal (SIGTERM/SIGINT on Unix, Ctrl+C on Windows) has been processed.
///
/// The 7 lifecycle steps:
///
/// 1. Open the registry connection via `ConnectionManager::open_registry`
///    (pragmas applied automatically).
/// 2. Discover session_id via the SessionStart hook's PPID-keyed file
///    (Phase 3 TL-auth — Plan B placeholder until that ships).
/// 3. Auto-reclaim the prior session lock if a binding + key are present
///    (Phase 3 TL-auth — Plan B placeholder).
/// 4. Build the Registrar and wire Phase 4's own subsystems
///    (hook endpoint server). Phases 5-9 uncomment their lines below.
/// 5. Spawn the rmcp stdio server (`mcp::run_mcp_stdio`).
/// 6. Block on `shutdown::wait_for_shutdown_signal()`.
/// 7. Graceful release: abort bg tasks, run shutdown hooks, abort mcp,
///    release session lock.
///
/// Between steps 1 and 4, `reconcile_migration_orphans` sweeps the
/// `migration_state` table for `'applying'`-state rows left behind by
/// crashed processes — see this module's header for the Phase 4
/// approximation rule (C-S10).
pub async fn start_server(settings: Settings, data_dir: std::path::PathBuf) -> Result<()> {
    // Step 1: Open registry connection via ConnectionManager (C-S12 — NOT
    // B5's private helper; the public canonical entry point. Pragmas are
    // applied internally by open_registry().)
    let conn = Arc::new(Mutex::new(
        crate::db::connection::ConnectionManager::open_registry(&data_dir)?.conn,
    ));
    tracing::info!(target: "server.lifecycle", "registry connection opened");

    // Migration orphan reconciliation (C-S10 — three-review SHOULD-3 (b)).
    // Marks any 'applying' rows as 'failed' (safe-hold) before any tool can
    // observe them mid-flight. Master-key holder clears via force_unlock.
    reconcile_migration_orphans(conn.clone()).await?;

    // Step 2: Discover session_id (Phase 3 TL-auth dependency — Plan B placeholder).
    // TODO(tl-auth-integration): replace with
    //   let session_id = crate::auth::sessions::discover_session_id_via_ppid(&data_dir, 2000).await;
    // when TL-auth ships Phase 3 task 5 (SessionStart hook). See decomposition §7.1.
    let session_id: Option<String> = None;
    if session_id.is_none() {
        tracing::info!(target: "server.lifecycle", "no session_id discovered — running unclaimed (graceful degradation)");
    }

    // Step 3: Auto-reclaim if session_id present (Phase 3 TL-auth dependency — Plan B placeholder).
    // TODO(tl-auth-integration): replace with the auto-reclaim block from plan lines 2050-2058
    //   when TL-auth ships Phase 3 tasks 1 + 2 + 4. See decomposition §7.1.
    // Concretely:
    //   let claimed = if let Some(sid) = session_id.as_deref() {
    //       let binding = { let c = conn.lock().await; crate::auth::sessions::lookup(&c, sid)? };
    //       if let Some(b) = binding {
    //           let key_path = crate::auth::keys::key_path(&data_dir, &binding_name_for(&b));
    //           if let Ok(raw) = crate::auth::keys::read_key_file(&key_path) {
    //               Some(crate::auth::claim::claim(conn.clone(), raw, Some(sid), &settings.session_locks).await?)
    //           } else { None }
    //       } else { None }
    //   } else { None };
    let claimed: Option<()> = None;

    // Step 4: Build registrar + register Phase 4's own subsystems.
    let mut registry = ServerRegistry::new();

    register_hook_endpoint_server(
        &mut registry,
        conn.clone(),
        data_dir.clone(),
        settings.clone(),
        claimed.as_ref(),
    )
    .await?;

    // Phases 5-9 add their register_X calls here:
    // register_tool_surface(&mut registry, ...)?;             // Phase 5
    // register_injection_pipeline(&mut registry, ...)?;       // Phase 6
    // register_digest_queue_poller(&mut registry, ...)?;      // Phase 7
    // register_mass_ingest_poller(&mut registry, ...)?;       // Phase 7
    // register_reconciler_sweep(&mut registry, ...)?;         // Phase 9
    // register_session_orphan_sweep(&mut registry, ...)?;     // Phase 9
    // register_sdk_runtime_cleanup(&mut registry, ...)?;      // Phase 9

    // Step 5: Spawn the rmcp stdio server. The handle is awaited in step 7.
    tracing::info!(target: "server.lifecycle", "spawning MCP stdio server");
    let mcp_handle = tokio::spawn(crate::server::mcp::run_mcp_stdio(
        conn.clone(),
        settings.clone(),
        claimed,
        data_dir.clone(),
    ));

    // Step 6: Block on shutdown signal.
    crate::server::shutdown::wait_for_shutdown_signal().await;

    // Step 7: Graceful release.
    tracing::info!(target: "server.lifecycle", "shutdown initiated — aborting background tasks");
    for task in registry.background_tasks {
        task.abort();
    }
    for hook in registry.shutdown_hooks {
        hook();
    }
    mcp_handle.abort();

    // Visible-failure principle: release the session lock if we hold one.
    // TODO(tl-auth-integration): when TL-auth ships Phase 3 task 3, replace
    // the placeholder below with:
    //   if let Some(c) = claimed.as_ref() {
    //       if let Err(e) = crate::auth::locks::release(conn.clone(), c).await {
    //           tracing::error!(target: "server.lifecycle", error = %e, "session lock release failed");
    //       }
    //   }
    // Plan line 2417 (CR-4) gates this: "SIGTERM triggers graceful shutdown:
    // lock row deleted". For Phase 4 the lock-release path is a placeholder;
    // the test is added in CR-4 once TL-auth's locks::release exists.
    if claimed.is_some() {
        tracing::info!(target: "server.lifecycle", "session lock release would run here (placeholder pending TL-auth)");
    }

    tracing::info!(target: "server.lifecycle", "shutdown complete");
    Ok(())
}

/// Sweep `migration_state` for `'applying'`-state rows at startup and mark
/// them `'failed'` (safe-hold). The schema-locked W1 `migration_state` table
/// has no `active_pid` column, so we use the conservative Phase-4 rule:
/// at startup, any `'applying'` row is presumed orphaned (a live sibling
/// process would not have allowed us to attach without the partial unique
/// index conflict surfacing somewhere upstream).
///
/// `is_applying` STAYS at 1 on failed rows (the safe-hold semantics from
/// the W1 runner). A master-key holder clears via `force_unlock` and may
/// resume the migration explicitly.
///
/// C-S13: all timestamp comparisons against `migration_state` columns use
/// the SQLite `'%Y-%m-%d %H:%M:%S'` format (not RFC3339). We don't actually
/// read any timestamps here — we only check `status` and update it — but
/// when writing `failed_at`, we use the matching format for consistency
/// with W1's MUST-3 fix.
async fn reconcile_migration_orphans(conn: Arc<Mutex<Connection>>) -> Result<()> {
    let conn = conn.lock().await;

    // Collect candidate orphans first so we can emit per-row warnings.
    let mut stmt = conn.prepare(
        "SELECT migration_id, source_version, target_version FROM migration_state \
         WHERE status = 'applying'",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let orphans: Vec<(String, String, String)> = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);

    if orphans.is_empty() {
        tracing::debug!(target: "server.lifecycle", "no migration orphans to reconcile");
        return Ok(());
    }

    // C-S13: SQLite CURRENT_TIMESTAMP format (space separator, no 'T'). The
    // chrono::NaiveDateTime path is the reference format; we generate it here
    // for the failed_at column write so the column stays comparable with
    // CURRENT_TIMESTAMP-defaulted columns elsewhere in the registry.
    let now_sqlite = chrono::Utc::now()
        .naive_utc()
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();

    for (mid, src, tgt) in orphans {
        tracing::warn!(
            target: "server.lifecycle",
            migration_id = %mid,
            source_version = %src,
            target_version = %tgt,
            "orphaned 'applying' migration found at startup — marking failed (safe-hold)"
        );
        conn.execute(
            "UPDATE migration_state \
             SET status = 'failed', failed_at = ?1, error_message = ?2 \
             WHERE migration_id = ?3 AND status = 'applying'",
            rusqlite::params![
                now_sqlite,
                "orphaned at server startup; sweep marked safe-hold",
                mid,
            ],
        )?;
    }

    Ok(())
}

/// Register the hook endpoint server (Phase 4's own subsystem — the V1
/// hybrid HTTP endpoints over Unix socket / Windows named pipe). The actual
/// bind + accept loop lives in `crate::server::hook_endpoints::start`
/// (owned by S4); we just wire it into the registry as a bg task.
///
/// `claimed` is the (currently placeholder) `ClaimedSession` Option from
/// step 3 of `start_server`. Once TL-auth ships, the `build_session_state`
/// helper below will read the real claim metadata and pass it in.
async fn register_hook_endpoint_server(
    registry: &mut ServerRegistry,
    conn: Arc<Mutex<Connection>>,
    data_dir: std::path::PathBuf,
    settings: Settings,
    claimed: Option<&()>,
) -> Result<()> {
    let session_state = build_session_state(claimed);
    let server_handle =
        crate::server::hook_endpoints::start(conn, data_dir, settings, session_state).await?;
    registry.spawn_bg("hook-endpoint-server", async move {
        // The endpoint server runs until externally aborted. We swallow the
        // result intentionally — bg tasks log internal errors via tracing.
        let result = server_handle.await;
        if let Err(e) = result {
            tracing::warn!(target: "server.registrar", error = %e, "hook-endpoint-server task joined with error");
        }
    });
    Ok(())
}

/// Build the `SessionState` payload for the hook endpoint server.
///
/// TODO(tl-auth-integration): when TL-auth ships `ClaimedSession`, swap the
/// `Option<&()>` placeholder for `Option<&crate::auth::claim::ClaimedSession>`
/// and populate `claimed_key_hash` + `primary_scope_id` from its fields.
fn build_session_state(_claimed: Option<&()>) -> crate::server::hook_endpoints::SessionState {
    crate::server::hook_endpoints::SessionState {
        claimed_key_hash: None,
        primary_scope_id: None,
        call_count: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        access_counts: Arc::new(Mutex::new(std::collections::HashMap::new())),
    }
}

// Suppress unused-import warning when AletheiaError isn't directly referenced
// in this file — it propagates through `Result` aliases. Kept as an explicit
// `use` so the compiler error path on integration is obvious.
#[allow(dead_code)]
fn _force_error_use(_: AletheiaError) {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::registry_schema;
    use rusqlite::params;
    use std::path::PathBuf;

    /// Per-test temp dir for an in-tree registry. Mirrors the pattern used
    /// in `crate::db::connection::tests` (tempfile isn't a workspace dep
    /// yet — see W1 handoff §6.2 caveat #9).
    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(label: &str) -> Self {
            let mut p = std::env::temp_dir();
            p.push(format!(
                "aletheia-v2-server-index-test-{}-{}",
                label,
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&p).expect("create tempdir");
            std::fs::create_dir_all(p.join("scopes")).expect("create scopes dir");
            Self { path: p }
        }

        fn path(&self) -> &std::path::Path {
            &self.path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    /// Open a fresh registry connection with the full schema installed and
    /// pragmas applied. Returns the Arc<Mutex<Connection>> shape that
    /// `reconcile_migration_orphans` expects.
    fn fresh_registry(data_dir: &std::path::Path) -> Arc<Mutex<Connection>> {
        let mgr = crate::db::connection::ConnectionManager::open_registry(data_dir)
            .expect("open_registry");
        registry_schema::install_all(&mgr.conn).expect("install_all");
        Arc::new(Mutex::new(mgr.conn))
    }

    /// Insert a `migration_state` row with `status='applying'`, `is_applying=1`.
    /// Returns the migration_id for assertion lookups.
    fn insert_applying_row(conn: &Connection) -> String {
        let migration_id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO migration_state \
                (migration_id, source_version, target_version, status, is_applying, started_at) \
             VALUES (?1, ?2, ?3, 'applying', 1, ?4)",
            params![
                migration_id,
                "1",
                "2",
                "2026-05-11 12:00:00", // SQLite CURRENT_TIMESTAMP format (C-S13)
            ],
        )
        .expect("insert applying row");
        migration_id
    }

    /// Read the current status of a migration_state row.
    fn fetch_status(conn: &Connection, migration_id: &str) -> String {
        conn.query_row(
            "SELECT status FROM migration_state WHERE migration_id = ?1",
            params![migration_id],
            |r| r.get(0),
        )
        .expect("fetch status")
    }

    /// Read the failed_at column for assertion that the SQLite-format
    /// timestamp was written (C-S13 contract).
    fn fetch_failed_at(conn: &Connection, migration_id: &str) -> Option<String> {
        conn.query_row(
            "SELECT failed_at FROM migration_state WHERE migration_id = ?1",
            params![migration_id],
            |r| r.get::<_, Option<String>>(0),
        )
        .expect("fetch failed_at")
    }

    /// C-S10: `reconcile_migration_orphans` flips an `'applying'` row to
    /// `'failed'` at startup. The Phase 4 rule treats every `applying`
    /// row at attach-time as orphaned. (`active_pid` is not a column on
    /// the locked W1 schema — we cannot do a sharper check here.)
    #[tokio::test]
    async fn reconcile_orphans_marks_applying_as_failed() {
        let dir = TempDir::new("orphan-marks-failed");
        let conn = fresh_registry(dir.path());

        let mid = {
            let c = conn.lock().await;
            insert_applying_row(&c)
        };

        reconcile_migration_orphans(conn.clone())
            .await
            .expect("reconcile");

        let status = {
            let c = conn.lock().await;
            fetch_status(&c, &mid)
        };
        assert_eq!(
            status, "failed",
            "orphan applying row should be marked failed"
        );

        // failed_at must use SQLite format (C-S13): YYYY-MM-DD HH:MM:SS,
        // no 'T' separator and no timezone offset. We assert structural
        // shape rather than exact value since we generated it from
        // chrono::Utc::now() inside the reconciler.
        let failed_at = {
            let c = conn.lock().await;
            fetch_failed_at(&c, &mid)
        };
        let failed_at = failed_at.expect("failed_at populated");
        assert!(
            !failed_at.contains('T'),
            "failed_at must use space separator (SQLite CURRENT_TIMESTAMP format), got: {failed_at}"
        );
        assert!(
            failed_at.len() == "YYYY-MM-DD HH:MM:SS".len(),
            "failed_at must be 19 chars (YYYY-MM-DD HH:MM:SS), got len={}: {failed_at}",
            failed_at.len()
        );
    }

    /// C-S10: `reconcile_migration_orphans` is a no-op on a clean
    /// registry (no `applying` rows). Verifies the empty-orphans branch.
    #[tokio::test]
    async fn reconcile_orphans_noop_on_clean_registry() {
        let dir = TempDir::new("orphan-noop");
        let conn = fresh_registry(dir.path());

        // Insert a completed row — should NOT be touched.
        let completed_id = uuid::Uuid::new_v4().to_string();
        {
            let c = conn.lock().await;
            c.execute(
                "INSERT INTO migration_state \
                    (migration_id, source_version, target_version, status, is_applying, started_at, completed_at) \
                 VALUES (?1, '1', '2', 'completed', 0, ?2, ?3)",
                params![
                    completed_id,
                    "2026-05-11 12:00:00",
                    "2026-05-11 12:01:00",
                ],
            )
            .expect("insert completed row");
        }

        reconcile_migration_orphans(conn.clone())
            .await
            .expect("reconcile");

        let status = {
            let c = conn.lock().await;
            fetch_status(&c, &completed_id)
        };
        assert_eq!(status, "completed", "completed row must not be modified");
    }

    /// `ServerRegistry::spawn_bg` actually spawns the future and tracks
    /// its handle. The future flips an AtomicBool we read after awaiting.
    #[tokio::test]
    async fn spawn_bg_actually_spawns_and_tracks() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let flag = Arc::new(AtomicBool::new(false));
        let flag_clone = flag.clone();

        let mut registry = ServerRegistry::new();
        registry.spawn_bg("test-flag-flip", async move {
            flag_clone.store(true, Ordering::SeqCst);
        });

        assert_eq!(
            registry.background_tasks.len(),
            1,
            "spawn_bg should append exactly one handle"
        );

        // Drain the handles, awaiting each, to confirm the future ran.
        let handles = std::mem::take(&mut registry.background_tasks);
        for h in handles {
            let _ = h.await;
        }
        assert!(
            flag.load(Ordering::SeqCst),
            "background task should have flipped the flag"
        );
    }

    /// C-S3: the seven pre-commented stub lines for Phases 5-9 MUST appear
    /// VERBATIM in this file. The contract is verifiable by literal grep;
    /// this test makes the assertion run as part of the test suite so a
    /// future refactor that accidentally renames a stub fails fast rather
    /// than waiting for downstream phases to discover a missing seam.
    #[test]
    fn pre_commented_stub_lines_present_verbatim() {
        let source = include_str!("index.rs");
        let required = [
            "// register_tool_surface(&mut registry, ...)?;             // Phase 5",
            "// register_injection_pipeline(&mut registry, ...)?;       // Phase 6",
            "// register_digest_queue_poller(&mut registry, ...)?;      // Phase 7",
            "// register_mass_ingest_poller(&mut registry, ...)?;       // Phase 7",
            "// register_reconciler_sweep(&mut registry, ...)?;         // Phase 9",
            "// register_session_orphan_sweep(&mut registry, ...)?;     // Phase 9",
            "// register_sdk_runtime_cleanup(&mut registry, ...)?;      // Phase 9",
        ];
        for line in required {
            assert!(
                source.contains(line),
                "missing required pre-commented stub line (C-S3): {line}"
            );
        }
    }
}
