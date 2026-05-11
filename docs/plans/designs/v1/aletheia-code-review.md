# Aletheia v0.1.0 Code Review

## Architecture Compliance

**Dual-interface pattern: PASS**
The MCP server (src/server/index.ts) runs stdio via `StdioServerTransport` for Claude Code tool calls, and simultaneously starts a Unix domain socket HTTP server (src/server/socket.ts) in the same Node.js process. Both share the same `db` connection and `sessionState`. This matches the design exactly.

**SQLite WAL mode with better-sqlite3: PASS**
Connection factory (src/db/connection.ts) correctly sets all required PRAGMAs: `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000` (via constructor `timeout` option), `temp_store=MEMORY`, `cache_size=-20000`, `wal_autocheckpoint=1000`, `foreign_keys=ON`.

**No console.log() in src/: PASS**
Grep confirms zero `console.log()` calls anywhere in src/. All diagnostic output uses `console.error()`. Critical requirement met.

**TypeScript ESM: PASS**
`package.json` has `"type": "module"`. tsconfig targets ES2022 with Node16 module resolution. All imports use explicit `.js` extensions.

**BEGIN IMMEDIATE for write transactions: PASS**
All write transactions across the codebase use `.immediate()` on better-sqlite3 transaction objects. Verified in: journal.ts (2), memory.ts (2), status.ts (3), handoff.ts (1), tags.ts (1), schema.ts (1), journal tool (1). Total: 11 transaction sites, all correct.

---

## Tool Completeness

**Tool count: 25 tools registered** in TOOL_DEFINITIONS array in src/server/index.ts.

Tools by group:
- **Auth/Setup (6):** claim, whoami, bootstrap, create_key, modify_key, list_keys
- **Entry Management (2):** create_entry, list_entries
- **Journal (2):** write_journal, promote_to_memory
- **Memory (3):** write_memory, retire_memory, read_memory_history
- **Discovery (3):** search, read, list_tags
- **Status (5):** read_status, replace_status, update_status, add_section, remove_section
- **Handoff (2):** create_handoff, read_handoff
- **System (2):** help, health

**Deep verification of 5 key tools:**

1. **write_journal** (src/server/tools/journal.ts): Fully implemented. Calls `appendJournalEntry()` for standard writes. Critical path implemented as a single `db.transaction().immediate()` that: appends journal entry, creates memory entry, links provenance, sets digested_at, processes tags inline. Circuit breaker checks `criticalWriteCount` against `settings.digest.criticalWriteCap`. Related entries returned by default (show_related default-on via `!skipRelated`). All paths return micro-XML.

2. **write_memory** (src/server/tools/memory.ts): Calls `writeMemory()` query module. OCC conflict detection returns current state. Tags processed via `addTags()`. Supersedes support present. Returns micro-XML with version_id.

3. **read_status** (src/server/tools/status.ts): Calls `readStatus()` query module. Returns full document with sections. section_id filter works. Returns version_id for OCC.

4. **create_handoff** (src/server/tools/handoff.ts): Calls `createHandoff()` which uses `INSERT OR REPLACE` -- correctly implements mailbox overwrite semantics.

5. **search** (src/server/tools/discovery.ts): Unified search across entry classes. Filters by entry_class, tags, query, include_archived. Calls separate journal/memory search functions. Returns combined micro-XML results.

**All tools are fully implemented** -- no stubs or placeholder logic found.

---

## CEO Design Adjustments

**#1: Digest teammate spawning -- designed for ralph-loop trigger: PARTIAL**
The L2 builder (src/injection/l2-builder.ts:80-85) includes `undigestedJournalCount` and `digestThreshold` in the L2 payload. This surfaces threshold information to Claude via injection, enabling the CEO's ralph-loop to detect when a digest is needed. However, there is no explicit spawning mechanism -- the system informs Claude of the threshold state and relies on Claude (or a supervisor) to spawn the digest teammate. This is the right approach for v0.1.0 (hooks can't spawn Claude sessions), but the triggering path is implicit rather than explicit.

**#2: update_status has continue? parameter: PASS**
The `update_status` tool (src/server/tools/status.ts:92-153) correctly accepts a `continue` boolean parameter (not `content?`). When `continue: true`, it finds the next section by position and returns it as `<next_section>`. This matches the design's state-machine auto-advance behavior: "Claude says 'task 2 complete' -> server moves task out of in-progress, optionally returns next task."

