# Arranger Journal: Aletheia

## Ingestion Notes
**Phase:** 1 — Ingestion
**Design document:** docs/plans/designs/2026-04-08-aletheia-design.md
**Dramaturg journal:** docs/plans/designs/decisions/custom-memory-server/dramaturg-journal.md (note: directory name mismatch — Dramaturg used `custom-memory-server`, Arranger derives `aletheia` from design doc filename)
**Feature name:** aletheia

**Critical context:** The design document has NOT been updated to reflect Phase 9 (Design Review) revisions. Five revisions from a post-Dramaturg review session supersede parts of the original design. The Arranger must plan from the Phase 9 decisions (in the dramaturg journal), using the original design doc for context on unchanged sections only.

**Phase 9 revisions that supersede design doc content:**
1. Architecture — Dual-Interface Hybrid replaces separate sidecar
2. OCC — Hybrid Strategy replaces monolithic OCC
3. show_related — Default-on replaces opt-in
4. Promotion — Dumb Capture, Smart Digest replaces inline promotion as primary
5. Data Lifecycle — Minimum Viable Lifecycle added (new section)

## Journal Distillation Summary
**Phase:** 1 — Ingestion
**Category:** checkpoint

**VERIFIED (5 items — skip in feasibility audit):**
SQLite WAL configuration, Micro-XML format for Claude, MCP JSON input constraint, claim-based auth pattern, Unix domain sockets on Node.js Windows 10+

**PARTIAL (3 items — follow-up in Phase 2/3):**
1. Windows UDS platform-specific implementation details (verified in principle, needs implementation validation)
2. Tool consolidation (~25 → ~20 tools) — flagged for implementation decision
3. Digest teammate prompt template structure — deferred to implementation

**UNRESEARCHED (5 items — mandatory verification):**
1. Handoff TTL 24h default (no usage-pattern validation)
2. Digest teammate threshold defaults (~15-20 entries)
3. Tag similarity suggestion algorithm (mechanism undefined)
4. Socket cleanup PID checking (cross-platform behavior)
5. Hook curl timeout 2s (untested under contention)

**Goal/Use-Case entries:** 12 inviolable user constraints identified
**Tension entries:** 5 acknowledged tensions (architectural complexity, OCC/compaction, promotion overhead, data growth, hook timeouts)
**Abandoned approaches:** 12 abandoned/invalidated approaches documented
**Implementation notes from Phase 9:** 9 items flagged for Arranger attention
**Stale entries:** None

**Completeness assessment:** Design doc passes all checklist items. 3 PARTIAL items are implementation decisions, not structural gaps — handle in Phase 3. No upstream referral needed.

**Strength:** verified

## Feasibility Audit
**Phase:** 2 — Feasibility Audit

### Audit: Dual-Interface MCP Server Pattern
**Finding:** VERIFIED — feasible. StdioServerTransport and http.createServer() on Unix socket coexist in same Node.js event loop.
**External input:** Gemini query (high reasoning). Both use libuv async I/O; no event loop conflicts.
**Critical constraint discovered:** stdout is the MCP JSON-RPC channel. ALL logging must use console.error() (stderr). Child processes must have explicit stdio config to prevent stdout inheritance. Any console.log() corrupts MCP stream and crashes connection.
**Impact:** Mandatory codebase-wide rule: no stdout usage outside MCP transport. Affects all tool handlers, hook execution, and library selection.
**Strength:** core

### Audit: better-sqlite3 WAL Multi-Process Access
**Finding:** VERIFIED — safe for multi-process concurrent access with WAL mode.
**External input:** Gemini query (high reasoning). busy_timeout handles write contention correctly. Reads are unlimited concurrent.
**Gotchas discovered:**
1. BEGIN IMMEDIATE required for write transactions — DEFERRED can deadlock in multi-process (two processes get read locks, both try to upgrade, immediate SQLITE_BUSY ignoring busy_timeout)
2. Synchronous blocking — busy_timeout blocks Node.js event loop. Short writes (1-2ms) imperceptible. Long writes freeze the process.
3. Checkpoint starvation — constant readers prevent WAL merge. WAL file grows unbounded. Need periodic PRAGMA wal_checkpoint(TRUNCATE) on idle/shutdown.
4. PRAGMAs are per-connection — every process must set on connect. Prefer constructor: new Database(path, { timeout: 5000 })
5. Never manually delete .wal/.shm files — auto-recovered by next connection
**Impact:** Transaction discipline in plan. Checkpoint strategy needed. Constructor-based config preferred.
**Strength:** core

