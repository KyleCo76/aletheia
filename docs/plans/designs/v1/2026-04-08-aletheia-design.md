# Aletheia — Design Document

## Goals

Aletheia is a complete, self-contained memory system for Claude Code that replaces the built-in memory with a structured, searchable, permission-aware, multi-session knowledge base. The name comes from the Greek *a-lethe-ia* — literally "un-forgetting" — the etymological opposite of Lethe, the user's existing session compaction skill. Together they form a memory lifecycle: Lethe forgets from the conversation window, Aletheia un-forgets into persistent storage.

The user wants a memory system that goes far beyond flat text injected every prompt. They envision a RAG-like knowledge base for AI agents — project details, history, user profiles, implementation approaches, all documented, tagged, and searchable. The system must support multi-agent hierarchies (CEO, PM, TL, Workers operating in tmux sessions) where teammates share memory on a single task, project-level memories are distilled to all members, and fresh workers inherit predecessors' context. It must equally support a solo developer who just wants persistent memory with zero setup.

The built-in Claude Code memory is line-limited, unstructured, has no history, gets injected every prompt with no control, and cannot be shared across sessions. Status files vary in quality across projects. There is no system-built journal for capturing user feedback, decisions, and values as a persistent reference. Long-running autonomous sessions need richer memory with control over what gets injected, when, and how often.

Aletheia is designed to be universal — it must work on a fresh system with zero assumptions about existing tools, OS configuration, or other MCP servers. It is built for sharing with other users on completely different setups.

---

## 1. Architecture & Data Layer

Aletheia uses a **dual-interface architecture**. The MCP server runs as a child process of Claude Code, communicating via stdio for tool calls. Simultaneously, it runs a Unix domain socket sidecar for hooks and CLI access. The SQLite database is owned exclusively by the MCP server process — no other process touches the database file directly.

### Data Store

- SQLite in WAL mode, single-process-owned
- Connection PRAGMAs: `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`, `temp_store=MEMORY`, `cache_size=-20000` (20MB), `wal_autocheckpoint=1000`
- Content stored as plain text in SQLite columns; metadata (tags, permissions, timestamps) in relational tables
- History tracked via diff-based storage internally; full snapshots rendered when Claude queries previous versions
- Schema designed for future knowledge graph extension — an `entry_links` table can be added later without migration

### Sidecar

- Unix domain socket at a deterministic path: `~/.aletheia/sockets/<hash>.sock` (hash derived from database path or session config)
- Hooks query the sidecar via socket instead of reading SQLite directly — eliminates all WAL cross-process visibility issues by design
- Cross-platform: Unix domain sockets supported on Linux, macOS, and Windows 10+ via Node.js. Windows support is best-effort; explicitly acceptable to drop if issues surface.
- Socket files cleaned up on process exit; stale sockets detected and replaced on startup

### Data Formats

- **Claude writes (tool inputs):** JSON, forced by MCP protocol
- **Claude reads (tool responses):** Micro-XML with short tags (`<sec>`, `<m>`, `<j>`) — structurally bulletproof for Claude's attention mechanism, nearly as token-efficient as Markdown
- **Injection payloads (L1/L2):** Dense YAML-style key-value inside a single XML wrapper — maximum information density for context window
- **Internal storage:** Plain text, optimized for server scalability, not Claude readability
- **Settings file:** TOML at `~/.aletheia/settings.toml` — human-readable, supports comments

### Circuit Breakers

- Configurable thresholds (max tool calls per interval, max entry size) to protect against agent runaway
- Status file operations (add/move/shift sections) are atomic — one tool call counts as one logical write regardless of internal mutations
- Natural multi-step workflows (add memory + demote old to history, full status rework) must not false-positive
- Thresholds are loose and configurable; when tripped, flag for supervisor review with last N memory operations attached — never auto-compaction

### Security

- Database file contains all entry content, tags, and permission keys. File permissions on `~/.aletheia/` must restrict access to the owning user.
- Socket file user-restricted to prevent other system users from querying the sidecar.

---

## 2. Entry Types & Tag System

Aletheia uses a **unified entry model** with behavior differentiated by `entry_class` enum, plus a separate Status type for structured state management. Unified storage enables cross-type search and discovery while separate tool interfaces maintain clear, single-responsibility boundaries for Claude.

### Unified Entries

Single storage table with `entry_class` enum (`"journal"` | `"memory"` | `"handoff"`) set automatically by which tool is called. Tags are purely for topical discovery, never for behavior control.

