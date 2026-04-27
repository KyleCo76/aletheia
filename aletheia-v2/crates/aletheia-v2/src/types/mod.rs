//! Core domain types shared across all phases.

pub mod audit;
pub mod entry;
pub mod feature;
pub mod key;
pub mod scope;

pub use audit::{AuditEventCategory, AuditEventType};
pub use entry::{EntryClass, EntryId, ValidityWindow, Version};
pub use feature::{FeatureId, FeatureState};
pub use key::{KeyHash, KeyId, KeyValue, Permissions};
pub use scope::{PermissionSet, ScopeId, ScopeKind, ScopeName};