**#3: read_memory_history tool exists: PASS**
Tool registered and implemented (src/server/tools/memory.ts:111-152). Calls `readMemoryHistory()` (src/db/queries/memory.ts:183-226) which returns current value plus previous versions from `memory_versions` table as full rendered snapshots (not raw diffs). Returns micro-XML with version_id and changed_at for each snapshot.

**#4: Token budget prioritization uses recency + access frequency: PASS**
Both L1 (src/injection/l1-builder.ts:53-57) and L2 (src/injection/l2-builder.ts:29-33) builders sort memories by `updatedAt` (recency) first, then `accessCounts` (frequency) as tiebreaker. Entries are included in sorted order until token budget is exhausted.

**#5: No handoff TTL: PASS**
No `expires_at` column in the handoffs table (src/db/schema.ts:71-77). Handoff schema uses `target_key TEXT PRIMARY KEY` with `INSERT OR REPLACE` semantics -- pure mailbox overwrite, no TTL.

---

## Coverage Gap Resolution

Reviewing gaps identified in aletheia-review.md:

| Gap # | Gap | Status | Notes |
|-------|-----|--------|-------|
| 1 | Handoff TTL / expires_at | Correctly omitted | Per CEO adjustment #5 |
| 2 | Digest teammate spawning | Partially addressed | L2 payload includes threshold data; spawning is caller's responsibility |
| 3 | Maintenance key provisioning | Addressed | setup.ts generates maintenance.key; bootstrap tool creates project-scoped keys |
| 4 | history_reminders config | Present but unused | Setting exists in AletheiaSettings interface but no code reads it |
| 5 | Interactive setup (-i flag) | Not implemented | CLI only supports `setup` and `teardown` |
| 6 | rollingDefault in defaults | Fixed | Present in DEFAULTS constant (value: 50) |
| 7 | Content-hash change detection | Implemented | FrequencyManager.updateHash() with single-bump doubling |
| 8 | Token budget prioritization | Implemented | Recency + access frequency in L1/L2 builders |
| 9 | Memory version history access | Implemented | read_memory_history tool added |
| 10 | bootstrap naming | Correct | Uses "bootstrap" name |
| 11 | Read-once handoff semantics | Implemented | readHandoff() does SELECT + DELETE in immediate transaction |
| 12 | UserPromptSubmit trigger | Settings support only | Hook registration only creates PreToolUse hooks |
| 14 | WAL checkpoint strategy | Not implemented | Only wal_autocheckpoint, no explicit checkpoint on shutdown |
| 16 | Digest OCC interaction | Not addressed | No guidance in implementation |
| 20 | update_status continue? | Implemented | continue parameter with next-section auto-advance |

---

## Hooks

**Hook count: 4 hooks implemented (of 5 specified)**

| Hook | Unix | Windows | Description |
|------|------|---------|-------------|
| Startup | startup.sh | startup.js | Checks session-info, shows guide or injects L1 |
| L1 Injection | l1-inject.sh | l1-inject.js | Queries /state, outputs if non-empty |
| L2 Injection | l2-inject.sh | l2-inject.js | Queries /context, outputs if non-empty |
| Memory Intercept | memory-intercept.sh | memory-intercept.js | Checks disableSystemMemory, warns about MEMORY.md |
| Overlap Detection | -- | -- | **MISSING** -- combined with startup per design, but no overlap logic exists in startup hooks |

**Fail-open semantics: PASS**
All hooks check for `ALETHEIA_SOCK`, exit 0 if unset. All curl calls have `--max-time 2` timeout. All command failures fall through to `exit 0`.

**Platform coverage: PASS**
Both Unix (POSIX sh with curl) and Windows (Node.js with http module) implementations present for all 4 hooks.

**Socket query (not SQLite direct): PASS**
All hooks query the socket sidecar via HTTP, never touching SQLite directly.

---

## CLI

**aletheia setup: PASS (with issues)**
- Creates `~/.aletheia/` directory structure (sockets, keys, data, templates, logs)
- Generates `settings.toml` with documented defaults
- Registers MCP server in `~/.claude/settings.json`
- Registers 4 hooks as PreToolUse handlers
- Generates maintenance key

**aletheia teardown: PASS**
- Removes MCP server registration from Claude settings
- Removes Aletheia hooks from PreToolUse
- Preserves data directory (prints instructions for manual removal)

