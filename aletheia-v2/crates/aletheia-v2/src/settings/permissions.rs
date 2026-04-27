/// `[permissions]` settings.
///
/// Phase 1 stubs the section with one toggle (whether non-CEO keys may
/// mint sub-keys). Phase 3 (auth) will extend this with concrete policy
/// keys. Defaults are conservative: only explicit grants confer
/// elevated capability.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
pub struct PermissionsSettings {
    /// If true, non-master keys with `create-sub-entries` permission
    /// may mint sub-keys for child sessions. Defaults to false; CEO
    /// keys (master) are never gated by this flag.
    pub allow_sub_key_creation: bool,
}
