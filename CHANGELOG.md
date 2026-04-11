# Changelog

All notable changes to Aletheia are documented in this file.

## v0.2.6 — 2026-04-11

Sixth same-day patch release. One real bug fix from the P3 leg
of the round-3 sweep.

### Fixed

- **Injection builders halted on the first oversized item.**
  `l1-builder.ts` and `l2-builder.ts` iterate candidate
  memories / journal entries in recency order and used `break`
  when an item exceeded the remaining token budget — meaning
  a single item larger than the budget would halt the loop and
  prevent every subsequent (older, smaller) item from being
  injected. Combined with the recency-first sort this was the
  worst possible heuristic: the freshest memory is typically
  the largest one, so a fat fresh memory blocked dozens of
  small older memories that would have fit in its slot.
  Sessions saw far less context than they should have. Fix:
  `break` → `continue` in all three sites (L1 memory loop, L2
  memory loop, L2 journal loop). Oversized items get skipped
  silently, smaller subsequent items still get the budget.
  Output is now always a superset of pre-fix output.

### Test infrastructure

- **74 tests total**, all green. v0.2.6 added 3 new cases in
  `test/injection-budget-skip.test.mjs` covering both builders
  and the journal loop.

## v0.2.5 — 2026-04-11

Fifth same-day patch release. Two real bug fixes from the round-3
Priority-3 sweep — both were latent in every shipped release
through v0.2.4.

### Fixed

- **Circuit breaker bulk-write bypass paths.** Round-3 P2
  investigation found two stacking holes. (1) `write_journal` /
  `write_memory` / `create_entry` / `promote_to_memory` accepted
  unbounded `tags: string[]` arrays; `addTags` inserts 2 rows
  per tag, so a single tool call counted as 1 write against the
  breaker but could mutate 200+ rows by stuffing 100 tags.
  (2) Most mutating handlers were entirely unguarded — only
  `write_journal`, `write_memory`, and `replace_status` called
  the breaker. The other seven (`create_entry`,
  `promote_to_memory`, `retire_memory`, `update_status`,
  `add_section`, `remove_section`, `create_handoff`) bypassed
  it completely. A session could mint unlimited entries /
  retirements / sections / handoffs / promotions without ever
  tripping the limit. Both bypasses are closed: new
  `MAX_TAGS_PER_CALL=32` cap + `validateTagCount` helper in
  `lib/errors.ts`, and `checkGeneralCircuitBreaker` +
  `recordWrite` applied uniformly to all 10 mutating handlers.

- **Hook scripts waited 2s on stale socket pointers.** Round-3
  P1 found that `l1-inject.sh`, `l2-inject.sh`,
  `memory-intercept.sh`, and `startup.sh` discover the MCP
  server's unix domain socket via pointer files but never
  checked whether the discovered path actually points at a
  live socket. When the pointer is stale (MCP server crashed
  without cleanup, or PID reuse on a long-running workstation),
  every hook invocation waited the full 2s curl timeout
  before exiting 0. The hooks fire on PreToolUse and similar
  fast-path events, so the wait was visible. Fix: add
  `[ -S "$SOCK" ] || exit 0` immediately after socket
  discovery in all four scripts. Fail-open semantics
  preserved.

### Test infrastructure

- **71 tests total**, all green. v0.2.5 added 15 new cases
  across `test/circuit-breaker-bulk-bypass.test.mjs` (9) and
  `test/hook-stale-socket.test.mjs` (6).

## v0.2.4 — 2026-04-11

Fourth same-day patch release. Closes the single biggest
outstanding security gap from round 1 and ships the foundation
for item #32.

### Fixed

- **Write handlers used to fail-OPEN on key rotation mid-session.**
  Round 1 (v0.2.3, commit `c4c1d91`) closed the fail-open on the
  three privileged auth handlers — `create_key`, `modify_key`,
  `list_keys` — but intentionally left the wider write surface
  alone. Write handlers in `journal.ts`, `memory.ts`, `status.ts`,
  `handoff.ts`, and `entries.ts` trusted `sessionState.claimedKey`
  without re-validating against the db, so a revoked read-write
  key could still pump data into the journal, mint memories,
  overwrite status docs, and create handoffs until the session
  died. New shared `claimGuard(db, sessionState, settings)`
  helper exported from `auth.ts`; all 10 write/mutate handlers
  (`write_journal`, `promote_to_memory`, `write_memory`,
  `retire_memory`, `replace_status`, `update_status`,
  `add_section`, `remove_section`, `create_handoff`,
  `create_entry`, plus `list_entries` for parity) now call it at
  handler entry. In dev mode (`enforce=false`) the guard is a
  no-op so unclaimed dev sessions continue to write freely.
  `entries.ts`'s local `requireClaim` helper is deleted.

