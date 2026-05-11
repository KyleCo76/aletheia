#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub struct ScopeId(pub(crate) String);

impl ScopeId {
    /// Construct a ScopeId, validating that the input is safe for use in
    /// raw SQL contexts (ATTACH DATABASE, PRAGMA <alias>) and filesystem
    /// paths.
    ///
    /// Accepts either:
    /// - A canonical UUID (8-4-4-4-12 hex with dashes, exactly 36 chars), or
    /// - A short alphanumeric handle matching `[a-z0-9_-]+` of length 1..=64.
    ///
    /// Rejects: SQL metacharacters (`;`, `'`, `"`, `--`), path traversal
    /// (`..`, `/`, `\`), whitespace, control characters, uppercase letters
    /// in the short-handle branch, and any other shape outside the two
    /// branches above.
    ///
    /// This is the only path by which outside callers may construct a
    /// `ScopeId`; the inner field is `pub(crate)`, so direct construction
    /// is reserved for within-crate code that already controls the
    /// provenance of its inputs (tests, registry reads, UUID generation).
    pub fn new(s: impl Into<String>) -> crate::error::Result<Self> {
        let s = s.into();
        if s.is_empty() || s.len() > 64 {
            return Err(crate::error::AletheiaError::Scope(format!(
                "invalid scope_id: {s:?}"
            )));
        }
        // Hard-reject the SQL-comment sequence "--" even though `-` itself
        // is allowed as a single character in the short-handle charset.
        // Defense-in-depth against any future interpolation site.
        if s.contains("--") {
            return Err(crate::error::AletheiaError::Scope(format!(
                "invalid scope_id: {s:?}"
            )));
        }
        if is_canonical_uuid(&s) || is_short_handle(&s) {
            Ok(ScopeId(s))
        } else {
            Err(crate::error::AletheiaError::Scope(format!(
                "invalid scope_id: {s:?}"
            )))
        }
    }

    /// Borrow the inner string. Use in preference to direct field access
    /// from outside the crate.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for ScopeId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Canonical UUID: 36 chars, hex with dashes at positions 8, 13, 18, 23
/// (8-4-4-4-12 layout). Hex digits are accepted in either case.
fn is_canonical_uuid(s: &str) -> bool {
    if s.len() != 36 {
        return false;
    }
    for (i, c) in s.char_indices() {
        let dash_position = matches!(i, 8 | 13 | 18 | 23);
        if dash_position {
            if c != '-' {
                return false;
            }
        } else if !c.is_ascii_hexdigit() {
            return false;
        }
    }
    true
}

/// Short handle: 1..=64 chars from `[a-z0-9_-]` only. No uppercase, no
/// whitespace, no path separators, no SQL metacharacters.
fn is_short_handle(s: &str) -> bool {
    if s.is_empty() || s.len() > 64 {
        return false;
    }
    s.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_accepts_valid_uuid() {
        let s = ScopeId::new("550e8400-e29b-41d4-a716-446655440000").expect("valid uuid");
        assert_eq!(s.as_str(), "550e8400-e29b-41d4-a716-446655440000");
    }

    #[test]
    fn new_accepts_lowercase_alphanumeric_with_underscore_and_hyphen() {
        let s = ScopeId::new("aletheia_v2-system").expect("valid short handle");
        assert_eq!(s.as_str(), "aletheia_v2-system");
    }

    #[test]
    fn new_rejects_sql_metacharacters() {
        for bad in &[r#"";"#, r#"'"#, r#"""#, "--", " ", " OR 1=1"] {
            let r = ScopeId::new(*bad);
            assert!(r.is_err(), "expected reject for {bad:?}, got {r:?}");
        }
    }

    #[test]
    fn new_rejects_path_traversal() {
        for bad in &["..", "../etc", "foo/bar", r"foo\bar"] {
            let r = ScopeId::new(*bad);
            assert!(r.is_err(), "expected reject for {bad:?}, got {r:?}");
        }
    }

    #[test]
    fn new_rejects_empty_string() {
        assert!(ScopeId::new("").is_err());
    }

    #[test]
    fn new_rejects_too_long() {
        let s = "a".repeat(65);
        assert!(ScopeId::new(s).is_err(), "65-char input must be rejected");
    }

    #[test]
    fn as_str_returns_inner() {
        let s = ScopeId::new("valid_id").unwrap();
        assert_eq!(s.as_str(), "valid_id");
    }

    #[test]
    fn display_formats_correctly() {
        let s = ScopeId::new("test").unwrap();
        assert_eq!(format!("{}", s), "test");
    }
}
