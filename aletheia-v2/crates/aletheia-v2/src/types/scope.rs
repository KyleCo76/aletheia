#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub struct ScopeId(pub String);

/// Short, human-readable scope handle (e.g. `"hockey"`, `"system"`).
/// Used for ATTACH alias derivation and CLI surface.
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub struct ScopeName(pub String);

/// The category of scope. The plan distinguishes the system scope
/// (`system`/CEO-tier) from project scopes and shared scopes; this enum
/// captures the distinction so later phases can branch on permission
/// rules. Phase 1 uses it only as a typed placeholder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScopeKind {
    /// CEO/system-tier scope; one per installation.
    System,
    /// Standard project scope (e.g. one per active codebase or initiative).
    Project,
    /// Shared scope used for cross-project memory/handoff exchange.
    Shared,
}

#[derive(Debug, Clone)]
pub struct PermissionSet {
    pub primary_scope_id: ScopeId,
    pub writable_scope_ids: Vec<ScopeId>,
    pub readonly_scope_ids: Vec<ScopeId>,
}
