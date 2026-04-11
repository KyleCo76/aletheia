# Changelog

All notable changes to Aletheia are documented in this file.

## v0.2.2 — 2026-04-11

Second patch release on top of v0.2.0 (same day as v0.2.1). Bundles
Bug C, an `aletheia verify` enhancement, and one incremental step of
the #31 migration.

### Fixed

- **Bug C — `search` false-negative on descriptive-phrase queries.**
  Task templates reference memories with English phrases like
  "load the bootstrap info" but `search` compared the whole phrase
  against column contents via a single `LIKE '%phrase%'`, so a
  concisely-named memory `bootstrap-info` never matched even when
  the target was obvious. New `buildSearchPredicate(query, columns)`
  helper in `src/db/queries/search-predicate.ts` produces a
  `(col LIKE ? OR col LIKE ? ...)` fragment matching both the
  literal phrase AND each meaningful token (length >= 3, stop-word
  filtered). Both `searchMemory` and `searchJournal` now use it.
  Single-word queries still behave identically.

### Added

- **`aletheia verify` now flags schema-version drift.** Prior
  behavior returned the observed schema version without comparing
  against what this build expects — a stale backup passed silently,
  and a future-schema backup passed too (which would let a restore
  overwrite a live db this binary can't understand). The verify
  result now includes `expectedSchemaVersion`, `needsMigration`
  (soft, auto-migrate on next server startup), and `fromFuture`
  (hard fail, `ok=false`). CLI output surfaces both signals. New
  `CURRENT_SCHEMA_VERSION` constant exported from `db/schema.ts`
  gives a single source of truth for "what schema does this build
  target".

### Changed

- **Item #31 — incremental migration.** `src/server/tools/entries.ts`
  migrated from `formatError` to `toolError` / `toolSuccess` from
  `response-format.ts`. Six tool modules remain on the legacy
  pattern (auth.ts, discovery.ts, handoff.ts, journal.ts, memory.ts,
  system.ts); each will migrate in its own follow-up commit.

### Test infrastructure

- **38 tests total**, all green. v0.2.2 added 7 new cases across
  `test/search-tokenization.test.mjs` (5) and expanded
  `test/backup-restore.test.mjs` with two schema-drift cases.

## v0.2.1 — 2026-04-11

Patch release on top of v0.2.0. Three targeted bug fixes found via
PM-Hockey's dogfooding and PM-Aletheia's own v0.2.0 scope review.

### Fixed

- **Bug A — `write_journal` / `write_memory` response echoed only
  "newly added" tags.** Responses listed only tags whose entry_tags
  junction row flipped 0→1 during the call — the subset of submitted
  tags that weren't already attached. A caller submitting an overlap
  between new tags and tags already on the entry saw the overlap drop
  from the response and wrongly concluded the tags were not persisted.
  New `getEntryTags` helper in `db/queries/tags.ts` returns the full
  post-write tag set; both standard and critical `write_journal` and
  `write_memory` now echo the union.

- **Bug B — generic `read` on an `entry_class='status'` entry
  returned an empty envelope.** The `read` handler in `discovery.ts`
  branched on entry_class being journal / memory / handoff but never
  covered status, so execution fell through the if-chain with an
  empty xml buffer. Dedicated `read_status` worked correctly; only
  the generic `read` had the gap. Fix: add a status branch that
  dispatches to `readStatus` and emits a `<status>` block in the
  same shape as `read_status`. A missing `status_documents` row now
  returns `NOT_FOUND` instead of an empty envelope.

- **Item #16 follow-up — cascading delegation enforcement is now a
  security invariant, not a permission check.** v0.2.0 gated the
  `canDelegatePermission` / `canDelegateScope` checks on
  `settings.permissions.enforce`, which meant a session claimed as
  `create-sub-entries` could mint a `maintenance` child in dev mode —
  privilege escalation dressed up as "enforcement is off". The
  subset checks now run whenever a claim exists, regardless of
  enforce mode. Unclaimed dev-mode sessions (no parent to compare
  against) still bypass entirely. The "must have a claim" and
  "must be at least create-sub-entries" gates remain tied to
  `enforce` — those are genuine permission checks.

### Test infrastructure

- **31 tests total**, all green. v0.2.1 added 8 new cases across
  `test/tag-response-union.test.mjs` (4),
  `test/read-status-dispatch.test.mjs` (3), and replaced the old
  dev-mode bypass case in `test/key-delegation.test.mjs` with two
  narrower cases (unclaimed bypass; claimed-still-enforced).

## v0.2.0 — 2026-04-11

Feature release on top of v0.1.2. Local-only commits in this release —
push deferred to a later session because the v0.1.2 push was blocked
by a GitHub PAT scope issue (the PAT lacks `workflow` scope, needed
to add `.github/workflows/release.yml`). Once that's resolved, both
v0.1.2 and v0.2.0 ship together.

### Added

- **Item #31 — Tool response format embedding.**
  `src/server/tools/response-format.ts` is the new single source of
  truth for the shape and error-code vocabulary of MCP tool responses.
  Exports an `ERROR_CODES` runtime list, an `ErrorCode` TypeScript
  union, typed `ToolErrorResponse` / `ToolSuccessResponse` shapes, and
  `toolError` / `toolSuccess` constructors that handlers should use
  instead of inlining response objects. Misspelled error codes now
  fail at compile time instead of slipping into the wire format. The
  pilot migration covers the 5 status-tool handlers (11 call sites);
  other tool modules continue to import `formatError` directly until
  follow-up commits migrate them. Wire format is byte-identical.

- **Item #24 — Backup / restore / verify CLI commands.** New
  `aletheia backup [path]`, `aletheia restore <path>`, and
  `aletheia verify [path]` subcommands wired in `src/cli/cli.ts`,
  backed by `src/cli/backup.ts`. All three use better-sqlite3's
  native online backup API (`db.backup`) so live databases with
  uncommitted WAL pages are handled correctly — never use
  `fs.copyFile` on a live SQLite db. `restoreDatabase` validates the
  source via `verifyDatabase` first, takes a safety backup of the
  current target so the operation is reversible
  (`pre-restore-<timestamp>.db` in `~/.aletheia/backups/`), and
  refuses to overwrite from a corrupt source. The new `~/.aletheia/
  backups/` directory is the canonical backup home.

- **Item #16 — Cascading key delegation with subset enforcement.**
  Closes a privilege-escalation hole in v0.1.x: `create_key` only
  checked that the caller had `create-sub-entries` or `maintenance`
  permission, then minted a new key with whatever permissions and
  `entry_scope` the caller asked for. A `create-sub-entries` holder
  could mint a `maintenance` key, and a project-scoped parent could
  mint a global child. Enforcement now mirrors the invariant
  `modifyKey` already enforces for in-place updates, along two axes:
    1. *Permission level*: child level ≤ parent level. Hardened via
       `canDelegatePermission(parent, child)`.
    2. *Entry scope*: a globally-scoped parent can delegate any scope;
       a project-scoped parent can ONLY delegate its own scope (no
       upward, no lateral). Hardened via `canDelegateScope`.
  Both helpers and the previously-private `PERMISSIONS_HIERARCHY` /
  `permissionLevel` are now exported from `db/queries/keys.ts`. Both
  checks live behind `settings.permissions.enforce`, matching the
  existing handler contract — dev mode still bypasses entirely.

- **Item #32 — Teammate memory segregation design doc.**
  `docs/v0.2.0-design/teammate-segregation.md`. Drafts the v0.2.x
  approach for segregating sub-agent (worker) writes from the
  parent PM's memory namespace. Recommends a hybrid of key-chain
  walking + a denormalized `owner_chain` column populated at write
  time, queried via LIKE prefix (which uses the index, unlike
  leading-% LIKE). Read-side implementation NOT shipped in v0.2.0
  — design discovery is the v0.2.0 deliverable for #32. Includes
  four open questions for Kyle / Dramaturg.

### Test infrastructure

- **23 tests total**, all green. v0.2.0 added 16 new test cases
  across `test/response-format.test.mjs` (4),
  `test/backup-restore.test.mjs` (6), and
  `test/key-delegation.test.mjs` (10), preserving the 3 v0.1.2
  bug #27 regression tests intact.

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
