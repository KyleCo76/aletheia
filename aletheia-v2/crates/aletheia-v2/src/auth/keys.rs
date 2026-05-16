//! Phase 3 W1 — key file management, SHA-256 hashing, DB row CRUD.
//!
//! This module owns:
//!
//! - The on-disk key-file convention (`~/.aletheia-v2/keys/<name>.key`,
//!   mode 0600 on Unix).
//! - SHA-256 hashing of raw key material via the `sha2` crate; the
//!   digest is the only form that ever reaches the `keys` table
//!   (contract C1 / plan `<mandatory>` line 1345).
//! - `create_key` / `lookup_by_hash` / `revoke_key` against the
//!   registry `keys` table (LOCKED schema, plan IS-2).
//! - Audit-event emission for `key_issued` and `key_modified`
//!   (vocabulary per IS-9 / contract C12).
//!
//! Critical contracts honored here:
//!
//! - **C1**: raw `KeyValue` is NEVER bound to any `keys.*` column. Only
//!   the hex SHA-256 digest goes into `key_hash`.
//! - **C7**: `lookup_by_hash` returns structured `AletheiaError::Other`
//!   with column-context on row-parse failure; no panics on corrupt
//!   rows.
//! - **C8**: no `println!` / `print!` / `dbg!`. The single transient
//!   log site is the Windows ACL-deferred note in `write_key_file`.
//! - **C9**: `create_key` always INSERTs `is_master_key=0 AND
//!   is_digest_key=0`. The keys table CHECK constraint
//!   `NOT (is_master_key=1 AND is_digest_key=1)` (three-review MUST-2)
//!   is honored at the schema layer; this module never sets either flag
//!   to 1. Master keys and digest keys are minted by separate paths
//!   (out of scope for Phase 3 W1).
//! - **C12**: emits `key_issued` (on create) and `key_modified`
//!   (on revoke) via `audit_log::emit_event` under category `Key`.
//! - **C13**: no `Connection::open*` calls in production code paths;
//!   functions take `&Connection` / `&mut Connection` from the caller.

use std::path::{Path, PathBuf};

use rusqlite::Connection;
use rusqlite::OptionalExtension;
use sha2::{Digest, Sha256};

use crate::db::audit_log;
use crate::error::{AletheiaError, Result};
use crate::types::audit::AuditEventCategory;
use crate::types::key::{KeyHash, KeyId, KeyValue, Permissions};
use crate::types::scope::ScopeId;

/// The directory under `data_dir` where raw key files live.
pub fn keys_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("keys")
}

/// Path to a named key file under `data_dir`.
pub fn key_path(data_dir: &Path, name: &str) -> PathBuf {
    keys_dir(data_dir).join(format!("{name}.key"))
}

/// Hex-encoded SHA-256 of the raw key value.
///
/// Contract C2: this is the only function that produces a `KeyHash`
/// from a `KeyValue`. The digest is what gets stored in `keys.key_hash`
/// (contract C1).
pub fn hash_key(raw: &KeyValue) -> KeyHash {
    let mut hasher = Sha256::new();
    hasher.update(raw.0.as_bytes());
    KeyHash(hex::encode(hasher.finalize()))
}

/// Write the raw key value to `path`, creating parent directories and
/// setting mode 0600 on Unix.
///
/// On Windows the mode-bit step is a no-op; the file lives under the
/// user profile already, and proper ACL hardening is deferred to a
/// later phase (TL-polish). A `tracing::debug!` records the deferral
/// at runtime.
pub fn write_key_file(path: &Path, raw: &KeyValue) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        // SHOULD-4 atomic mode-on-create: the file is created with mode 0600 directly
        // via O_CREAT. No intermediate world-readable window per
        // .pm-handoff/2026-05-11-phase-3-three-review-fixback.md SHOULD-4.
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(raw.0.as_bytes())?;
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, &raw.0)?;
        tracing::debug!(
            path = %path.display(),
            "write_key_file: Windows ACL hardening deferred; file under user profile"
        );
    }
    Ok(())
}

/// Read a key file's contents, trimming surrounding whitespace.
///
/// The trim is load-bearing: editor saves and shell `echo` invocations
/// commonly append a trailing newline that would otherwise corrupt the
/// hex value and break the SHA-256 lookup.
pub fn read_key_file(path: &Path) -> Result<KeyValue> {
    let content = std::fs::read_to_string(path)?;
    Ok(KeyValue(content.trim().to_string()))
}

