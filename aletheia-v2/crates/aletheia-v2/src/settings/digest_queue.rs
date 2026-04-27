/// `[digest_queue]` settings.
///
/// Phase 7 will define the worker that processes the digest queue.
/// Lease defaults follow CEO Item 9 conventions (ditto session_locks).
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(default)]
pub struct DigestQueueSettings {
    /// Lease duration (seconds) for an in-flight digest job. Worker A1
    /// default: 600 (10 min). Phase 7 may revise.
    pub lease_seconds: u32,
    /// Worker poll interval (seconds). Worker A1 default: 30.
    pub poll_interval_seconds: u32,
    /// Maximum retries per failed digest job. Worker A1 default: 3.
    pub max_retries: u32,
}

impl Default for DigestQueueSettings {
    fn default() -> Self {
        Self {
            lease_seconds: 600,
            poll_interval_seconds: 30,
            max_retries: 3,
        }
    }
}
