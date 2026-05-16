//! Forward-reference stub. Phase 9 (TL-polish) replaces with real deprecation logging.
//!
//! Phase 5 tools' `AuthContext::precheck()` calls `check_and_log()` for each tool
//! invocation; this no-op lets Phase 5 compile cleanly before Phase 9 ships.

use crate::error::Result;

pub fn check_and_log(_tool_name: &str, _session_id: Option<&str>) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_and_log_synthetic_call_site() {
        // SHOULD-4 (post-W2 three-review gate): verifies the documented
        // call shape that Phase 5 (TL-tools) AuthContext::precheck() will
        // use. A future refactor that changes this signature would fail
        // here BEFORE breaking the Phase 5 build.
        check_and_log("test_tool", None).expect("no-op stub must Ok");
        check_and_log("test_tool", Some("session-xyz")).expect("no-op stub must Ok");
    }
}
