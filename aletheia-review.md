# Aletheia Design-to-Plan Coverage Review

## GAPS -- Design items missing from plan

### 1. Handoff TTL / expires_at column
**Design:** Section 2 (Data Lifecycle, via Dramaturg Journal Phase 9 revision "Data Lifecycle -- Minimum Viable Lifecycle", lines 438-452): "Handoff TTL -- 24h default (configurable). expires_at column on handoffs table. Filtered at read time: WHERE expires_at > datetime('now'). Server-side, no tool needed." The design doc doesn't include this because Phase 9 revisions were never merged back into the design doc, but the Arranger journal explicitly acknowledges Phase 9 revisions as superseding.
**Plan:** The handoff schema (plan line ~329-335) has NO `expires_at` column. The handoff model was simplified to a mailbox-overwrite pattern (Arranger Decision 3), which the Arranger argues eliminates the need for TTL ("Handoff TTL: removed (overwrite model eliminates need)" -- Arranger journal Decision 9, line 198). However, the Phase 9 revision explicitly added TTL as a "must-have" for the data lifecycle. Even with overwrite semantics, an unconsumed handoff sitting indefinitely is still a data lifecycle problem. The Arranger unilaterally dropped a must-have from the design review without flagging it.
**Severity:** Medium. The overwrite model does reduce the accumulation problem but does not fully address the concern about stale unconsumed handoffs.

### 2. Digest teammate auto-spawning triggers
**Design (Dramaturg Journal Phase 9, "Revision: Promotion -- Dumb Capture, Smart Digest", lines 418-433):** Digest teammate auto-spawned at: "(a) entry count threshold, (b) time-based threshold (no digest in X hours of active use), (c) session-end hook." Three distinct trigger points.
**Plan:** The plan includes digest entry threshold and time threshold in settings (Phase 1 constants, plan lines 244-245: `digestEntryThreshold: 15`, `digestTimeThresholdHours: 4`). But there is NO mention anywhere in the plan of the session-end hook trigger (trigger c). The hook system (Phase 4) defines 5 hooks -- startup, L1 injection, L2 injection, memory interception, and overlap detection. There is no session-end / Stop hook that would spawn a digest teammate. The digest teammate prompt template is covered in Phase 5, but the actual spawning mechanism -- how the system detects thresholds are reached and launches the teammate -- is not described in any phase.
**Severity:** High. The digest teammate is a central design element ("Dumb Capture, Smart Digest" is one of the five Phase 9 revisions). The plan covers the prompt template and the tunable thresholds but never describes WHO spawns the digest teammate, WHEN it is spawned, or HOW the threshold detection works at runtime. This is a significant architectural gap -- the triggering mechanism is the entire execution path.

### 3. Digest teammate maintenance key provisioning in hook scripts
**Design (Dramaturg Journal Phase 9, lines 431):** "Digest teammate needs a dedicated maintenance key with 'read all, retire any, write new' permissions."
**Arranger journal (Decision: Maintenance Key Provisioning, lines 178-184):** "Digest spawning hooks read key from file and pass to teammate via -p prompt."
**Plan (Phase 4, line 983):** Setup generates maintenance key when enforce_permissions configured. But no hook in Phase 4 describes the logic for reading the maintenance key file and passing it to the digest teammate. The hooks described are the 5 standard hooks (startup, L1, L2, memory intercept, overlap detection). None of them spawn a digest teammate or reference the maintenance key at runtime.
**Severity:** High. Tied to gap #2 -- without a spawning mechanism, the key provisioning during spawning is also missing.

### 4. Settings: `history_reminders` configuration
**Design (Section 6, line 319):** `history_reminders = true` in settings.toml.
**Plan (Phase 2, settings interface, lines 540-567):** Includes `historyReminders: boolean` in the settings interface. However, there is no description anywhere in the plan of what `historyReminders` actually controls -- what behavior this flag enables/disables, which injection payloads it affects, or how it interacts with L1/L2 builders. The design document mentions "INJECT_HISTORY_REMINDERS" in the Vision Baseline but never defines its behavior either.
**Severity:** Low. The setting exists in the plan's data structures but its behavioral implementation is undefined.

