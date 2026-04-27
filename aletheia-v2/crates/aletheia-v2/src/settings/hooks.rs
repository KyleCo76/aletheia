/// `[hooks]` settings.
///
/// Phase 4+ (MCP server) will install Claude Code hooks for L1/L2
/// injection and history reminders. Phase 1 stubs the section so the
/// TOML schema accepts it; Phase 4 will extend with concrete fields.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(default)]
pub struct HooksSettings {
    /// Whether the MCP server installs Claude Code PreToolUse / Stop
    /// hooks at startup. Worker A1 default: true (the hooks are the
    /// primary injection vector).
    pub install_on_startup: bool,
}

impl Default for HooksSettings {
    fn default() -> Self {
        Self {
            install_on_startup: true,
        }
    }
}
