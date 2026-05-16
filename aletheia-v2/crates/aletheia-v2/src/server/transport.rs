//! Cross-platform IPC transport via `interprocess` v2.
//!
//! The server binds a Unix domain socket on Unix and a Windows named pipe on
//! Windows, exposed through the unified `interprocess::local_socket::tokio`
//! API. Each MCP server process binds at a per-PID path so multiple V2
//! instances can coexist (side-by-side install convention, plan
//! §"Install model"): `<data_dir>/sockets/aletheia-v2-<pid>.sock`. Note the
//! `aletheia-v2-` prefix (NOT V1's bare `aletheia-`) — both versions may run
//! concurrently on the same machine.
//!
//! After bind, a per-PPID pointer file
//! `<data_dir>/sockets/claude-<PPID>.sock.path` is written containing the
//! socket path. Phase 6 hook scripts (running as children of the Claude Code
//! process, sharing the same PPID as the MCP server) consult this pointer to
//! locate the active socket — preserving the V1 hook contract while moving
//! the socket itself into the V2 namespace.
//!
//! ## Platform notes
//!
//! - **Unix:** the socket file is `chmod 0600` immediately after bind. This
//!   provides the user-level isolation that Phase 4 endpoints rely on (the
//!   hook server has no authentication; the filesystem permission is the
//!   sole gate). The mode is set on the actual `.sock` file, not the
//!   parent directory.
//!
//! - **Windows:** named pipes created via `interprocess` v2's
//!   `ListenerOptions` inherit a default security descriptor that grants
//!   access only to the creating user (per the crate's behavior on
//!   `CreateNamedPipeW`). **This assumption has NOT been verified on a
//!   Windows CI runner during Phase 4** — Wave 2 has no Windows CI.
//!   Treat the Windows ACL story as a Phase 4 verification gap (plan CR-4
//!   known risk, line 2427). Phase 10 follow-up: spike a real Windows
//!   binding and read back the DACL.
//!
//! - **PPID resolution:** Unix uses `nix::unistd::getppid()`. Windows has
//!   no equally cheap call (the closest is `CreateToolhelp32Snapshot` or
//!   `NtQueryInformationProcess`, neither cheap nor pleasant). Phase 4
//!   lands a Windows fallback that writes the pointer with PPID `0`;
//!   Phase 6 hook scripts already plan to scan `sockets/` for the
//!   most-recent `aletheia-v2-*.sock` on Windows as a degraded but
//!   functional path. A TODO marks the proper fix.

use crate::error::{AletheiaError, Result};
use interprocess::local_socket::{
    GenericFilePath, ListenerNonblockingMode, ListenerOptions, ToFsName, tokio::Listener,
};
use std::path::{Path, PathBuf};

/// Compute the per-PID socket path for this server process.
///
/// Convention: `<data_dir>/sockets/aletheia-v2-<pid>.sock`. The `aletheia-v2-`
/// prefix differentiates this from V1's `aletheia-<pid>.sock`, enabling
/// side-by-side install of V1 and V2 servers.
pub fn socket_path(data_dir: &Path) -> PathBuf {
    let pid = std::process::id();
    data_dir
        .join("sockets")
        .join(format!("aletheia-v2-{}.sock", pid))
}

