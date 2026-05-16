//! Phase 3 W4 — top-level claim flow (plan lines 1714-1797).
//!
//! This module composes Wave A's outputs (`keys::lookup_by_hash`,
//! `sessions::bind`, `locks::acquire`) into the `ClaimedSession` value
//! that Phase 4 (TL-server) returns to MCP clients. The claim flow is
//! the single entry point that:
//!
//! 1. Hashes the raw key material the user presented (C2).
//! 2. Looks up the matching `keys` row and rejects revoked / unknown
//!    keys with structured `AletheiaError::Auth` errors (C7).
//! 3. Builds the `PermissionSet` snapshot that Phase 5 write handlers
//!    consult before any DB write (IS-3 / C5).
//! 4. Optionally binds + locks a `session_id` so the session is
//!    auto-reclaimable on next launch and split-brain-safe (IS-3 / C3).
//! 5. Emits an `auth.claim` audit event (C12).
//!
//! ## C2 — SHA-256 hashing
//!
//! Hashing is delegated to `keys::hash_key`; this module does not call
//! `Sha256` directly. The raw `KeyValue` never lands in any column on
//! the way out of this function (C1, enforced by `keys::lookup_by_hash`
//! which only ever binds the hex digest).
//!
//! ## C5 — `PermissionSet` documentation surface (IS-3)
//!
//! `ClaimedSession::permission_set` is the IS-3 integration point.
//! Phase 5 write handlers MUST check
//! `permission_set.writable_scope_ids.contains(&target_scope)` before
//! any DB write. Read handlers check both writable and readonly sets.
//! See plan lines 1903 / IS-3.
//!
//! ## C6 — ScopeId defense-in-depth
//!
//! No new `ScopeId` values are constructed from raw strings in this
//! module; the values flow from `KeyRecord`, where `keys::lookup_by_hash`
//! already routes every scope_id through `ScopeId::new`.
//!
//! ## C7 — visible-failure on lock conflict
//!
//! The conflict error format is mandatory: it MUST contain the foreign
//! PID, hostname, and last-heartbeat timestamp, with the wording in
//! `claim_conflict_returns_formatted_error_with_pid_hostname` test.
//!
//! ## C8 — no `println!` / `print!` / `dbg!`
//!
//! This module is silent on the happy path. If transient logging is
//! ever needed it should use `tracing::debug!` (stderr).
//!
//! ## C12 — audit vocabulary
//!
//! - `claim()` emits `auth.claim` after a successful lookup + (optional)
//!   lock acquire.
//! - `whoami()` emits `auth.whoami` after a successful (non-revoked)
//!   lookup.
//! - `refresh_claim()` deliberately does NOT emit; per CR-3 known-risk
//!   #5 it's a thin pass-through used on every write-path precheck and
//!   emitting would spam the audit log.
//!
//! ## C13 — no new connections
//!
//! All functions take `Arc<Mutex<Connection>>` and acquire the inner
//! lock per call site; none of them open a fresh `rusqlite::Connection`.

use std::sync::Arc;
use tokio::sync::Mutex;

use rusqlite::{Connection, OptionalExtension};

use crate::auth::keys::{self, KeyRecord};
use crate::auth::locks::{self, LockAcquireResult, LockHandle};
use crate::auth::sessions;
use crate::db::audit_log;
use crate::error::{AletheiaError, Result};
use crate::settings::SessionLocksSettings;
use crate::types::audit::AuditEventCategory;
use crate::types::key::{KeyHash, KeyValue};
use crate::types::scope::PermissionSet;

/// Value returned by `claim()`.
///
/// Phase 4 (TL-server) hands this to the MCP request handler; Phase 5
/// (TL-tools) reads `permission_set` on every write path.
#[derive(Debug)]
pub struct ClaimedSession {
    /// The full `keys` row that matched the presented raw key.
    pub key_record: KeyRecord,
    /// IS-3 contract: Phase 5 write handlers MUST check
    /// `permission_set.writable_scope_ids.contains(&target_scope)`
    /// before any DB write to that scope. Read handlers check both
    /// writable and readonly sets. See plan lines 1903 / IS-3.
    pub permission_set: PermissionSet,
    /// `Some(sid)` iff the caller passed a `session_id` AND
    /// `locks::acquire` succeeded. `None` for one-shot claims that
    /// don't bind to a particular session (e.g. CLI tooling).
    pub session_id: Option<String>,
    /// Heartbeat handle for the session lock. Phase 4's graceful
    /// shutdown calls `locks::release(handle)` on `tokio::signal::ctrl_c`.
    pub lock_handle: Option<LockHandle>,
}

