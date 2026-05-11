// Phase 2 sub-task B5 — Migration state structs and the lifecycle enum.
//
// These structs mirror the `migration_state` and `migration_scope_progress`
// tables installed by `registry_schema::install_all` (B2). Field order is
// kept aligned with the DDL declaration order for readability; the runner
// (`runner.rs`) reads and writes these tables through these types.
//
// `MigrationStatus` doubles as a Rust-side enum (typed transitions in the
// runner) and a string-form CHECK constraint value
// (`'queued' | 'paused_for_writes' | 'applying' | 'completed' | 'failed'`).
// `Display` and `FromStr` provide a round-trippable string encoding for SQL
// bindings and result-set decoding; tests below confirm the round-trip.

use std::fmt;
use std::str::FromStr;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::error::AletheiaError;

/// The lifecycle status of a migration. Variants and their string form
/// match the `migration_state.status` CHECK constraint in
/// `registry_schema::MIGRATION_STATE_TABLE`.
///
/// The serde representation uses `rename_all = "snake_case"` so JSON /
/// `Display` / `FromStr` all agree on the canonical SQL form
/// (`paused_for_writes`, etc.).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MigrationStatus {
    Queued,
    PausedForWrites,
    Applying,
    Completed,
    Failed,
}

impl MigrationStatus {
    /// Canonical lowercase-with-underscores string used in the DB CHECK
    /// constraint. Preferred for direct SQL bindings (no JSON quoting).
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::PausedForWrites => "paused_for_writes",
            Self::Applying => "applying",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }
}

impl fmt::Display for MigrationStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for MigrationStatus {
    type Err = AletheiaError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "queued" => Ok(Self::Queued),
            "paused_for_writes" => Ok(Self::PausedForWrites),
            "applying" => Ok(Self::Applying),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            other => Err(AletheiaError::Other(format!(
                "unknown migration status: {other}"
            ))),
        }
    }
}

/// Mirror of the `migration_state` registry row. Field order matches the
/// DDL in `registry_schema::MIGRATION_STATE_TABLE`.
#[derive(Debug, Clone)]
pub struct MigrationState {
    pub migration_id: String,
    pub source_version: String,
    pub target_version: String,
    pub status: MigrationStatus,
    /// The global flag tools check on every call. Mirrors
    /// `migration_state.is_applying` (TINYINT 0/1). Stays TRUE on `failed`
    /// status — safe-hold for manual intervention via `force_unlock`.
    pub is_applying: bool,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub failed_at: Option<DateTime<Utc>>,
    pub error_message: Option<String>,
    pub initiated_by_key_hash: Option<String>,
    /// JSON-encoded details payload (matches `details TEXT` column).
    pub details: Option<String>,
}

/// Mirror of the `migration_scope_progress` registry row.
#[derive(Debug, Clone)]
pub struct MigrationScopeProgress {
    pub migration_id: String,
    pub scope_id: String,
    pub status: String,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub error_message: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each variant of `MigrationStatus` round-trips through `Display` →
    /// `FromStr` with the canonical CHECK-constraint string form. This is
    /// the load-bearing contract between the runner's typed transitions
    /// and the raw SQL bindings written to `migration_state.status`.
    #[test]
    fn migration_status_string_round_trip() {
        for (variant, expected) in [
            (MigrationStatus::Queued, "queued"),
            (MigrationStatus::PausedForWrites, "paused_for_writes"),
            (MigrationStatus::Applying, "applying"),
            (MigrationStatus::Completed, "completed"),
            (MigrationStatus::Failed, "failed"),
        ] {
            // Display path
            assert_eq!(variant.to_string(), expected, "Display for {variant:?}");
            // as_str path (used by direct SQL bindings)
            assert_eq!(variant.as_str(), expected, "as_str for {variant:?}");
            // FromStr path
            let parsed: MigrationStatus = expected
                .parse()
                .unwrap_or_else(|e| panic!("parse {expected}: {e}"));
            assert_eq!(parsed, variant, "FromStr round-trip for {expected}");
            // Serde path (rename_all = snake_case must agree)
            let json = serde_json::to_string(&variant).expect("serialize");
            assert_eq!(
                json,
                format!("\"{expected}\""),
                "serde JSON for {variant:?}"
            );
        }

        // Negative case: unknown strings produce an error.
        let err = "nonexistent".parse::<MigrationStatus>();
        assert!(err.is_err(), "unknown status must fail to parse");
    }
}