**Journal** (entry_class: journal) — the long-term record.
- Append-only, immutable after creation. Timestamped.
- Sub-sections supported (e.g., "Initial Build," "Feature 1").
- Open mode (full dump) and rolling mode (tail N entries, configurable default).
- Purpose: persistent record of user feedback, decisions, values, reasoning. What the user and Claude discussed, captured across sessions and compactions.
- Immutability enforced server-side — no edit/delete tools exist for journal entries.

**Memory** (entry_class: memory) — active knowledge.
- Mutable, updatable. Diff-based version history with full snapshots rendered on query.
- Key-value structure with tags.
- Open and rolling retrieval modes.
- Optimistic Concurrency Control: `version_id` required for updates. If stale (another session modified since last read), write fails and returns current state for re-evaluation.
- Purpose: things Claude should know and can revise. Project details, implementation approaches, user preferences.

**Hand-off** (entry_class: handoff) — ephemeral transfer.
- No history tracking. Supports large, rich documents (implementation strategy, current work context, learned points).
- Server-enforced read-once semantics available. Optional target key for directing to a specific recipient.
- Deleted after consumption.
- Purpose: one-shot transfer from supervisor to subordinate.

**Filtered reads:** Despite unified storage, Claude can query by entry_class — "all journal entries" or "all memory entries" as distinct views.

**Supersedes field:** Entries can reference what they replace via a `supersedes` field. Single-level only — no deep chain traversal. Provides minimum viable relationship tracking.

### Journal Digest / Promotion

- **Inline promotion:** `promote_to_memory(journal_id, synthesized_knowledge, tags)` — Claude promotes immediately when it recognizes a journal entry contains permanent knowledge.
- **Supervisor digest:** Periodic backup sweep. Supervisor reviews undigested journal entries and promotes durable insights to project-level or agent-level memory.
- Journal entries retain immutability; promoted content becomes new memory entries with provenance.
- `last_digested_at` watermark identifies undigested entries for review.

### Status (Separate Type)

- Structured Claude-optimized document with named sections. Not part of unified entry storage.
- **Operations:** Read (full or section), replace (full document with OCC), section state-machine operations.
- **State-machine check-ins:** Claude says "task 2 complete" → server moves task out of in-progress, optionally returns next task. Saves context over full read/process/rewrite cycles.
- Full read/replace always available as fallback for major reworks.
- No version history — current snapshot only. **Single undo buffer** (one previous version) protects against botched replaces.
- Section operations are atomic — internal cascading handled as one logical operation for circuit breaker purposes.
- **Temporal framing:** "Status is for information that won't matter tomorrow. Memory is for information that will matter next week."

### Tag System

- Tags stored in many-to-many relational table, not embedded in content.
- Multiple tags per entry: `#frontend`, `#scheduler`, `#bugfix`, etc.
- Automatic project namespace injection via MCP prompt-back — server prompts for project name on first entry creation. Configurable session-ID fallback (disables error prompt, changes to notice, succeeds).
- **Discovery:** `list_tags` returns all tags across accessible entries. `search_by_tags` retrieves matching entries across all or specific types.
- **`show_related`** parameter on read and write operations — opt-in, value is minimum shared tag threshold. `show_related: 1` = broad (1+ shared), higher = stricter. Omitted = no related entries. Server caps at entry's actual tag count.

### Concurrent Write Detection

- Shared entries use OCC with `version_id`. If version doesn't match, write fails and returns current state.
- Failure response includes the other write's tags for relevance assessment.

### Adaptive Injection Frequency

- Base frequency configurable (L1 every ~10, L2 every ~20 PreToolUse calls).
- No change since last injection: single bump to double the interval (20 → 40). Does not continue escalating.
- Change detected (at PostToolUse): reset to base frequency, inject on next PreToolUse.

### Default Templates

- Ship with educational defaults: one heavily commented "golden" template, plus manager, backend-implementation, and UI design templates.
- Users add templates alongside defaults — defaults not editable. Templates optional.

---

## 3. Permission & Key Management

Aletheia uses a **claim-based authentication model** with hierarchical key management. Permissions are fully optional — the system works without them.

### Authentication Flow

- `claim(key)` — called once per session. Server associates the MCP connection with that key for all subsequent calls.
- `whoami` — returns current key, permissions, accessible entries. Recovery mechanism after context compaction.
- Sessions without a claim operate in simple mode (when `enforce_permissions` is off).

### Simple Mode (enforce_permissions = false)

- No keys, no project setup, no hierarchy. Solo developer starts Claude and the server is immediately usable.
- Auto-initialization on first write — server creates a session entry automatically.
- Re-attaches to existing entries based on working directory on subsequent sessions.

