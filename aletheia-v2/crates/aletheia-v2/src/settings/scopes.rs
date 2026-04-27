/// `[scopes]` settings.
///
/// Phase 3 (auth + scope registration) consumes these. The maximum
/// simultaneous ATTACH count corresponds to the SQLite ATTACH ceiling
/// (build flag SQLITE_MAX_ATTACHED=125 — see build.rs).
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(default)]
pub struct ScopesSettings {
    /// Maximum scopes a single session may simultaneously have
    /// attached. Worker A1 default: 16 (well under the 125 SQLite
    /// hard cap, but enough headroom for CEO sessions spanning many
    /// projects).
    pub max_attached_per_session: u32,
}

impl Default for ScopesSettings {
    fn default() -> Self {
        Self {
            max_attached_per_session: 16,
        }
    }
}
