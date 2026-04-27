use std::collections::HashMap;

/// `[digest]` and `[digest.per_scope]` settings.
///
/// Phase 7 (digest pipeline) will extend with concrete pipeline
/// parameters. Phase 1 stubs with the minimum surface needed by other
/// modules.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(default)]
pub struct DigestSettings {
    /// Threshold (entry count) at which a scope's digest queue is
    /// triggered automatically. Worker A1 default: 25 entries.
    pub entry_threshold: u32,
    /// Threshold (hours since last digest) at which a scope's digest
    /// queue is triggered. Worker A1 default: 24 hours.
    pub time_threshold_hours: u32,
    /// Per-scope overrides (keyed by scope name). Empty by default.
    pub per_scope: HashMap<String, DigestPerScope>,
}

impl Default for DigestSettings {
    fn default() -> Self {
        Self {
            entry_threshold: 25,
            time_threshold_hours: 24,
            per_scope: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
pub struct DigestPerScope {
    pub entry_threshold: Option<u32>,
    pub time_threshold_hours: Option<u32>,
}
