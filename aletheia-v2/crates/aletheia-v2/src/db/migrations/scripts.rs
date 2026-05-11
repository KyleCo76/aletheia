// Phase 2 sub-task B5 — Embedded migration SQL scripts.
//
// V2.0.0 baseline: the initial schema lives in `scope_schema.rs` (per-scope
// DBs) and `registry_schema.rs` (the registry DB) and is materialized at
// **create time**, not via a migration run. Therefore `migration_for_version(1)`
// returns `None` — there is no script to apply when promoting a fresh data
// dir to V2.0.0; the schema already matches.
//
// Future V2.x → V2.y migrations ship as `include_str!`-embedded `.sql` files
// in `migrations/scripts/`. The convention (per plan lines 1211-1227):
//
// ```rust
// pub const V2_0_TO_V2_1: &str = include_str!("./scripts/v2_0_to_v2_1.sql");
// pub fn migration_for_version(target: u32) -> Option<&'static str> {
//     match target {
//         1 => None,
//         2 => Some(V2_0_TO_V2_1),
//         _ => None,
//     }
// }
// ```
//
// The `scripts/` subdirectory is intentionally not created in Phase 2; the
// first non-baseline migration (V2.0.1+) adds it alongside its `.sql` file.

/// Return the embedded SQL script that promotes the previous schema
/// generation to `target`. Returns `None` for the V2.0.0 baseline (which
/// is set at create time) and for unknown future targets (the caller
/// treats `None` for `target > current_max_version` as a hard error;
/// `migrations::start_migration` enforces that). For Phase 2, every input
/// returns `None`.
pub fn migration_for_version(target: u32) -> Option<&'static str> {
    match target {
        // V2.0.0 baseline: the initial schema is set at create time
        // (`scope_schema::install_all`, `registry_schema::install_all`),
        // not via a migration run.
        1 => None,
        // Future migrations register here, e.g.:
        //   2 => Some(V2_0_TO_V2_1),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Per plan lines 1221-1227: the V2.0.0 baseline has no migration
    /// script — the schema is materialized at create time. Phase 4's
    /// `start_migration` MCP tool relies on this `None` to short-circuit
    /// the runner when `target == 1`.
    #[test]
    fn migration_for_version_baseline_returns_none() {
        assert!(
            migration_for_version(1).is_none(),
            "V2.0.0 baseline must not have a migration script"
        );
    }

    /// Defense-in-depth: unknown future targets also return `None` in
    /// Phase 2. The caller treats `None` for a non-baseline target as a
    /// hard error; this test pins the current behavior so a typo in
    /// `migration_for_version` (e.g. accidentally returning Some for a
    /// random target) is caught immediately.
    #[test]
    fn migration_for_version_unknown_targets_return_none() {
        for t in [0_u32, 2, 3, 100, u32::MAX] {
            assert!(
                migration_for_version(t).is_none(),
                "target {t} must return None in Phase 2"
            );
        }
    }
}