### Bootstrap (enforce_permissions = true)

- One-time system-level command: `bootstrap(name, enforce_permissions: true)`. No key required — the only tool call that works without a claim.
- Creates the project, generates the master key, writes to `~/.aletheia/keys/<project>.key`.
- Response directs Claude to inform the user: "Master key saved to `<path>`. Record securely and delete the file."
- **One-shot per project name** — permanently disabled once master key exists. No second master key.
- Recovery for lost master key: change `enforce_permissions` to false, or remove and reinstall.

### Key Model

- Keys grant permission levels: read-only, read-write, create-sub-entries.
- Scoped downward — sub-keys beneath creator's entry. Cannot access sibling or parent entries as read-write.
- Cannot self-promote (prevents escalation).
- **Mutable:** Creator can promote or demote sub-key permissions. Only keys beneath your own level can be modified. Master key can modify anything.
- Sub-key creation requires `create-sub-entries` permission.

### Key Distribution

- Orchestrated sessions: supervisor generates key, passes via `-p` prompt flag when launching teammate.
- Teammate claims on startup, reports key to supervisor.
- `list_keys` — supervisor sees all sub-keys beneath their scope.

### Read-Only Inheritance

- Non-owner sessions get read-only access to shared entries by default.
- Only the entry's creator can write.
- PMs manage project-level memory; TLs manage team-level; workers get read-write on shared task entries if key grants it.

### Security

- Master key never output to TUI — only written to file, user records and deletes.
- Keys passed via `-p` prompt, not stored in shared working directories.
- Unclaimed sessions with `enforce_permissions = true` get concise error: `<error code="NO_CLAIM">Use claim(key) to authenticate</error>`.

---

## 4. Hook System

Five bundled hooks, all configurable and individually disableable. Hooks are the primary enforcement layer — they don't rely on Claude choosing to follow instructions.

### Hook 1: Startup Injection (first PreToolUse or UserPromptSubmit)

- Queries sidecar for session state.
- **Orchestrated session** (key via `-p`): prompts Claude to claim.
- **Simple mode, existing entry**: auto-claims for cwd, injects L1 context.
- **Simple mode, no entry**: injects "Aletheia available. Memory will auto-initialize on first use."
- **Enforce permissions, no key**: injects authentication instructions.
- Runs memory overlap detection: reads built-in MEMORY.md, notifies of overlapping usage.
- Includes brief description of capabilities and recommends tag-based search.

### Hook 2: L1 Immediate-Scope (every ~10 PreToolUse, configurable)

- Dense YAML-in-XML format.
- Content: Status file (full), active memory entries tagged with current task, unconsumed handoffs.
- Small, targeted payload — what Claude needs right now.

### Hook 3: L2 Broad-Scope (every ~20 PreToolUse, configurable)

- Content: all accessible memory entries, recent journal entries (rolling), tag list for discovery.
- Larger payload — the big picture reminder.

### Adaptive Frequency

- No change since last injection: single bump to double interval (20 → 40). Not escalating.
- Change detected (PostToolUse): reset to base, inject on next PreToolUse.
- Token budget per injection payload (configurable max). Exceeding budget: prioritize by recency and access frequency.
- Content-hash change detection: matching hash = skip or inject brief "memory unchanged" marker.

### Hook 4: Memory Interception (PreToolUse matching Write/Edit to MEMORY.md)

- `DISABLE_SYSTEM_MEMORY = true`: block write, mirror content to Aletheia, alert session.
- `DISABLE_SYSTEM_MEMORY = false`: allow write, alert session to consider Aletheia.
- Only matches exact MEMORY.md path — does not broadly intercept Write/Edit.

### Hook 5: Memory Overlap Detection (startup, combined with Hook 1)

- Reads built-in MEMORY.md. If content exists: notifies, recommends clearing or migrating.

### Configuration

- All hooks in `~/.aletheia/settings.toml`.
- PreToolUse default, UserPromptSubmit as alternative.
- Intervals adjustable, hooks individually disableable.

---

## 5. MCP Tool Interface

Tools organized into functional groups. JSON inputs, Micro-XML responses. Deferred tool loading keeps system prompt lean.

### Authentication & Setup
- `claim(key)` — authenticate session
- `whoami` — current key, permissions, entries
- `bootstrap(name, enforce_permissions)` — one-time system init
- `create_key(permissions, entry_id)` — create sub-key
- `modify_key(key_id, permissions)` — promote/demote
- `list_keys` — sub-keys beneath caller's scope