/// Bind a Unix domain socket (or Windows named pipe) at the per-PID socket
/// path. Performs the following sequence:
///
/// 1. Creates the `<data_dir>/sockets/` directory if it does not exist.
/// 2. Removes any stale socket file at the per-PID path (left behind by a
///    prior crashed server with the same PID after PID reuse).
/// 3. Builds the listener via `ListenerOptions::new().name(...).create_tokio()`.
/// 4. On Unix: sets the socket file mode to `0600`.
/// 5. Writes the per-PPID pointer file
///    `<data_dir>/sockets/claude-<PPID>.sock.path` containing the actual
///    socket path string (V1 hook compat).
///
/// Returns the live `Listener` ready for `accept().await` in the caller's
/// accept loop.
pub async fn bind_listener(data_dir: &Path) -> Result<Listener> {
    let path = socket_path(data_dir);

    // Validate sun_path BEFORE any filesystem side effects (SHOULD-1 fix —
    // three-review gate, Phase 4). The prior ordering ran create_dir_all
    // and remove_file before this check, which on overflow left a partial
    // `sockets/` directory tree behind even though the function errored.
    // Pre-bind validation: the Unix `sockaddr_un.sun_path` field is a fixed-size
    // C array, and `bind(2)` returns a cryptic `InvalidInput` if the path is
    // longer. We surface a structured error before the syscall.
    //
    // Sizing rationale (from glibc / BSD headers):
    //   - Linux: `sun_path` is 108 bytes (107 usable + 1 null terminator).
    //   - macOS / BSD: `sun_path` is 104 bytes (103 usable + 1 null terminator).
    //
    // We use 104 as the conservative practical bound — admitting macOS/BSD
    // without runtime divergence. The 4-byte gap below Linux's true limit
    // costs nothing in practice (a deeply-nested `--data-dir` that fits in
    // 104 bytes fits in 108 too) and keeps the binary portable.
    #[cfg(unix)]
    {
        /// macOS / BSD sockaddr_un.sun_path is 104 bytes (103 usable + 1 NUL terminator).
        /// Linux is 108; we use the conservative bound. Comparison is >= because a
        /// path of exactly 104 bytes would have no room for the NUL.
        const SUN_PATH_LEN_MACOS: usize = 104;
        let path_bytes = path.as_os_str().as_encoded_bytes().len();
        if path_bytes >= SUN_PATH_LEN_MACOS {
            return Err(AletheiaError::Other(format!(
                "socket path ({path_bytes} bytes) does not leave room for NUL within sun_path limit ({SUN_PATH_LEN_MACOS}): \
                 {path:?}. Shorten the data directory path or use a different working location."
            )));
        }
    }

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // SHOULD-5 (three-review gate, Phase 4): tighten parent dir to
            // 0700 as defense-in-depth. The socket file gets chmod 0600
            // after bind, but there's a TOCTOU window where the socket
            // exists with umask-default mode. Closing off the directory
            // at 0700 eliminates the cross-user traversal path even
            // during that window.
            let perms = std::fs::Permissions::from_mode(0o700);
            if let Err(e) = std::fs::set_permissions(parent, perms) {
                tracing::warn!(
                    target: "server.transport.bind",
                    error = %e,
                    parent = %parent.display(),
                    "failed to chmod sockets parent dir to 0700; continuing (defense-in-depth, not load-bearing)"
                );
            }
        }
    }

    if path.exists() {
        tracing::warn!(
            target: "server.transport",
            path = %path.display(),
            "removing stale socket file from prior server crash before bind"
        );
        std::fs::remove_file(&path)?;
    }

    let name = path
        .as_path()
        .to_fs_name::<GenericFilePath>()
        .map_err(|e| AletheiaError::Other(format!("socket name from path: {}", e)))?;

    let listener = ListenerOptions::new()
        .name(name)
        .nonblocking(ListenerNonblockingMode::Both)
        .create_tokio()?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&path)?.permissions();
        perms.set_mode(0o600);
        std::fs::set_permissions(&path, perms)?;
    }

    let ppid = ppid_for_pointer();
    let pointer = data_dir
        .join("sockets")
        .join(format!("claude-{}.sock.path", ppid));
    std::fs::write(&pointer, path.to_string_lossy().as_bytes())?;

    tracing::info!(
        target: "server.transport",
        socket = %path.display(),
        pointer = %pointer.display(),
        ppid,
        "IPC listener bound"
    );

    Ok(listener)
}