---

## Code Quality

### CRITICAL Issues

**CRITICAL-1: Hook/endpoint field mismatch (data contract broken)**
The startup hook scripts check for a field `hasEntry` from the `/session-info` endpoint response:
- Unix (startup.sh:10): `grep -o '"hasEntry":\s*true'`
- Windows (startup.js:29): `if (!info.hasEntry)`

But the `/session-info` endpoint (src/injection/endpoints.ts:45-57) returns:
```json
{"claimed": bool, "claimedEntry": string|null, "permissions": string|null, "entryCount": number}
```
There is NO `hasEntry` field. The startup hook will always take the "no entry" path and show the operational guide, never injecting L1 state on startup.

Similarly, the memory-intercept hooks check for `disableSystemMemory` from `/session-info`, but that field is not in the response either.

**CRITICAL-2: Setup references wrong hooks directory**
In `src/cli/setup.ts:37`, `getHooksDir()` computes the path as:
```typescript
const packageRoot = path.resolve(distDir, '..');
return path.join(packageRoot, 'src', 'hooks');
```
After npm global install, the package structure is `dist/` and `hooks/` (from package.json `files` field). The `src/` directory is NOT included in the npm package. The function should reference `hooks/` at the package root, not `src/hooks/`. This means `aletheia setup` will fail to find hook scripts after global installation.

**CRITICAL-3: ALETHEIA_SOCK environment variable never set**
The MCP server starts the socket at a PID-based path and stores it in `boundSocketPath` (src/server/socket.ts:12), but this path is never exported as `ALETHEIA_SOCK` to the hook environment. The hooks all rely on `$ALETHEIA_SOCK` being set, but nothing sets it. The MCP server registration in setup.ts registers:
```json
{"command": "node", "args": ["...dist/server/index.js"], "env": {}}
```
The `env` object is empty. Without `ALETHEIA_SOCK`, every hook will immediately `exit 0` (fail-open), making the entire hook system non-functional.

**CRITICAL-4: Session state key mismatch between tools and injection**
The injection builders (l1-builder.ts, l2-builder.ts) and endpoints (endpoints.ts) read `sessionState.get('claimedEntry')` as the entry ID for querying data. But the auth tools set `sessionState.set('claimedKey', ...)` -- the key is `claimedKey`, not `claimedEntry`. Similarly, `permissions` and `entryCount` are never set in sessionState by any tool. This means L1/L2 injection and all socket endpoints will always return null/empty payloads because `claimedEntry` is always undefined.

### MODERATE Issues

**MODERATE-1: create_entry requires projectNamespace but simple mode has no way to set it**
The `create_entry` tool (src/server/tools/entries.ts:51-59) returns a `prompt_back` error if `projectNamespace` is not set in session state. In simple mode (no permissions), there's no bootstrap call, and nothing else sets `projectNamespace`. This means simple-mode users cannot create entries without first calling bootstrap. The design specifies "Auto-initialization on first write" for simple mode.

**MODERATE-2: Handoff read_handoff requires claim but design says simple mode needs zero setup**
The `read_handoff` tool (src/server/tools/handoff.ts:48-60) requires a claimed key to determine `targetKey`. In simple mode without claims, this always returns `NO_CLAIM` error.

**MODERATE-3: Tag search semantics inconsistency**
The `searchByTags` query (src/db/queries/tags.ts:63-79) requires ALL tags to match (HAVING COUNT = tag count), but the `search` tool in discovery.ts passes tags to `searchJournal` and `searchMemory` which use `IN` clause matching ANY tag. The behavior differs depending on which search path is taken.

**MODERATE-4: No circuit breaker for general writes**
The design specifies "Configurable thresholds (max tool calls per interval, max entry size) to protect against agent runaway." Only the critical write cap is implemented. The general `circuitBreakerWritesPerInterval` and `circuitBreakerIntervalMinutes` constants exist in DEFAULTS but are never checked.

**MODERATE-5: Memory entry creation race in `promote_to_memory`**
The `promote_to_memory` handler (src/server/tools/journal.ts:196-232) calls `writeMemory()` (which has its own `.immediate()` transaction), then separately calls `INSERT INTO memory_journal_provenance` and `UPDATE journal_entries SET digested_at` outside any transaction. If the process crashes between writeMemory and the provenance/digested updates, the promoted memory exists but the journal isn't marked as digested and has no provenance link. These three operations should be in a single transaction (like the critical write path does correctly).

