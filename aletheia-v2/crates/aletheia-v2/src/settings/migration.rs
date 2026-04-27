/// `[migration]` settings.
///
/// Phase 2 + Phase 8 (migration framework) consume these. Defaults
/// chosen to favor safe, observable migrations: dry-run by default,
/// and a paused-rollover quiesce window long enough for in-flight
/// tool calls to complete.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(default)]
pub struct MigrationSettings {
    /// Whether migrations default to dry-run (a flag the operator must
    /// explicitly clear to apply). Worker A1 default: true.
    pub default_dry_run: bool,
    /// Seconds to wait in `paused_for_writes` for in-flight tool calls
    /// to complete before applying schema changes. Worker A1 default:
    /// 30 (matches reasonable MCP tool latency budget).
    pub paused_quiesce_seconds: u32,
}

impl Default for MigrationSettings {
    fn default() -> Self {
        Self {
            default_dry_run: true,
            paused_quiesce_seconds: 30,
        }
    }
}
