/// `[memory]` settings.
///
/// Phase 1 stubs with a small number of toggles; Phase 5 (memory
/// operations) will extend. Defaults chosen to favor explicit promotion
/// (no auto-promote) and to keep memory journal entries reasonably
/// sized.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(default)]
pub struct MemorySettings {
    /// Whether `promote_to_memory` requires explicit user approval per
    /// invocation. Worker A1 default: true (conservative).
    pub require_promote_confirmation: bool,
    /// Maximum chars in a single memory entry's content. Worker A1
    /// default: 16k chars (rough proxy for ~4k tokens).
    pub max_entry_chars: u32,
}

impl Default for MemorySettings {
    fn default() -> Self {
        Self {
            require_promote_confirmation: true,
            max_entry_chars: 16_000,
        }
    }
}
