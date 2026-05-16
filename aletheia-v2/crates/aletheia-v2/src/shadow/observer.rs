//! Forward-reference stub. Phase 9 (TL-polish) replaces with real Shadow Mode observer.

#[derive(Debug, Default)]
pub struct ShadowObserver;

impl ShadowObserver {
    pub fn new() -> Self {
        Self
    }

    /// No-op until Phase 9 ships the real comparison-ranking observer.
    pub fn observe_sync(&self, _emitted_ranking: &[String], _comparison_ranking: &[String]) {
        // No-op.
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observer_synthetic_call_site() {
        // SHOULD-4 (post-W2 three-review gate): verifies the documented
        // call shape that Phase 6 (TL-pipelines) ScoringEngine will use
        // as Option<&ShadowObserver>::observe_sync(&emitted, &compare).
        let observer = ShadowObserver::new();
        observer.observe_sync(&[], &[]);
        observer.observe_sync(
            &["entry-1".to_string()],
            &["entry-1".to_string(), "entry-2".to_string()],
        );
        // No panic = pass. The no-op stub has no observable side effect.
    }
}
