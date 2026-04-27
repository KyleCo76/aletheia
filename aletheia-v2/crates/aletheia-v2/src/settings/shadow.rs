/// `[shadow]` settings.
///
/// Phase 6/7 will define the shadow-comparison observer that records
/// the divergence between V2's emitted ranking and the V1-baseline
/// ranking. Defaults: low sample rate (10%) to keep storage cost
/// bounded; bumped to 100% in dev/test environments via TOML override.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(default)]
pub struct ShadowSettings {
    /// Fraction of l1/l2 events to record into `shadow_comparison_log`.
    /// Worker A1 default: 0.10. Range [0.0, 1.0].
    pub sample_rate: f64,
    /// Whether shadow comparison is enabled at all. Worker A1 default:
    /// true (sample rate of 0 effectively disables, but this gate is
    /// for explicit kill-switch).
    pub enabled: bool,
}

impl Default for ShadowSettings {
    fn default() -> Self {
        Self {
            sample_rate: 0.10,
            enabled: true,
        }
    }
}
