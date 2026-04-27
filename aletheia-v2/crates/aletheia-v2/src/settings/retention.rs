/// `[retention]` settings.
///
/// Phase 7+ retention sweeper consumes these. The 5-year audit-log
/// retention is the canonical V2 value (per plan §retention).
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(default)]
pub struct RetentionSettings {
    /// Days to retain `sys_audit_log` rows before they become eligible
    /// for master-key-gated purge. Worker A1 default: 5 years (1825
    /// days), per plan retention §.
    pub sys_audit_log_days: u32,
    /// Days to retain superseded entry versions before retention may
    /// hard-delete. Worker A1 default: 365 (1 year).
    pub superseded_entries_days: u32,
}

impl Default for RetentionSettings {
    fn default() -> Self {
        Self {
            sys_audit_log_days: 5 * 365,
            superseded_entries_days: 365,
        }
    }
}