/// Authenticate a raw key, optionally bind+lock a `session_id`, and
/// emit `auth.claim`.
///
/// Errors:
/// - `AletheiaError::Auth("Invalid key")` — hash not found.
/// - `AletheiaError::Auth("Key revoked")` — row exists but
///   `revoked_at` is set.
/// - `AletheiaError::Auth(format!("Session {sid} already active in PID
///   {pid} on host {host} (last heartbeat: {ts}). ..."))` — lock
///   conflict (C3).
pub async fn claim(
    conn: Arc<Mutex<Connection>>,
    raw_key: KeyValue,
    session_id: Option<&str>,
    settings: &SessionLocksSettings,
) -> Result<ClaimedSession> {
    // 1. Hash the raw key (C2). The raw value never leaves this stack
    //    frame; only `key_hash` is passed downstream.
    let key_hash = keys::hash_key(&raw_key);

    // 2. Lookup. Drop the lock guard immediately so subsequent steps
    //    (`sessions::bind`, `locks::acquire`, audit emit) can each take
    //    the mutex independently.
    let record = {
        let c = conn.lock().await;
        keys::lookup_by_hash(&c, &key_hash)?
    }
    .ok_or_else(|| AletheiaError::Auth("Invalid key".into()))?;

    if record.revoked_at.is_some() {
        return Err(AletheiaError::Auth("Key revoked".into()));
    }

    // 3. Build the PermissionSet snapshot (C5 / IS-3). Clone from the
    //    already-validated KeyRecord — no fresh ScopeId construction
    //    happens here (C6).
    let permission_set = PermissionSet {
        primary_scope_id: record.primary_scope_id.clone(),
        writable_scope_ids: record.writable_scope_ids.clone(),
        readonly_scope_ids: record.readonly_scope_ids.clone(),
    };

    // 4. Optional session binding + lock acquire.
    //
    // PLAN-BUG-6 adaptation: the plan code (lines 1757-1772) sequences
    // `bind` before `acquire`. But `sessions::bind` uses
    // `INSERT OR REPLACE`, and `session_locks` has
    // `FOREIGN KEY(session_id) REFERENCES session_bindings(session_id)
    // ON DELETE CASCADE`. SQLite's REPLACE semantics delete-then-insert,
    // which cascade-deletes any existing live `session_locks` row —
    // defeating the FATAL conflict gate (C3 / plan `<mandatory>` line
    // 1347).
    //
    // Fix without modifying W2's `sessions::bind`: peek `session_locks`
    // for a live conflict BEFORE calling `bind`. If a row exists with a
    // fresh heartbeat (age < `stale_threshold_seconds`), return
    // `Conflict` directly. Otherwise fall through to the plan flow
    // (bind cascade-deletes any *stale* row harmlessly, then acquire
    // fresh-INSERTs). This preserves C3 (visible-failure on live
    // conflict) while leaving the bind/acquire pairing intact for the
    // happy path. Surface to TL as plan-bug-6 in worker report.
    let lock_handle = if let Some(sid) = session_id {
        // Pre-check for a live conflict to defend against the
        // cascade-delete defeat.
        {
            let c = conn.lock().await;
            // MUST-2 fixback (.optional()? not .ok()): rusqlite SQLITE_BUSY / SQLITE_LOCKED /
            // schema errors must propagate; only QueryReturnedNoRows yields Ok(None). Letting
            // transient SQL errors collapse to None would silently no-op the C3 defense per
            // .pm-handoff/2026-05-11-phase-3-three-review-fixback.md MUST-2.
            let existing: Option<(i64, String, String)> = c
                .query_row(
                    "SELECT active_pid, hostname, last_heartbeat_at \
                     FROM session_locks WHERE session_id = ?",
                    rusqlite::params![sid],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?;
            if let Some((existing_pid, existing_host, last_hb_str)) = existing {
                // PLAN-BUG-5 parsing pattern (W3's `locks.rs`): SQLite's
                // CURRENT_TIMESTAMP format is "YYYY-MM-DD HH:MM:SS", not
                // RFC3339.
                let last_hb =
                    chrono::NaiveDateTime::parse_from_str(&last_hb_str, "%Y-%m-%d %H:%M:%S")
                        .map(|n| n.and_utc())
                        .map_err(|e| {
                            AletheiaError::Other(format!(
                                "parse last_heartbeat_at {last_hb_str:?}: {e}"
                            ))
                        })?;
                let age_seconds = (chrono::Utc::now() - last_hb).num_seconds();
                if age_seconds < settings.stale_threshold_seconds as i64 {
                    // Emit `lock_fatal_conflict` audit event (mirrors
                    // `locks::acquire`'s emit on the same branch).
                    audit_log::emit_event(
                        &c,
                        AuditEventCategory::Lock,
                        "lock_fatal_conflict",
                        None,
                        None,
                        None,
                        Some(&serde_json::json!({
                            "session_id": sid,
                            "active_pid": existing_pid,
                            "hostname": existing_host,
                            "last_heartbeat_age_seconds": age_seconds,
                            "detected_in": "claim::pre_bind_peek",
                        })),
                    )?;
                    return Err(AletheiaError::Auth(format!(
                        "Session {} already active in PID {} on host {} (last heartbeat: {}). \
                         Launch a new session with `claude`, or terminate the existing one first.",
                        sid, existing_pid, existing_host, last_hb
                    )));
                }
                // Else: stale — fall through; bind+acquire will
                // orphan-recover.
            }
        }
        {
            let c = conn.lock().await;
            sessions::bind(&c, sid, &key_hash, &record.primary_scope_id)?;
        }
        match locks::acquire(conn.clone(), sid, settings).await? {
            LockAcquireResult::Acquired(h) => Some(h),
            LockAcquireResult::Conflict {
                active_pid,
                hostname,
                last_heartbeat,
            } => {
                // Defense-in-depth: in principle unreachable after the
                // pre-check above, but if `locks::acquire` ever surfaces
                // a Conflict (race window between peek and bind) honor
                // C7 wording here too.
                return Err(AletheiaError::Auth(format!(
                    "Session {} already active in PID {} on host {} (last heartbeat: {}). \
                     Launch a new session with `claude`, or terminate the existing one first.",
                    sid, active_pid, hostname, last_heartbeat
                )));
            }
        }
    } else {
        None
    };

    // 5. Audit (C12 / IS-9). Use the primary_scope_id as the
    //    `scope_id` column and the key_hash as `actor_key_hash`.
    {
        let c = conn.lock().await;
        audit_log::emit_event(
            &c,
            AuditEventCategory::Auth,
            "claim",
            Some(record.primary_scope_id.as_str()),
            Some(&key_hash.0),
            None,
            Some(&serde_json::json!({ "session_id": session_id })),
        )?;
    }

    Ok(ClaimedSession {
        key_record: record,
        permission_set,
        session_id: session_id.map(String::from),
        lock_handle,
    })
}

/// Re-fetch a key record by hash, rejecting revoked rows.
///
/// Used by Phase 5's write-path precheck on every tool call (the MCP
/// `refresh_claim` handler is a thin pass-through over this). Per CR-3
/// known-risk #5 this function does NOT emit an audit event — emitting
/// on every write-path precheck would flood `sys_audit_log`.
pub async fn refresh_claim(conn: Arc<Mutex<Connection>>, key_hash: &KeyHash) -> Result<KeyRecord> {
    let c = conn.lock().await;
    keys::lookup_by_hash(&c, key_hash)?
        .filter(|r| r.revoked_at.is_none())
        .ok_or_else(|| AletheiaError::Auth("Key revoked or invalid".into()))
}

/// Re-fetch a key record by hash and emit an `auth.whoami` audit event.
///
/// Distinct from `refresh_claim`: this is the explicit user-facing
/// "who am I?" query (Phase 5 `whoami` MCP tool). Auditing on every
/// invocation is intentional — `whoami` is rare (UI-initiated) and the
/// trail is useful for debugging permission surprises. C12 vocab:
/// `auth.whoami`.
pub async fn whoami(conn: Arc<Mutex<Connection>>, key_hash: &KeyHash) -> Result<KeyRecord> {
    let c = conn.lock().await;
    let record = keys::lookup_by_hash(&c, key_hash)?
        .filter(|r| r.revoked_at.is_none())
        .ok_or_else(|| AletheiaError::Auth("Key revoked or invalid".into()))?;
    audit_log::emit_event(
        &c,
        AuditEventCategory::Auth,
        "whoami",
        Some(record.primary_scope_id.as_str()),
        Some(&key_hash.0),
        None,
        None::<&serde_json::Value>,
    )?;
    Ok(record)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::keys;
    use crate::types::key::Permissions;
    use crate::types::scope::ScopeId;

    fn fast_settings() -> SessionLocksSettings {
        SessionLocksSettings {
            heartbeat_seconds: 60,
            stale_threshold_seconds: 180,
        }
    }

    /// Build a registry DB with pragmas + schema + the parent rows
    /// `session_locks` requires (scopes; session_bindings created by
    /// claim flow on demand).
    async fn setup_registry() -> Arc<Mutex<Connection>> {
        let path =
            std::env::temp_dir().join(format!("aletheia-w4-claim-{}.db", uuid::Uuid::new_v4()));
        let conn = Connection::open(&path).expect("open db");
        crate::db::pragmas::apply(&conn).expect("pragmas apply");
        crate::db::registry_schema::install_all(&conn).expect("install schema");
        conn.execute(
            "INSERT INTO scopes (scope_id, name) VALUES (?, ?)",
            rusqlite::params!["test-scope", "test-scope"],
        )
        .expect("seed scope");
        Arc::new(Mutex::new(conn))
    }

    /// Mint a test key in the registry and return (key_record, raw_value).
    async fn mint_test_key(conn: &Arc<Mutex<Connection>>) -> (KeyRecord, KeyValue) {
        let primary = ScopeId::new("test-scope").unwrap();
        let writable = vec![ScopeId::new("test-scope").unwrap()];
        let mut c = conn.lock().await;
        keys::create_key(
            &mut c,
            Some("w4-test"),
            Permissions::ReadWrite,
            &primary,
            &writable,
            &[],
            None,
        )
        .expect("create_key")
    }

    #[tokio::test]
    async fn claim_valid_key_returns_acquired() {
        let conn = setup_registry().await;
        let (_record, raw) = mint_test_key(&conn).await;

        let claimed = claim(conn.clone(), raw, Some("test-session-1"), &fast_settings())
            .await
            .expect("claim ok");

        assert_eq!(claimed.session_id, Some("test-session-1".to_string()));
        assert!(
            claimed.lock_handle.is_some(),
            "expected lock_handle Some on Acquired"
        );
        assert_eq!(
            claimed.permission_set.primary_scope_id.as_str(),
            "test-scope"
        );

        // Cleanup: release the lock so the heartbeat task doesn't outlive
        // the test runtime.
        locks::release(claimed.lock_handle.unwrap())
            .await
            .expect("release ok");
    }

    #[tokio::test]
    async fn claim_invalid_key_returns_auth_error() {
        let conn = setup_registry().await;
        // 64 zero hex chars — valid format, but not in the keys table.
        let bogus = KeyValue("0".repeat(64));

        let err = claim(conn, bogus, Some("test-session-bad"), &fast_settings())
            .await
            .expect_err("claim must reject unknown key");

        match err {
            AletheiaError::Auth(msg) => {
                assert!(
                    msg.contains("Invalid key"),
                    "expected 'Invalid key' in {msg:?}"
                );
            }
            other => panic!("expected AletheiaError::Auth, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn claim_revoked_key_returns_auth_error() {
        let conn = setup_registry().await;
        let (record, raw) = mint_test_key(&conn).await;
        {
            let c = conn.lock().await;
            keys::revoke_key(&c, &record.key_id).expect("revoke ok");
        }

        let err = claim(conn, raw, Some("test-session-revoked"), &fast_settings())
            .await
            .expect_err("claim must reject revoked key");

        match err {
            AletheiaError::Auth(msg) => {
                assert!(
                    msg.contains("Key revoked"),
                    "expected 'Key revoked' in {msg:?}"
                );
            }
            other => panic!("expected AletheiaError::Auth, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn claim_with_no_session_id_returns_no_lock() {
        let conn = setup_registry().await;
        let (_record, raw) = mint_test_key(&conn).await;

        let claimed = claim(conn, raw, None, &fast_settings())
            .await
            .expect("claim ok");

        assert!(claimed.session_id.is_none(), "session_id must be None");
        assert!(
            claimed.lock_handle.is_none(),
            "lock_handle must be None when no session_id provided"
        );
    }

    #[tokio::test]
    async fn claim_conflict_returns_formatted_error_with_pid_hostname() {
        let conn = setup_registry().await;
        let (_record, raw) = mint_test_key(&conn).await;

        // Pre-insert a live conflicting lock owned by a fake PID.
        // session_bindings must exist first (FK).
        {
            let c = conn.lock().await;
            c.execute(
                "INSERT INTO session_bindings (session_id, key_hash, primary_scope_id) \
                 VALUES (?, ?, ?)",
                rusqlite::params!["session-X", "fakehash", "test-scope"],
            )
            .expect("insert session_binding");
            c.execute(
                "INSERT INTO session_locks (session_id, active_pid, hostname, \
                 claimed_at, last_heartbeat_at) \
                 VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
                rusqlite::params!["session-X", 99_999_999i64, "peer-host"],
            )
            .expect("pre-insert conflicting lock");
        }

        let err = claim(conn, raw, Some("session-X"), &fast_settings())
            .await
            .expect_err("claim must fail on live conflict");

        match err {
            AletheiaError::Auth(msg) => {
                assert!(
                    msg.contains("PID 99999999"),
                    "expected 'PID 99999999' substring in {msg:?}"
                );
                assert!(msg.contains("session-X"), "expected session id in {msg:?}");
                assert!(msg.contains("peer-host"), "expected hostname in {msg:?}");
            }
            other => panic!("expected AletheiaError::Auth, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn claim_emits_auth_event() {
        let conn = setup_registry().await;
        let (_record, raw) = mint_test_key(&conn).await;

        let claimed = claim(
            conn.clone(),
            raw,
            Some("test-session-audit"),
            &fast_settings(),
        )
        .await
        .expect("claim ok");

        {
            let c = conn.lock().await;
            let count: i64 = c
                .query_row(
                    "SELECT COUNT(*) FROM sys_audit_log \
                     WHERE event_category = 'auth' AND event_type = 'claim'",
                    [],
                    |r| r.get(0),
                )
                .expect("count audit");
            assert!(
                count >= 1,
                "expected at least one auth.claim event, got {count}"
            );
        }

        locks::release(claimed.lock_handle.unwrap())
            .await
            .expect("release ok");
    }

    #[tokio::test]
    async fn refresh_claim_filters_revoked() {
        let conn = setup_registry().await;
        let (record, _raw) = mint_test_key(&conn).await;

        // Pre-revoke verification: refresh_claim returns Ok.
        let refreshed = refresh_claim(conn.clone(), &record.key_hash)
            .await
            .expect("refresh_claim ok");
        assert_eq!(refreshed.key_id, record.key_id);

        // Revoke and re-check.
        {
            let c = conn.lock().await;
            keys::revoke_key(&c, &record.key_id).expect("revoke ok");
        }
        let err = refresh_claim(conn, &record.key_hash)
            .await
            .expect_err("refresh_claim must reject revoked key");
        match err {
            AletheiaError::Auth(msg) => {
                assert!(
                    msg.contains("Key revoked"),
                    "expected 'Key revoked' in {msg:?}"
                );
            }
            other => panic!("expected AletheiaError::Auth, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn whoami_emits_audit_event() {
        let conn = setup_registry().await;
        let (record, _raw) = mint_test_key(&conn).await;

        let resolved = whoami(conn.clone(), &record.key_hash)
            .await
            .expect("whoami ok");
        assert_eq!(resolved.key_id, record.key_id);

        let c = conn.lock().await;
        let count: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM sys_audit_log \
                 WHERE event_category = 'auth' AND event_type = 'whoami'",
                [],
                |r| r.get(0),
            )
            .expect("count audit");
        assert!(
            count >= 1,
            "expected at least one auth.whoami event, got {count}"
        );
    }
}