### 5. Interactive setup mode (`aletheia setup -i`)
**Design (Section 6, line 299):** "`aletheia setup -i` -- Interactive guided configuration."
**Plan (Phase 4, lines 977-989):** Describes `aletheia setup` flow and `aletheia teardown` flow. No mention of the `-i` interactive mode. The plan only covers the default sensible-defaults path.
**Severity:** Low-Medium. The interactive mode was explicitly designed for power users who want guided configuration.

### 6. Settings file: `rolling_default` configuration
**Design (Section 6, line 322):** `rolling_default = 50` under `[memory]` in settings.toml.
**Plan:** The settings interface (Phase 2, line 550) includes `rollingDefault: number` in the settings type, and the journal query module (line 590) references "last N, default from settings." However, the `DEFAULTS` constant (Phase 1, lines 239-251) does NOT include `rollingDefault`. Every other setting has an explicit default value in the DEFAULTS constant except this one.
**Severity:** Low. The setting is present in the interface but missing from the defaults constant -- likely an oversight.

### 7. Content-hash change detection details
**Design (Section 4, Hook 3 / Adaptive Frequency, lines 211-213):** "Content-hash change detection: matching hash = skip or inject brief 'memory unchanged' marker."
**Plan (Phase 3, injection/frequency.ts, lines 812-814):** Mentions content-hash change detection and "No change: single bump to 2x interval." But does NOT mention the option of injecting a brief "memory unchanged" marker as an alternative to skipping entirely. The design gives two options (skip OR marker); the plan only implements skip/bump.
**Severity:** Low. Minor behavioral detail.

### 8. Token budget prioritization strategy
**Design (Section 4, line 212):** "Token budget per injection payload (configurable max). Exceeding budget: prioritize by recency and access frequency."
**Plan (Phase 3, lines 805-807):** L1 and L2 builders "respect token budget" but the specific prioritization strategy (recency + access frequency) is not described. The plan says payloads respect the budget and the conductor review verifies "payloads truncated when exceeding budget" (line 877) but never specifies HOW entries are selected when the budget is tight.
**Severity:** Medium. Without a prioritization strategy, implementers must make this decision ad hoc.

### 9. Memory version history: querying previous versions / full snapshot rendering
**Design (Section 2, lines 73-74):** "Diff-based version history with full snapshots rendered on query." Also: "History tracked via diff-based storage internally; full snapshots rendered when Claude queries previous versions" (line 24).
**Plan (Phase 2, line 634):** "Memory version snapshot: store diffs internally, render full snapshots when Claude queries previous versions." This is stated as a data behavior but there is NO tool in Phase 3 that allows Claude to query previous versions of a memory entry. The `read` tool reads current state. There is no `read_history` or version parameter on `read_memory`. The version history is stored but never exposed.
**Severity:** Medium-High. The design explicitly calls for Claude to be able to query previous versions. The plan stores the data but provides no access path.

### 10. `bootstrap` tool naming
**Design (Section 5, line 240):** `bootstrap(name, enforce_permissions)` -- system-level initialization tool.
**Dramaturg Journal (line 217):** Originally named `init_project`, renamed to bootstrap because "A project is a part of the system, it's slightly confusing when it's meant to initialize the entire system."
**Plan (Phase 3, line 748):** Uses `bootstrap(name, enforce_permissions)` -- correctly named. However, the design doc Section 3 (line 149) still says `bootstrap(name, enforce_permissions: true)` with `enforce_permissions` as a boolean parameter. The plan's Phase 3 implementation does not clarify whether `enforce_permissions` is a required parameter, optional with default, or part of settings. Minor ambiguity.
**Severity:** Very Low. Naming is correct; parameter semantics are a minor implementation detail.

### 11. Read-once semantics for handoffs
**Design (Section 2, line 81):** "Server-enforced read-once semantics available. Optional target key for directing to a specific recipient."
**Plan:** The plan's handoff model (mailbox overwrite) has consume-on-read semantics (Phase 2, line 613: "SELECT + DELETE in immediate transaction (consume)"). This covers read-once. However, the design says read-once is "available" (optional), while the plan makes it mandatory (always consumes on read). The design implies handoffs could optionally be read without consuming.
**Severity:** Low. The plan's always-consume approach is simpler and the Arranger's mailbox model makes optional non-consuming reads less meaningful.