/// Mint a fresh 32-byte random key, hex-encoded (64 hex characters).
pub fn generate_key() -> KeyValue {
    use rand::RngCore;
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    KeyValue(hex::encode(buf))
}

/// In-memory representation of a `keys` row.
///
/// All 12 columns are surfaced; `created_at` is not modeled here
/// because Phase 3 doesn't read it (the schema sets it via
/// `CURRENT_TIMESTAMP` and downstream readers query `revoked_at`).
#[derive(Debug, Clone)]
pub struct KeyRecord {
    pub key_id: KeyId,
    pub key_hash: KeyHash,
    pub name: Option<String>,
    pub permissions: Permissions,
    pub created_by_key_id: Option<KeyId>,
    pub primary_scope_id: ScopeId,
    pub writable_scope_ids: Vec<ScopeId>,
    pub readonly_scope_ids: Vec<ScopeId>,
    pub is_master_key: bool,
    pub is_digest_key: bool,
    pub digest_for_scope_id: Option<ScopeId>,
    pub revoked_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// Create a new (non-master, non-digest) key row in the `keys` table.
///
/// Contract C1: only the SHA-256 hex digest is bound to `key_hash`;
/// the raw value is returned via the second element of the tuple so
/// the caller can write it to a key file and hand it to a teammate.
/// It NEVER touches any other column.
///
/// Contract C9: this function hard-codes `is_master_key=0 AND
/// is_digest_key=0`. Minting a master or digest key is a different
/// (out-of-scope) code path.
///
/// Contract C12: emits a `key_issued` audit event under category
/// `Key` after a successful INSERT.
pub fn create_key(
    conn: &mut Connection,
    name: Option<&str>,
    permissions: Permissions,
    primary_scope_id: &ScopeId,
    writable_scope_ids: &[ScopeId],
    readonly_scope_ids: &[ScopeId],
    created_by_key_id: Option<&KeyId>,
) -> Result<(KeyRecord, KeyValue)> {
    let raw = generate_key();
    let key_hash = hash_key(&raw);
    let key_id = KeyId(uuid::Uuid::new_v4().to_string());
    let writable_json = serde_json::to_string(writable_scope_ids)?;
    let readonly_json = serde_json::to_string(readonly_scope_ids)?;

    conn.execute(
        "INSERT INTO keys \
         (key_id, key_hash, name, permissions, created_by_key_id, \
          primary_scope_id, writable_scope_ids, readonly_scope_ids, \
          is_master_key, is_digest_key) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)",
        rusqlite::params![
            key_id.0,
            key_hash.0,
            name,
            permissions_str(permissions),
            created_by_key_id.map(|k| &k.0),
            primary_scope_id.0,
            writable_json,
            readonly_json,
        ],
    )?;

    // C12: emit `key_issued`. Actor is the new key itself (its hash);
    // the `created_by_key_id` is included in the JSON details.
    let details = serde_json::json!({
        "name": name,
        "permissions": permissions_str(permissions),
        "created_by_key_id": created_by_key_id.map(|k| k.0.as_str()),
    });
    audit_log::emit_event(
        conn,
        AuditEventCategory::Key,
        "key_issued",
        Some(primary_scope_id.as_str()),
        Some(&key_hash.0),
        None,
        Some(&details),
    )?;

    let record = KeyRecord {
        key_id,
        key_hash,
        name: name.map(String::from),
        permissions,
        created_by_key_id: created_by_key_id.cloned(),
        primary_scope_id: primary_scope_id.clone(),
        writable_scope_ids: writable_scope_ids.to_vec(),
        readonly_scope_ids: readonly_scope_ids.to_vec(),
        is_master_key: false,
        is_digest_key: false,
        digest_for_scope_id: None,
        revoked_at: None,
    };
    Ok((record, raw))
}

/// Look up a key row by its SHA-256 hex digest.
///
/// Returns `Ok(None)` if no row matches. Returns `Err` on a malformed
/// row (e.g. JSON-corrupt `writable_scope_ids`, unknown permission
/// string, invalid `revoked_at` format, scope_id rejected by
/// `ScopeId::new`).
///
/// Contract C7: row-parse failures surface as `AletheiaError::Other`
/// with column-name + value context, NOT panics.
///
/// Contract C6 (defense-in-depth): every `ScopeId` constructed from a
/// DB column routes through `ScopeId::new()`, so a corrupt or
/// adversarial row cannot smuggle an unsafe scope string into in-memory
/// state.
pub fn lookup_by_hash(conn: &Connection, hash: &KeyHash) -> Result<Option<KeyRecord>> {
    let row_opt: Option<KeyRecordParse> = conn
        .query_row(
            "SELECT key_id, key_hash, name, permissions, created_by_key_id, \
                    primary_scope_id, writable_scope_ids, readonly_scope_ids, \
                    is_master_key, is_digest_key, digest_for_scope_id, revoked_at \
             FROM keys WHERE key_hash = ?",
            rusqlite::params![hash.0],
            |row| {
                Ok(KeyRecordParse {
                    key_id: row.get(0)?,
                    key_hash: row.get(1)?,
                    name: row.get(2)?,
                    permissions: row.get(3)?,
                    created_by_key_id: row.get(4)?,
                    primary_scope_id: row.get(5)?,
                    writable_scope_ids: row.get(6)?,
                    readonly_scope_ids: row.get(7)?,
                    is_master_key: row.get(8)?,
                    is_digest_key: row.get(9)?,
                    digest_for_scope_id: row.get(10)?,
                    revoked_at: row.get(11)?,
                })
            },
        )
        .optional()
        .map_err(AletheiaError::from)?;

    let raw = match row_opt {
        Some(r) => r,
        None => return Ok(None),
    };

    // C6: every scope_id from the DB is re-validated through
    // ScopeId::new(). Wrap any rejection in AletheiaError::Scope with
    // column context.
    let primary_scope_id = ScopeId::new(raw.primary_scope_id.clone()).map_err(|e| {
        AletheiaError::Scope(format!(
            "parse primary_scope_id {:?}: {}",
            raw.primary_scope_id, e
        ))
    })?;

    // C7: writable_scope_ids is stored as a JSON array of strings.
    // Surface a structured error on malformed JSON.
    let writable_raw: Vec<String> = serde_json::from_str(&raw.writable_scope_ids).map_err(|e| {
        AletheiaError::Other(format!(
            "parse writable_scope_ids {:?}: {}",
            raw.writable_scope_ids, e
        ))
    })?;
    let writable_scope_ids: Vec<ScopeId> = writable_raw
        .into_iter()
        .map(|s| {
            ScopeId::new(s.clone())
                .map_err(|e| AletheiaError::Scope(format!("writable_scope_ids entry {s:?}: {e}")))
        })
        .collect::<Result<Vec<_>>>()?;

    let readonly_raw: Vec<String> = serde_json::from_str(&raw.readonly_scope_ids).map_err(|e| {
        AletheiaError::Other(format!(
            "parse readonly_scope_ids {:?}: {}",
            raw.readonly_scope_ids, e
        ))
    })?;
    let readonly_scope_ids: Vec<ScopeId> = readonly_raw
        .into_iter()
        .map(|s| {
            ScopeId::new(s.clone())
                .map_err(|e| AletheiaError::Scope(format!("readonly_scope_ids entry {s:?}: {e}")))
        })
        .collect::<Result<Vec<_>>>()?;

    let digest_for_scope_id =
        match raw.digest_for_scope_id {
            Some(s) => Some(ScopeId::new(s.clone()).map_err(|e| {
                AletheiaError::Scope(format!("parse digest_for_scope_id {s:?}: {e}"))
            })?),
            None => None,
        };

    let permissions = permissions_from_str(&raw.permissions)?;

    // revoked_at is stored in SQLite's CURRENT_TIMESTAMP format
    // ("YYYY-MM-DD HH:MM:SS"), NOT RFC3339. Same defect class as
    // three-review MUST-3 / W1 caveat #13. Parse-from-str then
    // .and_utc() to lift to UTC.
    let revoked_at: Option<chrono::DateTime<chrono::Utc>> = match raw.revoked_at {
        Some(s) => Some(
            chrono::NaiveDateTime::parse_from_str(&s, "%Y-%m-%d %H:%M:%S")
                .map(|n| n.and_utc())
                .map_err(|e| AletheiaError::Other(format!("parse revoked_at {s:?}: {e}")))?,
        ),
        None => None,
    };

    Ok(Some(KeyRecord {
        key_id: KeyId(raw.key_id),
        key_hash: KeyHash(raw.key_hash),
        name: raw.name,
        permissions,
        created_by_key_id: raw.created_by_key_id.map(KeyId),
        primary_scope_id,
        writable_scope_ids,
        readonly_scope_ids,
        is_master_key: raw.is_master_key != 0,
        is_digest_key: raw.is_digest_key != 0,
        digest_for_scope_id,
        revoked_at,
    }))
}

/// Set `revoked_at` on the named key to `CURRENT_TIMESTAMP`.
///
/// Idempotent: re-revoking an already-revoked key overwrites the
/// timestamp without error. Contract C12: emits a `key_modified` audit
/// event under category `Key`.
pub fn revoke_key(conn: &Connection, key_id: &KeyId) -> Result<()> {
    conn.execute(
        "UPDATE keys SET revoked_at = CURRENT_TIMESTAMP WHERE key_id = ?",
        rusqlite::params![key_id.0],
    )?;

    let details = serde_json::json!({
        "key_id": key_id.0,
        "action": "revoke",
    });
    audit_log::emit_event(
        conn,
        AuditEventCategory::Key,
        "key_modified",
        None,
        None,
        None,
        Some(&details),
    )?;
    Ok(())
}

// --- private helpers ---

/// Raw shape returned from a SQLite row before semantic parsing.
/// We extract the columns first (catches type-mismatch errors at the
/// `rusqlite::Error` layer), then validate each field with structured
/// errors per contract C7.
struct KeyRecordParse {
    key_id: String,
    key_hash: String,
    name: Option<String>,
    permissions: String,
    created_by_key_id: Option<String>,
    primary_scope_id: String,
    writable_scope_ids: String,
    readonly_scope_ids: String,
    is_master_key: i64,
    is_digest_key: i64,
    digest_for_scope_id: Option<String>,
    revoked_at: Option<String>,
}

fn permissions_str(p: Permissions) -> &'static str {
    match p {
        Permissions::ReadOnly => "read-only",
        Permissions::ReadWrite => "read-write",
        Permissions::CreateSubEntries => "create-sub-entries",
        Permissions::Maintenance => "maintenance",
    }
}

