use chrono::{DateTime, Utc};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryClass {
    Journal,
    Memory,
    Status,
    Handoff,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub struct EntryId(pub String);

impl EntryId {
    /// Mint a new UUID-v4-backed EntryId.
    pub fn new() -> Self {
        Self(Uuid::new_v4().to_string())
    }
}

impl Default for EntryId {
    fn default() -> Self {
        Self::new()
    }
}

/// Monotonically-increasing per-entry version counter (1, 2, 3, ...).
/// New value rows append; the prior row's `valid_to` is set to the new
/// row's `valid_from` to maintain bitemporal lineage.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize,
)]
#[serde(transparent)]
pub struct Version(pub u32);

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
pub struct ValidityWindow {
    pub valid_from: DateTime<Utc>,
    pub valid_to: Option<DateTime<Utc>>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn entry_id_new_produces_unique_values() {
        let mut set = HashSet::new();
        for _ in 0..5 {
            set.insert(EntryId::new());
        }
        assert_eq!(
            set.len(),
            5,
            "5 calls to EntryId::new() must produce 5 distinct IDs"
        );
    }

    #[test]
    fn entry_class_serializes_lowercase() {
        let s = serde_json::to_string(&EntryClass::Journal).unwrap();
        assert_eq!(s, "\"journal\"");
    }
}
