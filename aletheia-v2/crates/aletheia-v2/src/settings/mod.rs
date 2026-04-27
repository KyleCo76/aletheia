//! Settings tree.
//!
//! ## Danger-file mitigation
//!
//! Per plan line 179 (mandatory): the settings module is split into
//! per-section submodule files so each phase modifies its own file
//! rather than a single monolithic `settings.rs`. The aggregator below
//! is the only place that knows about every submodule — adding a new
//! section requires editing this file once (declaration + composition).
//!
//! ## Default behavior
//!
//! `Settings::default()` produces a fully-populated struct using each
//! submodule's `Default` impl. `Settings::load(path)` reads a TOML
//! file; missing sections fall back to defaults via `#[serde(default)]`.
//! A non-existent path returns the default tree without error — the
//! installation is usable out-of-the-box without a user-supplied
//! `settings.toml`.

mod digest;
mod digest_queue;
mod features;
mod hooks;
mod injection;
mod limits;
mod mass_ingest;
mod memory;
mod migration;
mod permissions;
mod retention;
mod scopes;
mod session_locks;
mod shadow;

pub use digest::{DigestPerScope, DigestSettings};
pub use digest_queue::DigestQueueSettings;
pub use features::FeaturesSettings;
pub use hooks::HooksSettings;
pub use injection::{InjectionRecency, InjectionRelevance, InjectionSettings, InjectionWeights};
pub use limits::LimitsSettings;
pub use mass_ingest::MassIngestSettings;
pub use memory::MemorySettings;
pub use migration::MigrationSettings;
pub use permissions::PermissionsSettings;
pub use retention::RetentionSettings;
pub use scopes::ScopesSettings;
pub use session_locks::SessionLocksSettings;
pub use shadow::ShadowSettings;

// Worker A1 deviation note: the plan's stanza (line 312) constructs
// `Settings::default()` via `Self::deserialize(empty TOML table)`. With
// `#[serde(default)]` on the struct, that path triggers infinite
// recursion on the test runner: serde's `default` for missing fields
// calls `Settings::default()` which calls `deserialize` which loops
// until the stack overflows. We instead `#[derive(Default)]`, which
// composes each submodule's own `Default` impl — semantically identical
// to the plan's intent but immune to the recursion bug.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
pub struct Settings {
    pub permissions: PermissionsSettings,
    pub injection: InjectionSettings,
    pub memory: MemorySettings,
    pub hooks: HooksSettings,
    pub digest: DigestSettings,
    pub digest_queue: DigestQueueSettings,
    pub mass_ingest: MassIngestSettings,
    pub shadow: ShadowSettings,
    pub session_locks: SessionLocksSettings,
    pub retention: RetentionSettings,
    pub features: FeaturesSettings,
    pub migration: MigrationSettings,
    pub scopes: ScopesSettings,
    pub limits: LimitsSettings,
    pub debug: bool,
}

impl Settings {
    /// Load settings from a TOML file. A non-existent path returns the
    /// default tree (no error). Parse errors propagate as
    /// `AletheiaError::Toml`.
    pub fn load(path: &std::path::Path) -> crate::error::Result<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let contents = std::fs::read_to_string(path)?;
        let parsed: Self = toml::from_str(&contents)?;
        Ok(parsed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_populates_every_section() {
        let s = Settings::default();
        // Spot-check Q6 specifications per CR-1 line 615.
        assert_eq!(s.injection.weights.0.get("tag_overlap"), Some(&0.4));
        assert_eq!(s.session_locks.heartbeat_seconds, 60);
        assert_eq!(s.mass_ingest.approval_ttl_hours, 24);
        // Other defaults sanity check.
        assert_eq!(s.injection.l1_interval, 10);
        assert_eq!(s.injection.l2_interval, 20);
        assert_eq!(s.injection.recency.half_life_days, 30.0);
        assert!(!s.debug);
    }

    /// CRITICAL CONTRACT C1: InjectionWeights is a HashMap<String, f64>
    /// with `#[serde(transparent)]`, so V3-anticipated keys
    /// (e.g. `graph_proximity`) parse without code change. This test is
    /// the explicit forward-compat lock-in mentioned in CR-1 line 616.
    #[test]
    fn injection_weights_accepts_v3_anticipated_keys() {
        let toml_str = r#"
[injection.weights]
graph_proximity = 0.5
tag_overlap = 0.4
"#;
        let parsed: Settings = toml::from_str(toml_str).expect("must parse V3-anticipated keys");
        assert_eq!(
            parsed.injection.weights.0.get("graph_proximity"),
            Some(&0.5)
        );
        assert_eq!(parsed.injection.weights.0.get("tag_overlap"), Some(&0.4));
    }

    #[test]
    fn load_nonexistent_path_returns_default() {
        let s = Settings::load(std::path::Path::new("/nonexistent/path/settings.toml"))
            .expect("missing path must not error");
        assert_eq!(s.injection.weights.0.get("tag_overlap"), Some(&0.4));
    }
}