fn permissions_from_str(s: &str) -> Result<Permissions> {
    match s {
        "read-only" => Ok(Permissions::ReadOnly),
        "read-write" => Ok(Permissions::ReadWrite),
        "create-sub-entries" => Ok(Permissions::CreateSubEntries),
        "maintenance" => Ok(Permissions::Maintenance),
        other => Err(AletheiaError::Other(format!(
            "unknown permissions string {other:?}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{pragmas, registry_schema};
    use rusqlite::params;
    use std::path::PathBuf;

    /// Unique tempfile path for a per-test SQLite DB. Mirrors the
    /// pattern used in `db::pragmas::tests` (the `tempfile` crate is
    /// not in workspace deps per W1 §6.2 #9).
    fn unique_db_path(label: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("aletheia-w1-{label}-{}.db", uuid::Uuid::new_v4()));
        p
    }

    fn fresh_registry_conn() -> (Connection, PathBuf) {
        let path = unique_db_path("keys");
        let conn = Connection::open(&path).expect("open db");
        pragmas::apply(&conn).expect("apply pragmas");
        registry_schema::install_all(&conn).expect("install schema");
        (conn, path)
    }

    fn seed_scope(conn: &Connection, scope_id: &str, name: &str) {
        conn.execute(
            "INSERT INTO scopes (scope_id, name) VALUES (?1, ?2)",
            params![scope_id, name],
        )
        .expect("seed scope");
    }

    #[test]
    fn hash_key_matches_known_fixture() {
        // RFC 6234 / FIPS 180-4 SHA-256 test vector #1:
        //   input  = "abc"
        //   digest = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
        let raw = KeyValue("abc".to_string());
        let hash = hash_key(&raw);
        assert_eq!(
            hash.0,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn generate_key_produces_64_char_hex() {
        let k = generate_key();
        assert_eq!(k.0.len(), 64, "expected 64-char hex, got {}", k.0.len());
        assert!(
            k.0.chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
            "expected lowercase hex, got {}",
            k.0
        );
    }

    #[test]
    fn write_read_round_trip_preserves_value() {
        let path = std::env::temp_dir().join(format!(
            "aletheia-w1-roundtrip-{}.key",
            uuid::Uuid::new_v4()
        ));
        let raw = generate_key();
        write_key_file(&path, &raw).expect("write");
        let read_back = read_key_file(&path).expect("read");
        assert_eq!(raw.0, read_back.0, "round-trip should preserve value");
        std::fs::remove_file(&path).ok();
    }

    #[cfg(unix)]
    #[test]
    fn key_file_has_mode_0600_on_unix() {
        use std::os::unix::fs::PermissionsExt;
        let path =
            std::env::temp_dir().join(format!("aletheia-w1-mode-{}.key", uuid::Uuid::new_v4()));
        let raw = generate_key();
        write_key_file(&path, &raw).expect("write");
        let meta = std::fs::metadata(&path).expect("metadata");
        let mode = meta.permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "expected mode 0600, got {:o}", mode);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn create_key_then_lookup_by_hash_round_trip() {
        let (mut conn, path) = fresh_registry_conn();
        seed_scope(&conn, "scope-a", "scope-a");
        seed_scope(&conn, "scope-b", "scope-b");
        let primary = ScopeId::new("scope-a").unwrap();
        let writable = vec![
            ScopeId::new("scope-a").unwrap(),
            ScopeId::new("scope-b").unwrap(),
        ];
        let readonly = vec![ScopeId::new("scope-b").unwrap()];

        let (record, _raw) = create_key(
            &mut conn,
            Some("test-key"),
            Permissions::ReadWrite,
            &primary,
            &writable,
            &readonly,
            None,
        )
        .expect("create_key");

        let looked_up = lookup_by_hash(&conn, &record.key_hash)
            .expect("lookup ok")
            .expect("row exists");

        assert_eq!(looked_up.key_id, record.key_id);
        assert_eq!(looked_up.key_hash, record.key_hash);
        assert_eq!(looked_up.name, Some("test-key".to_string()));
        assert_eq!(looked_up.permissions, Permissions::ReadWrite);
        assert_eq!(looked_up.created_by_key_id, None);
        assert_eq!(looked_up.primary_scope_id, primary);
        assert_eq!(looked_up.writable_scope_ids, writable);
        assert_eq!(looked_up.readonly_scope_ids, readonly);
        assert!(!looked_up.is_master_key, "C9: must not be master");
        assert!(!looked_up.is_digest_key, "C9: must not be digest");
        assert_eq!(looked_up.digest_for_scope_id, None);
        assert_eq!(looked_up.revoked_at, None);

        drop(conn);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn lookup_by_hash_returns_none_for_unknown_hash() {
        let (conn, path) = fresh_registry_conn();
        let unknown = KeyHash("0".repeat(64));
        let result = lookup_by_hash(&conn, &unknown).expect("lookup ok");
        assert!(result.is_none(), "expected None for unknown hash");
        drop(conn);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn revoke_key_sets_revoked_at() {
        let (mut conn, path) = fresh_registry_conn();
        seed_scope(&conn, "scope-a", "scope-a");
        let primary = ScopeId::new("scope-a").unwrap();
        let writable = vec![ScopeId::new("scope-a").unwrap()];

        let (record, _raw) = create_key(
            &mut conn,
            Some("to-revoke"),
            Permissions::ReadOnly,
            &primary,
            &writable,
            &[],
            None,
        )
        .expect("create_key");

        revoke_key(&conn, &record.key_id).expect("revoke");

        let looked_up = lookup_by_hash(&conn, &record.key_hash)
            .expect("lookup ok")
            .expect("row exists");
        assert!(
            looked_up.revoked_at.is_some(),
            "revoked_at must be Some after revoke"
        );

        drop(conn);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn lookup_by_hash_visible_failure_on_corrupt_writable_json() {
        let (conn, path) = fresh_registry_conn();
        seed_scope(&conn, "scope-a", "scope-a");

        // Manually INSERT a row with broken JSON in writable_scope_ids.
        let corrupt_hash = "f".repeat(64);
        conn.execute(
            "INSERT INTO keys \
             (key_id, key_hash, permissions, primary_scope_id, \
              writable_scope_ids, readonly_scope_ids, \
              is_master_key, is_digest_key) \
             VALUES (?, ?, 'read-write', 'scope-a', \
                     'not-valid-json', '[]', 0, 0)",
            params!["corrupt-1", &corrupt_hash],
        )
        .expect("insert corrupt row");

        let err = lookup_by_hash(&conn, &KeyHash(corrupt_hash))
            .expect_err("lookup must fail on corrupt JSON");
        match err {
            AletheiaError::Other(msg) => {
                assert!(
                    msg.contains("writable_scope_ids"),
                    "error must mention column name, got: {msg}"
                );
                assert!(
                    msg.contains("not-valid-json"),
                    "error must include value context, got: {msg}"
                );
            }
            other => panic!("expected AletheiaError::Other, got {other:?}"),
        }

        drop(conn);
        std::fs::remove_file(&path).ok();
    }
}
