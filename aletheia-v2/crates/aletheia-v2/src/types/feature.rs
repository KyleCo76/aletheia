use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub struct FeatureId(pub String);

impl FeatureId {
    pub fn new() -> Self {
        Self(Uuid::new_v4().to_string())
    }
}

impl Default for FeatureId {
    fn default() -> Self {
        Self::new()
    }
}

/// Lifecycle states of a feature, matching the Phase 2 CHECK constraint
/// on `features.state` (plan line 740).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FeatureState {
    Active,
    Tabled,
    WrappedUp,
    Abandoned,
}
