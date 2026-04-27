/// Audit event categories matching the Phase 2 CHECK constraint on
/// `sys_audit_log.event_category` (plan line 934). Variants must stay
/// in sync with the SQL DDL — adding a new variant here requires a
/// schema migration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuditEventCategory {
    Auth,
    Lock,
    Scope,
    Key,
    Digest,
    Migration,
    Deprecation,
    Reconciliation,
}

impl AuditEventCategory {
    /// Stable lowercase string used in the DB CHECK constraint. The
    /// serde rename also produces lowercase, but `as_str` is preferred
    /// for direct INSERTs (no need to allocate JSON quotes).
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Auth => "auth",
            Self::Lock => "lock",
            Self::Scope => "scope",
            Self::Key => "key",
            Self::Digest => "digest",
            Self::Migration => "migration",
            Self::Deprecation => "deprecation",
            Self::Reconciliation => "reconciliation",
        }
    }
}

/// Open-vocabulary event-type label (e.g. `"key.created"`,
/// `"lock.heartbeat_missed"`). String-typed by design — Phase 2 onward
/// emits these as free-form labels within a category.
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub struct AuditEventType(pub String);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn category_as_str_round_trips_through_serde() {
        for c in [
            AuditEventCategory::Auth,
            AuditEventCategory::Lock,
            AuditEventCategory::Scope,
            AuditEventCategory::Key,
            AuditEventCategory::Digest,
            AuditEventCategory::Migration,
            AuditEventCategory::Deprecation,
            AuditEventCategory::Reconciliation,
        ] {
            let json = serde_json::to_string(&c).unwrap();
            // serde-rendered string == quoted as_str()
            assert_eq!(json, format!("\"{}\"", c.as_str()));
        }
    }
}