/// Resolve the parent PID for the pointer-file name.
///
/// On Unix, returns the real PPID via `nix::unistd::getppid()`.
///
/// On Windows, returns `0` as a documented fallback. Hook scripts (Phase 6)
/// will scan `<data_dir>/sockets/` for the most-recent `aletheia-v2-*.sock`
/// on Windows rather than relying on a PPID-keyed pointer.
///
/// TODO(phase-10): wire a real Windows PPID lookup (e.g. via
/// `windows-sys`'s `CreateToolhelp32Snapshot` + `Process32First`/`Next`,
/// matching `GetCurrentProcessId()`).
fn ppid_for_pointer() -> i32 {
    #[cfg(unix)]
    {
        nix::unistd::getppid().as_raw()
    }
    #[cfg(windows)]
    {
        0
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// RAII tempdir wrapper. `tempfile` is not in workspace deps (W1 §6.2
    /// caveat #9); we manage cleanup manually. Mirrors the pattern in
    /// `db::connection::tests`.
    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(label: &str) -> Self {
            // Keep the tempdir name short: the socket path (tempdir +
            // `/sockets/aletheia-v2-<pid>.sock`) must fit under the
            // `sun_path` 104-byte conservative limit enforced by
            // `bind_listener`. The `a2-test-<label>-` prefix is 11 chars
            // plus the label; UUID-suffix collision protection is
            // preserved.
            let mut p = std::env::temp_dir();
            p.push(format!("a2-test-{}-{}", label, uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&p).expect("create tempdir");
            Self { path: p }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn socket_path_uses_aletheia_v2_prefix_and_pid() {
        let data_dir = Path::new("/tmp/aletheia-v2-test");
        let p = socket_path(data_dir);
        let file_name = p.file_name().unwrap().to_string_lossy().to_string();
        let expected_prefix = format!("aletheia-v2-{}", std::process::id());
        assert!(
            file_name.starts_with(&expected_prefix),
            "socket file name {file_name:?} should start with {expected_prefix:?} \
             (side-by-side install convention)"
        );
        assert!(
            file_name.ends_with(".sock"),
            "socket file name {file_name:?} should end with .sock"
        );
        assert_eq!(
            p.parent().and_then(|parent| parent.file_name()),
            Some(std::ffi::OsStr::new("sockets")),
            "socket should live in <data_dir>/sockets/"
        );
    }

    #[tokio::test]
    async fn bind_listener_creates_socket_file() {
        let td = TempDir::new("bind");
        let listener = bind_listener(td.path()).await.expect("bind_listener");
        let expected = socket_path(td.path());
        assert!(
            expected.exists(),
            "socket file should exist at {expected:?} after bind"
        );
        drop(listener);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn bind_listener_sets_mode_0600_on_unix() {
        use std::os::unix::fs::PermissionsExt;
        let td = TempDir::new("mode");
        let listener = bind_listener(td.path()).await.expect("bind_listener");
        let p = socket_path(td.path());
        let mode = std::fs::metadata(&p)
            .expect("stat socket file")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(
            mode, 0o600,
            "socket file at {p:?} should be chmod 0600 (got {mode:o})"
        );
        drop(listener);
    }

    #[tokio::test]
    async fn bind_listener_removes_stale_socket_file() {
        let td = TempDir::new("stale");
        let p = socket_path(td.path());
        std::fs::create_dir_all(p.parent().unwrap()).expect("mk parent");
        std::fs::write(&p, b"junk-from-prior-crashed-server").expect("write junk");
        assert!(p.exists(), "precondition: junk file present");

        let listener = bind_listener(td.path())
            .await
            .expect("bind_listener should succeed despite stale file");
        assert!(p.exists(), "socket should be re-bound at the same path");
        drop(listener);
    }

    #[tokio::test]
    async fn bind_listener_writes_per_ppid_pointer_file() {
        let td = TempDir::new("pointer");
        let listener = bind_listener(td.path()).await.expect("bind_listener");

        let ppid = ppid_for_pointer();
        let pointer = td
            .path()
            .join("sockets")
            .join(format!("claude-{}.sock.path", ppid));
        assert!(
            pointer.exists(),
            "pointer file {pointer:?} should exist after bind"
        );

        let contents = std::fs::read_to_string(&pointer).expect("read pointer file");
        let expected_socket = socket_path(td.path());
        assert_eq!(
            contents,
            expected_socket.to_string_lossy(),
            "pointer file should contain the actual socket path"
        );
        drop(listener);
    }

    /// Verify that `bind_listener` rejects paths whose resulting socket path
    /// would exceed the conservative 104-byte `sun_path` limit BEFORE
    /// attempting the bind syscall — i.e. the caller gets a structured
    /// `AletheiaError` rather than the cryptic `InvalidInput` that the
    /// `bind(2)` syscall produces on overflow.
    #[cfg(unix)]
    #[tokio::test]
    async fn bind_listener_rejects_path_exceeding_sun_path_limit() {
        // 120 'x' bytes alone push the socket path well past 104, regardless
        // of the per-PID suffix length. The directory does not need to exist;
        // the length check runs before any filesystem operation that would
        // care, and `create_dir_all` on a path under `/tmp` is harmless even
        // if we eventually short-circuit.
        let long_segment = "x".repeat(120);
        let data_dir = std::path::PathBuf::from("/tmp").join(&long_segment);

        let result = bind_listener(&data_dir).await;
        assert!(
            result.is_err(),
            "bind_listener should reject overlong paths before syscall"
        );
        let err = format!("{:?}", result.unwrap_err());
        assert!(
            err.contains("sun_path"),
            "error should mention sun_path; got: {err}"
        );

        // Best-effort cleanup of the dir bind_listener may have created.
        let _ = std::fs::remove_dir_all(&data_dir);
    }
}
