/// `[mass_ingest]` settings.
///
/// Phase 5/6 will define the mass-ingest approval flow. The 24-hour
/// approval TTL is a CR-1 spot-check value (plan line 615), so its
/// default is locked here.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(default)]
pub struct MassIngestSettings {
    /// Hours before a pending mass-ingest request expires. CR-1
    /// spot-check pin: MUST default to 24.
    pub approval_ttl_hours: u32,
    /// Maximum entry count permitted in a single mass-ingest request
    /// without escalation. Worker A1 default: 1000.
    pub max_entries_per_request: u32,
    /// Checkpoint interval (entries processed between resume-state
    /// writes). Worker A1 default: 50.
    pub checkpoint_interval: u32,
}

impl Default for MassIngestSettings {
    fn default() -> Self {
        Self {
            approval_ttl_hours: 24,
            max_entries_per_request: 1000,
            checkpoint_interval: 50,
        }
    }
}
