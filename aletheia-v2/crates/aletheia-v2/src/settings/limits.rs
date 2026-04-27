/// `[limits]` settings.
///
/// Phase 4+ tool handlers consume these as guardrails on tool inputs
/// and storage growth. Defaults are conservative; operators can tune
/// upward via TOML override.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(default)]
pub struct LimitsSettings {
    /// Maximum content length (chars) for a single create_entry call.
    /// Worker A1 default: 64k chars.
    pub max_entry_content_chars: u32,
    /// Maximum tags per entry. Worker A1 default: 32.
    pub max_tags_per_entry: u32,
    /// Maximum search result count. Worker A1 default: 100.
    pub max_search_results: u32,
}

impl Default for LimitsSettings {
    fn default() -> Self {
        Self {
            max_entry_content_chars: 64 * 1024,
            max_tags_per_entry: 32,
            max_search_results: 100,
        }
    }
}
