# Changelog

All notable changes to Aletheia are documented in this file.

## v0.1.2 — 2026-04-11

Bug-fix release on top of v0.1.1.

### Fixed

- **Bug #27 — `update_status` silent no-op on missing section.** Calling
  `update_status(entry_id, section_id, state)` with a `section_id` that
  did not exist in the target entry's status document used to return a
  success response while making zero database changes — callers had no
  way to detect the miss. The handler now returns
  `{isError: true, code: NOT_FOUND}` and the error message names the
  missing `section_id`. The query layer's `updateStatusSection` performs
  the existence check and the UPDATE inside a single immediate
  transaction so the `{found}` return reflects the same row state the
  UPDATE saw. A regression test in `test/status-update-not-found.test.mjs`
  exercises both the bug case and the happy path.

- **Install: `npm install -g git+https://...` race with `prepare`
  script.** Global git installs sometimes ran the `prepare` lifecycle
  before npm had placed devDependencies on PATH, so `tsc` was missing
  and the build aborted. The fix is two-part:
    1. The `prepare` script is now a small Node wrapper
       (`scripts/prepare.mjs`) that gracefully skips the build when
       `tsc` is not installed, exiting 0 and printing a clear stderr
       message that points users at the supported install path. Global
       installs from a git URL no longer hard-fail.
    2. A new GitHub Actions workflow (`.github/workflows/release.yml`)
       runs on every `v*` tag push, executes `npm pack` in a clean CI
       environment with all devDependencies installed, and attaches the
       resulting prebuilt tarball to the GitHub release. This is the
       supported install path going forward.

### Install (v0.1.2)

```bash
npm install -g \
  https://github.com/KyleCo76/aletheia/releases/download/v0.1.2/aletheia-0.1.2.tgz
```

The tarball ships with a precompiled `dist/` directory, so the install
host does not need TypeScript or any devDependencies.

The legacy install command (`npm install -g git+https://...`) is no
longer supported and will produce a non-functional installation even
though it no longer hard-errors during `prepare`.

## v0.1.1 — 2026-04-10

Six-bug maintenance release. Fixed:

- **#15** — `setup` now registers the MCP server via the
  `claude mcp add` subprocess instead of writing to
  `~/.claude/settings.json` (Claude Code reads from `~/.claude.json`).
- **#17** — Circuit-breaker write limits are now configurable via the
  `[limits]` section of `settings.toml` (`circuit_breaker_writes_per_interval`,
  `circuit_breaker_interval_minutes`, `critical_write_cap`) instead of
  being hardcoded.
- **#18** — `replace_status` now accepts an empty `version_id` on the
  initial write to a newly-created status entry, instead of rejecting it
  before the query layer can mint a fresh version. OCC still engages
  for any existing document.
- **#19** — L1 and L2 injection builders now scope their queries by
  `project_namespace` when one is set in session state. New
  `readStatusByProject` / `readMemoriesByProject` /
  `readJournalEntriesByProject` query helpers JOIN through `entries` to
  filter by namespace. Prior to this fix, the builders treated the
  project-namespace string as an entry UUID and silently returned no
  data in multi-agent sessions.
- **#20** — Per-session socket discovery via parent PID. Hooks read
  `~/.aletheia/sockets/claude-<PPID>.sock.path` (where `$PPID` is
  Claude Code's PID, shared by both the MCP server and the hook child
  processes) instead of the shared `current` file, eliminating the
  race where concurrent MCP servers stomped on the discovery pointer.
  The legacy `current` file is still written for backward compat.
- **#21** — `claim` handler now sets `projectNamespace` in session
  state from the key's `entry_scope`. Previously only `bootstrap` did
  this, so non-bootstrap sessions wrote to the `default` namespace
  instead of the namespace they thought they were in.

## v0.1.0 — 2026-04-09

Initial public release. Self-contained MCP-based memory system for
Claude Code with SQLite persistence, dual stdio/Unix-socket interface,
hook-driven L1/L2 context injection, key-based permissions, and CLI
setup/teardown.
