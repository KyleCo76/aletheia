# Decision Journal: Custom Memory Server

## Vision Baseline
**Phase:** Phase 2 — Vision Loop
**What:** A complete, self-contained package (MCP server + bundled hooks + companion components) providing a flexible, structured memory system for Claude Code sessions. The system provides:

- **Entry types:** Journals (historical, tagged, sub-sectioned — user feedback, decisions, values), Memories (persistent knowledge, tagged, mirrors journal structure), Status files (single structured Claude-optimized document per entry with targeted section CRUD), and possibly Hand-offs (single file, no history).
- **Fully flexible structure:** No mandatory hierarchy. Topology determined entirely by how entries are created and keys distributed. Ranges from flat single-user to deeply nested multi-tier. Not all PMs need project memory; not all sessions need multiple entries.
- **Multi-entry per session:** A session loads multiple entries simultaneously. A TL might load: shared project memory (read-only) + own TL memory (read-write) + shared worker memory they manage (read-write as owner). Typically ~2 shared + own, but unbounded.
- **Multi-session per entry:** Many-to-many mapping. Multiple teammate sessions share a single entry (e.g., "remindly-backend-implementation"). 2 workers on entry-A, 3 on entry-B, etc.
- **Read-only inheritance:** Non-owner sessions load entries as read-only. Only the entry's creator can write. PMs typically manage project-level memory (project-scoped), not CEOs. Prevents lower tiers from corrupting shared context.
- **Key-based permissions:** Keys grant specific levels — read-only, read-write, create-sub-entries. Entry creator generates keys at appropriate permission levels. Key generation requires permission. Keys can be session-specific or tier-wide. Fallback to session-ID when keys aren't needed.
- **Simple default mode:** When "enforce permissions" is OFF, a single user can start a session and have it hook into the server — no keys, no project setup, no hierarchy. Complexity is opt-in.
- **Tag-based discovery:** All entry types support multiple tags per entry (#front-end #Scheduler-screen #etc). System reports all tags in use across all entry types. Retrieves all entries matching specified tags. Primary discovery mechanism for sessions.
- **Controlled injection:** Configurable injection frequency — can be every turn, every N turns, or manual. Not strictly every-turn by default, but every-turn is a valid configuration. Compact memory payload + optionally all available tags (INJECT_HISTORY_REMINDERS setting).
- **Claude-optimized formats:** ALL files in the server are Claude-optimized — structured for LLM consumption, token-efficient, not focused on human readability.
- **RAG-like searchable history:** Full history on journals/memories. Search across content, headers, tags. Open mode (full dump) vs rolling mode (tail N lines). Queryable knowledge base of project details, user profiles, implementation approaches, decision history.
- **Dual access paths:** MCP interface for Claude tool calls + secondary path (CLI/shared data store) for hooks to query directly.
- **Complete package:** MCP server + bundled hooks (startup injection, memory interception/redirect, periodic reminders) + companion components. Hooks are primary enforcement — not dependent on Claude following instructions.
- **Universal:** Fresh system, no assumptions about existing tools/OS/MCP servers. Designed for sharing.
- **Settings:** Enforce permissions, disable entry types, project splitting on/off, disable sharing, DISABLE_SYSTEM_MEMORY, injection frequency, INJECT_HISTORY_REMINDERS, and more.

**Why:** Built-in Claude Code memory is line-limited, unstructured, has no history, gets injected every prompt with no control, and cannot be shared across sessions. Multi-session workflows (teammates sharing task context, project-level knowledge distilled to all members, fresh workers inheriting predecessor context) have no native support. Status files vary in quality/structure across projects. No system-built journal for user feedback/decisions/values. Long-running autonomous sessions need a searchable, tagged, historical knowledge base. User wants control over injection timing and content.

**How used:**
- Tag-based retrieval: Teammate spawns → searches tags for context (e.g., "app install methods") → retrieves matching entries across types → compiles decision + reasoning → reports to team leader
- Flexible hierarchy: PM creates project entry, loads it (read-write as owner). TLs load project entry (read-only) + create own (read-write). PM creates shared worker memory, generates keys. Workers load project (read-only) + shared worker memory (read-write) + optionally own entry.
- Simple mode: Solo developer starts Claude, hooks fire, memory server available. No setup, no keys.
- Session inheritance: Session dies/compacts → new session claims same entry or creates new one inheriting from old → full historical context preserved.
- Status updates: Targeted section edits — no full file read/rewrite needed.
- Startup: Hook injects compact memory payload + tag list, recommends using memory server.

**User verbatim (key statements):**
- "I want a structured STATUS file that is Claude-focused (not markdown, no focus on human readability) that all projects can use"
- "A place for Claude to scratch user feedback, this is how I view the journal, a persistent 'memory' of what the user and Claude directly discussed for a long-term reference point of the user's decisions and values"
- "I envision this server to almost work as a RAG system for agents, where project details, history, a user profile, and implementation approaches are all documented and searchable"
- "do not think of this system or the installed tools, think of a fresh system where the OS was just installed and Claude was setup"
- "I would end up removing it [mcp__memory__] in favor of this full-system approach"
- "hooks that directly pull from the mcp and/or prompt Claude in different ways"
- "the higher memories must be read-only so that changes are controlled by the memory entry's creator"
- "the key is that these entries work on something similar to a key-management system with keys allowing different permission models"
- "we must also have a simple 'default' workflow where a simple user can start a session and have it just hook into the server as a single-user experience"
- "I envision this being used by: launching a teammate -> teammate searches through available tags with context of what it wants to find out -> It requests all memories/journals/etc for things with those tags -> Compiles them into a decision and reasoning and reports this back to team leader"
- "sessions should be able to use multiple memory entries, so I could have a PM session have a 'Project Memory' and then TL's load the 'Project Memory' + their own"

**User confirmed:** yes
**Research during vision:** Identified dual-access-path requirement (MCP + CLI/shared store for hooks). Deferred to Phase 5.
**Status:** settled

## Decision: Project Name
**Phase:** Phase 3 — Vision Expansion
**Category:** decision
**Decided:** The project is named **Aletheia** (CLI: `aletheia`). Full name used — no abbreviation. Pairs with existing "Lethe" skill as etymological opposite (a-lethe-ia = "un-forgetting").
**User verbatim:** "I LOVE the Aletheia connection" and "Is there a practical reason to limit the cli command to 5 characters rather than the full name?"
**User context:** User enjoys Greek mythology naming. Has existing skill "Lethe" for session compaction. Wants the pairing to be explicit and recognizable. Full name preferred over abbreviation for clarity and searchability.
**Alternatives discussed:** Mneme (Muse of Memory — clean, direct), Mitos (Ariadne's thread — creative but less direct), Clio (Muse of History — namespace collisions with existing products), Metis (Titaness of wisdom — confusion with "metrics"), Eidos (Platonic Forms — too abstract). Aletheia chosen for its unique etymological construction from Lethe itself.
**Status:** settled
**Supersedes:** —

## Decision: Lethe-Aletheia Integration Pipeline
**Phase:** Phase 3 — Vision Expansion
**Category:** goal
**Decided:** Lethe should migrate compacted content into Aletheia's memory history rather than purely discarding it. Lethe becomes a migration pipeline: compact out of conversation window → deposit distilled content into Aletheia's persistent storage. The two tools form a cycle (forgetting from session, un-forgetting into storage) rather than being purely opposite.
**User verbatim:** "lethe could even be updated to migrate what it cuts from the context window into the mcp's memory history rather than cutting and forgetting"
**User context:** This emerged naturally from the naming discussion. Transforms both tools' relationship from thematic opposites into a functional lifecycle.
**Alternatives discussed:** None — user proposed this organically and it was immediately clear as a strong enrichment.
**Status:** settled
**Supersedes:** —

## Decision: Circuit Breakers with Supervisor Review
**Phase:** Phase 3 — Vision Expansion
**Category:** decision
**Decided:** Aletheia will have configurable circuit breakers (max writes per interval, max entry size) to protect against agent runaway. Key design constraints: (1) Status file operations (add/move/shift sections) must be atomic — one tool call, one logical write — so multi-step section management doesn't false-positive. (2) Natural multi-operation workflows (add memory + demote old to history, rework STATUS for new feature/project) must not be flagged. (3) Thresholds must be loose and configurable. (4) When tripped, flag for supervisor review with last N memory operations attached — NOT auto-compaction.
**User verbatim:** "we must be careful that simply editing a Status file for example is not flagged as repetitive" and "I think it would be safer to flag for a supervisor review of the session/N prior memory calls" and "This should be naturally loose and possibly configurable. We must also factor in adding a new memory AND demoting a current memory to the history, or reworking the entire STATUS"
**User context:** User has direct experience with false-positive detection in multi-step workflows. Strongly prefers supervisor review over autonomous intervention. Wants the system to err toward "this is probably fine."
**Alternatives discussed:** Auto-compaction via Lethe rejected — agent marking its own work is marking its own homework. Auto-truncation with alert tag considered but supervisor review preferred.
**Status:** settled
**Supersedes:** —

## Decision: Tag Namespacing via MCP Prompt-Back
**Phase:** Phase 3 — Vision Expansion
**Category:** decision
**Decided:** Automatic tag namespacing using MCP prompt-back mechanism. When an entry is created and no project namespace exists, the server returns a concise clarification error prompting for a project name. Subsequent entries under that project inherit the namespace. Configurable setting to allow session-ID fallback — when enabled, disables the error prompt, changes to a notice, and succeeds using session ID as namespace. This preserves zero-friction for simple setups while enabling structured namespacing for complex hierarchies.
**User verbatim:** "MCP prompt-back with config option to allow session id fallback (disables error prompt, changes to notice prompt and succeeds)"
**User context:** User concerned about tool call failures burning context (past experience). CWD-based approach explored and rejected — directory structure varies between users, "noise directories" problem, conflicts with universality. User wants the prompt-back error message to be short and concise.
**Alternatives discussed:** CWD-based namespacing rejected (fragile, host-specific, noise directories). Per-tier naming rejected (too much friction, fails on every new tier). Session-ID-only rejected as primary (opaque, not human-meaningful) but accepted as configurable fallback.
**Status:** settled
**Supersedes:** —

## Decision: Mutable Key Permissions
**Phase:** Phase 3 — Vision Expansion
**Category:** decision
**Decided:** Key permissions must be changeable after creation. A PM created without sub-entry creation permission can be promoted to allow that permission. Supports evolving team structures where roles change mid-project.
**User verbatim:** "key permissions must be changeable. So a PM who is not created with permission to create to sub-entries can be promoted to allowing that permission"
**User context:** Recognizes that team structures evolve during a project — roles grow, responsibilities shift. Static permissions would force recreation of entries/keys.
**Alternatives discussed:** None — this was a direct user requirement.
**Status:** settled
**Supersedes:** —

## Vision Expansion
**Phase:** Phase 3 — Vision Expansion
**Sources:** Dramaturg ideation, Gemini creative ideation (gemini-brainstorm)
**Accepted:**
- **Aletheia naming** — etymological opposite of Lethe (a-lethe-ia = "un-forgetting"). Full name, no abbreviation. CLI: `aletheia`.
- **Lethe-Aletheia integration pipeline** — Lethe migrates compacted content into Aletheia's memory history instead of discarding. Forgetting from session → un-forgetting into storage.
- **Circuit breakers with supervisor review** — configurable, loose thresholds. Atomic status file operations. Flags for supervisor review (not auto-compaction). Must not false-positive on natural multi-step workflows.
- **Tag namespacing via MCP prompt-back** — server prompts for project name on first entry creation. Configurable session-ID fallback (disables error, changes to notice, succeeds).
- **Mutable key permissions** — permissions can be upgraded/downgraded after creation.
- **Entry templates** — ship with defaults (golden commented template, manager, backend-implementation, UI design). User additions alongside defaults, not editing defaults. Optional. Specific template set to be finalized in Phase 5.
- **Tag-overlap relatedness** — write responses include "related entries" when tag overlap detected. Implicit relationship layer via shared tags. Cross-type discovery via multi-tag search.
- **Hybrid diff storage** — store history as diffs internally for efficiency, render full snapshots when Claude queries previous versions.
- **Permission-scoped health metrics** — entry sizes, tag distribution, access frequency, staleness. Scoped to caller's key permissions — cannot see metrics for entries outside access level.
**Rejected:**
- **Dead-letter recovery** — server-side atomic operations handle data integrity. Session-level recovery is an orchestration concern, not Aletheia's responsibility.
- **Full semantic linking / knowledge graph** — too complex, fragile. Tag-overlap relatedness provides the lightweight implicit version.
- **Pub/sub notifications (basic)** — workers can already directly message TLs. Basic notification unnecessary.
- **Entry lifecycle / TTL** — unnecessary complexity, manual cleanup sufficient.
- **Export/import** — dropped for now.
**Tabled:**
- **Cross-session reactive injection** — DROPPED. Hooks are event-driven (not timer-based), so idle sessions never poll. This creates inherent latency that makes reactive cross-session injection unreliable. Direct messaging (comms-link) remains the right tool for urgent cross-session communication.
- **Entry template specifics** — which templates ship as defaults, exact structure. Phase 5 topic.
**Vision Baseline updated:** no — core What/Why/How-used unchanged. Enrichments added capabilities within existing scope.
**Status:** settled

## Topic Map
**Phase:** Phase 4 — Broad Design Scoping
**Areas to explore in Phase 5:**
- **Data layer** — SQLite schema design, WAL cross-process visibility fix, Claude-facing vs internal format choices, concurrent multi-session access, atomic operations, circuit breaker implementation, knowledge graph future-proofing
- **Entry types and tag system** — Journals, memories, status files (section CRUD mechanics), hand-offs. Multi-tag per entry, tag search/discovery, tag-overlap relatedness in write responses. Default templates (golden template, manager, backend, UI).
- **Permission / key management** — Key representation and lifecycle (generation, distribution, validation, mutation). Tier-wide vs session-specific. Read-only / read-write / create-sub-entries levels. Simple mode bypass. How keys are passed between sessions.
- **Hook system** — PreToolUse as default trigger, L1/L2 injection tiers (immediate-scope ~10 calls, broad-scope ~20 calls), built-in memory interception/redirect, memory file cleanup/overlap detection, UserPromptSubmit config alternative, hook registration during install.
- **MCP tool surface** — Tools Aletheia exposes to Claude, tool call patterns, prompt-back flows (project name, concise error messages), response formats, help command.
- **Package and distribution** — npm packaging, `npm install -g` flow, first-run setup (registers MCP server + hooks), cross-platform (Linux, macOS, Windows?), settings file location/structure.
**Dropped from topic map:**
- **Lethe integration** — Lethe is a Claude skill that calls Aletheia's standard MCP tools like any other session. Aletheia just needs to support direct history writes, which it already must for demoting active memories. Integration is transparent to Aletheia; the Lethe side is a separate future update.
**User confirmed coverage:** yes
**Status:** confirmed

## Research: SQLite WAL Cross-Process Visibility
**Phase:** Phase 5 — Approach Loop
**Question:** What causes the WAL visibility issue the user experienced, and what's the best architecture for dual-access (MCP server + hooks/CLI) to the same data store?
**Tools used:** gemini-query (high reasoning)
**Findings:** WAL visibility issues are configuration bugs, not WAL flaws. Three causes: (1) snapshot isolation from dangling read transactions, (2) -shm file permission problems causing silent fallback to stale .db reads, (3) uncommitted writer transactions. All fixable with proper PRAGMAs and transaction discipline. WAL is confirmed correct for this use case — DELETE/TRUNCATE modes cause SQLITE_BUSY on concurrent read/write. However, the HTTP sidecar pattern is architecturally superior: MCP server owns SQLite exclusively (single-process, most reliable mode) and exposes a local endpoint for hooks to query. Eliminates entire class of multi-process SQLite bugs by design.
**Decision:** Sidecar architecture via Unix domain sockets. MCP server runs two interfaces: stdio for Claude Code + Unix domain socket for hooks/CLI. SQLite is single-process-owned by the MCP server. Hooks query via socket using deterministic paths (~/.aletheia/sockets/<hash>.sock) derived from shared config. No port management, no registry, no race conditions. Unix domain sockets supported on Windows 10+ (2018) via Node.js — cross-platform likely viable, with Windows support droppable as fallback if issues surface.
**Arranger note:** PARTIAL — Arranger should verify Unix domain socket support on Windows 10+ with Node.js before committing to cross-platform. If verification fails, Windows support is explicitly acceptable to drop.
**Status:** settled
**Supersedes:** —

## Decision: SQLite Connection Configuration
**Phase:** Phase 5 — Approach Loop
**Category:** decision
**Decided:** SQLite owned exclusively by MCP server process. Connection PRAGMAs: journal_mode=WAL, synchronous=NORMAL, busy_timeout=5000, temp_store=MEMORY, cache_size=-20000 (20MB), wal_autocheckpoint=1000. Hooks never touch SQLite directly — all data access through Unix domain socket sidecar.
**User verbatim:** "I like the sidecar approach" and "Agreed then, I read it as unix domain sockets was a no-go on Windows but if it's supported then fantastic"
**User context:** User has experienced WAL visibility issues firsthand. Strong preference for eliminating the problem by design rather than configuring around it.
**Alternatives discussed:** Direct SQLite access from hooks (requires careful PRAGMA config, still susceptible to visibility bugs). HTTP sidecar with port management (works but requires service registry, race conditions, orphaned ports). Dynamic port with file discovery (simpler but relies on file cleanup). Unix domain sockets chosen for zero coordination overhead and deterministic addressing.
**Status:** settled
**Supersedes:** —

## Research: Data Format for Claude-Facing Content
**Phase:** Phase 5 — Approach Loop
**Question:** What data format optimizes for Claude read/write ability, token efficiency, and searchability across MCP tool responses and injection payloads?
**Tools used:** gemini-query (high reasoning)
**Findings:** MCP protocol forces JSON for tool inputs (Claude writes). For tool responses (Claude reads), Micro-XML with short tags (<sec>, <m>, <j>) provides structurally bulletproof parsing — Claude's attention heads isolate XML tags perfectly, preventing context bleed from Markdown's ambiguous boundaries. Nearly as token-efficient as Markdown. For L1/L2 injection payloads, YAML-style KV inside a single XML wrapper maximizes information density. Format differs per entry type (status needs section IDs for CRUD, journals need timestamps, memories are KV) but delivery wrapper stays consistent. Internal storage: plain text in SQLite columns, metadata/tags in relational tables. MCP server handles all format conversion.
**Decision:** JSON in (writes) → SQLite (plain text + relational metadata) → Micro-XML out (reads). Injection payloads use dense YAML-in-XML. Aligns with user's existing hybrid document structure convention.
**Arranger note:** VERIFIED — format architecture follows directly from MCP protocol constraints and Claude's known XML parsing strengths. No further verification needed.
**Status:** settled
**Supersedes:** —

## Decision: Entry Type Structure
**Phase:** Phase 5 — Approach Loop
**Category:** decision
**Decided:** Four entry types with distinct characteristics:
- **Journal:** Append-only, read, search. Full history (immutable entries). Timestamped, tagged, sub-sectioned. Long-term record of decisions/feedback/values.
- **Memory:** Create, read, update, search. Diff-based version history. Key-value-like knowledge, tagged. Active knowledge that evolves.
- **Status:** Read, replace (full document), section CRUD (add/move/remove). No history (current snapshot only). Frequently updated. Single structured document per entry.
- **Hand-off:** Create, read, delete. No history. One-shot transfer document, consumed and discarded by receiving session.
**User verbatim:** "Yes that matches" and "Handoffs will also need delete so they are not kept past their usage"
**User context:** Status "replace" covers the full-document rework scenario as a single operation. Section CRUD handles targeted edits within. Hand-offs are ephemeral — delete after consumption.
**Alternatives discussed:** None — breakdown mapped cleanly to user's mental model from Vision Loop.
**Status:** settled
**Supersedes:** —

## Decision: Tag-Overlap Relatedness via show_related Threshold
**Phase:** Phase 5 — Approach Loop
**Category:** decision
**Decided:** Tag-overlap relatedness is opt-in via a `show_related` parameter on write/update tool calls. The parameter value is the tag-overlap threshold: `show_related: 1` returns all entries sharing 1+ tags, `show_related: 2` requires 2+ shared tags, etc. When omitted entirely, no relatedness check is performed and no related entries are returned — keeping simple write responses minimal.
**User verbatim:** "make the argument accept the relevance threshold, show_related: 1 would return all results that have 1+ matching tag" and "with no show_related argument it should NOT return any related entries, this makes simple additions with not context requested as small of context as needed, Claude does not even need to output the show_related: portion"
**User context:** User prioritizes minimal context burn on routine writes. Discovery is available on demand with tunable precision. Hybrid of opt-in (option C) and threshold (option B).
**Alternatives discussed:** Always-on relatedness (too noisy). Fixed threshold without opt-in (still noisy on simple writes). Pure opt-in boolean (less flexible than threshold).
**Status:** settled
**Supersedes:** —

## Decision: Claim-Based Authentication Model
**Phase:** Phase 5 — Approach Loop
**Category:** decision
**Decided:** Authentication uses a claim-based model. Claude calls `aletheia claim(key)` once per session — server associates the MCP connection with that key for all subsequent calls. No key needed per tool call. `aletheia whoami` returns current key, permissions, and accessible entries (recovery after context compaction). `aletheia list_keys` returns all sub-keys beneath the caller's scope for supervisor visibility.
**User verbatim:** "Will Claude 'claim' the server with a key or need the key for each call? If it claims it, then we could have a command specific to retrieving the key so Claude could get it as needed."
**User context:** Claim model means key only appears in context once. whoami is the recovery mechanism. Supervisors need visibility into their subtree's keys.
**Alternatives discussed:** Per-call key inclusion (token-wasteful, redundant). Key storage in working directory (security risk in shared directories — workers could read TL's key).
**Status:** settled
**Supersedes:** —

## Decision: Simple Mode Auto-Initialization
**Phase:** Phase 5 — Approach Loop
**Category:** decision
**Decided:** When enforce_permissions is OFF and no claim exists, the server auto-initializes a session entry on first write. Zero friction — no explicit init step. Re-attaches to existing entries based on working directory on subsequent sessions (solo developer gets continuity). Startup hook injects brief notice: "Aletheia available. Memory will auto-initialize on first use."
**User verbatim:** "Yes that matches what I was thinking for the re-attaching"
**User context:** Simple mode must be zero-friction for solo developers. Continuity across sessions by directory matching.
**Alternatives discussed:** Requiring explicit init call (unnecessary friction for simple mode).
**Status:** settled
**Supersedes:** —

## Decision: Project Bootstrap and Master Key Security
**Phase:** Phase 5 — Approach Loop
**Category:** decision
**Decided:** Bootstrap flow for enforce_permissions=true projects:
1. `aletheia init_project(name, enforce_permissions: true)` — keyless, one-shot per project name
2. Server generates master key, writes to `~/.aletheia/keys/<project>.key`
3. Response directs Claude to inform the user: file is at <path>, save it securely and delete the file
4. Key file is the ONLY place the master key is exposed — NOT output to console/TUI (prevents other sessions from reading CEO's TUI output)
5. Human records key securely, deletes file
6. `init_project` permanently disabled for that project name once master key exists — no second master key, ever
7. All sub-keys are scoped downward — cannot create keys at or above creator's level
8. Recovery for lost master key: change enforce_permissions to false (allows ignoring keys) or remove and reinstall server. No backdoor recovery mechanism.
**User verbatim:** "let's NOT instruct Claude to write to the console but instead to write the file path with instructions to the user to record safely and delete the file" and "Directions should be to Claude 'Inform user that file is at .. and to save it ...'" and "the only way would be to change to enforce_permissions=false to allow for multi-master-keys or ignoring keys, whichever implementation approach is chosen. OR to remove the server and reinstall"
**User context:** Security-first design. Preventing key leakage via TUI output. Preventing escalation (TL creating own CEO structure). Lost master key = locked project is intentional security behavior with explicit escape hatches.
**Alternatives discussed:** Outputting key to Claude's TUI (rejected — other sessions could read it). Key file persisting indefinitely (rejected — user deletes after recording). Recovery backdoor (rejected — undermines security model).
**Status:** settled
**Supersedes:** —

## Decision: Permission Scoping and Mutation Rules
**Phase:** Phase 5 — Approach Loop
**Category:** decision
**Decided:** Key mutation and scoping rules: (1) A key's creator can modify its permissions (promote or demote). (2) Only keys beneath your own level can be modified. (3) Master key can modify anything. (4) A key cannot self-promote (prevents escalation). (5) Sub-keys are automatically scoped beneath the creator's entry — cannot access sibling entries or parent entries as read-write. (6) Creator can grant create-sub-entries permission to a sub-key, enabling that key to create its own sub-keys beneath itself.
**User verbatim:** "Yes that looks correct"
**User context:** Confirms downward-only scoping, creator-controlled mutation, no self-promotion.
**Alternatives discussed:** None — model matched user's expectations directly.
**Status:** settled
**Supersedes:** —

## Decision: Hook System Architecture
**Phase:** Phase 5 — Approach Loop
**Category:** decision
**Decided:** Five hooks in the complete package:
1. **Startup injection** (first PreToolUse or UserPromptSubmit): Query sidecar for existing claim/entry. Orchestrated sessions: Claude claims with key from -p prompt. Simple mode with existing entry: auto-claim for cwd. Simple mode no entry: inject "Aletheia available, auto-initializes on first use." Enforce permissions ON with no key: inject "Aletheia requires authentication. Use claim(key) or bootstrap command."
2. **L1 immediate-scope** (every ~10 PreToolUse): Inject focused current-task memory.
3. **L2 broad-scope** (every ~20 PreToolUse): Inject broader project context, role, constraints.
4. **Memory interception** (PreToolUse matching Write/Edit to MEMORY.md path): Behavior depends on DISABLE_SYSTEM_MEMORY setting. When true: block write, mirror content to Aletheia, alert session. When false: allow write, alert session to consider Aletheia.
5. **Memory overlap detection** (startup): Read built-in MEMORY.md, notify of overlapping usage, recommend clearing.
All hooks configurable — intervals adjustable, individually disableable. PreToolUse as default trigger, UserPromptSubmit as config alternative. Bootstrap command is system-level (not "init_project") — exact naming deferred to Topic 5 MCP tool surface.
**User verbatim:** "if the setting to disable built-in memory is on then it should block, mirror, and alert the Claude session. If the setting is off, then it should allow the read/write and alert the Claude session" and "I don't know if aletheia init_project(name) is the correct wording. A project is a part of the system, it's slightly confusing when it's meant to initialize the entire system"
**User context:** User wants hooks as primary enforcement layer (not relying on Claude following instructions). DISABLE_SYSTEM_MEMORY provides both aggressive (block+mirror) and tandem (allow+alert) modes. Bootstrap command must communicate system-level initialization, not just project creation.
**Alternatives discussed:** UserPromptSubmit as default (rejected — doesn't fire for autonomous agents). Timer-based polling (rejected — hooks are event-driven). Key injection via hooks (rejected — claim + whoami sufficient, avoids context clutter).
**Status:** settled
**Supersedes:** —

## Decision: MCP Tool Surface
**Phase:** Phase 5 — Approach Loop
**Category:** decision
**Decided:** ~25 tools organized into groups: Authentication (claim, whoami, bootstrap, create_key, modify_key, list_keys), Entry Management (create_entry, list_entries), Journal (append, read, search), Memory (write, read, search), Status (read, replace, add/move/remove/update section), Hand-off (create, read, delete), Discovery (list_tags, search_by_tags), System (help, health). Tool count is acceptable due to deferred/lazy tool loading — schemas hidden until Claude requests them via ToolSearch.

show_related parameter unified across reads and writes: value = minimum number of shared tags. Higher = stricter. Omitted = no related entries. Server caps at entry's actual tag count if value exceeds it (so show_related:99 effectively means "match all tags" without needing to know the count).

Error messages use concise XML format: `<error code="CODE">one-line message</error>`. No stack traces or verbose explanations. help command available for detail.
**User verbatim:** "Unified would be the best approach I agree" and "That works" (on server capping at tag count) and "That works well" (on error format)
**User context:** Deferred tool loading addresses tool count concern. Unified show_related semantics prevent Claude confusion across read/write contexts. Concise errors reduce context burn from failed calls (past experience with verbose failures).
**Alternatives discussed:** Consolidated tools with action parameter (rejected — granular tools are clearer with deferred loading). Inverted show_related semantics for reads (rejected — inconsistency between read/write contexts would confuse Claude).
**Status:** settled
**Supersedes:** —

## Decision: Package Distribution and Installation
**Phase:** Phase 5 — Approach Loop
**Category:** decision
**Decided:** npm global install: `npm install -g aletheia`. Setup command: `aletheia setup` installs with sensible defaults (registers MCP server, hooks, creates ~/.aletheia/ directory structure). `aletheia setup -i` for interactive configuration walkthrough. Power users edit settings file directly. Settings file at `~/.aletheia/settings.toml` — TOML format for human readability and comment support. Self-documenting with inline comments explaining each option.
**User verbatim:** "Maybe a -i option to make it interactive?" and "Human readability, I'm not familiar with TOML but choose whatever is more widely-preferred"
**User context:** User wants minimal friction for basic install, interactive option for guided setup. Settings must be human-editable (unlike Claude-optimized entry data). TOML chosen as modern config standard with comment support.
**Alternatives discussed:** JSON (no comment support, verbose for config). YAML (indentation pitfalls, implicit type coercion). TOML selected for human readability, comment support, and wide adoption.
**Status:** settled
**Supersedes:** —

## Section Approved: Architecture & Data Layer
**Phase:** Phase 6 — Review Loop
**Key decisions reflected:** Research: SQLite WAL Cross-Process Visibility, Decision: SQLite Connection Configuration, Research: Data Format for Claude-Facing Content, Decision: Circuit Breakers with Supervisor Review
**User feedback incorporated:** none — approved as presented
**Status:** settled

## Decision: Unified Storage with Separate Tool Interfaces
**Phase:** Phase 6 — Review Loop (revised from Phase 5 Entry Type Structure)
**Category:** decision
**Decided:** Single unified storage table with entry_class enum ("journal" | "memory" | "handoff") set automatically by which tool is called. Separate tool interfaces: write_journal(), write_memory(), create_handoff() all write to the same underlying table. Tags are purely for topical discovery, NOT for behavior control. Status remains a separate type with its own operations. This gives unified cross-type search/discovery while maintaining clear, single-responsibility tool boundaries.
**User verbatim:** "I agree, we can proceed with those"
**User context:** Critical review by both an AI agent teammate and Gemini identified that tags-as-behavior-control was an anti-pattern (conflicting tags, missing tags edge cases). Separate tools with unified storage solves the original overlap problem (unified search) without creating the classification confusion (distinct tool interfaces).
**Alternatives discussed:** Fully separate types (original design — fragmented search, cross-type confusion). Fully unified with tag-based behavior (reviewed design — same classification problem, tags as control plane anti-pattern). Unified storage + separate tools chosen as the synthesis.
**Status:** settled
**Supersedes:** Decision: Entry Type Structure

## Decision: Optimistic Concurrency Control
**Phase:** Phase 6 — Review Loop
**Category:** decision
**Decided:** Concurrent writes to shared entries use OCC with version_id. If version doesn't match (another session modified the entry since last read), the write FAILS and returns the current state so Claude can re-evaluate and retry. Replaces the earlier "both succeed + warning" approach.
**User verbatim:** "I agree, we can proceed with those"
**User context:** Gemini review identified that "both succeed + warning" creates branched history requiring Claude to read, merge, and rewrite — potentially while a third agent writes. OCC is cleaner and prevents split-brain concurrent updates.
**Alternatives discussed:** Both-succeed-with-warning (creates branched history, merge burden on Claude). Pessimistic locking (too heavy, blocks other sessions). OCC chosen for clean failure-and-retry semantics.
**Status:** settled
**Supersedes:** —

## Decision: Inline Promotion + Supervisor Digest
**Phase:** Phase 6 — Review Loop
**Category:** decision
**Decided:** Two promotion mechanisms: (1) `promote_to_memory(journal_id, synthesized_knowledge)` tool for inline promotion — Claude promotes immediately when it recognizes a journal entry contains permanent knowledge. (2) Supervisor-triggered digest as periodic backup sweep for entries that slipped through inline promotion. Journal entries retain immutability; promoted content becomes new memory entries with provenance. `last_digested_at` watermark identifies undigested entries.
**User verbatim:** User agreed to inline promotion approach in Obsidian note ("I like the promotion idea") and confirmed refinement
**User context:** Addresses journal growth problem — journal becomes raw input, memory is refined product, with both immediate and periodic promotion paths.
**Alternatives discussed:** Async-only batch digestion (latency risk — Agent B starts before supervisor digests Agent A's decisions). Inline-only (misses things Claude doesn't recognize as permanent). Both mechanisms chosen for coverage.
**Status:** settled
**Supersedes:** —

## Decision: Temporal Framing for Status vs Memory
**Phase:** Phase 6 — Review Loop
**Category:** decision
**Decided:** Tool descriptions use explicit temporal framing to distinguish Status from Memory: "Status is for information that won't matter tomorrow. Memory is for information that will matter next week." This gives Claude a clear, actionable boundary rather than abstract architectural distinctions.
**User verbatim:** "I agree, we can proceed with those"
**User context:** Gemini review identified that Status/Memory overlap is porous without explicit temporal guidance. LLMs understand temporal boundaries better than abstract type boundaries.
**Alternatives discussed:** None — this is a documentation/description refinement, not a structural change.
**Status:** settled
**Supersedes:** —

## Decision: Single-Level Supersedes
**Phase:** Phase 6 — Review Loop
**Category:** decision
**Decided:** Entries can reference what they supersede via a `supersedes` field, but kept to single-level references — no deep chain traversal. Entry A references "supersedes B" but no recursive chain resolution. Simple and useful without linked-list complexity.
**User verbatim:** "I agree, we can proceed with those"
**User context:** Gemini flagged deep supersedes chains as a linked-list nightmare. Single-level keeps the value (knowing what was replaced) without the complexity (traversing replacement history).
**Alternatives discussed:** Deep chain traversal (complex, costly to query). No supersedes at all (loses valuable relationship tracking). Single-level chosen as minimum viable relationship.
**Status:** settled
**Supersedes:** —

## Section Approved: Entry Types & Tag System (Revised)
**Phase:** Phase 6 — Review Loop
**Key decisions reflected:** Decision: Unified Storage with Separate Tool Interfaces, Decision: Entry Type Structure (original), Decision: Tag-Overlap Relatedness, Decision: Optimistic Concurrency Control, Decision: Inline Promotion + Supervisor Digest, Decision: Temporal Framing, Decision: Single-Level Supersedes
**User feedback incorporated:** Major revision — merged Journal/Memory/Handoff into unified storage with separate tool interfaces. entry_class enum replaces tags-as-behavior. OCC replaces succeed-and-warn for concurrent writes. Added inline promotion tool alongside supervisor digest. Added temporal framing for Status/Memory distinction. Supersedes limited to single-level. Driven by AI teammate review + Gemini critical analysis.
**Status:** settled

## Section Approved: Permission & Key Management
**Phase:** Phase 6 — Review Loop
**Key decisions reflected:** Decision: Claim-Based Authentication Model, Decision: Simple Mode Auto-Initialization, Decision: Project Bootstrap and Master Key Security, Decision: Permission Scoping and Mutation Rules
**User feedback incorporated:** none — approved as presented
**Status:** settled

## Section Approved: Hook System
**Phase:** Phase 6 — Review Loop
**Key decisions reflected:** Decision: Hook System Architecture, Decision: Adaptive injection frequency (single bump, not escalating), content-hash change detection, token budget for payloads
**User feedback incorporated:** none — approved as presented
**Status:** settled

## Section Approved: MCP Tool Interface
**Phase:** Phase 6 — Review Loop
**Key decisions reflected:** Decision: MCP Tool Surface, Decision: Unified Storage with Separate Tool Interfaces, Decision: Optimistic Concurrency Control, Decision: Inline Promotion + Supervisor Digest, Decision: Temporal Framing
**User feedback incorporated:** Tool inventory updated to reflect unified storage model (separate tools per entry_class), OCC version_id on writes, promote_to_memory tool, temporal framing in descriptions, status state-machine operations retained
**Status:** settled

## Section Approved: Package & Distribution
**Phase:** Phase 6 — Review Loop
**Key decisions reflected:** Decision: Package Distribution and Installation
**User feedback incorporated:** none — approved as presented
**Status:** settled

## Reconciliation
**Phase:** Phase 7 — Reconciliation
**Sections checked:** All 6 (Architecture & Data Layer, Entry Types & Tag System, Permission & Key Management, Hook System, MCP Tool Interface, Package & Distribution)
**Inconsistencies found:** None substantive. All terminology consistent (entry_class, unified storage, OCC). Status undo buffer and OCC serve complementary purposes (self-inflicted vs concurrent corruption) — noted but not inconsistent.
**Implementation readiness:** Yes — all major design decisions settled. No deferred design-level questions. Template specifics explicitly flagged as implementation detail.
**Status:** settled

## Final Design Document
**Phase:** Phase 8 — Final Design Doc
**Location:** docs/plans/designs/2026-04-08-aletheia-design.md
**Journal completeness:** All checkpoint triggers produced entries. Vision Baseline, Vision Expansion, Topic Map, 15+ settled decisions, 6 section approvals, reconciliation complete.
**Status:** finalized

---

## Post-Design Review Session
**Phase:** Phase 9 — Design Review (2026-04-08)
**Methodology:** Multi-perspective review using Claude teammate (Claude usage perspective) + Gemini (technical architecture review) + interactive brainstorming with user as participant. All decisions below are amendments to the finalized design document.

## Revision: Architecture — Dual-Interface Hybrid
**Phase:** Phase 9 — Design Review
**Category:** revision
**Revised:** The separate Unix domain socket sidecar process is eliminated. The MCP server itself serves dual duty — stdio for Claude Code + Unix domain socket for hooks. Multiple MCP servers (from concurrent Claude Code sessions) share SQLite via WAL mode with `busy_timeout=5000`. Each MCP server exposes a session-specific socket. Hooks query their own session's MCP server via `curl --unix-socket "$ALETHEIA_SOCK"`. Socket path discovery via environment variable injected by Claude Code.
**Rationale:** User's empirical evidence (from comms-link MCP server) confirmed hooks cannot reliably read WAL-mode SQLite directly — the -shm file visibility issue is real, not theoretical. However, introducing a separate sidecar daemon creates lifecycle management complexity (startup races, orphan processes, version mismatch after upgrades). Since the MCP server is already a long-running process with a SQLite connection, giving it dual responsibility eliminates the daemon complexity while solving the hook visibility problem.
**Research basis:** Gemini analysis of SQLite WAL cross-process behavior, Claude analysis of MCP process spawning model, user's direct experience with comms-link MCP server.
**Implementation notes:** Socket cleanup via SIGINT/SIGTERM handlers. Startup garbage collection: glob for aletheia-*.sock, parse PID from filename, kill -0 to check liveness, delete orphaned sockets. Hook commands must include --max-time 2 to prevent hangs. Socket permissions 0600 for security.
**Status:** settled
**Supersedes:** Research: SQLite WAL Cross-Process Visibility (sidecar architecture portion), Decision: SQLite Connection Configuration (hooks never touch SQLite portion — now hooks query via socket on MCP server instead of separate sidecar)

## Revision: OCC — Hybrid Strategy
**Phase:** Phase 9 — Design Review
**Category:** revision
**Revised:** Monolithic OCC replaced with three-layer hybrid approach:
1. **Solo bypass:** When enforce_permissions=false, OCC is disabled entirely. version_id becomes optional in tool schema. Writes always succeed. Solo developers never see or think about concurrency.
2. **State-forwarding errors:** When OCC conflict occurs in multi-agent mode, the error response includes the current version_id AND a brief summary of conflicting state. The failed write becomes the read — Claude can retry immediately without a separate read tool call.
3. **Granular status atomicity:** Section operations (update_status, add_section, remove_section) are atomic at the server level and don't require OCC. Only replace_status (full document rewrite) requires OCC.
**Also decided:** No version_ids in L1/L2 injection payloads. Leaner injections preferred — state-forwarding errors handle recovery when version_ids are lost to context compaction.
**Rationale:** Both reviewers independently flagged OCC as broken for LLM clients. Claude's context compaction loses version_ids from earlier tool results, forcing redundant re-reads. The original OCC decision (replacing "both succeed + warning") was correct for preventing split-brain — the hybrid preserves that safety while eliminating friction for the ~90% solo case and providing clean recovery for multi-agent.
**User verbatim:** "let's lean toward the leaner injections with no version_ids in injections"
**Status:** settled
**Supersedes:** Decision: Optimistic Concurrency Control (replaces monolithic OCC with hybrid)

## Revision: show_related Default
**Phase:** Phase 9 — Design Review
**Category:** revision
**Revised:** show_related changes from opt-in to default-on (server-side default with sensible threshold). Opt-OUT available via skip_related parameter.
**Rationale:** Both reviewers found show_related valuable. Context burn is minimal. Opt-in parameters that require per-call decisions are consistently underused by LLMs. Default-on with opt-out is more effective.
**User verbatim:** "if there is consensus that defaulting to show_related=true then we can adjust to that, the context burn is minimal and if they all find it useful then we can turn it on"
**Status:** settled
**Supersedes:** Decision: Tag-Overlap Relatedness via show_related Threshold (changes default behavior from opt-in to default-on)

## Revision: Promotion — Dumb Capture, Smart Digest
**Phase:** Phase 9 — Design Review
**Category:** revision
**Revised:** Inline promote_to_memory is no longer the primary journal-to-memory mechanism. Replaced with a four-layer "Dumb Capture, Smart Digest" model:
1. **Capture (during work):** write_journal(content, tags). Dead simple. No promotion decisions. Working Claude is a journalist — capture what happened, what was decided, what the user said.
2. **Critical escape hatch:** write_journal(content, tags, critical: true, memory_summary: "..."). memory_summary REQUIRED when critical: true. Circuit-breaker governed (~max 3 per session). "Critical" verbiage intentionally discourages casual use. Server creates both journal entry and memory entry atomically. Journal entry auto-marked digested_at to prevent duplicate promotion by digest.
3. **Solo digest (teammate-driven):** Dedicated subagent auto-spawned at: (a) entry count threshold (configurable, default ~15-20 undigested), (b) time-based threshold (no digest in X hours of active use), (c) session-end hook. Teammate reads undigested journal entries + existing memories + tag vocabulary. Performs many-to-one synthesis: multiple journal entries condensed into efficient memories. Also handles cleanup — retires contradicted/duplicate/stale memories during the same pass.
4. **Supervisor digest (multi-agent):** Supervisor periodically reviews undigested entries across worker journals. Same synthesis + cleanup, but at the team/project level. ~80% reliable as existing design.
**promote_to_memory** kept as explicit tool for edge cases, not primary path.
**Schema additions:** Per-entry digested_at TIMESTAMP on journal_entries table. Junction table memory_journal_provenance(memory_id, journal_id) for provenance tracking. Critical entries set digested_at in same transaction to prevent digest-teammate duplication.
**Scaling pattern (user's addition):** For large-graph situations, multiple digest teammates can be spawned per tag type (e.g., one for #frontend, one for #backend), with a coordinator teammate handling cross-tag linking. Narrows each teammate's scope for more focused synthesis.
**Rationale:** Claude reviewer's honest self-assessment: inline promotion requires a 5-step meta-cognitive process that competes with the user's actual task, achieving ~55-65% reliability at best. User's additional constraints: (1) memory should be condensed from multiple journal entries (many-to-one synthesis), which inline promotion fundamentally cannot do; (2) don't expose the dual-layer model to the working Claude instance. The solution: separate capture from synthesis into different agent roles. Working Claude captures with full attention on user's task. Digest Claude synthesizes with full attention on knowledge quality. Neither is degraded by doing the other's job.
**User verbatim:** "I also like the idea of condensing/combining journal entries into more efficient memories, which the post-review is critical for" and "I also have the concern about exposing the dual-layer memory model to the Claude instance too much" and "I think a simpler approach for a solo-model is to have a teammate perform the review in-place of the supervisor" and "I'm wondering if we have a #critical option for the write that instantly promotes to memory"
**Implementation notes:** Digest teammate prompt should be a first-class configurable template (like entry templates), not an implementation detail. Digest teammate needs a dedicated maintenance key with "read all, retire any, write new" permissions (extends permission model).
**Status:** settled
**Supersedes:** Decision: Inline Promotion + Supervisor Digest (replaces inline-primary with digest-primary)

## Revision: Data Lifecycle — Minimum Viable Lifecycle
**Phase:** Phase 9 — Design Review
**Category:** revision (overrides Phase 3 rejection of TTL/lifecycle)
**Revised:** The original rejection of entry lifecycle/TTL is overridden. A minimum viable lifecycle is added with the philosophy: "Disk space is cheap; context window tokens are expensive." Goal is preventing context poisoning, not saving disk space.
**Must-haves:**
- **retire_memory(entry_id, reason?)** — single tool (not separate delete + archive). Server handles soft/hard delete internally via archived_at timestamp. Removes from injection and search. reason field optional but valuable for audit.
- **Digest teammate absorbs cleanup** — during synthesis pass, also identifies and retires contradicted/duplicate/stale memories. Primary cleanup mechanism (~80% reliability).
- **Handoff TTL** — 24h default (configurable). expires_at column on handoffs table. Filtered at read time: WHERE expires_at > datetime('now'). Server-side, no tool needed.
**Should-haves:**
- **supersedes auto-retires** — when memory B is created with supersedes: A, A is automatically archived at DB level. Supersedes link becomes provenance, not just metadata.
- **Journal tiering** — entries with digested_at set are excluded from L2 injection and rolling reads, but remain searchable with explicit date-range queries. Transition is automatic.
- **Active tags VIEW** — SQL view filtering tags from non-archived entries only.
**Explicitly NOT needed:** Journal deletion/pruning (disk is cheap, provenance is priceless). Memory TTL/auto-expiry (memories don't have natural shelf life — cleanup must be intelligence-driven). Separate delete + archive tools (one tool, server decides). Aggressive VACUUM (auto_vacuum + WAL checkpointing sufficient).
**Schema additions:** archived_at TIMESTAMP on memory table. expires_at DATETIME on handoffs table. active_tags VIEW. All default queries append WHERE archived_at IS NULL.
**Rationale:** Both reviewers independently flagged unbounded data growth as critical. Memories can be created/updated but never removed — stale memories pollute injection and search over time. The original rejection of lifecycle ("manual cleanup sufficient") doesn't account for LLM behavioral reality: Claude won't proactively hunt for stale data (~15-20% reliability), but will reactively clean up when encountering contradictions (~70%). The digest teammate provides the primary mechanism (~80%).
**User verbatim:** (User approved the approach as presented)
**Status:** settled
**Supersedes:** Vision Expansion rejected item "Entry lifecycle / TTL"

## Notes for Arranger: Items from Final Review
**Phase:** Phase 9 — Design Review
**Category:** implementation notes
**The following items were identified during final review and should be addressed during implementation planning:**
1. **Maintenance key for digest teammate** — Digest teammate needs cross-scope permissions to retire entries it didn't create. Add a maintenance key concept to the permission model with "read all, retire any, write new" scope. (Claude reviewer: 🟡 Significant)
2. **Tag similarity suggestions** — Server response includes similar existing tags when submitted tags are close but don't match. Zero-friction normalization. (Claude reviewer: 🟢 Minor)
3. **Tool consolidation** — Search tools could consolidate to single search(entry_class?, tags?, query?). Read tools to single read(entry_id) with server-side type detection. Also add list_handoffs tool. Reduces tool count ~28 to ~20. Flag for implementation decision. (Claude reviewer: 🟡 Significant)
4. **Digest teammate prompt as first-class artifact** — Configurable template shipped with system, heavily commented golden default. (Claude reviewer: 🟡 Significant)
5. **Hook timeouts** — All hook curl commands must include --max-time 2 to prevent hangs. (Gemini: HIGH)
6. **Socket garbage collection** — On startup, glob for aletheia-*.sock, parse PID from filename, kill -0 to check liveness, delete orphaned sockets. (Gemini: HIGH)
7. **Transaction discipline** — Never hold SQLite write locks during LLM generation. Read → release → think → begin transaction → write → commit. (Gemini: HIGH)
8. **Digest teammate OCC interaction** — In multi-agent mode, digest teammate should use OCC and handle state-forwarding errors, even if working agent has solo bypass. Prevents race between critical escape hatch and concurrent digest. (Gemini: MEDIUM)
9. **Startup injection quality** — First-session UX depends on startup hook content. 3-5 lines, concrete examples, no abstraction. (Claude reviewer: 🟢 Minor)
**Status:** noted for Arranger
