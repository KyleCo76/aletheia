/// Crate version pulled from `Cargo.toml` at compile time.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Schema version baseline for V2.0.0. Bumped per migration in
/// `src/db/migrations/scripts.rs` (Phase 2+).
pub const SCHEMA_VERSION: u32 = 1;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_is_two_dot_zero() {
        assert_eq!(VERSION, "2.0.0");
    }

    #[test]
    fn schema_version_starts_at_one() {
        assert_eq!(SCHEMA_VERSION, 1);
    }
}
