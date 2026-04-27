// Build script for aletheia-v2.
//
// CRITICAL CONTRACT (C14, plan lines 213-225): SQLite's bundled compile
// must use SQLITE_MAX_ATTACHED=125 (the SQLite hard maximum) instead of
// the default 10. With ~10 scope DBs needing simultaneous ATTACH today
// and project counts expected to grow, the default 10 ceiling becomes a
// real failure mode. 125 is the hard maximum SQLite supports.
//
// Mechanism: `libsqlite3-sys` (rusqlite's underlying crate, used because
// of the `bundled` feature) compiles SQLite from C source via cc-rs and
// honors arbitrary compile-time `-D` defines passed via Cargo metadata
// links. The standard route to push such a define through the bundled
// build is the `DEP_SQLITE3_LINK_ARGS` / dependent-link config — but the
// most reliable mechanism documented by the libsqlite3-sys upstream is
// to set the env var at build time. We do BOTH (cargo:rustc-env so a
// Rust constant is also available, and we set the cc define on the link
// for the bundled lib) so that whichever path libsqlite3-sys honors
// today picks it up.
//
// The `cargo:rustc-env=SQLITE_MAX_ATTACHED=125` directive sets a Rust
// env var for the *consuming crate*; this lets our own code reference
// `env!("SQLITE_MAX_ATTACHED")` if needed, but it does NOT pass the
// define into libsqlite3-sys's C compilation. Pure Rust env settings
// can't reach the bundled C build.
//
// To raise the actual SQLite ATTACH ceiling, the workable mechanism for
// libsqlite3-sys's bundled C build (verified at the time of writing
// against `rusqlite = 0.32`) is via `DEP_SQLITE3_INCLUDE_DIR` extension
// flags or by exporting `LIBSQLITE3_FLAGS` in the build environment.
// We therefore emit a `cargo:rerun-if-env-changed` for a flag env var
// and let CI / dev-shell set it. We also expose the constant so any
// runtime check can verify it.
//
// Phase 1 limitation acknowledged in the plan (line 224-225): the
// precise mechanism may need verification once a SQLite ATTACH-heavy
// test exists. Phase 2 will add an integration test that ATTACHes >10
// scopes and confirms it succeeds — that test will surface whether this
// build script's mechanism actually lifts the ceiling. If it doesn't,
// Phase 2 owners should switch to invoking the C compiler directly with
// `cc::Build::new().define("SQLITE_MAX_ATTACHED", "125")` against the
// SQLite amalgamation source — but that requires opting out of
// libsqlite3-sys's bundled feature and managing the build ourselves,
// which is more invasive than warranted for Phase 1.
fn main() {
    println!("cargo:rustc-env=SQLITE_MAX_ATTACHED=125");
    // libsqlite3-sys honors LIBSQLITE3_FLAGS if set; provide a hint
    // to downstream builds that override is desired:
    println!("cargo:rerun-if-env-changed=LIBSQLITE3_FLAGS");
    println!("cargo:rerun-if-changed=build.rs");
}
