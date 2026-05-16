//! Forward-reference stub for V3-bound Shadow Mode infrastructure.
//!
//! Phase 9 (TL-polish) replaces with real Shadow Mode comparison-ranking observer.
//! Phase 6 (TL-pipelines) `ScoringEngine.top_k_filtered` accepts `Option<&ShadowObserver>`;
//! the no-op stub lets Phase 6 compile cleanly before Phase 9 ships.

pub mod observer;

pub use observer::ShadowObserver;