### Audit: Socket Startup Race Condition
**Finding:** NEW REQUIREMENT — lockfile needed for socket lifecycle.
**External input:** Gemini query (high reasoning). Identified "massive, highly-likely race condition" in naive stale-socket-replace pattern: two simultaneous starts can clobber each other's sockets.
**Resolution:** Acquire exclusive lockfile before socket operations. Options: proper-lockfile npm, or fs.openSync(lockpath, 'wx'). Lock → check socket → cleanup if stale → bind → release.
**Impact:** New implementation requirement not in design. Socket startup sequence must include lockfile acquisition.
**Strength:** core

### Audit: npm Global Packaging
**Finding:** VERIFIED — standard pattern supports CLI + hooks + MCP server.
**External input:** Gemini query (high reasoning). bin field for CLI, files array for shell hooks, ESM import.meta.url for asset paths.
**Notes:** Shell scripts invoked via `bash [script]` to avoid +x permission issues. Child processes must have explicit stdio config (stdout poisoning prevention).
**Impact:** Standard packaging; no special handling needed.
**Strength:** context

### Audit: TOML Parser
**Finding:** VERIFIED — smol-toml is the recommended choice.
**External input:** Gemini query (high reasoning). Modern, fast, TOML v1.0 compliant, lightweight. For read-only settings parsing (Aletheia's use case). Alternative @taplo/core (Rust/WASM) if comment-preserving round-trip needed.
**Impact:** Library selection settled.
**Strength:** context

### Audit: Socket PID Cleanup Cross-Platform
**Finding:** VERIFIED — process.kill(pid, 0) works Linux/macOS/Windows.
**External input:** Gemini query (high reasoning). Node.js abstracts via libuv. EPERM = alive, ESRCH = dead.
**Caveat:** PID recycling undetectable via kill alone. Solution: PID check + socket ping (attempt connection). If ECONNREFUSED, safe to cleanup.
**Impact:** Socket garbage collection approach confirmed. Must combine PID check with socket connectivity test.
**Strength:** core

### Audit Skip Classifications
- **Tool consolidation:** Implementation decision, not feasibility — Phase 3 scope.
- **Digest teammate prompt template:** Content design, not feasibility — Phase 3 scope.
- **Handoff TTL 24h default:** Tunable value, not feasibility — Phase 3 scope.
- **Digest teammate thresholds (~15-20):** Tunable value, not feasibility — Phase 3 scope.
- **Tag similarity algorithm:** Implementation design, not feasibility — Phase 3 scope.
- **Hook curl timeout 2s:** Tunable value, not feasibility — Phase 3 scope.
- **Windows UDS details:** Already PARTIAL with explicit "acceptable to drop" escape hatch from Dramaturg. No further audit needed.

### Feasibility Audit Summary
**All high-impact items verified.** No design conflicts found. Three new implementation constraints discovered (stdout poisoning, BEGIN IMMEDIATE transactions, socket lockfile). All are refinements of existing architecture, not contradictions. Ready for Phase 3.
**Strength:** verified

## Implementation Decisions
**Phase:** 3 — Implementation Discussion

### Decision 1: SQLite Schema — Container + Per-Class Tables
**Finding/Decision:** Normalized schema with unified `entries` container table + per-class content tables (journal_entries, memory_entries, handoffs, status_documents, status_sections). Supporting tables: tags, entry_tags, memory_versions, memory_journal_provenance, keys, schema_version.
**Rationale:** Journal appends create new rows, memory updates existing rows — single flat table would be sparse with class-specific nullable columns. Per-class tables give clean queries, clean indexes, and entry_class is implicit in which table is queried. Cross-type search joins through entries table.
**Migration system:** schema_version table with integer. Sequential migration functions on startup.
**Impact:** Foundation for all data operations.
**Strength:** core

### Decision 2: Project Structure — TypeScript ESM
**Finding/Decision:** Standard TypeScript ESM package. src/ with server/, db/, hooks/, cli/, injection/, permissions/, templates/ directories. Build via tsc to dist/. Shell hooks copied to hooks/ at build time.
**Key libraries:** better-sqlite3 (SQLite), smol-toml (settings), proper-lockfile (socket startup), @modelcontextprotocol/sdk (MCP).
**Impact:** Defines module boundaries for all implementation phases.
**Strength:** core

### Decision 3: Tool Consolidation — Targeted Merges
**Finding/Decision:** Two targeted consolidations from ~25 to ~21 tools:
1. search_journal + search_memory + search_by_tags → single search(entry_class?, tags?, query?)
2. read_journal + read_memory + read_handoff → single read(entry_id, mode?, limit?). Server detects type. read_status kept separate (section_id parameter).
3. Handoff model simplified: mailbox slot per target, not queue. create_handoff(target_key, content, tags) overwrites existing. read_handoff() reads + hard-deletes caller's slot. No handoff_id needed. No list_handoffs needed. Simple table: handoffs(target_key PK, content, tags, created_by, created_at).
**Rationale:** Preserves granular write tools (genuinely different parameters) while consolidating near-identical search/read interfaces. Handoff simplification eliminates accumulation problem entirely — overwrite, not append.
**Alternatives considered:** Full consolidation to ~15 tools (rejected — granular writes are clearer). list_handoffs tool (rejected — read_handoff() with empty response serves same purpose in one call).
**Impact:** Defines MCP tool surface for implementation. Simplifies handoff schema.
**Strength:** core

### Decision 4: Logging — stderr Only
**Finding/Decision:** All runtime logging via console.error() (stderr). stdout is MCP JSON-RPC channel — any stray console.log() crashes the connection. Optional file logging to ~/.aletheia/logs/server.log via debug flag in settings.toml, default off.
**Rationale:** Driven by stdout poisoning constraint discovered in Phase 2. Child processes must also have explicit stdio config to prevent stdout inheritance.
**Impact:** Mandatory codebase-wide rule. Affects library selection (must not write to stdout).
**Strength:** core

### Decision 5: Socket Path — PID-Based in User Directory
**Finding/Decision:** ~/.aletheia/sockets/aletheia-<pid>.sock. Directory permissions 0700, socket permissions 0600. PID in filename enables startup garbage collection (glob, parse PID, kill -0). ALETHEIA_SOCK env var passed to hooks.
**Rationale:** User-owned directory (not /tmp/) for security. PID-based naming enables stale socket detection. Env var discovery is simpler than deterministic hash approach in original design.
**Impact:** Hook scripts reference $ALETHEIA_SOCK. Setup creates sockets/ directory.
**Strength:** core

### Decision 6: Lockfile — proper-lockfile
**Finding/Decision:** proper-lockfile npm package for socket startup coordination. Lockfile at ~/.aletheia/sockets/startup.lock. Acquired before socket operations, released after bind.
**Rationale:** Handles stale lock detection from crashed processes. Naive fs.openSync('wx') doesn't handle stale locks. Race condition on socket startup verified as real concern in Phase 2 (Gemini identified "massive, highly-likely race condition").
**Impact:** Socket lifecycle startup sequence: acquire lock → check existing socket → cleanup if stale → bind → set permissions → release lock.
**Strength:** core

### Decision 7: Hook Implementation — POSIX sh Primary + Node.js Windows Fallback
**Finding/Decision:** Dual hook implementation. Primary: POSIX sh scripts using curl --unix-socket "$ALETHEIA_SOCK" --max-time 2 (Linux/macOS). Fallback: Node.js scripts using http module over Named Pipes (Windows). `aletheia setup` detects platform and registers appropriate variant. Unused variant sits in package, never loaded.
**Rationale:** sh+curl gives ~10-20ms latency on Unix (5x faster than Node.js ~50-100ms V8 startup). Hooks fire every ~10 tool calls — latency matters. Windows hooks can be developed as parallel task alongside sh hooks (same logic, different language).
**Impact:** Windows is a confirmed target, not a hanging question. Two hook implementations to maintain (thin wrappers, ~10-20 lines each).
**Strength:** core

### Decision: Windows Support Confirmed
**Finding/Decision:** Windows is a definitive target for initial release. All components verified:
- MCP server (Node.js stdio): cross-platform by default
- better-sqlite3: cross-platform
- proper-lockfile: cross-platform
- process.kill(pid, 0): works via libuv on Windows
- Socket: Named Pipes (\\.\pipe\aletheia-<pid>) — auto-cleanup on crash, actually better than Unix sockets
- Hooks: Node.js fallback scripts (parallel task alongside sh hooks)
- Socket path abstraction: helper function returns Unix socket path or Named Pipe name based on os.platform()
**Rationale:** User required settling Windows definitively before implementation. All components verified feasible. Hook dual-implementation is the only additional effort. "Acceptable to drop" escape hatch from Dramaturg is no longer needed — we have a clear path.
**Impact:** Platform abstraction layer needed for socket/pipe paths. Windows hooks as parallel implementation task.
**Strength:** core

### Decision 8: Maintenance Permission Level
**Finding/Decision:** New `maintenance` permission level added to existing hierarchy (read-only, read-write, create-sub-entries, maintenance). Maintenance keys can: read all entries in scope, create new entries, retire any entry in scope (regardless of creator). Cannot edit entries it didn't create — only retire.
**Rationale:** Digest teammate needs cross-scope retire permissions. Adding a permission level is cleaner than a special key type or special-casing the permission model.
**Impact:** Permission model extension. Affects key generation and validation logic.
**Strength:** core

### Decision: Maintenance Key Provisioning
**Finding/Decision:** Maintenance key lifecycle:
- Simple mode (enforce_permissions=false): no key needed, digest teammate just works.
- Multi-agent mode: `aletheia setup` auto-generates maintenance key at ~/.aletheia/keys/maintenance.key. Digest spawning hooks read key from file and pass to teammate via -p prompt. Teammate claims on startup.
**Rationale:** User specified digest teammate must be autonomous — spawning session should not burn context gathering data or passing credentials manually. Auto-generation + hook-based passing is zero-effort for the user.
**Impact:** Hook scripts need access to maintenance key path. Setup command generates key. Hooks pass it to spawned digest teammate.
**Strength:** core

### Decision 9: Tunable Defaults
**Finding/Decision:** All configurable in settings.toml:
- Digest entry threshold: 15
- Digest time threshold: 4 hours active use
- Hook curl timeout: 2 seconds (fail-open)
- L1 interval: 10 PreToolUse calls
- L2 interval: 20 PreToolUse calls
- Injection token budget: 1500 per injection
- show_related default threshold: 1 (broad)
- Circuit breaker: 20 writes per 5 minutes
- Critical write cap: 3 per session
- Adaptive no-change bump: 2x interval (single bump)
- Handoff TTL: removed (overwrite model eliminates need)
**Strength:** core

### Decision 10: Digest Teammate Prompt Template
**Finding/Decision:** First-class configurable artifact at ~/.aletheia/templates/digest-prompt.md. Heavily commented golden default. Digest teammate is AUTONOMOUS — has its own MCP connection to Aletheia, makes all tool calls itself (search undigested journals, read memories, list_tags, write_memory, retire_memory). Spawning session only launches; zero context burn on caller.
**Inputs to teammate:** self-acquired via tool calls. Prompt template tells it what to do, not provides data.
**Ordered objectives:** (1) synthesize memories from journal patterns, (2) retire contradicted/duplicate memories, (3) normalize inconsistent tags.
**Constraints:** batch processing, BEGIN IMMEDIATE for writes, reference source journal IDs for provenance, mark all reviewed entries digested_at.
**Strength:** core

### Decision 11: Startup Injection Content
**Finding/Decision:** Max 5 lines. Must include: what Aletheia is (one line), how to capture (write_journal), when to use critical: true, how to discover (search with tags). Must include concrete example. Must NOT include full tool listing or architecture.
**Strength:** core

### Decision 12: Tag Similarity — Normalization Matching
**Finding/Decision:** Normalize tags (lowercase, strip hyphens/underscores/spaces) and compare against normalized existing tags. If submitted #front-end normalizes to match existing #frontend, include <tags_similar>#frontend (12 entries)</tags_similar> in response. Zero fuzzy complexity — handles 90% case (case, hyphens, underscores).
**Strength:** core

### Decision Inventory Checkpoint
**Phase:** 3 — Implementation Discussion
**All 12 decisions + Windows target + maintenance key provisioning settled.**
User confirmed inventory complete. No gaps identified.
**Strength:** verified

## Phase Structure
**Phase:** 4 — Phase Structuring

### Phase Decomposition
**5 phases, 2-5 tasks each:**

**Phase 1: Foundation** (3 tasks, all parallel)
- A: Project scaffolding (package.json, tsconfig, ESM, directory structure, deps)
- B: SQLite database (schema, connection module, migration runner)
- C: Platform abstraction (socket/pipe path helper, OS detection)

**Phase 2: Server Infrastructure + Data Layer** (5 tasks, two parallel tracks)
- Track 1 (server): A: MCP server skeleton, B: Socket HTTP server (lifecycle, lockfile, GC), C: Settings (smol-toml, defaults)
- Track 2 (data): D: Data query modules (all tables), E: Data behaviors (versioning, supersedes, tiering, tag similarity)

**Phase 3: MCP Tools + Injection** (4 tasks, all parallel)
- A: Auth + Entry tools
- B: Journal + Memory + Discovery tools (incl. critical escape hatch, circuit breaker)
- C: Status + Handoff tools
- D: Injection system (L1/L2 builders, adaptive frequency, content-hash, token budget, socket endpoints)

**Phase 4: Hooks + CLI + Setup** (3 tasks, all parallel)
- A: Unix hooks (5 POSIX sh scripts)
- B: Windows hooks (5 Node.js scripts)
- C: CLI + setup/teardown (registration, directory creation, settings, maintenance key)

**Phase 5: Content + Packaging + Integration** (3 tasks)
- A: Templates + content (entry templates, digest prompt, startup injection, help)
- B: npm packaging (files, bin, build, README)
- C: Integration testing strategy

### Danger Files
- src/server/socket.ts: Phase 2 (bind/lifecycle) + Phase 3 (injection endpoints)
- package.json: Phase 1 (initial) + Phase 5 (packaging)

### Integration Surfaces
1. Schema → Query modules (Phase 1→2): table/column names match
2. Query modules → Tools (Phase 2→3): function signatures, return types
3. Socket endpoints → Hooks (Phase 3→4): endpoint paths, response format
4. Tool surface → CLI setup (Phase 3→4): tool names for registration
5. All → Packaging (Phase 1-4→5): file paths, entry points, hook locations

### Critical Path
Phase 1 → Phase 2D (data queries) → Phase 3B (tools) → Phase 4A (hooks) → Phase 5B (packaging)

### Parallelization Assessment
- Phase 1: 3 independent tasks (full parallel)
- Phase 2: 2 independent tracks of 2-3 tasks each (track-level parallel)
- Phase 3: 4 independent tool groups (full parallel)
- Phase 4: 3 independent tasks (full parallel)
- Phase 5: 3 tasks (A+B parallel, C after integration)

**Strength:** core

## Finalization
**Phase:** 6 — Finalization
**Verification:** All 11 structural and content checks passed on first attempt. No failures.
**Plan file:** docs/plans/designs/aletheia-plan.md (1185 lines)
**Plan-index:** Generated with verified timestamp 2026-04-09T23:30:00. Line numbers spot-checked against actual sentinel positions — all accurate.
**Session complete.**
**Strength:** verified