### 12. Adaptive injection: `UserPromptSubmit` alternative trigger
**Design (Section 4, lines 227-228):** "PreToolUse default, UserPromptSubmit as alternative."
**Plan (Phase 2, settings interface, line 542):** Includes `trigger: 'PreToolUse' | 'UserPromptSubmit'` in settings. But the hook implementations in Phase 4 only describe PreToolUse hooks. There is no description of how UserPromptSubmit hooks would differ in implementation or registration. The settings support it but the hooks don't account for it.
**Severity:** Low-Medium. The configuration exists but the implementation path for the alternative trigger is not described.

### 13. Schema: future knowledge graph extension
**Design (Section 1, line 25):** "Schema designed for future knowledge graph extension -- an `entry_links` table can be added later without migration."
**Plan:** No mention of `entry_links` or knowledge graph extensibility in the schema design. The schema is complete and functional but this forward-looking design consideration is not documented.
**Severity:** Very Low. This is explicitly a "future" consideration, but the design specifically called out the schema should be designed with this in mind.

### 14. WAL checkpoint strategy
**Arranger journal (Phase 2 audit, line 63):** "Checkpoint starvation -- constant readers prevent WAL merge. WAL file grows unbounded. Need periodic PRAGMA wal_checkpoint(TRUNCATE) on idle/shutdown."
**Plan:** The connection module sets `wal_autocheckpoint = 1000` (plan line 274) but there is no explicit checkpoint-on-shutdown or periodic checkpoint strategy. The auto-checkpoint handles normal operation but the Arranger's own audit flagged that constant readers can prevent WAL merge, requiring explicit checkpointing -- which is not in the plan.
**Severity:** Low-Medium. The auto-checkpoint covers most cases, but the Arranger's own audit finding is not reflected in the plan.

### 15. Transaction discipline: never hold write locks during LLM generation
**Dramaturg Journal (Phase 9, Notes for Arranger, item 7, line 464):** "Never hold SQLite write locks during LLM generation. Read -> release -> think -> begin transaction -> write -> commit."
**Plan:** The plan's mandatory directive is "All write transactions must use better-sqlite3's .immediate() mode" (line 280). But there is no explicit instruction about transaction scope discipline -- specifically, that transactions should be as short as possible and never span LLM generation time. With better-sqlite3's synchronous API this is largely handled naturally (write transactions complete before returning), but this Gemini-flagged HIGH priority item deserves explicit mention.
**Severity:** Low. better-sqlite3's synchronous nature largely prevents this, but the explicit guidance is missing.

### 16. Digest teammate OCC interaction in multi-agent mode
**Dramaturg Journal (Phase 9, Notes for Arranger, item 8, line 465):** "In multi-agent mode, digest teammate should use OCC and handle state-forwarding errors, even if working agent has solo bypass. Prevents race between critical escape hatch and concurrent digest."
**Plan:** The digest teammate prompt template (Phase 5, lines 1083-1094) says "batch processing, BEGIN IMMEDIATE for writes" but does not mention OCC handling. The prompt template should instruct the digest teammate to use version_id-based OCC when in multi-agent mode and handle state-forwarding errors gracefully. This was flagged as MEDIUM priority by Gemini.
**Severity:** Medium. Race condition between critical escape hatch and concurrent digest is a real scenario.

### 17. Scaling pattern: multiple digest teammates per tag type
**Dramaturg Journal (Phase 9, line 428):** "For large-graph situations, multiple digest teammates can be spawned per tag type (e.g., one for #frontend, one for #backend), with a coordinator teammate handling cross-tag linking."
**Plan:** No mention of this scaling pattern anywhere. The plan describes a single digest teammate.
**Severity:** Very Low. This is an advanced scaling pattern, not a core feature. But it was a user-contributed idea that should at least be noted.

### 18. File logging configuration
**Arranger journal (Decision 4, line 136):** "Optional file logging to ~/.aletheia/logs/server.log via debug flag in settings.toml, default off."
**Plan (Phase 2, settings interface, line 566):** Includes `debug: boolean` in settings. Phase 1 constants (line 234) defines `LOGS_DIR`. But no phase describes implementing file logging -- the actual mechanism of writing to `~/.aletheia/logs/server.log` when debug is true. The directory and the setting exist but the logging implementation is not described.
**Severity:** Low. The infrastructure is present; the behavioral implementation is not described.

