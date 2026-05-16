//! Phase 3 W1 — permission and scope delegation checks.
//!
//! Two pure functions enforce the V2 delegation invariants:
//!
//! - `can_delegate_permission`: a child key's permission level must be
//!   ≤ the parent's (no upward escalation; ReadWrite parent cannot mint
//!   a Maintenance child).
//! - `can_delegate_scope`: a child scope must appear in the parent
//!   key's `writable_scope_ids` (no lateral or upward scope grant).
//!
//! Both return `Result<()>` so call sites can `?` them.
//!
//! Plan reference: lines 1489-1525. Deviation: the plan defines a
//! `level()` helper that maps `Permissions` to `u8`; we instead rely
//! directly on the `PartialOrd` derive on `Permissions` (variant
//! declaration order in `types::key`: ReadOnly < ReadWrite <
//! CreateSubEntries < Maintenance). The derive is the source of truth
//! per the `permissions_ordering_is_ascending_by_capability` test in
//! `types::key`; an additional `level()` helper would be a parallel
//! mapping and a future drift hazard. Same semantics, less surface.

use crate::error::{AletheiaError, Result};
use crate::types::key::Permissions;
use crate::types::scope::ScopeId;

/// Verify that `child` permission can be delegated from `parent`.
///
/// Succeeds iff `child <= parent` per the `PartialOrd` derive on
/// `Permissions`. The variant order in `types::key::Permissions` is
/// ascending by capability, so direct comparison is correct.
pub fn can_delegate_permission(parent: Permissions, child: Permissions) -> Result<()> {
    if child > parent {
        return Err(AletheiaError::Auth(format!(
            "Cannot delegate {child:?} from {parent:?} (child must be ≤ parent)"
        )));
    }
    Ok(())
}

/// Verify that `child_scope` can be delegated from a key whose
/// writable scopes are `parent_writable`.
///
/// Succeeds iff `child_scope` appears in `parent_writable`. The
/// `parent_scope` parameter is accepted for API symmetry / future use
/// (e.g. logging context); the check itself does not depend on the
/// parent's primary scope, only on the writable-set membership.
pub fn can_delegate_scope(
    _parent_scope: &ScopeId,
    child_scope: &ScopeId,
    parent_writable: &[ScopeId],
) -> Result<()> {
    if !parent_writable.iter().any(|s| s == child_scope) {
        return Err(AletheiaError::Scope(format!(
            "Cannot delegate scope {child_scope:?} — not in parent's writable scopes"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delegate_permission_downward_ok() {
        can_delegate_permission(Permissions::Maintenance, Permissions::ReadWrite)
            .expect("Maintenance → ReadWrite must be allowed");
        can_delegate_permission(Permissions::ReadWrite, Permissions::ReadOnly)
            .expect("ReadWrite → ReadOnly must be allowed");
        can_delegate_permission(Permissions::Maintenance, Permissions::Maintenance)
            .expect("equal levels must be allowed");
    }

    #[test]
    fn delegate_permission_upward_errors() {
        let err = can_delegate_permission(Permissions::ReadOnly, Permissions::Maintenance)
            .expect_err("ReadOnly → Maintenance must be rejected");
        match err {
            AletheiaError::Auth(msg) => {
                assert!(msg.contains("Cannot delegate"), "msg = {msg}");
                assert!(msg.contains("Maintenance"), "msg = {msg}");
                assert!(msg.contains("ReadOnly"), "msg = {msg}");
            }
            other => panic!("expected AletheiaError::Auth, got {other:?}"),
        }
    }

    #[test]
    fn delegate_scope_in_parent_writable_ok() {
        let parent_scope = ScopeId::new("parent-scope").unwrap();
        let child_scope = ScopeId::new("child-scope").unwrap();
        let writable = vec![
            ScopeId::new("other-scope").unwrap(),
            child_scope.clone(),
            ScopeId::new("third-scope").unwrap(),
        ];
        can_delegate_scope(&parent_scope, &child_scope, &writable)
            .expect("child in writable must succeed");
    }

    #[test]
    fn delegate_scope_not_in_parent_writable_errors() {
        let parent_scope = ScopeId::new("parent-scope").unwrap();
        let child_scope = ScopeId::new("forbidden-scope").unwrap();
        let writable = vec![
            ScopeId::new("other-scope").unwrap(),
            ScopeId::new("third-scope").unwrap(),
        ];
        let err = can_delegate_scope(&parent_scope, &child_scope, &writable)
            .expect_err("child outside writable must fail");
        match err {
            AletheiaError::Scope(msg) => {
                assert!(msg.contains("forbidden-scope"), "msg = {msg}");
                assert!(msg.contains("not in parent"), "msg = {msg}");
            }
            other => panic!("expected AletheiaError::Scope, got {other:?}"),
        }
    }
}