**MODERATE-6: Supersedes handling incomplete**
The `supersedes` field is handled in `writeMemory()` (archives the superseded entry), but there's no tool parameter or UI for specifying which entry to supersede. The `write_memory` tool schema has a `supersedes` parameter, but there's no corresponding `supersedes` field in the `entries` table for tracking the relationship. The design mentions "Supersedes field: entries can reference what they replace" but the entries table has no such column.

### MINOR Issues

**MINOR-1: Package.json `files` includes `src/templates` but directory doesn't exist**
The `files` field lists `["dist", "hooks", "src/templates"]` but `src/templates/` does not exist. The plan calls for Phase 5 to create default templates, but they haven't been implemented yet.

**MINOR-2: historyReminders setting defined but unused**
`AletheiaSettings.injection.historyReminders` exists in the interface and settings.toml but no code reads or acts on it.

**MINOR-3: Tag normalization inconsistency**
`normalizeTag()` in tags.ts strips hyphens, underscores, and spaces, then lowercases. But the help text (system.ts:58) tells users tags are "normalized automatically: 'API Auth' -> 'api-auth' (lowercase, hyphenated)". The actual normalization removes all separators entirely, so "API Auth" becomes "apiauth", not "api-auth".

**MINOR-4: read tool default show_related behavior inverted from design**
The `read` tool (discovery.ts:123) shows related entries when `showRelated !== false` (i.e., default-on). This matches the Phase 9 revision (default-on with opt-out), which is correct. But the parameter is named `show_related` (opt-in name) while functioning as default-on -- slightly confusing naming.

**MINOR-5: duplicate readClaudeSettings/writeClaudeSettings**
Both setup.ts and teardown.ts define identical `readClaudeSettings()` and `writeClaudeSettings()` functions. Should be in a shared utility.

**MINOR-6: Windows hooks use CommonJS (require) not ESM**
The Windows hook scripts use `const http = require('http')` -- CommonJS syntax. Since the project is `"type": "module"`, these files would fail if loaded as part of the package's ESM module system. They work only because they're invoked as standalone scripts via `node`, not imported. This is technically fine but fragile.

**MINOR-7: Overlap detection hook missing**
The fifth hook (overlap detection / MEMORY.md scanning) is described as "combined with Hook 1 (startup)" in the design, but the startup hooks contain no overlap detection logic -- they don't read or reference MEMORY.md at all.

---

## Packaging

**package.json:**
- Name: `aletheia` -- correct
- Version: `0.1.0` -- correct
- bin: `./dist/cli/cli.js` -- correct (will need shebang, which cli.ts has via `#!/usr/bin/env node` comment but needs to be emitted)
- files: `["dist", "hooks", "src/templates"]` -- `src/templates` doesn't exist (MINOR-1)
- engines: `>=18.0.0` -- correct
- Dependencies: `@modelcontextprotocol/sdk`, `better-sqlite3`, `smol-toml`, `proper-lockfile` -- all correct, all `"latest"` (should be pinned for production)
- devDependencies: `typescript`, `@types/better-sqlite3`, `@types/node` -- correct, no leakage

**Build script concern:** `package.json` has `"copy-hooks"` script that copies from `src/hooks/` to `hooks/`, which is then included in the npm package. This works, but means the hooks directory at the repo root is a build artifact, not source.

**Setup path issue:** As noted in CRITICAL-2, setup.ts references `src/hooks/` which won't exist in the installed package. Should reference the `hooks/` directory at package root.

---

## Issues Found

### CRITICAL (must fix before release)