### 19. Uninstall: `npm uninstall -g aletheia`
**Design (Section 6, line 343):** Lists `npm uninstall -g aletheia` as part of the uninstall process, separate from `aletheia teardown`.
**Plan (Phase 4, lines 985-988):** Describes `aletheia teardown` but does not mention `npm uninstall -g aletheia` as a companion step or document it anywhere in the CLI tool's help output or user instructions.
**Severity:** Very Low. Standard npm uninstall is self-evident, but the design lists it explicitly as part of the uninstall flow.

### 20. `update_status` "continue" parameter (state-machine auto-advance)
**Design (Section 5, line 264):** `update_status(entry_id, section_id, state?, continue?)` -- has a `continue?` parameter.
**Design (Section 2, lines 99):** "State-machine check-ins: Claude says 'task 2 complete' -> server moves task out of in-progress, optionally returns next task."
**Plan (Phase 3, line 787):** `update_status(entry_id, section_id, state?, content?)` -- has `content?` instead of `continue?`. The auto-advance / "returns next task" behavior is not described. The plan substitutes a content update parameter for the design's continuation parameter.
**Severity:** Medium. The state-machine auto-advance is a key Status feature from the design -- "saves context over full read/process/rewrite cycles" (design line 100). The plan replaces this with simple content updates.

### 21. Socket path: deterministic hash vs PID-based
**Design (Section 1, line 29):** Socket path uses "hash derived from database path or session config": `~/.aletheia/sockets/<hash>.sock`.
**Plan / Arranger Journal (Decision 5, lines 141-145):** Socket path changed to PID-based: `~/.aletheia/sockets/aletheia-<pid>.sock`. Env var discovery instead of deterministic hash.
**Note:** This is documented in the Arranger journal as a deliberate decision, but it contradicts the design doc. Listed under CONTRADICTIONS below.

---

## CONTRADICTIONS -- Plan disagrees with design

### 1. show_related: default-on vs opt-in
**Design doc (Section 2, lines 111):** "Opt-in, value is minimum shared tag threshold. `show_related: 1` = broad. Omitted = no related entries."
**Dramaturg Journal Phase 9 (lines 409-416):** Revised to default-on with opt-out via `skip_related`.
**Plan (Phase 3, line 765):** "show_related: default-on at threshold from settings. `skip_related: true` to opt out."
**Assessment:** The PLAN correctly follows the Phase 9 revision. The DESIGN DOC is stale. No true contradiction -- the plan correctly follows the latest decisions. But the design doc text is misleading if read as source of truth.

### 2. Handoff model: queue with IDs vs mailbox overwrite
**Design doc (Section 2, lines 78-83):** Handoffs have `target_key` for directing to a specific recipient, read-once semantics, "Deleted after consumption." Section 5 (lines 258-259): `create_handoff(entry_id, content, tags, target_key?)`, `read_handoff(handoff_id)`, `delete_handoff(handoff_id)` -- uses handoff IDs, implies multiple handoffs can exist per target.
**Plan (Phase 2, lines 611-614 / Phase 3, lines 793-795):** Mailbox overwrite model. `create_handoff(target_key, content, tags)` overwrites existing. `read_handoff()` consumes caller's slot. No handoff_id. No `delete_handoff` tool.
**Assessment:** The Arranger made a deliberate simplification (Arranger journal Decision 3, lines 126-132). The design doc's handoff model (with IDs, queuing, delete tool) is fully replaced. This is a significant departure but is well-reasoned. It should be noted that the design doc listed `delete_handoff` as a tool, which the plan drops entirely.

### 3. Socket path scheme
**Design doc (Section 1, line 29):** `~/.aletheia/sockets/<hash>.sock` with hash derived from database path or session config.
**Plan (Phase 1, line 412):** `~/.aletheia/sockets/aletheia-<pid>.sock` with PID-based naming.
**Assessment:** Deliberate Arranger decision (Decision 5). PID-based naming enables easier stale socket detection. Well-reasoned change but contradicts design doc.

### 4. `update_status` parameter: `continue?` vs `content?`
**Design doc (Section 5, line 264):** `update_status(entry_id, section_id, state?, continue?)`.
**Plan (Phase 3, line 787):** `update_status(entry_id, section_id, state?, content?)`.
**Assessment:** The plan replaces the `continue` parameter (which triggers auto-advance to next task) with a `content` parameter (which updates section content). These serve fundamentally different purposes. The state-machine auto-advance behavior described in the design (Section 2, lines 99-100) is lost.