### Changed

- **Item #31 migration complete — `validateContentSize` now
  returns typed `ContentSizeError`.** The helper in
  `lib/errors.ts` used to return a pre-formatted XML error
  string which callers had to splice into an inline
  `{content:[...], isError:true}` envelope. Three handlers
  (`write_journal`, `write_memory`, `replace_status`) carried
  that legacy shape just for the size-check branch while every
  other error path used `toolError`. Now `validateContentSize`
  returns `{ code: 'CONTENT_TOO_LARGE', message } | null` and
  callers wrap with `toolError(code, message)` — symmetric with
  every other error branch. The bare `formatError` helper
  remains available for `circuit-breaker.ts` and
  `server/index.ts` which still format their own cross-layer
  errors; those aren't tool-handler paths and can be follow-ups.

### Added

- **Item #32 — smallest shippable slice shipped.** Full
  design at `docs/v0.2.0-design/teammate-segregation.md`.
  v0.2.4 ships the foundation:
    1. `getKeyChain(db, keyId): string` in
       `db/queries/keys.ts` walks `keys.created_by` upward and
       returns a slash-joined root-to-leaf ancestor path.
       Cycle-defended (visited set) and depth-capped at 16.
    2. The `claim` and `bootstrap` handlers now call
       `getKeyChain` at auth time and stash the result on
       `sessionState.keyChain`. Populated but unused — readers
       don't consume it yet.
  This decouples the auth path from the future read-side work:
  when the `owner_chain` column migration lands, no changes are
  needed to `claim` / `bootstrap`. Four open questions from the
  design doc still block the full read-side implementation;
  they're waiting for Kyle / Dramaturg input.

### Test infrastructure

- **56 tests total**, all green. v0.2.4 added 12 new cases
  across `test/write-handler-refresh.test.mjs` (5) and
  `test/key-chain.test.mjs` (7).

## v0.2.3 — 2026-04-11

Third same-day patch release. Two real bug fixes caught during the
Priority-3 investigation, plus completion of the #31 migration
across every tool module.

### Fixed

- **Latent migration bug — migration3 FAILED on any populated
  v0.1.0 database.** Discovered while writing a test for
  v0.1.0 → v0.2.x schema skip handling. Migration 3 rebuilds the
  entries table via DROP + CREATE + RENAME to widen the
  entry_class CHECK constraint. With SQLite foreign_keys
  enabled — which Aletheia turns on at every connection — `DROP
  TABLE entries` rejects the drop when journal_entries /
  memory_entries / status_documents / entry_tags hold rows that
  reference entries.id. The migration therefore worked ONLY on
  fresh installs with empty tables. Any real v0.1.0 → v0.2.x
  upgrade with populated data would fail with
  SQLITE_CONSTRAINT_FOREIGNKEY and leave the database
  half-migrated. Fix lives at the orchestrator level: runMigrations
  now captures the prior foreign_keys setting, disables it before
  the migration loop, runs PRAGMA foreign_key_check after (as a
  belt-and-braces guard), and restores the setting in a finally
  block. `PRAGMA defer_foreign_keys` is NOT sufficient — it only
  defers row-level checks, not DROP TABLE's own up-front guard.
  Impact: v0.1.0 users with live data have never successfully
  upgraded. Fresh installers are unaffected.

- **Key rotation mid-session used to fail-OPEN.** Discovered
  during the Priority-3 "key rotation mid-session" investigation.
  Once a session called claim(), the validated key was cached in
  sessionState and never re-checked. A key deleted or downgraded
  in the db after the claim had no effect on the session — the
  handler kept exercising the stale cached permission level. An
  admin revoking a compromised key could not stop an already-
  claimed session. New `refreshClaim(db, sessionState)` helper at
  the top of auth.ts re-queries the keys table by id on every
  privileged call, clears the cache on delete, and refreshes the
  cache on modification. Coverage is limited to auth.ts handlers
  (create_key, modify_key, list_keys). Broader coverage for
  non-auth write handlers is a follow-up.

### Changed

- **Item #31 migration complete.** The remaining four tool
  modules migrated to `toolError` / `toolSuccess` from
  `response-format.ts`: handoff.ts, discovery.ts, journal.ts,
  auth.ts. `system.ts` has no error paths and did not need
  migration. Status, entries, memory, handoff, discovery,
  journal, auth — every tool module now uses the typed
  response-format constructors. Wire format byte-identical.
  `formatError` remains available in `lib/errors.ts` for the
  `validateContentSize` helper which still returns pre-formatted
  text; that edge case is the last legacy caller.

### Test infrastructure

- **44 tests total**, all green. v0.2.3 added 6 new cases across
  `test/migration-chain-skip.test.mjs` (3) and
  `test/key-rotation-mid-session.test.mjs` (3).

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
