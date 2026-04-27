/// Stable identifier for a key row in the registry.
/// Phase 1 uses a String wrapper; Phase 2's `keys` table will pin the
/// underlying type via DDL.
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub struct KeyId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct KeyHash(pub String);

/// Raw key material (64-char hex). Never serialized to the DB or logs;
/// the `Debug` impl is intentionally redacted.
#[derive(Clone)]
pub struct KeyValue(pub String);

impl std::fmt::Debug for KeyValue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KeyValue")
            .field("value", &"<redacted>")
            .finish()
    }
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "kebab-case")]
pub enum Permissions {
    ReadOnly,
    ReadWrite,
    CreateSubEntries,
    Maintenance,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permissions_ordering_is_ascending_by_capability() {
        // Critical contract: PartialOrd derive on the variant declaration
        // order is the source of truth for capability hierarchy. Subsequent
        // phases use `key.perms < required` for access checks.
        assert!(Permissions::ReadOnly < Permissions::ReadWrite);
        assert!(Permissions::ReadWrite < Permissions::CreateSubEntries);
        assert!(Permissions::CreateSubEntries < Permissions::Maintenance);
    }

    #[test]
    fn key_value_debug_is_redacted() {
        let k = KeyValue("super-secret-hex-material".into());
        let dbg = format!("{:?}", k);
        assert!(!dbg.contains("super-secret"));
        assert!(dbg.contains("<redacted>"));
    }
}
