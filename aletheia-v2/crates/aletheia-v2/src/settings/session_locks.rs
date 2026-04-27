/// `[session_locks]` settings.
///
/// Phase 5 (session lifecycle) consumes these. CEO Item 9 set the
/// canonical defaults: heartbeat 60s, stale threshold 180s. CR-1
/// spot-check pins `heartbeat_seconds = 60`.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(default)]
pub struct SessionLocksSettings {
    /// Frequency (seconds) at which an active session refreshes its
    /// heartbeat. CR-1 spot-check pin: 60.
    pub heartbeat_seconds: u32,
    /// Threshold (seconds since last heartbeat) at which a session
    /// lock is considered stale and may be reaped. CEO Item 9: 180.
    pub stale_threshold_seconds: u32,
}

impl Default for SessionLocksSettings {
    fn default() -> Self {
        Self {
            heartbeat_seconds: 60,
            stale_threshold_seconds: 180,
        }
    }
}
