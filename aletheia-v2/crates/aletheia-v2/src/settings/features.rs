/// `[features]` settings.
///
/// Phase 5 (feature lifecycle) consumes these. Feature initiation,
/// tabling, and wrap-up policy live here. Phase 1 stubs with two
/// toggles; Phase 5 will extend.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(default)]
pub struct FeaturesSettings {
    /// Whether `init_feature` requires a non-empty description.
    /// Worker A1 default: true.
    pub require_description: bool,
    /// Maximum number of simultaneously-active features per scope.
    /// Worker A1 default: 5 (matches V1 convention).
    pub max_active_per_scope: u32,
}

impl Default for FeaturesSettings {
    fn default() -> Self {
        Self {
            require_description: true,
            max_active_per_scope: 5,
        }
    }
}