### 5. OCC behavior scope
**Design doc (Section 2, line 75):** "Optimistic Concurrency Control: `version_id` required for updates. If stale, write fails and returns current state for re-evaluation."
**Phase 9 revision:** OCC becomes hybrid -- disabled in solo mode, state-forwarding in multi-agent mode.
**Plan (Phase 2, line 600):** OCC check only when `enforce_permissions is true`. When false, version_id ignored.
**Assessment:** Plan correctly follows Phase 9 revision. Design doc is stale. The plan's implementation ties OCC to `enforce_permissions`, which maps cleanly to solo vs multi-agent. Not a true contradiction -- plan follows the latest decision.

### 6. Handoff TTL: must-have vs removed
**Dramaturg Journal Phase 9 (lines 442):** "Handoff TTL -- 24h default (configurable). expires_at column on handoffs table. Filtered at read time." Listed as a MUST-HAVE.
**Arranger Journal (Decision 9, line 198):** "Handoff TTL: removed (overwrite model eliminates need)."
**Plan:** No expires_at column in handoff schema.
**Assessment:** Direct contradiction between Dramaturg Phase 9 must-have and Arranger's removal decision. The Arranger argues the overwrite model makes TTL unnecessary, but the design review listed it as must-have. This should be escalated for design owner review.

### 7. Tool count: ~25 vs ~21
**Design doc (Section 5):** Lists ~25 tools across all groups.
**Plan:** Targets ~21 tools after consolidation (unified search, unified read, simplified handoff).
**Assessment:** Deliberate Arranger consolidation decision. Well-documented. Not a problem, but a noted departure.

### 8. `create_entry` tool
**Design doc (Section 5, line 268):** `create_entry(entry_class, tags, content?, template?)`.
**Plan (Phase 3, line 756):** Same tool signature present. However, the unified storage model means `create_entry` creates an entry in the `entries` container table, but the actual content for journal/memory/handoff is created via the type-specific write tools. The relationship between `create_entry` and the type-specific write tools is unclear -- does `write_journal` auto-create an entry, or must `create_entry` be called first?
**Assessment:** Ambiguity, not outright contradiction. The plan should clarify whether `create_entry` is a prerequisite for type-specific writes or if type-specific tools auto-create entries.

---

## PLAN ADDITIONS -- Plan items not in design

### 1. Socket startup lockfile (proper-lockfile)
**Plan location:** Phase 2, lines 513-519 / Phase 1, line 237 (LOCKFILE_PATH constant).
**Basis:** Arranger feasibility audit discovered socket startup race condition. Gemini identified "massive, highly-likely race condition." (Arranger journal, lines 70-74.)
**Assessment:** Legitimate addition. Addresses a real race condition not anticipated in the design. Well-researched.

### 2. `foreign_keys = ON` PRAGMA
**Plan location:** Phase 1, line 275.
**Design:** Not mentioned in the design's PRAGMA list (Section 1, line 22).
**Assessment:** Standard SQLite best practice. Reasonable addition for referential integrity.

### 3. Explicit `BEGIN IMMEDIATE` transaction requirement
**Plan location:** Phase 1, line 280 (mandatory directive).
**Basis:** Arranger feasibility audit with Gemini (Arranger journal, lines 61-62). DEFERRED transactions can deadlock in multi-process WAL.
**Assessment:** Legitimate addition. Addresses real deadlock scenario verified by Gemini.

### 4. `active_tags` SQL VIEW
**Plan location:** Phase 1, lines 383-389.
**Basis:** Dramaturg Journal Phase 9 (line 446): "Active tags VIEW -- SQL view filtering tags from non-archived entries only." This IS in the design review.
**Assessment:** Has basis in Phase 9 revision. Not a plan addition.

### 5. Node.js test runner recommendation
**Plan location:** Phase 5, line 1120.
**Assessment:** Implementation guidance. Reasonable.

### 6. `crypto.randomUUID()` for entry IDs
**Plan location:** Phase 1, lines 421-422.
**Assessment:** Implementation detail. Reasonable choice.

### 7. No `console.log()` mandatory rule
**Plan location:** Phase 1, line 145 (mandatory directive), repeated in conductor reviews.
**Basis:** Arranger feasibility audit (stdout poisoning constraint, Arranger journal lines 52-54).
**Assessment:** Legitimate addition. Critical correctness requirement for MCP stdio transport.