### Journal (append-only)
- `write_journal(entry_id, content, tags, show_related?)`
- `read_journal(entry_id, mode?, limit?, show_related?)`
- `search_journal(entry_id?, tags?, query?)`
- `promote_to_memory(journal_id, synthesized_knowledge, tags)`

### Memory (mutable, OCC)
- `write_memory(entry_id, key, value, tags, version_id?, show_related?)`
- `read_memory(entry_id, key?, show_related?)`
- `search_memory(entry_id?, tags?, query?)`

### Hand-off (ephemeral)
- `create_handoff(entry_id, content, tags, target_key?)`
- `read_handoff(handoff_id)`
- `delete_handoff(handoff_id)`

### Status (structured document)
- `read_status(entry_id, section_id?)`
- `replace_status(entry_id, content, version_id)` — OCC + single undo buffer
- `update_status(entry_id, section_id, state?, continue?)` — state-machine check-in
- `add_section(entry_id, section_id, content, position?)`
- `remove_section(entry_id, section_id)`

### Entry Management
- `create_entry(entry_class, tags, content?, template?)`
- `list_entries(entry_class?, tags?)`

### Discovery
- `list_tags(entry_class?)`
- `search_by_tags(tags, entry_class?, show_related?)`

### System
- `help(topic?)`
- `health` — permission-scoped metrics

### Cross-Cutting

**`show_related`:** Opt-in on read/write. Value = minimum shared tag threshold. Omitted = none. Server caps at entry's tag count.

**Errors:** `<error code="CODE">one-line message</error>`. No stack traces.

**Prompt-back:** First entry under new project namespace prompts for project name. Session-ID fallback configurable.

**Tool descriptions** include temporal framing for Status vs Memory distinction.

---

## 6. Package & Distribution

### Installation

```bash
npm install -g aletheia
aletheia setup        # Sensible defaults
aletheia setup -i     # Interactive guided configuration
```

### Setup Creates

1. Registers MCP server in Claude Code config
2. Registers all five hooks
3. Creates `~/.aletheia/` (settings.toml, sockets/, keys/, data/, templates/)
4. Generates default settings
5. Installs default entry templates

### Settings (`~/.aletheia/settings.toml`)

```toml
[permissions]
enforce = false

[injection]
trigger = "PreToolUse"
l1_interval = 10
l2_interval = 20
history_reminders = true
token_budget = 1500

[memory]
disable_system_memory = false
rolling_default = 50

[hooks]
startup = true
l1_injection = true
l2_injection = true
memory_interception = true
overlap_detection = true
```

### Cross-Platform

- Linux, macOS: fully supported
- Windows 10+: best-effort (Unix domain sockets via Node.js). Acceptable to drop.

### Uninstall

- `aletheia teardown` — removes registrations, optionally removes data
- `npm uninstall -g aletheia`

---

## Arranger Notes

### New Protocols / Unimplemented Patterns
- Unix domain socket sidecar running alongside MCP stdio — dual-interface pattern not common in existing MCP servers. See journal: Research: SQLite WAL Cross-Process Visibility.
- Optimistic Concurrency Control via version_id on shared entry writes. See journal: Decision: Optimistic Concurrency Control.
- Adaptive injection frequency with single-bump doubling and content-hash change detection. See journal: Decision: Hook System Architecture.
- State-machine status operations (task completion with auto-advance). See journal: Decision: Entry Type Structure.

### Open Questions
- Exact default template structures (golden, manager, backend, UI) — flagged as implementation detail
- Unix domain socket support on Windows 10+ with Node.js needs verification before committing to cross-platform. See journal: Research: SQLite WAL Cross-Process Visibility (Arranger note: PARTIAL)
- Specific SQLite schema design (table structure, indexes, migration strategy) — deferred to implementation
- Hook script implementation details (bash/zsh compatibility, fish shell support)

### Key Design Decisions
- Unified storage with separate tool interfaces — the core architectural synthesis. See journal: Decision: Unified Storage with Separate Tool Interfaces.
- Sidecar over direct SQLite access from hooks. See journal: Research: SQLite WAL Cross-Process Visibility.
- Claim-based authentication with master key file-based delivery. See journal: Decision: Project Bootstrap and Master Key Security.
- Tags for discovery only, entry_class enum for behavior. See journal: Decision: Unified Storage with Separate Tool Interfaces.
- Circuit breakers flag for supervisor review, never auto-compaction. See journal: Decision: Circuit Breakers with Supervisor Review.