| # | Issue | Location | Impact |
|---|-------|----------|--------|
| C1 | Hook/endpoint field name mismatch (`hasEntry`/`disableSystemMemory` vs actual fields) | startup hooks + memory-intercept hooks vs endpoints.ts | All hooks malfunction -- startup always shows guide, memory intercept checks wrong field |
| C2 | Setup references `src/hooks/` which won't exist in npm package | src/cli/setup.ts:37 | `aletheia setup` fails to register hooks after global install |
| C3 | `ALETHEIA_SOCK` env var never set for hooks | src/server/index.ts, src/cli/setup.ts | Entire hook system non-functional -- all hooks exit immediately |
| C4 | Session state key mismatch (`claimedKey` vs `claimedEntry`) | tools/auth.ts vs injection/*.ts, endpoints.ts | L1/L2 injection always returns null; socket endpoints return empty data |

### MODERATE (should fix before release)

| # | Issue | Location | Impact |
|---|-------|----------|--------|
| M1 | Simple mode cannot create entries (projectNamespace unset) | tools/entries.ts:51-59 | Simple mode users blocked from core functionality |
| M2 | read_handoff requires claim in simple mode | tools/handoff.ts:48-60 | Handoffs unusable without permission system |
| M3 | Tag search semantics inconsistency (ALL vs ANY) | queries/tags.ts vs discovery.ts | Confusing, unpredictable search results |
| M4 | General circuit breaker unimplemented | -- | No protection against agent runaway beyond critical writes |
| M5 | promote_to_memory not transactional | tools/journal.ts:196-232 | Crash can leave orphaned memory without provenance |
| M6 | Supersedes relationship not tracked in schema | db/schema.ts, queries/memory.ts | Design requirement for relationship tracking unmet |

### MINOR (can fix post-release)

| # | Issue | Location | Impact |
|---|-------|----------|--------|
| m1 | `src/templates` in files array but doesn't exist | package.json | npm pack warning |
| m2 | historyReminders setting unused | lib/settings.ts | Dead config |
| m3 | Tag normalization differs from help text | queries/tags.ts, tools/system.ts | User confusion |
| m4 | show_related naming slightly confusing | tools/discovery.ts | UX clarity |
| m5 | Duplicate utility functions | cli/setup.ts, cli/teardown.ts | Code smell |
| m6 | Windows hooks use CommonJS | hooks/windows/*.js | Fragile but functional |
| m7 | Overlap detection hook missing | hooks/unix/startup.sh | MEMORY.md migration not prompted |

---

## Verdict

**NOT READY FOR RELEASE.** The implementation is architecturally sound and shows strong adherence to the design's core concepts -- dual-interface MCP, SQLite WAL with proper PRAGMAs, BEGIN IMMEDIATE transactions, micro-XML responses, unified entry model with separate tool interfaces, mailbox handoff model, and the "Dumb Capture, Smart Digest" pattern.

However, four critical data-contract bugs (C1-C4) mean the hook system and injection system are entirely non-functional. These are not edge cases -- they are broken integration points between the three layers (MCP tools, socket server, hooks) that make up Aletheia's architecture:

- **C3 + C4** together mean: even if hooks fire, the injection payloads they query would be empty. The entire L1/L2 context injection pipeline is broken end-to-end.
- **C1** means even the startup hook's fallback (showing the guide vs injecting state) makes the wrong decision every time.
- **C2** means npm-installed Aletheia can't register hooks at all.

**Estimated fix effort:** The four critical issues are straightforward data-contract fixes:
- C1: Add `hasEntry` and `disableSystemMemory` to `/session-info` response (or update hooks to use existing fields)
- C2: Change `getHooksDir()` to reference `hooks/` not `src/hooks/`
- C3: Set `ALETHEIA_SOCK` in the MCP server env config, or pass socket path via MCP server registration env
- C4: Align session state keys between auth tools and injection builders (use `claimedEntry` everywhere, or change builders to read `claimedKey`)

After fixing criticals and moderates, the implementation would be solid for v0.1.0. The code quality, error handling, and architectural fidelity are strong. The query modules are clean and well-structured. The tool implementations are complete and non-trivial. The hook fail-open pattern is correctly applied everywhere.

**Strengths:**
- Zero console.log -- critical correctness requirement met perfectly
- All 25 tools registered and fully implemented with real logic
- All write transactions use .immediate() consistently
- Micro-XML response format throughout
- OCC with state-forwarding errors implemented correctly
- Critical write escape hatch with circuit breaker works well
- Memory version history with full snapshot rendering
- update_status continue? parameter with next-section auto-advance
- Token budget prioritization with recency + access frequency
- Socket lifecycle management (lockfile, garbage collection, cleanup on exit)

**What's missing beyond bugs:**
- Default entry templates (Phase 5 content)
- General circuit breaker implementation
- Overlap detection logic in startup hook
- UserPromptSubmit hook trigger path
- Interactive setup mode (-i flag)
- File logging implementation (debug mode)
- WAL checkpoint on shutdown