### 8. Socket file permissions `0600`
**Plan location:** Phase 2, line 519.
**Basis:** Design doc Section 1, line 52: "Socket file user-restricted to prevent other system users from querying the sidecar." Plan makes this concrete with 0600.
**Assessment:** Implementation detail of a design requirement. Not truly new.

### 9. Endpoint `GET /session-info`
**Plan location:** Phase 3, line 819.
**Design:** Not in design doc's hook descriptions. The design describes hooks querying for "session state" (Section 4, line 189) but doesn't specify a `/session-info` endpoint.
**Assessment:** Implementation detail to support the startup hook's functionality. Reasonable.

### 10. Guidance to combine L1+L2 hooks into single injection hook
**Plan location:** Phase 4, lines 949-951 (guidance tag).
**Assessment:** Plan-level optimization suggestion. Not in design. Flagged as guidance, not mandatory.

### 11. `memory_entries.archived_at` and soft-delete model
**Plan location:** Phase 1, schema line 315.
**Basis:** Dramaturg Journal Phase 9 (lines 448): "archived_at TIMESTAMP on memory table."
**Assessment:** Has basis in Phase 9 revision. Correctly implemented.

### 12. Settings `digest` section (entryThreshold, timeThresholdHours, criticalWriteCap)
**Plan location:** Phase 2, settings interface lines 561-565.
**Basis:** Dramaturg Journal Phase 9 revision and Arranger Decision 9.
**Assessment:** Has basis in design decisions. Correctly implemented.

### 13. `retire_memory` tool
**Plan location:** Phase 3, lines 771-772.
**Basis:** Dramaturg Journal Phase 9 (lines 440-441): "retire_memory(entry_id, reason?) -- single tool."
**Assessment:** Has basis in Phase 9 revision. Correctly implemented.

---

## COVERAGE SUMMARY

### Coverage Estimate: ~88%

The plan covers the vast majority of the design document's requirements. The core architecture (dual-interface MCP server, SQLite WAL, unified entry model, tag system, permission model, hook system, CLI setup) is thoroughly planned with detailed schemas, code snippets, and phase-by-phase implementation steps.

### Major Themes Covered Well:
- **Architecture:** Dual-interface pattern, SQLite connection management, platform abstraction -- excellent coverage
- **Entry types:** Journal, memory, status, handoff all have complete schemas and query modules
- **Tag system:** Normalization, similarity suggestions, many-to-many relational storage, active_tags view
- **Permission model:** Claim-based auth, key hierarchy, maintenance key, scoping rules
- **Hook system:** All 5 hooks described with fail-open semantics, cross-platform implementation
- **CLI / setup / teardown:** Complete installation and uninstallation flows
- **Data lifecycle:** retire_memory, supersedes auto-retire, journal tiering, archived_at
- **Circuit breakers:** Write caps, critical write limits, supervisor review flagging
- **OCC hybrid model:** Solo bypass, state-forwarding errors, granular status atomicity
- **Templates and content:** Entry templates, digest prompt, startup injection, help tool
- **Packaging:** npm global install, cross-platform support (Unix + Windows)

### Major Themes Missed or Underspecified:
- **Digest teammate execution path:** The plan describes WHAT the digest teammate does (prompt template) and WHAT thresholds trigger it, but not HOW it is spawned, WHO spawns it, or WHEN the threshold checks run. This is the most significant gap.
- **Memory version history access:** Stored but never exposed via tools. Claude cannot query previous versions despite the design requiring it.
- **Status state-machine auto-advance:** The `continue` parameter and "returns next task" behavior is replaced with simple content updates, losing a key design feature.
- **Handoff TTL:** Removed by Arranger despite being a Phase 9 must-have. Needs design owner review.
- **Token budget prioritization:** The strategy for which entries to include when budget is exceeded is unspecified.

### Notes on Phase 9 Handling:
The Arranger correctly identified that Phase 9 revisions supersede the original design doc and planned accordingly for most items. The five Phase 9 revisions (dual-interface, hybrid OCC, show_related default, dumb capture/smart digest, data lifecycle) are all reflected in the plan's architecture. However, some sub-details within these revisions were dropped (handoff TTL, session-end digest trigger, digest OCC interaction, scaling pattern).
