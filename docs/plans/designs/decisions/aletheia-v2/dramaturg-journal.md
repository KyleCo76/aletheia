# Dramaturg Decision Journal — Aletheia V2

**Topic:** `aletheia-v2` — evolution of Aletheia V1 with targeted deltas (L1/L2 relevance filtering, SDK-based digest, scope-leak fix, reclaim-on-resume, mass-ingest mode, knowledge graph, version migration, first-upgrade KG bootstrap).
**Design doc target:** `kyle-projects/aletheia/docs/plans/designs/2026-04-17-aletheia-v2-design.md`
**V1 reference journal:** `kyle-projects/aletheia/aletheia-dramaturg-journal.md` — canonical for V1 architecture decisions that V2 inherits and does not re-litigate.
**Session mode:** Interactive solo CC session (not comms-link — `~/.ElevatedStage/dramaturg.txt` flag ignored per spawn prompt).

---

## Note: Prior Aborted Stub (2026-04-16)

A prior Dramaturg session on 2026-04-16 created a setup stub in this location before being aborted without producing any checkpoint-triggered journal entries. That stub used a "full rebuild" framing that was later pivoted during the 2026-04-17 session (Kyle clarified V2 is evolution, not clean slate, after Dramaturg pushback that V1 is already a properly registered MCP server). This journal supersedes that stub in full.

---

## Vision Baseline
**Phase:** Phase 2 — Vision Loop

**What:** Aletheia V2 — an **evolution** of V1, not a greenfield rebuild. V1's core architecture (SQLite + socket-based dual-interface + unified storage with `entry_class` enum + claim-based auth + L1/L2 PreToolUse hooks + Dumb-Capture-Smart-Digest + `retire_memory` lifecycle) remains canonical. V2 extends V1 with the following targeted deltas:

- **SDK-based digest / synthesis agents** replacing tmux-spawned teammate sessions. Feature-wrap-up and feature-init SDK hooks become first-class lifecycle events.
- **L1/L2 relevance tagging** — injection is filtered by project/role tags so memories from inactive projects don't pollute current working context (e.g., Hermes memories don't inject during Hockey work).
- **Reclaim-on-resume** — `claude --resume` picks up the prior Aletheia claim automatically via session-ID association. Fresh or corrupted session IDs must still be able to re-claim explicitly.
- **Mass-ingest mode** with supervisor approval — bypass rate limits for first-session ingestion, bulk edits, and KG bootstrap operations.
- **Scope isolation fix** — `search` must honor the caller's `entry_scope` (from cross-scope leak bug report 2026-04-14).
- **Knowledge graph layer** — relational structure for entries enabling richer relatedness than V1's tag-overlap alone. Kyle flagged this as *"may warrant separate Dramaturg session for complexity/scope"* — decision deferred to Phase 5 based on scope signals.
- **Version-upgrade migration framework** — existing entries survive schema/behavior changes via a tested declarative migration path.
- **First-upgrade KG bootstrap** — one-time (or rare) operation processing the existing entry corpus through the SDK-based KG builder. May be subsumed under mass-ingest mode or modeled as its own command (Phase 5 decision).
- **Configuration surface retained** — V1's existing config options remain; additions as V2 requires.

**Why (user verbatim):**
- *"problem of many, many entries stacking up and becoming more of a chore to use than a helpful system"*
- *"CEO will have memories from multiple projects, and Hermes memories may only be needed for Hermes tasks. When Aletheia and Hockey are the only in-flight projects, Hermes memories should not get injected"*
- *"if a session needs to do first ingestion or a mass edit, it currently hits the rate limit, this must be override able with a supervisor approval"*
- Scope-leak bug report: *"A PM can read journal entries from other PMs and the CEO. In a multi-project system, this breaks the isolation model"*
- *"Must be able to reclaim Aletheia on resume. Session-ID related possibly so --resume will also reclaim Aletheia right away but a fresh(new) session ID would need to reclaim (must still be supported, if CEO session id is corrupted new session must be able to re-claim)"*
- *"I imagine that on first upgrade with the new knowledge graph and SDK approach, I will need to run an init with existing data to allow a knowledge graph to be built from a large set of existing entries"*
- *"Existing entries must be kept in place/migrated on version upgrades"*

**How used:**
- V1 foundational patterns continue: claim-on-startup, hook-driven L1/L2 injection, digest passes, `retire_memory`.
- CEO switches project context → L1/L2 filters by project tag automatically; inactive-project memories don't inject.
- `claude --resume` picks up Aletheia claim immediately — no re-claim friction. Fresh sessions can still explicitly re-claim.
- First-session ingestion or bulk migration → request supervisor approval → mass-ingest bypass activates, rate-limit override in effect for the duration.
- Feature boundary events trigger SDK-driven memory lifecycle: wrap-up archives feature-specific entries into a more archived state; init stages relevant memories for the incoming feature's scope.
- Digest / synthesis runs as SDK subprocess rather than spawned tmux teammate — cheaper, deterministic, fewer moving parts.
- First V2 deployment on existing data: KG bootstrap runs → existing corpus becomes graph-enriched without destructive migration; entries remain in place.

**User verbatim (scope clarification during session):**
- Initially framed: *"I am viewing this as a full re-build of Aletheia, we can certainly migrate work from V1, but I don't want to be constrained by the existing infrastructure, it is merely there for reference"*
- After Dramaturg pushback noting V1 is already a registered MCP server (misconception driven by Hermes's mcp-migration generating slash commands — Aletheia has none and correctly shouldn't since MCP tools ≠ slash commands): *"If Aletheia is already a proper mcp with deferred tools than we can ignore the point(s) regarding the full-rebuild/mcp change/etc."*
- V2 scope finalized as evolution + targeted deltas. V1 journal remains canonical for foundational decisions.

**User confirmed:** yes — implicit via *"That looks good with one other point…"* after Dramaturg synthesis was presented and user added version-upgrade migration + first-upgrade KG bootstrap to the delta list.

**Research during vision:** None yet. User requested `#step1` Gemini 3-stage brainstorm (popular memory systems inventory → comparative analysis → vision-contextualized ideation) — queued for Phase 3 Vision Expansion. Staged specifically to surface anti-patterns that single-shot brainstorms miss.

**Status:** settled

---

## Vision Expansion
**Phase:** Phase 3 — Vision Expansion

**Sources:** Dramaturg ideation + Gemini 3-stage staged brainstorm (search → synthesis → brainstorm), with Kyle adjudicating at each stage boundary.

**Research via staged brainstorm (consolidated Research entry for the 3-stage pipeline):**
- **Stage 1** (`gemini-search`): Inventory of ~30 memory systems across 7 categories — LLM-agent memory libs, GraphRAG, MCP servers, RAG frameworks, tiered architectures, personal KB systems, CC-specific tooling.
- **Stage 2** (`gemini-query` pro / high reasoning): Comparative synthesis + anti-pattern catalog (7 patterns — V1 architecture already dodges 5) + adopt-vs-build scoring against 16-item V2 requirements checklist.
  - **Verdict: BUILD.** Top candidate (Zep) = 11/32; average ~8/32. No existing system combines V2's three disjoint problem spaces (multi-agent hierarchy + MCP-native + temporal-aware KG semantics).
- **Stage 3** (`gemini-brainstorm` maxRounds=4): Vision-contextualized brainstorm. Consensus 9/10. Major architectural refinements surfaced: ATTACH DATABASE partitioning proposal, threshold-gated Top-K, SDK digest orchestration contract, risk mitigations for session-ID reclaim + mass-ingest UX + KG-bootstrap races + migration with in-flight sessions.
- **Arranger note:** VERIFIED — 3-stage Gemini pipeline, Stage 1 grounded via `gemini-search`.

**Scope framing update during this phase (user-introduced):**
Kyle announced V2 will not be built or released — implementation jumps V1 → V3 (or is renamed appropriately). V2's output is architectural reference for (a) the subsequent KG Dramaturg session and (b) eventual V3 implementation. Consequence: V2 deliberately avoids over-specifying items that KG will revise; frame-and-hand-off instead of deep-design for KG-adjacent topics.

**Accepted enrichments (carried forward into V2 design + V3 inheritance):**
- **ATTACH DATABASE scope partitioning** — separate `.db` per scope; readonly-attach for inheritance. If a DB isn't attached, it cannot be queried — closes the scope-leak bug's failure class. (Gemini Stage 3 refinement over original `namespace_id` filter proposal.)
- **Temporal validity columns** on entries — `valid_from`, `valid_to` (NULL = currently valid). Supersedes auto-updates `valid_to`. Queries auto-append `AND (valid_to IS NULL OR valid_to > CURRENT_TIMESTAMP)`. (Graphiti principle.)
- **SDK digest orchestration** — MCP server spawns detached child process (Node), tracks PID, heartbeat + lease-lock coordination. Replaces V1's tmux teammate cleanly. (V1's isolation preserved; tmux dependency dropped.)
- **Threshold-gated Top-K relevance** with configurable per-hook threshold (L1 stricter, L2 looser). Specific scoring function deferred to KG session. (Gemini refinement + Dramaturg addition.)
- **`content_hash` deduplication at MCP tool boundary** — `INSERT OR IGNORE` on hash of content + scope_id. (Cognee principle.)
- **Reasoning-trace field** (`internal_monologue` / `reasoning_trace`) on journal entries — optional, budget-aware L1 injection can use it. (TiM principle.)
- **Filesystem / cwd → scope auto-binding** as default; explicit `set_override_context` tool for override. (Serena principle + Dramaturg hybrid.)
- **OS-alert for budget pressure** via MCP notifications when L2 payload approaches 85–90% of token budget. (Letta principle.)
- **Session-ID reclaim with heartbeat TTL** — `session_locks` table; 15–30s heartbeat; second concurrent claim throws fatal MCP error.
- **Mass-ingest approval via status-document polling** — supervisor sets `approved: true` flag on a designated status doc; server polls. No new tool needed.
- **Paused-rollover migration** with OS-alert during global write-lock.
- **Explicit `feature_init` / `feature_wrap_up` tool calls** — not inferred from git events or activity heuristics (false-trigger risk).
- **Tool deprecation lifecycle** — `deprecated: true` MCP flag + forward-migration instruction strings. Essential for V1 → V3 transition UX.
- **System audit trail** (`sys_audit_log`) — immutable log of auth token issuance, privilege changes, scope transitions.
- **Tombstoning + `query_past_state`** — never DELETE; combined with temporal columns enables time-travel debugging at near-zero marginal cost.
- **Shadow Mode Testing** — hidden tool piping same context through V1 and V3 ranking logic, logging diffs for tuning. Scoped to early V3 rollout.
- **Digest crash recovery via lease-lock** — `digest_lock` with TTL; expires → next trigger retries.
- **KG bootstrap snapshot isolation** (if / when KG lands) — bootstrap operates against timestamped snapshot; delta writes queued in `kg_pending_edges`.

**Rejected:**
- Automatic entity resolution / tag merging — V3 with KG, not V2.
- Always-on injection without relevance gating — already prevented by threshold-gated Top-K.
- Inferred feature-boundary triggers (git-branch events, activity heuristics) — too risky for false triggers during exploratory work.
- Configurable tag behavior — tags remain discovery-only per V1 decision.
- Application-layer read-permission overlays for scope (namespace_id + filter approach) — superseded by ATTACH DATABASE model which is mathematically stronger.

**Deferred to future KG Dramaturg session:**
- Knowledge graph layer (schema, traversal, edges, entity model)
- First-upgrade bootstrap approach (likely absorbs tag-rationalization — KG session decides)
- L1/L2 relevance scoring function (framework locked in V2; algorithm awaits graph signal)
- Multi-hop / transitive relatedness queries
- Entity resolution / tag merging
- `show_related` semantic evolution with graph signal available
- V1 → V3 migration design (since V2 doesn't ship, actual migration spans V1's schema to V3's combined V2+KG schema)
- Handoff research document authored: `docs/plans/designs/decisions/aletheia-v2/knowledge-graph-research-handoff.md`

**Vision Baseline updated:** yes. Original Vision Baseline listed KG as a V2 delta (#6). Per Kyle's 2026-04-17 decision, KG is deferred to a subsequent Dramaturg session. V2 vision refined to: scope-fix + L1/L2 relevance *framework* (not algorithm) + SDK digest orchestration + reclaim-on-resume + mass-ingest + version migration + feature hooks + temporal columns + `sys_audit_log` + tool deprecation lifecycle + `content_hash` dedup + tombstoning + shadow mode.

**V2 implementation framing:** V2 will not be built or released. Implementation jumps V1 → V3 after the KG session completes. V2's artifact is a design document that serves as V3's foundational reference + scoping boundary.

**User confirmed:** yes — Kyle explicitly agreed with all final takes on Gemini's recommendations, approved the two scope additions (tool deprecation lifecycle, sys_audit_log), deferred entity resolution to V3, approved both creative patterns (tombstoning, shadow mode), approved the KG defer, and committed to the design-only (no-build) framing.

**Status:** settled

---

## Topic Map
**Phase:** Phase 4 — Broad Design Scoping

**Areas to explore in Phase 5** (10 topics, split by treatment tier per Vision Expansion framing):

**Full-design topics (9) — V3 inherits directly:**

1. **Scope partitioning implementation (ATTACH DATABASE)** — per-scope `.db` lifecycle, readonly-attach semantics, orphan cleanup, WAL verification. *Foundational:* Topics 2, 3, 4, 6, 8 depend on this partition model.
2. **SDK digest contract** — MCP-server spawn semantics, heartbeat + lease-lock protocol, failure modes (rate limit, auth, crash), dispatch-queue design. Replaces V1's tmux teammate.
3. **Session-ID reclaim & session_locks** — heartbeat cadence, fatal-error semantics on concurrent-claim collision, race protection against dual-terminal resumes.
4. **Migration framework** — paused-rollover flow, OS-alert signaling, in-flight-session protection, V1 → V3 migration path design. *Depends on:* Topics 1, 7, 9.
5. **Feature-wrap-up / feature-init tool semantics** — signatures, state transitions, caller authorization, behavior during each. Brand-new behavior; no precedent in V1 or inventory.
6. **Mass-ingest supervisor approval flow** — status-document shape, poll cadence, rate-limit override scope, approval expiry.
7. **Tool deprecation lifecycle + sys_audit_log** — schema design, `deprecated: true` flagging mechanism, forward-migration strings, audit-record fields + immutability guarantees.
8. **Temporal columns + tombstoning + query_past_state** — schema additions (`valid_from`, `valid_to`), query semantics, retention policy, soft-delete via setting `valid_to`. *Foundational:* supersedes, retirement, and V3's KG edges all use this pattern.
9. **Shadow Mode Testing** — hidden tool shape, diff logging, rollout-scoped activation/deactivation.

**Frame-and-hand-off topic (1) — pattern locked, algorithm deferred to KG Dramaturg session:**

10. **L1/L2 relevance framework** — threshold-gate + Top-K + pluggable scoring interface; active-project determination hybrid (explicit override > status tag > cwd > inferred); explicit hand-off points for V3's graph-proximity contribution.

**Execution order for Phase 5** (foundational first, composite last):
Topic 1 (partitioning) → Topic 8 (temporal) → Topic 2 (SDK digest) → Topic 3 (session_locks) → Topic 7 (deprecation + audit) → Topic 5 (feature tools) → Topic 6 (mass-ingest) → Topic 10 (L1/L2 framework) → Topic 4 (migration) → Topic 9 (shadow mode).

**User confirmed coverage:** yes (2026-04-17)
**Status:** confirmed

---

## Research: SQLite ATTACH DATABASE with WAL Mode Verification
**Phase:** Phase 5 — Approach Loop (Topic 1 — Scope Partitioning)
**Question:** Can V2's per-scope partitioned storage (separate .db file per scope; ATTACH for inheritance) work safely with SQLite WAL mode? Specifically: WAL compatibility, cross-DB data-leak prevention, multi-writer concurrency, attached-DB limits, schema/migration management, per-scope backup.
**Tools used:** `gemini-search` (grounded in official SQLite documentation)
**Findings:**
- **WAL + ATTACH + readonly-URI: fully compatible.** Per-file pagers, separate `-wal` and `-shm` per DB, no cross-file interference.
- **Data leak: physically impossible at SQL level for non-attached DBs.** No filter logic required. Security reduces to "only attach what this claim permits."
- **Multi-writer concurrency:** each .db has its own writer lock → N scopes = N parallel writers. Bypasses V1's single-writer bottleneck — this is a material unforeseen win.
- **Attach limit:** 10 default, 125 hard max (`SQLITE_MAX_ATTACHED`). Practical hierarchies (4-level max seen in the design) are well within defaults.
- **Schema management:** per-DB `PRAGMA <schema>.user_version`; migrations require a direct writable connection per scope .db (attached-readonly connections cannot run DDL).
- **Per-scope backup:** `VACUUM <attached> INTO '<path>'` works independently per DB.
- **Pitfalls:** long-running readers on a parent DB can prevent the parent's WAL checkpoint truncation (not blocking — WAL just grows until the reader releases); cross-DB transaction atomicity is lost on hardware crash (doesn't affect us — we only write to `main`).
**Decision:** Architecture verified on all 8 probed dimensions at high confidence. ATTACH-per-scope is the locked-in partitioning approach.
**Arranger note:** VERIFIED — against official SQLite documentation (sqlite.org/lang_attach.html, sqlite.org/limits.html, sqlite.org/pragma.html, sqlite.org/lang_vacuum.html). The exact MCP / env integration point for reading Claude Code's session ID is the only implementation detail requiring the Arranger's attention.
**Status:** settled
**Supersedes:** —

---

## Decision: Scope Partitioning Architecture
**Phase:** Phase 5 — Approach Loop (Topic 1)
**Category:** decision

**Decided:** V2 partitions scope storage via per-scope SQLite `.db` files under `~/.aletheia/scopes/`, with a global `scope_registry.db` for metadata and auth.

### File layout
- `~/.aletheia/settings.toml`
- `~/.aletheia/scopes/<scope_uuid>.db` — per scope (UUID-based, rename-safe)
- `~/.aletheia/scopes/archived/<scope_uuid>.db` — retired but not purged
- `~/.aletheia/scope_registry.db` — global metadata (scope_id, parent_id, owner_key_hash, display_name, created_at, retired_at, plus `session_bindings` table below)
- `~/.aletheia/sockets/aletheia-<pid>.sock` — per-MCP-server process
- `~/.aletheia/keys/` — master + issued keys
- `~/.aletheia/templates/` — entry templates

### Claim model (revised from V1's single-scope-per-claim)
A key grants a permission set across multiple scopes. Claim resolves to:
- `primary_scope_id` — the key's natural home (where the key was minted)
- `writable_scope_ids` — includes primary; may include shared scopes (e.g., PM's project memory)
- `readonly_scope_ids` — ancestors / explicitly granted read-only access

**Example — PM claim:** `primary=pm_alice_scope` (writable `main`); `writable=[pm_alice_scope, hockey_project_scope]` (project attached writable as `w_hockey`); `readonly=[system_scope]` (attached as `r_system` readonly).

### Attach flow on claim
1. Open `<primary_scope>.db` as `main` (writable, WAL)
2. Additional writable scopes → `ATTACH DATABASE 'file:<path>' AS w_<label>`
3. Readonly ancestors → `ATTACH DATABASE 'file:<path>?mode=ro' AS r_<label>`
4. Write guard: `target_scope ∈ writable_scope_ids` else error

### Write routing
- **Existing-entry writes** → scope inferred from `entry_id` lookup (option B); no explicit param
- **New-entry creation** → `target_scope` param, defaults to primary (option C)
- Write guard rejects writes to scopes outside `writable_scope_ids`

### Server response transparency (safety net)
Every write response includes scope routing in the Micro-XML wrapper:
```
<entry id="..." scope="<scope_name>" scope_alias="main|w_<label>" routing="primary|inferred|explicit"/>
```
- `routing="primary"` — wrote to claim's primary scope (default for new entries with no `target_scope`)
- `routing="inferred"` — scope derived from existing-entry lookup
- `routing="explicit"` — caller passed `target_scope`

Purpose: agents see which scope actually received the write — catches unexpected routing (e.g., new entry without `target_scope` silently landing on primary when the agent thought it was writing to a project scope).

### Scope lifecycle
- `bootstrap(name)` — one-shot per install; creates registry + `system.db`; master key written to `~/.aletheia/keys/`
- `create_key(permissions, parent_scope_id)` — creates child scope .db + registry row; key hash stored
- `retire_scope(scope_id, action)` where `action ∈ {archive, purge, fork}`:
  - `archive` — .db moved to `scopes/archived/`; registry `retired_at=NOW`
  - `purge` — hard delete (master key required; confirmed)
  - `fork` — copy to new scope_id (snapshots / branching)
  - Cascade prevention: cannot retire parent with living children

### Auto-claim on resumed session
Registry table:
```sql
session_bindings (
  session_id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,
  primary_scope_id TEXT NOT NULL,
  claimed_at TIMESTAMP NOT NULL,
  last_heartbeat_at TIMESTAMP NOT NULL
)
```
On connection:
1. MCP server reads `CLAUDE_CODE_SESSION_ID` (exact integration point = Arranger detail)
2. Lookup `session_bindings` → if found and key still valid, **auto-reclaim silently**; inject startup notice: `"Aletheia auto-claimed: scope=<name>, writable=[<list>]"`
3. Else inject normal `"Use claim(key) to authenticate"` notice
4. Any explicit `claim(key)` upserts the binding row with current `session_id`

**Session-ID corruption recovery:** old binding is orphaned (heartbeat GC after ~30 days, configurable). User starts a new session with any new session_id → calls `claim(key)` → new binding created, full access restored. **Scope .db files are never touched by session_id failures.** The key is the persistent identity; session_id is a cache.

### Orphan handling
- Startup: scan `scopes/` for .db files not in registry → log to `sys_audit_log` as orphans; no auto-delete
- Scan registry for scope_ids with missing .db files → log as corruption; surface via `health` tool

### Per-scope migrations
- Each .db has its own `PRAGMA user_version`
- Migration runner iterates registry → opens each scope .db directly writable → applies DDL → bumps version
- Paused-rollover (Topic 4): global flag in registry; active sessions get OS-alert; new claims blocked until complete

### Concurrency model
- `scope_registry.db` — shared writer across MCP server processes (WAL + `busy_timeout`); writes only on claim/create/retire → low contention
- Per-scope .db — one writer per file; N files = N parallel writers; multi-agent parallelism is free

### Cross-scope queries
- Reads iterate `main` + attached schemas via fully-qualified refs (`main.entries`, `anc_1.entries`)
- `include_ancestors` param on read/search tools (default `true`); `false` restricts to own scope

**User verbatim:**
- *"Agree with UUID, though we must retain the ability to re-claim."*
- *"If a session ID is corrupted and unrecoverable, I cannot lose all Aletheia entries because I have to start an entirely new session."*
- *"rely on SQLite's 125 max as long as it doesn't cause any real-world issues, this would be an implementation detail for Arranger."*
- *"Multiple writable scopes. I want PM's to have their own memory as well as a project-memory. The project memory is shared as read-only to TL's."*
- *"approach B as default with approach C for alternate scopes."*
- *"server return that the entry was stored in PRIMARY/TAGGED storage depending on where it is stored, so that Claude can see a no-scope entry was sent to it's own memory rather than a project memory as a safety net."*

**Alternatives discussed:**
- Unified DB + `namespace_id` filter (Dramaturg original proposal, pre-Gemini Stage 3) — rejected; filter-logic failures are the V1 scope-leak bug's failure class
- Slugified display-name file naming — rejected; rename handling + collision risk
- Single-writable-scope-per-session (V1 model) — rejected; doesn't support PM's dual own + project memory
- Scope inference via `cwd` only — rejected; not explicit enough for cross-project CEO sessions
- Option A (explicit `target_scope` required on every write) — rejected; too much agent cognitive burden

**Arranger note:** PARTIAL — the exact MCP / env integration point for reading `CLAUDE_CODE_SESSION_ID` must be verified against the MCP spec + Claude Code's session handshake. Architecture is sound regardless of which integration point is chosen.

**Status:** settled
**Supersedes:** —

---

## Decision: Append-Only Versioning + Temporal Columns + Tombstoning
**Phase:** Phase 5 — Approach Loop (Topic 8)
**Category:** decision (structural — replaces V1's diff-storage)

**Decided:** V2 replaces V1's diff-based in-place storage with **append-only versioned rows**. All entry types (journal, memory, status, handoff) get first-class temporal validity (`valid_from` / `valid_to`). Status uses **section-granular append-only** to preserve V1's section-CRUD semantics without full-doc rewrites on single-task updates.

### Main `entries` schema
```sql
CREATE TABLE entries (
  internal_id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id TEXT NOT NULL,                -- stable user-facing ID (same across versions)
  version INTEGER NOT NULL,              -- 1, 2, 3... within entry_id
  entry_class TEXT NOT NULL,             -- journal | memory | status | handoff
  content TEXT,                          -- for status: container metadata only; section data in status_sections
  content_hash TEXT NOT NULL,            -- Cognee dedup
  tags JSON,

  valid_from TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  valid_to TIMESTAMP,                    -- NULL = current
  invalidation_reason TEXT,              -- see convention table below

  supersedes_entry_id TEXT,              -- single-level supersedes (V1 inherited)
  reasoning_trace TEXT,                  -- TiM principle (optional)
  critical_flag INTEGER DEFAULT 0,       -- V1's #critical escape hatch
  digested_at TIMESTAMP,                 -- journal-only: when absorbed into digest (NULL = undigested, included in L2)

  created_by_key_hash TEXT,              -- audit

  UNIQUE(entry_id, version),
  INDEX idx_entries_entry_id_current (entry_id, valid_to),
  INDEX idx_entries_class_valid (entry_class, valid_to),
  INDEX idx_entries_content_hash (content_hash),
  INDEX idx_entries_digested (entry_class, digested_at) WHERE entry_class = 'journal'
);
```

### Status-specific — section-granular append-only
The `entries` row with `entry_class='status'` carries container metadata (tags, valid_from/valid_to for the WHOLE status). Section data lives in:
```sql
CREATE TABLE status_sections (
  internal_id INTEGER PRIMARY KEY AUTOINCREMENT,
  status_entry_id TEXT NOT NULL,         -- FK to entries.entry_id where entry_class='status'
  section_id TEXT NOT NULL,
  version INTEGER NOT NULL,              -- per (status_entry_id, section_id)
  content TEXT,                          -- NULL when section removed
  state TEXT,                            -- optional state-machine value
  position INTEGER,                      -- ordering within status
  valid_from TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  valid_to TIMESTAMP,
  invalidation_reason TEXT,              -- "updated" | "state_changed" | "removed"
  changed_by_key_hash TEXT,
  UNIQUE(status_entry_id, section_id, version),
  INDEX idx_status_current (status_entry_id, section_id, valid_to)
);
```

### State transitions (entries)
| Event | Effect |
|---|---|
| Create new | INSERT row version=1, valid_from=NOW, valid_to=NULL |
| Update (memory) | INSERT new row version+1, valid_from=NOW; prior row valid_to=NOW, reason="updated" |
| Supersede B → A | Insert A; B.valid_to=NOW, reason="superseded_by:<A.entry_id>" |
| Retire | valid_to=NOW, reason="retired:<user reason>" |
| Digest absorbs journal entry | Set journal's digested_at=NOW (valid_to stays NULL unless retired) |

### Status tool semantics (V1 surface preserved, append-only under the hood)
| Tool | Implementation |
|---|---|
| `update_status(entry_id, section_id, content?/state?)` | INSERT new section version; prior version's valid_to=NOW, reason="updated" or "state_changed" |
| `add_section(entry_id, section_id, content, position?)` | INSERT version=1 for new section |
| `remove_section(entry_id, section_id)` | Current version's valid_to=NOW, reason="removed" (tombstoned) |
| `replace_status(entry_id, content, version_id)` | Transaction: per-section insert/tombstone diff; OCC on container version |
| `read_status(entry_id, section_id?)` | `SELECT FROM status_sections WHERE status_entry_id=? AND valid_to IS NULL ORDER BY position` |

### Query semantics
| Intent | WHERE clause |
|---|---|
| Current state (default) | `valid_to IS NULL` |
| As of time T | `valid_from <= T AND (valid_to IS NULL OR valid_to > T)` |
| Full history of entry | `entry_id = ? ORDER BY version` |

### New MCP tools
- `query_past_state(entry_id, timestamp)` — single row for journal/memory/handoff; joined status_sections state for status
- `query_entry_history(entry_id)` — all versions ordered

### Retention policy
```toml
[retention]
enable = true
default_days = 365           # purge tombstoned/superseded rows after this
# Per-entry-type override (optional):
# status_days = 365
# memory_days = 365
# journal_days = 730
```
- Applies ONLY to rows where `valid_to IS NOT NULL AND valid_to < NOW - retention_days`
- **Active rows (`valid_to IS NULL`) are NEVER purged**
- **Applies uniformly to both `entries` and `status_sections` tables** (per Kyle's explicit clarification)
- Purge runs as a background SDK maintenance task (Topic 2 pipeline)

### `invalidation_reason` conventions (TEXT with convention)
| Reason | Meaning |
|---|---|
| `superseded_by:<entry_id>` | Another entry replaced this |
| `retired:<user reason>` | `retire_memory` called with reason |
| `retired:digest_stale` | Digest judged stale/contradicted during synthesis |
| `updated` | Regular update (memory / status section) |
| `state_changed` | Status section state-machine transition |
| `removed` | Status section deleted |

### Digest interaction
- Reads only active entries (`valid_to IS NULL`)
- May retire stale memories by setting `valid_to` with reason `retired:digest_stale`
- Sets `digested_at` on journal entries absorbed into memory synthesis (journal excluded from future L2 injection and digest passes but remains active for `query_past_state`)
- Tombstoned entries remain accessible via `query_past_state` until retention purge

**User verbatim:**
- *"Yes, ok to replace diff-storage"*
- *"we should add a simple, configurable retention policy with a default to 1 year. This should not apply to active entries, only superseded/tombstoned"*
- *"TEXT with convention is good"*
- *"digest should only act on active entries"*
- *"retain the ability to update tasks in the status entry without re-writing the entire status entry"*
- *"the storage cost concern of a simple database is almost completely irrelevant. We must ensure that the status entries follow the same retention cleanup policy"*

**Alternatives discussed:**
- Keep V1's diff-based version history — rejected; query_past_state + tombstoning + validity windows collectively pressure toward append-only
- Full-doc append for status (every section change writes full-status version) — rejected; Kyle's concern about rewriting whole status on single task updates; defeats V1's section-CRUD guarantee
- Separate `invalidation_kind` enum column — rejected; TEXT with convention simpler and queryable with LIKE/startswith
- No retention (pure infinite append) — rejected; Kyle opted for configurable default 1 year
- Apply retention to active entries — explicitly rejected; only tombstoned/superseded
- Exempt status from retention — explicitly rejected per Kyle's clarification; status sections follow the same retention policy

**Arranger note:** VERIFIED — append-only versioning + section-granular append-only are well-established patterns (event sourcing, SVN per-file history, Datomic). Retention as background maintenance is standard DB hygiene.

**Status:** settled
**Supersedes:** V1 "Hybrid diff storage" decision (from V1 Vision Expansion)

---

## Decision: SDK Digest Contract
**Phase:** Phase 5 — Approach Loop (Topic 2)
**Category:** decision (major — replaces V1 tmux-teammate pattern)

**Decided:** SDK digest replaces V1's tmux-spawned teammate. MCP server is the orchestrator; spawns Claude Code SDK subprocess for synthesis work; uses a shared queue in `scope_registry.db` for dispatch + audit; enforces crash recovery via lease-lock with tiered TTLs; runs in isolated per-cwd workspace to avoid CLAUDE.md and permission collisions.

### Lifecycle overview
1. Trigger fires on MCP server (entry_threshold / time_threshold / session_end / feature_wrap / feature_init / manual / mass_ingest / retention_purge)
2. Dedup check: if pending/leased queue item exists for same `(scope, trigger_class)`, skip with visible `DUPLICATE_QUEUED` response
3. Insert row into `digest_queue`
4. Worker dispatch depends on trigger_type:
   - `retention_purge` → MCP server processes **in-process** (pure SQL DELETE; no LLM)
   - Everything else → spawn SDK subprocess
5. SDK subprocess leases queue item, runs synthesis via Aletheia MCP, commits results, exits
6. Crash recovery: lease TTL expires → next dispatch retries with `retry_count+1`

### `digest_queue` schema (in `scope_registry.db`)
```sql
CREATE TABLE digest_queue (
  queue_id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_id TEXT NOT NULL,
  trigger_type TEXT NOT NULL,                -- entry_threshold | time_threshold | session_end | feature_wrap | feature_init | manual | mass_ingest | retention_purge
  trigger_metadata JSON,                     -- trigger-specific context
  requested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status TEXT NOT NULL DEFAULT 'pending',    -- pending | leased | committed | failed | cancelled
  leased_by_pid INTEGER,
  lease_expires_at TIMESTAMP,
  started_at TIMESTAMP,
  committed_at TIMESTAMP,
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,
  INDEX idx_digest_status_scope (status, scope_id)
);
```

### Lease TTL tiers (configurable)
| Trigger type | Default lease TTL |
|---|---|
| `digest` (normal) | 30 min |
| `feature_wrap` / `feature_init` | 30 min |
| `session_end` | 30 min |
| `mass_ingest` | 3 h |
| `retention_purge` | 15 min (in-process) |

Override per-run via `trigger_metadata.lease_override_minutes`.

### Dedicated digest key per scope
Generated at scope creation. Stored in `<global-data-dir>/keys/digest-<scope_uuid>.key`, perms 0600.

Permissions:
- ✅ Read journal/memory in own scope, read attached ancestors for context
- ✅ Write memory in own scope, retire memory in own scope, update `digested_at` on journal rows
- ❌ Write to ancestor scopes, `create_key`/`modify_key`/`retire_scope`, cross-scope writes

Rotatable via `rotate_digest_key(scope_id)`. All claims logged to `sys_audit_log`.

### Directory layout — global data vs per-cwd runtime

**Global data directory** (V3 install-time decision; V1 precedent `~/.aletheia/`; if plugin-installed, the plugin-provided directory under `~/.claude/plugins/...`):
```
<global-data-dir>/
├── settings.toml
├── scopes/<scope_uuid>.db
├── scopes/archived/
├── scope_registry.db
├── keys/ (master + digest + issued sub-keys)
├── templates/ (user-added; defaults read-only from npm install dir)
└── sockets/aletheia-<pid>.sock
```

**Per-cwd SDK runtime** (`<parent_cwd>/.aletheia/sdk-agent/`):
```
<parent_cwd>/.aletheia/
├── .gitignore                          # single line "*"
└── sdk-agent/
    ├── CLAUDE.md                       # digest agent constitution
    ├── .mcp.json                       # aletheia MCP only
    ├── .claude/
    │   └── settings.local.json         # claudeMdExcludes to suppress parent CLAUDE.md injection
    └── digest-context-<queue_id>.md    # per-run transient; cleaned on commit
```

SDK subprocess launches with:
- `cwd = <parent_cwd>/.aletheia/sdk-agent/`
- `--allowed-tools "mcp__aletheia__*"` — tool surface locked to Aletheia MCP
- Env: `ALETHEIA_DIGEST_QUEUE_ID`, `ALETHEIA_DIGEST_KEY`

**CLAUDE.md walk isolation** — via `claudeMdExcludes` in `sdk-agent/.claude/settings.local.json`. The CC harness honors this setting before Claude runs, so parent-project CLAUDE.md files are not injected into the digest agent's context. **Rejected approach:** a terminator CLAUDE.md at `.aletheia/` root saying "don't walk further" — wrong because CLAUDE.md discovery is harness injection (pre-Claude), not Claude-driven active seek, so Claude-readable instructions don't control harness behavior.

**Collision at `cwd=~`:** if `cwd=~` and global data is at `~/.aletheia/`, then `~/.aletheia/sdk-agent/` coexists with sibling global-data files (`settings.toml`, `scopes/`, etc.). No file-name overlaps; MCP server never reads/writes `sdk-agent/`; SDK subprocess never reads/writes outside `sdk-agent/`. Clean by convention.

### Model selection per trigger type
```toml
[digest.models]
default = "opus"                         # 200k context
mass_ingest = "opus[1m]"                 # 1M context for bulk operations
feature_wrap = "opus"                    # per-run override available
session_end = "opus"
# retention_purge: not applicable (no LLM, in-process)
```

**Rationale for 200k default:** typical digest run is 50-100k tokens (undigested journal + existing memories + reasoning + output). 200k cap prevents runaway usage from rogue agents. Budget pressure at 200k is itself a useful signal that trigger thresholds should fire more often. Mass-ingest and KG bootstrap (V3) need 1M for large corpus processing.

### Failure handling
| Failure | Action |
|---|---|
| Rate limit | Queue item → `failed`; exponential backoff (base 60s, cap 1h) up to `max_retries` |
| Auth expired / invalid digest key | Queue item → `failed`; logged to `sys_audit_log`; manual intervention |
| SDK crash mid-digest | Lease TTL expires; next dispatch re-queues with `retry_count+1` |
| Lease timeout without crash | Same — lease expiry is the watchdog |
| Max retries exceeded | Permanently `failed`; `sys_audit_log` entry |
| OCC conflict on memory write | V1 hybrid OCC state-forwarding error; digest retries with fresh state; counts against retry budget |

### Concurrency model
- **Across scopes:** parallel (different .db files = independent writers per Topic 1)
- **Within a scope:** serialized via lease mechanism (one active lease per scope)
- MCP server fans out: one SDK subprocess per scope needing digest simultaneously

### Visible dedup — system-wide principle

Extends Topic 1's write-routing transparency into a system-wide rule: **the server never silently modifies the agent's intended action; any server-side action that deviates from what the agent requested is reported explicitly.**

| Dedup point | When | Response |
|---|---|---|
| Queue dedup on `dispatch_digest(scope, trigger)` | Existing pending/leased queue item for same `(scope, trigger_class)` | `<error code="DUPLICATE_QUEUED" existing_queue_id="<id>" status="<s>" requested_at="<ts>"/>` |
| Memory dedup via `content_hash` on `write_memory` | Content hash matches existing active memory in same scope | `<duplicate existing_entry_id="<id>" existing_version="<v>" message="Identical content already stored"/>` (informational, not error — dedup is a learning signal: Claude didn't read existing memories) |

**V3 enhancement (deferred to KG session):** dedup response enriched with graph-linked neighbors — `<duplicate existing_entry_id="..." related_entries="[<id>, <id>, ...]"/>`. Captured in KG handoff doc.

**User verbatim:**
- *"Digest key, expiration time needs to be longer than five minutes to allow for multiple long thinking sessions."*
- *"With the SDK actually running as a CLAUDE.md process with its own tool calls and potentially CLAUDE.md file, we need to ensure that this process is launched somewhere it is not going to get conflicted with any existing CLAUDE.md files or anything similar."*
- *"We can launch with '--model opus' instead of '--model opus[1m]' which will limit the model to 200k tokens and prevent any massive usage spike from a rogue agent."*
- *"dedup is useful but should reply with a failure message that states the duplicate memory entry"*
- *"this link will also lead it to the other linked memories then as well"*
- *"~/.claude is CC managed directory and is itself write-protected"*
- *"what exactly is the conflict of the shared ~/.aletheia/ directory, none of the files/directories overlap"*
- *"couldn't we just have a .aletheia/sdk-agent/ to help separate things?"*
- *"there is a way to use the */.claude/settings.local.json to exclude CLAUDE.md files, we should use this, not a separate CLAUDE.md with instructions to not crawl as I believe that is a harness injection, not a Claude active seek"*

**Alternatives discussed:**
- Persistent digest daemon — rejected; on-demand spawn is simpler, SDK startup cost dominated by LLM latency
- SDK reads/writes scope .db files directly — rejected; all data access through Aletheia MCP for auth + transparency
- SDK uses caller's or master key — rejected; dedicated per-scope digest key with narrow permissions is least-privilege
- Global-only digest runtime at `<global-data-dir>/sdk-agent/` — rejected; parent session's cwd permission scope requires per-cwd placement
- Terminator CLAUDE.md to stop harness walk — rejected; CLAUDE.md walk is harness injection, not Claude-driven seek, so Claude-readable instructions don't control harness behavior; `claudeMdExcludes` in `.claude/settings.local.json` is the correct control plane
- 5-minute lease TTL — rejected; too tight for multiple long-thinking turns during digest
- Silent dedup on queue or content — rejected; visible dedup upheld as system-wide transparency principle

**Arranger note:** PARTIAL
- Global data directory location depends on install mechanism (standalone npm vs CC plugin); architecture is location-agnostic
- Exact SDK flags for launching with cwd + tool allowlist + model selection need verification against current Claude Code SDK API
- `claudeMdExcludes` settings.local.json schema needs verification for current CC harness version
- Permission-prompt behavior for SDK subprocess should be empirically validated during V3 implementation

**Status:** settled
**Supersedes:** V1 tmux-spawned teammate digest pattern

---

## Decision: Session Locks & Concurrent-Claim Protection
**Phase:** Phase 5 — Approach Loop (Topic 3)
**Category:** decision

**Decided:** Session-ID concurrent-claim protection via a short-lived `session_locks` table, separate from Topic 1's long-lived `session_bindings`. Heartbeat-based liveness; FATAL error on live-conflict; orphan-recovery on stale heartbeat.

### Schema (in `scope_registry.db`)
```sql
-- Long-lived: credential binding (Topic 1)
CREATE TABLE session_bindings (
  session_id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,
  primary_scope_id TEXT NOT NULL,
  claimed_at TIMESTAMP NOT NULL,
  last_seen_at TIMESTAMP NOT NULL           -- last time any MCP server observed this session (30d GC)
);

-- Short-lived: active-use lock (Topic 3)
CREATE TABLE session_locks (
  session_id TEXT PRIMARY KEY,
  active_pid INTEGER NOT NULL,
  hostname TEXT NOT NULL,                    -- PID alone isn't unique across machines
  claimed_at TIMESTAMP NOT NULL,
  last_heartbeat_at TIMESTAMP NOT NULL,
  FOREIGN KEY(session_id) REFERENCES session_bindings(session_id)
);
```

### Heartbeat protocol
- Cadence: **30s default** (configurable via `[session.heartbeat_seconds]`)
- Stale threshold: **90s default** = 3× cadence (configurable via `[session.stale_threshold_seconds]`)
- MCP server ticks `UPDATE session_locks SET last_heartbeat_at=NOW WHERE session_id=? AND active_pid=<mypid>`
- If UPDATE touches 0 rows (lock was stolen/recovered): log to `sys_audit_log` + warn + exit

### Claim flow with lock protection
1. MCP server starts with `session_id = X`
2. BEGIN transaction on `scope_registry.db`
3. `SELECT * FROM session_locks WHERE session_id = X`
4. Branch:
   - **Exists + fresh heartbeat (<90s):** FATAL — *"Session X already active in PID Y on &lt;hostname&gt; (last heartbeat Ns ago). Refusing to claim."*
   - **Exists + stale heartbeat:** orphan-recover: UPDATE row with new pid/hostname/claimed_at/last_heartbeat_at; log to `sys_audit_log` as `lock_orphan_recovered`
   - **Doesn't exist:** INSERT new row
5. Lookup `session_bindings`; auto-reclaim if match, else await explicit `claim(key)`
6. COMMIT
7. Start heartbeat tick timer

### Dual-terminal resume race
- T1: session_id=X live, heartbeat fresh
- T2: `claude --resume X` → T2's MCP server sees fresh lock → FATAL
- User message: *"Session X already active in PID 12345 on host zen. Launch a new session with `claude`, or terminate the existing one first."*

### Shutdown paths
- **Graceful:** atexit handler → DELETE from `session_locks`; UPDATE `session_bindings.last_seen_at=NOW`
- **Crash:** lock row persists; heartbeat stops; next session orphan-recovers after 90s

### Cross-machine support
`hostname` column supports multi-machine / NFS scenarios. SQLite over NFS with WAL + busy_timeout handles DB-level contention. No special multi-machine code required at design level.

### Audit-log integration
All lock transitions emit `sys_audit_log` entries (Topic 7 schema):
- `lock_acquired` (new row INSERT)
- `lock_orphan_recovered` (stale → new owner)
- `lock_fatal_conflict` (FATAL rejection)
- `heartbeat_stolen` (UPDATE touched 0 rows → another process stole the lock)
- `lock_released` (graceful DELETE)

**User verbatim:**
- *"Agreed, must be separate"*
- *"Those defaults look good with config options"*
- *"Agreed, keep as FATAL error"*
- *"Yes, cheap and good value"*
- *"Agreed, log to sys_audit_log for transparency if nothing else"*

**Alternatives discussed:**
- Unified `session_state` table merging bindings + locks — rejected; different lifecycles (months vs session-duration), merging would force clearing binding on disconnect and lose auto-reclaim
- Non-fatal warning on concurrent claim — rejected; split-brain-writes risk outweighs diagnostic convenience
- Defer `hostname` to V3 — rejected; cheap to include, supports multi-machine naturally
- 60s heartbeat / 180s stale — rejected; 30s/90s better for dead-session detection speed without thrashing the DB

**Arranger note:** VERIFIED — standard distributed-lock-with-heartbeat pattern. Topic 1 establishes session_bindings; Topic 3 layers concurrent-use protection cleanly on top.

**Status:** settled
**Supersedes:** —

---

## Decision: Tool Deprecation Lifecycle + `sys_audit_log`
**Phase:** Phase 5 — Approach Loop (Topic 7)
**Category:** decision

**Decided:** Immutable `sys_audit_log` captures security/lifecycle events across Aletheia. Tool deprecation lifecycle uses a first-class `deprecated` / `removed` state with visible response warnings.

### `sys_audit_log` schema (in `scope_registry.db`)
```sql
CREATE TABLE sys_audit_log (
  audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  event_category TEXT NOT NULL,          -- auth | lock | scope | key | digest | migration | deprecation
  event_type TEXT NOT NULL,              -- specific event within category
  scope_id TEXT,                         -- NULL for system-level events
  actor_key_hash TEXT,                   -- key that caused the event
  subject_key_hash TEXT,                 -- key acted upon (for key mutations)
  pid INTEGER,
  hostname TEXT,
  details JSON,                          -- event-specific structured payload
  INDEX idx_audit_event_at (event_at),
  INDEX idx_audit_scope (scope_id, event_at),
  INDEX idx_audit_category (event_category, event_at)
);
```

### Event catalog (extensible)
| Category | Event types |
|---|---|
| `auth` | `claim`, `whoami`, `auto_reclaim`, `claim_rejected` |
| `lock` | `lock_acquired`, `lock_released`, `lock_orphan_recovered`, `lock_fatal_conflict`, `heartbeat_stolen` |
| `scope` | `scope_created`, `scope_retired`, `scope_archived`, `scope_purged`, `scope_forked` |
| `key` | `key_issued`, `key_modified`, `key_rotated`, `digest_key_created` |
| `digest` | `digest_queued`, `digest_leased`, `digest_committed`, `digest_failed`, `digest_retried` |
| `migration` | `migration_started`, `migration_step_completed`, `migration_completed`, `migration_rollback` |
| `deprecation` | `tool_deprecated_usage`, `tool_removed_usage_attempt` |

### Append-only enforcement (belt-and-suspenders)
- **MCP tool surface:** no `UPDATE` / `DELETE` tools for audit log
- **SQLite trigger:** blocks `UPDATE` / `DELETE` on `sys_audit_log` unless the session is master-key-authenticated running the dedicated `purge_audit_log` tool

### Retention policy (separate from entry retention)
```toml
[audit.retention]
enable = true
default_days = 1825                      # 5 years
# Per-category override available:
# deprecation_days = 365                 # deprecation-usage purgeable faster
```
Manual purge: `purge_audit_log(older_than, master_key)` — master-key-only.

### Visibility
- **Master key:** all events
- **Scope key:** events for `scope_id = own_scope OR scope_id IN readable_ancestors OR scope_id IS NULL` (matches ATTACH read model from Topic 1)
- **Digest key:** events for own scope only (narrower — service account; no ancestor audit visibility)

### Tool deprecation metadata
```typescript
{
  name: "old_tool_name",
  deprecated: true,
  deprecated_since: "v3.0",
  removal_planned_for: "v3.2",
  migration_hint: "Use `new_tool_name` with parameter X instead"
}
```

### Runtime behavior

**On a `deprecated` tool call:**
1. Execute normally (backward compatibility maintained)
2. Response wrapped with deprecation notice:
   ```xml
   <response>...</response>
   <deprecated since="v3.0" removal="v3.2" hint="Use new_tool_name instead"/>
   ```
3. Log `tool_deprecated_usage` event (flood-protected — see dedup below)

**On a `removed` tool call:**
- `<error code="TOOL_REMOVED" since="v3.2" hint="Use new_tool_name instead"/>`
- Log `tool_removed_usage_attempt` event
- Stub retained in tool registry so migration hint is returned rather than generic "unknown tool"

### Flood protection for `tool_deprecated_usage`
**Session-scoped dedup:** one event per `(session_id, tool_name)` per day. Rationale: captures migration progress (which sessions still use which deprecated tools) without flooding the log with repeated calls from a single session.

### Deprecation states
- `active` (default) — normal tool
- `deprecated` — works, emits warning + audit entry
- `removed` — FATAL error with migration hint
- Future: `optional_deletion` (Kyle's note) — evaluated at later versions whether the stub can be fully removed

**User verbatim:**
- *"5yrs is good"*
- *"I'm leaning option a as well, session-scoped dedup"*
- *"Yes"* (to SQLite trigger-level append-only enforcement)
- *"Agreed, narrower scope"* (digest key audit visibility = own scope only)
- *"Agreed, removed state, can be evaluated at later versions for optional deletion."*

**Alternatives discussed:**
- Unified `event_type` without category split — rejected; category speeds indexed queries (e.g., "all auth events in the last hour")
- Per-event counter rows (single row per tool_name per session, incrementing) — rejected; append-only integrity is simpler than mutable counter rows
- Every deprecation-usage call logged — rejected; floods the log for tight loops
- Generic "unknown tool" on removed tools — rejected; loses migration UX
- Shared retention with entries — rejected; audit forensics need longer lifetime

**Arranger note:** VERIFIED — audit-log as append-only event store + tool deprecation via metadata are standard patterns (database migration tooling, OS package managers, deprecated API frameworks).

**Status:** settled
**Supersedes:** —

---

## Decision: Feature Lifecycle Tools & State Machine
**Phase:** Phase 5 — Approach Loop (Topic 5)
**Category:** decision (novel V2 — no V1 or inventory precedent)

**Decided:** Features are a first-class lifecycle concept in V2, modeled as a metadata layer on top of the existing entry model (no new entry_class). Features have explicit state transitions — `active`, `tabled`, `wrapped_up`, `abandoned` — managed by dedicated tools.

### Schema

Per-scope .db:
```sql
CREATE TABLE features (
  feature_id TEXT PRIMARY KEY,              -- UUID
  name TEXT NOT NULL,                       -- human-readable
  description TEXT,
  state TEXT NOT NULL,                      -- 'active' | 'tabled' | 'wrapped_up' | 'abandoned'
  initiated_at TIMESTAMP NOT NULL,
  tabled_at TIMESTAMP,
  wrapped_at TIMESTAMP,
  abandoned_at TIMESTAMP,
  abandonment_reason TEXT,
  initiated_by_key_hash TEXT,
  last_tabled_by_key_hash TEXT,             -- surfaced in cross-session resume notice
  last_tabled_by_session_id TEXT,
  wrapped_by_key_hash TEXT,
  feature_tags JSON,
  metadata JSON,
  UNIQUE(name)                              -- name unique within scope
);

ALTER TABLE entries ADD COLUMN feature_id TEXT REFERENCES features(feature_id);
CREATE INDEX idx_entries_feature ON entries(feature_id);
```

`scope_registry.db`:
```sql
ALTER TABLE session_locks ADD COLUMN active_feature_id TEXT;
```

### State machine

| From | Event | To |
|---|---|---|
| (none) | `feature_init(name)` | `active` |
| `active` | `table_feature(id)` | `tabled` |
| `tabled` | `resume_feature(id)` | `active` |
| `active` OR `tabled` | `feature_wrap_up(id)` | `wrapped_up` |
| `active` OR `tabled` | `abandon_feature(id, reason)` | `abandoned` |

Terminal states (`wrapped_up`, `abandoned`) cannot transition.

### Tool surface

```
feature_init(name, description?, feature_tags?, primary_scope?, stage_memories=true)
  → { feature_id, staged_handoff_id?, digest_queue_id }

table_feature(feature_id? | name?)
  → confirmation + prior state

resume_feature(feature_id? | name?)
  → { feature_id, resumed_from_tabled_at, last_tabled_by }

feature_wrap_up(feature_id? | name?, synthesize=true, archive_policy='retain')
  → { wrap_up_summary: {entries_total, entries_synthesized, memories_created, entries_tombstoned}, digest_queue_id }

abandon_feature(feature_id? | name?, reason)
  → { feature_id, entries_retained }

list_features(scope_id?, state_filter?)
  → features list with id, name, state, timestamps, initiator, feature_tags
```

### Key semantics

**Auto-table on overlap:** `feature_init` or `resume_feature` when session has a different active feature → auto-table the current, surface transparency notice in response:
```xml
<feature id="new-uuid" name="new-feature"/>
<auto_tabled previously_active_id="old-uuid" previously_active_name="old-feature" message="Previously active feature tabled to make way"/>
```

**Cross-session resume allowed:** features belong to scopes, not sessions. Session B can resume a feature Session A tabled. Response includes transparency notice:
```xml
<feature id="X" state="active"/>
<resumed_from_tabled tabled_at="<ts>" tabled_by_session="<session_id>" tabled_by_key="<key_hash>" message="This feature was last tabled by [session]"/>
```

**Feature scope selection:** defaults to session's primary scope; can target any `writable_scope_ids` via `primary_scope` param.

**Cross-scope reads during synthesis:** feature SDK subprocesses read ancestors (readonly-attached) for context; writes only to the feature's home scope.

**Auto-tagging:**
- Writes during active feature get `feature_id = session.active_feature_id` + `features.feature_tags` merged
- Tabled features don't receive auto-tagging (paused)
- Per-call `skip_feature_association=true` override for infrastructure/cross-feature notes

**Scope retirement cascade:** `retire_scope` requires all features in scope to be in terminal state (`wrapped_up` | `abandoned`). Tabled features block; error response lists blockers.

**Wrap-up / abandon on tabled:** allowed directly — `tabled → wrapped_up` or `tabled → abandoned` without needing `resume_feature` first.

**Authorization:**
- `feature_init`, `table_feature`, `resume_feature`, `feature_wrap_up`, `abandon_feature` — any key with write perm in target scope
- Master key can operate on any feature regardless of initiator

**Archive policy on wrap-up:** `retain` default (entries stay queryable via `feature_id` + `query_past_state`) or `tombstone` (sets `valid_to` on feature-only ephemeral entries absorbed into synthesis).

### SDK synthesis behavior

**`feature_init` SDK (trigger_type=`feature_init`):**
- Read existing memories in scope + readable ancestors matching `feature_tags`
- LLM-synthesize a staged context handoff
- `create_handoff(content=staged_context, target_feature_id=<new_feature_id>)`

**`feature_wrap_up` SDK (trigger_type=`feature_wrap`):**
- Read feature-linked journal + memory entries
- LLM-synthesize durable memory entries (feature-level learnings promoted to scope-level)
- Mark source journal entries `digested_at=NOW`
- If `archive_policy='tombstone'`, set `valid_to=NOW` on feature-ephemeral entries absorbed

### `sys_audit_log` events
- `feature_initiated`
- `feature_tabled`
- `feature_resumed`
- `feature_wrapped_up`
- `feature_abandoned`
- `feature_auto_tabled`

**User verbatim:**
- *"Agreed, defaults to primary with target-able scope"*
- *"Warning, non-fatal. Though I wonder if we should have a way to 'table' a feature or support multiple features with an active flag."*
- *"Agreed, retain"*
- *"Agreed, read-only access to ancestors"*
- *"Per-call"*
- *"Agreed on cross-session resume, allowed with notice"*

**Alternatives discussed:**
- Features as tag-driven only, no `features` table — rejected; lifecycle state needs first-class tracking for audit + cascading operations
- Warning-only on feature_init overlap (no tabling as first-class state) — rejected; real workflows benefit from explicit pause-resume semantics; tabling is not a workaround, it's the pattern
- Forbid overlap entirely (fatal) — rejected; too rigid for multi-feature workflows
- Tombstone by default on wrap-up — rejected; storage is cheap, retain is strictly more powerful
- Reject cross-session resume (require same session that tabled) — rejected; multi-agent workflows need cross-session continuity
- Session-level auto-tag override mode — rejected in favor of per-call for finer control

**Arranger note:** VERIFIED — feature-as-state-machine with metadata table + entry FK is standard pattern (VCS branches, project management systems, ALM tools). Tabling semantic parallels `git stash` + branch switching.

**Status:** settled
**Supersedes:** —

---

## Decision: Mass-Ingest Supervisor Approval Flow
**Phase:** Phase 5 — Approach Loop (Topic 6)
**Category:** decision

**Decided:** Mass-ingest operations require explicit supervisor approval via a status-document polling mechanism. Once approved, the operation runs as an SDK subprocess with elevated capacity (1M model, 3h lease, higher retry budget, first-class checkpointing). Approval is a final gate — no post-approval cancellation tool.

### Request flow
1. Session calls `request_mass_ingest(operation, scope_id?, summary, justification, estimated_entry_count, source_reference?)` → returns `{ request_id, approval_status_entry_id, approval_status_doc_path }`
2. Server INSERTs `mass_ingest_requests` row (state=`pending_approval`), creates approval status entry with `request` / `approval` / `metadata` sections, logs `mass_ingest_requested`
3. Supervisor (out-of-band) reviews the status doc, sets `approved=true` via standard `update_status(section='approval', ...)`
4. Server polls approval status every 30s (configurable) → on approval: state=`approved`, enqueue `digest_queue` with `trigger_type='mass_ingest'`; on denial: state=`denied` with reason; on expiry: state=`expired`
5. SDK subprocess (1M model, 3h lease) runs the operation with checkpointing
6. Completion: state=`completed` (or `failed`); audit event

### `mass_ingest_requests` schema (in `scope_registry.db`)
```sql
CREATE TABLE mass_ingest_requests (
  request_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  requested_by_key_hash TEXT NOT NULL,
  requested_by_session_id TEXT,
  operation TEXT NOT NULL,                  -- ingest | bulk_edit | migration
  summary TEXT NOT NULL,
  justification TEXT NOT NULL,
  estimated_entry_count INTEGER,
  source_reference TEXT,
  request_payload JSON,
  approval_status_entry_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending_approval',
  approved_by_key_hash TEXT,
  approved_by_session_id TEXT,
  approved_at TIMESTAMP,
  approval_note TEXT,
  approval_expires_at TIMESTAMP NOT NULL,
  denial_reason TEXT,
  queue_id INTEGER,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP,
  INDEX idx_ingest_state (state, approval_expires_at)
);
```

### First-class progress checkpointing
```sql
CREATE TABLE mass_ingest_checkpoints (
  request_id TEXT NOT NULL,
  checkpoint_at TIMESTAMP NOT NULL,
  processed_count INTEGER NOT NULL,
  resume_state JSON NOT NULL,               -- SDK-defined resume context
  PRIMARY KEY (request_id, checkpoint_at),
  FOREIGN KEY (request_id) REFERENCES mass_ingest_requests(request_id)
);
```
SDK writes a checkpoint every N entries or M minutes (configurable). On timeout or crash mid-run, next retry reads the latest checkpoint and resumes rather than restarting from scratch.

### Approval status doc structure
Auto-created at `<scope>:status:mass-ingest-<request_id>` with three sections:
| Section | Content | Writer |
|---|---|---|
| `request` | Operation, summary, justification, estimated_entry_count, requester, timestamp | Server (initial, read-only) |
| `approval` | `approved` (bool), `approval_note` (text) | Supervisor via `update_status` |
| `metadata` | Expiry, expected impact, request_id | Server (initial, read-only) |

### Authorization
- **Can approve:** parent-scope key (hierarchical supervisor), master key
- **Cannot approve:** the requester themselves
- **Self-approval policy:** `solo_only` default — allowed only when `enforce_permissions=false`. Configurable as `forbidden | solo_only | allowed`.

### Behavior differences (mass-ingest vs normal digest — Topic 2 restated)
- Model: `opus[1m]` (1M context)
- Lease TTL: 3h (vs normal 30min)
- Max retries: 10 (vs normal 3)
- First-class progress checkpointing (resume-from-checkpoint rather than restart)

### Approval timing
- Default expiry: 24h (configurable via `[mass_ingest.approval_ttl_hours]`)
- Prevents stale approvals from being used long after the supervisor might have forgotten the context

### No post-approval cancellation
Approval is a final gate. `cancel_mass_ingest(request_id)` is NOT provided. Emergency cancellation by the supervisor kills the SDK process directly (via standard process-kill tooling). Rationale: simpler semantics; avoids race conditions between a cancellation request and the SDK committing mid-step; aligns with the principle that approval fully commits.

### Abuse prevention
- Rate-limit: configurable requests per key per day (default 5/day)
- Supervisor audit visibility via `sys_audit_log`
- Expiry: stale approvals cannot be resurrected

### `sys_audit_log` events
- `mass_ingest_requested`
- `mass_ingest_approved`
- `mass_ingest_denied`
- `mass_ingest_expired`
- `mass_ingest_started`
- `mass_ingest_checkpoint`
- `mass_ingest_completed`
- `mass_ingest_failed`

**User verbatim:**
- *"Agreed, default to solo-only"*
- *"Yes correct"* (parent-scope + master approver hierarchy)
- *"24 as a configurable default should be good"*
- *"First-class"* (progress checkpointing)
- *"I think we can omit cancellation post-approval. Approval is final gate, any need to cancel can be handled by supervisor killing the processes if absolutely needed"*

**Alternatives discussed:**
- Dedicated approval primitive (new tool) instead of reusing status docs — rejected; existing status + section-CRUD does the job with no new surface area
- Owner self-approval always allowed — rejected; violates supervisor-discipline principle except in solo-mode
- 12h expiry — rejected; too short for async supervisor workflows
- 72h expiry — rejected; too stale; supervisor may have forgotten context
- Checkpointing as Arranger implementation detail — rejected; first-class schema so resume semantics are in the contract, not opaque
- Post-approval `cancel_mass_ingest` tool — rejected; introduces race conditions with SDK commits; emergency cancellation via process-kill is sufficient

**Arranger note:** VERIFIED — approval-via-status-doc and first-class checkpointing are standard patterns (CI/CD manual approvals, long-running batch jobs, workflow engines with resumable state).

**Status:** settled
**Supersedes:** —

---

## Decision: L1/L2 Relevance Framework (frame-and-hand-off)
**Phase:** Phase 5 — Approach Loop (Topic 10)
**Category:** decision — **framework complete for V2; scoring function extended in V3 KG session without pipeline/config/tool changes**

**Decided:** V2 ships a complete injection-relevance pipeline (gather → score → threshold → Top-K → emit) with a baseline scoring function using V2-available signals. V3 (KG Dramaturg session) extends the scoring function by adding a `graph_proximity` signal; no other pipeline, configuration, or tool-surface changes.

### Two-layer model: active project vs active context

**Active project** (scope-level) — *which project is this session working on*. Priority chain:
1. Explicit `set_active_project(scope_id | project_tag)`
2. Session's `active_feature_id` → feature's parent scope
3. Session's primary scope from claim
4. Session's cwd (git root basename)
5. Inferred from recent tool calls' dominant scope-tag

**Active context** (tag-level) — *which tags drive relevance scoring*. Priority chain:
1. Explicit `set_active_context(tags)`
2. Session's `active_feature_id` → `features.feature_tags`
3. Active project's project-tags (auto-derived)
4. Inferred from recent N tool calls' tag frequency

**Auto-derivation rule:** setting an active project (via `set_active_project`, `resume_feature`, `feature_init`, or cwd detection) automatically resets active context to the project's tags. Explicit `set_active_context` overrides this derivation.

**Mismatch detection:** when `set_active_context(tags)` is called with tags having zero overlap with the active project's tags:
```xml
<active_context tags="[...]" source="explicit_override"/>
<warn code="CONTEXT_PROJECT_MISMATCH" active_project="<name>" message="Active context shares no tags with active project — injection may surface unrelated content"/>
```

### Injection pipeline (per hook invocation)

```
L1 every ~10 tool calls; L2 every ~20 (Topic 1's adaptive frequency preserved from V1)

1. Gather candidates
   L1: session's active-feature entries + unconsumed handoffs + current status
   L2: all accessible memories + recent journal tail (undigested) + tag catalog

2. Score each candidate:
   score(c, ctx) = Σ (signal_i(c, ctx) * weight_i)

3. Threshold gate: drop candidates with score < hook_threshold
   Threshold = minimum relevance for inclusion; below → filtered out BEFORE Top-K.
   If nothing scores above threshold, hook injects nothing (better than weak matches).

4. Top-K sort + budget fill:
   Sort by score descending; take until token budget reached.
   Tie-break rules (in order):
     a. Memory > Journal (refined knowledge > raw capture)
     b. Recent > Older (within same entry class)
     c. Critical > Non-critical (if not already primary signal)

5. Emit YAML-in-XML injection payload (V1 format inherited)
```

### V2 baseline scoring signals (all normalized to [0, 1])

| Signal | Definition |
|---|---|
| `tag_overlap` | `overlap_count(candidate.tags, active_context_tags) / max(len(active_context_tags), 1)` |
| `recency` | `exp(-age_days / half_life_days)` where `age_days = (now - candidate.valid_from).days` |
| `active_project` | `1.0` if `candidate.project_tag` matches `session.active_project`, else `0.0` |
| `critical` | `1.0` if `candidate.critical_flag = 1`, else `0.0` |

### Configuration surface

```toml
[injection.relevance]
l1_threshold = 0.7               # stricter: immediate-scope only
l2_threshold = 0.5               # looser: broader scope
l1_token_budget = 1000
l2_token_budget = 3000
inferred_context_window = 20     # N recent tool calls for priority-5 inference

[injection.weights]
tag_overlap = 0.4
active_project = 0.3
critical = 0.2                   # outweighs recency per user direction
recency = 0.1                    # swapped from initial proposal
# V3 KG session will add:
# graph_proximity = ???          (set at V3 design time; missing key defaults to 0)

[injection.recency]
half_life_days = 30
```

### New MCP tools

```
set_active_project(scope_id? | project_tag?, ttl_minutes?: int)
  → { active_project, active_context: <auto-derived>, expires_at? }

set_active_context(tags: list, ttl_minutes?: int)
  → { active_context, source: "explicit_override", expires_at?, warn? }
  # Warning emitted if zero tag-overlap with active project

clear_active_project()
  → { active_project: <next-priority source> }

clear_active_context()
  → { active_context: <next-priority source> }
```

`whoami` response extended to surface both `active_project` and `active_context` with their sources.

### V3 extension contract (to KG Dramaturg session)

**Invariants — V3 cannot change these:**
- Pipeline steps and order (gather → score → threshold → Top-K → emit)
- Existing weight keys (`tag_overlap`, `active_project`, `critical`, `recency`)
- Tool signatures for `set_active_project`, `set_active_context`, and their clear counterparts
- `active_project` / `active_context` priority chains (V3 may add sources at priority 0 for graph-derived, but cannot reorder existing)

**V3 additions (non-breaking):**
1. `graph_proximity(candidate, context_anchor_nodes) → float` signal
2. `graph_proximity` key under `[injection.weights]` (missing key defaults to 0 in V2; V3 sets actual value)
3. Context type extended with graph-anchor nodes derived from active context
4. `show_related` enhancement using graph-traversal (dedup response — per Topic 2 note, KG handoff doc)
5. Multi-hop relatedness queries as first-class

### CEO multi-project pattern (Kyle's rationale)

Captures why feature > status in the project priority chain:

> CEO session has a status doc tracking 3 in-flight projects (P1, P2, P3). PMs message CEO: *PM1 messages → CEO calls `resume_feature(project_1)` → active project + context switches to P1 → L1/L2 inject P1 memories → CEO reacts and responds → PM2 messages → `resume_feature(project_2)` → active switches to P2 → P2 memories inject → etc.*

The status doc holds the dashboard of projects; the active feature drives the current focus. Both coexist cleanly.

**User verbatim:**
- *"Calling the new set_active_context should set a warning that active context does not match the active project. Setting an active project should set the appropriate active context"*
- *"memories should take priority over journals only in conflict conditions"*
- *"critical should outweigh recency, so swap their values"*
- *"Definitely feature above status, as a session like CEO will have a status that is tracking multiple active projects and the active project can be switched based on what the CEO is actively interacting with at any given time"*
- *"Agreed, optional TTL"*
- *"these threshold values are used to determine the worst relevance value that can be used for L1/L2 entries"* (confirmed understanding)

**Alternatives discussed:**
- Single priority chain conflating project + context — rejected; two-layer model matches real workflow where context can be narrower than project scope
- Memory-over-journal always (not just tie-break) — rejected; explicit weighting handles normal case; tie-break handles edge case without dominating the scoring
- Recency > critical — rejected; explicit signals should outweigh implicit heuristics per user direction
- Status > feature in priority — rejected; CEO multi-project pattern requires feature precedence
- Setting active context without warning on project mismatch — rejected; violates transparency principle
- TTL required on context override — rejected; optional is strictly more flexible

**Arranger note:** PARTIAL
- Pipeline and framework are VERIFIED (standard relevance-scoring architecture in search/RAG systems)
- V2 scoring function is provisional — will be tuned during early V3 rollout (via Shadow Mode Testing from Topic 9) before lock-in
- V3 graph_proximity signal design is deferred to KG Dramaturg session

**Status:** settled (V2 framework); extends in V3
**Supersedes:** —

---

## Decision Amendment: Digest Critical-Entry Scope Review (extends Topic 2)
**Phase:** Phase 5 — Approach Loop (amendment raised during Topic 10 discussion)
**Category:** decision amendment — **extends, does not supersede Topic 2**

**Decided:** The SDK digest subprocess gains a **critical-entry scope-review pass** as part of normal synthesis. This addresses both a knowledge-management concern (critical entries about project-level concerns should live at project scope) and an injection-pollution concern (critical entries with broad applicability would otherwise flood a single session's or feature's L1/L2 injection).

### Pipeline addition during digest

For each entry where `critical_flag = 1` and `valid_to IS NULL`:
1. Analyze entry content + tags + current scope
2. Assess scope-appropriateness — is this feature-scoped when project-scoped would be better? Project-scoped when ancestor-scoped would be better?
3. **If scope appears mismatched:** flag for promotion
4. **If scope is appropriate:** do nothing (critical entry legitimately stays at current scope — not all criticals need promotion)

### Promotion is a proposal, not an action

Actual cross-scope promotion requires authorization (cannot be unilateral by digest key):

| Authorization path | Mechanism |
|---|---|
| Master key | Can execute promotion directly (has cross-scope write) |
| Non-master, with supervisor | Lightweight approval flow (status-document polling pattern, similar to mass-ingest) — "promotion approval" status doc |
| Solo mode (`enforce_permissions=false`) | Owner self-approves |

When promotion is approved and committed:
- New memory entry created at target scope with original content
- Original entry's `valid_to = NOW`, `invalidation_reason = "promoted_to:<new_entry_id>@<target_scope>"`
- Transaction: both operations atomic (either both commit or neither)

### Why this matters (Kyle's rationale)

Critical entries accumulate at session/feature level. Without a promotion mechanism, project-level critical knowledge stays trapped in the session that happened to identify it — missing from other sessions' injection. Promotion routes knowledge to the scope where it's most useful (project-level memory injectable to the whole project's sessions) rather than flooding a single agent's context.

**But promotion is not universal:** some critical entries are legitimately session- or feature-scoped. The digest makes a *proposal*, not a mandate — the entry stays in place unless promotion is approved.

### `sys_audit_log` events
- `critical_entry_promotion_proposed` (digest flags)
- `critical_entry_promotion_approved`
- `critical_entry_promotion_committed`
- `critical_entry_promotion_denied`

**User verbatim:**
- *"critical entries, these should be reviewed during digest to determine if they are feature-scoped or project-scoped and possibly flag for promotion to the shared memory entries"*
- *"I don't want critical entries to build up and flood the injection entries. This promotion allows these to move to appropriate locations, but is optional. A critical entry may legitimately be scoped to that session and should not be flagged for promotion, but critical entries I envision to be used for things that are usually project-level and are entered as critical because it effects most/all tasks."*

**Amendment scope:** This amends Topic 2's Digest Contract by adding the critical-entry review pass. It does not supersede any Topic 2 decision. Digest_queue, SDK subprocess, lease mechanism, trigger types, model selection, isolation directory all remain as defined in Topic 2.

**Arranger note:** VERIFIED — automated scope-mismatch detection with human-in-the-loop promotion is a standard pattern (linting with suggested fixes, CI recommendations with PR approval).

**Status:** settled
**Extends:** Topic 2 Decision (SDK Digest Contract)

---

## Decision: Migration Framework (Two-Surface Design)
**Phase:** Phase 5 — Approach Loop (Topic 4 — integrating topic)
**Category:** decision

**Decided:** Two distinct migration surfaces with different purposes:
- `migrate_from_v1(v1_db_path, target_v3_path?, confirm_backup_taken=true)` — one-shot V1 → V3 structural restructuring (single DB → per-scope DBs + `scope_registry.db`)
- `start_migration(target_version, dry_run=false)` — generic DDL migration flow for V3.x → V3.y+1

### Migration state machine (generic flow)
```
queued → paused_for_writes → applying → completed
                               ↓
                            failed (manual intervention via resume/force_unlock)
```

### Schema (in `scope_registry.db`)
```sql
CREATE TABLE migration_state (
  migration_id TEXT PRIMARY KEY,
  target_version TEXT NOT NULL,
  started_at TIMESTAMP NOT NULL,
  paused_at TIMESTAMP,
  applying_started_at TIMESTAMP,
  completed_at TIMESTAMP,
  failed_at TIMESTAMP,
  state TEXT NOT NULL,                       -- queued | paused_for_writes | applying | completed | failed | cancelled
  failure_reason TEXT,
  scopes_total INTEGER,
  scopes_completed INTEGER DEFAULT 0,
  scopes_failed INTEGER DEFAULT 0,
  initiated_by_key_hash TEXT NOT NULL,
  dry_run BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE migration_scope_progress (
  migration_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  from_version INTEGER NOT NULL,
  to_version INTEGER NOT NULL,
  state TEXT NOT NULL,                       -- pending | applying | completed | failed
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  error_details JSON,
  PRIMARY KEY (migration_id, scope_id),
  FOREIGN KEY (migration_id) REFERENCES migration_state(migration_id)
);
```

### Generic paused-rollover flow (`start_migration`)
1. Verify master key; INSERT `migration_state` row, state=`queued`
2. **Pause phase:** set global `migration_in_progress=true`; broadcast OS-alert to active sessions via MCP notifications; 30s drain for in-flight writes
3. **Applying phase:** iterate registry scopes → open each scope .db directly (writable) → apply DDL scripts from `user_version+1` to `target_version` → bump `user_version` → COMMIT per-scope (atomic) → UPDATE `migration_scope_progress`
4. **Completion:** set global flag `false`; broadcast "migration complete"; sessions resume on next tool call
5. **Failure:** global flag stays `true` (system in safe-hold); `sys_audit_log` captures which scope failed; admin options — `resume_migration(migration_id)` to retry from failed scope, or `force_unlock(migration_id)` to unblock writes without finishing migration (dangerous, master-key-only, audited)

### In-flight session protection during `applying`
**Hard-block all tool calls** (reads and writes) with:
```xml
<error code="MIGRATION_IN_PROGRESS" migration_id="..." state="applying" estimated_completion="..."/>
```
Per-scope COMMIT/ROLLBACK handles per-scope failure atomicity. Simpler to hard-block briefly than reason about read safety across partially-migrated scopes.

### Forward-only migrations
V2 doesn't require `down()` reverse scripts. Per-scope COMMIT/ROLLBACK handles per-scope failure during apply. True rollback of a completed migration requires backup restore. Future versions may add `down()` support if needed.

### Dry-run mode
`start_migration(target_version, dry_run=true)` — parses target DDL against each scope's current schema, estimates duration, no writes. Emits report.

### V1 → V3 migration (`migrate_from_v1`)

Structural shift: V1's single `~/.aletheia/data/aletheia.db` → V3's per-scope DBs + `scope_registry.db` under the V3-chosen `<global-data-dir>`.

**Flow:**
1. Master-key required; `confirm_backup_taken=true` required (tool refuses otherwise)
2. Analyze V1 DB: identify unique scopes via V1's `entry_scope` column
3. For each unique scope:
   - Mint scope_uuid
   - INSERT into `scope_registry.db`
   - Create per-scope `.db` with V3 schema
   - Copy V1 entries into scope .db, transforming schema:
     - `valid_from` = V1's `created_at`; `valid_to` = NULL (fresh append-only history starts post-migration)
     - Populate `content_hash` during migration
     - Populate `supersedes_entry_id` from V1's supersedes field
     - Version column starts at 1
     - `digested_at` left NULL (treated as undigested for post-migration digest pass)
   - Status entries: section data split out into `status_sections` table
4. Migrate keys: V1 keys → V3 `keys/` directory with scope-mapping preserved
5. Migrate settings: V1 `settings.toml` → V3 `settings.toml` with new config keys defaulted
6. Archive V1 DB (rename to `aletheia-v1-pre-migration.db.bak`); do not delete
7. Emit migration report: scopes migrated, entries migrated, any issues

### Authorization
- `migrate_from_v1` — master key ONLY; requires `confirm_backup_taken=true` flag
- `start_migration` — master key ONLY
- `get_migration_status` — any authenticated caller
- `resume_migration`, `force_unlock` — master key ONLY

### Migration script location
`<npm-install-dir>/migrations/`:
- `v3_x_to_v3_y.sql` — forward DDL for V3.x → V3.y+1 generic migrations
- `v1_to_v3/` — V1 → V3 restructuring scripts + schema-transform helpers
Scripts ship read-only with the npm package. Users never modify.

### `sys_audit_log` events
- `migration_started`, `migration_paused_for_writes`, `migration_applying_started`
- `migration_scope_started`, `migration_scope_completed`, `migration_scope_failed`
- `migration_completed`, `migration_failed`, `migration_cancelled`, `migration_force_unlocked`
- `v1_migration_started`, `v1_migration_completed`, `v1_migration_failed` (distinct from generic flow)

**User verbatim:**
- *"Yes, absolutely"* (hard-block reads during applying)
- *"Yes that's ok for V2"* (forward-only migrations)
- *"Agreed, separate"* (V1 → V3 as separate tool)
- *"Enforced"* (backup requirement enforced)
- *"Agreed, migration should be safe-by-default"*

**Alternatives discussed:**
- Allow reads during `applying` — rejected; partially-migrated state risks inconsistent reads; hard-block is simpler and brief
- Integrate V1 → V3 into `start_migration` — rejected; structural shift is fundamentally different from DDL migration; two distinct tools keep semantics clean
- Backup as strong recommendation only (trust user) — rejected; structural shift is irreversible without backup
- Reversible migrations with `down()` scripts — rejected for V2; per-scope COMMIT/ROLLBACK + backup-restore is sufficient; future versions may add reversibility
- User-writable migration scripts — rejected; ship read-only from npm package for safety

**Arranger note:** VERIFIED — two-surface migration + paused-rollover with per-scope atomicity is the standard pattern (Rails/Django migrations + version-bumping per-DB pragma). V1 → V3 structural migration is custom but straightforward (ETL-like one-shot transformation).

**Status:** settled
**Supersedes:** —

---

## Decision: Shadow Mode Testing (V1 vs V3 Parallel Ranking)
**Phase:** Phase 5 — Approach Loop (Topic 9 — final Phase 5 topic)
**Category:** decision

**Decided:** Shadow Mode is an opt-in, rollout-scoped comparison mechanism. On sampled hook invocations when enabled, the system computes both V1-equivalent and V3 relevance rankings in parallel, emits the V3 ranking as actual injection (user experience identical), and logs the diff for maintainer analysis.

### Flow
1. On each L1/L2 hook invocation when `[shadow.enabled] = true`, with probability `sampling_rate`:
   - Compute V3 ranking normally (this is the emitted injection)
   - Compute V1-equivalent ranking via pure function `v1_rank(candidates, context)`
   - Log both rankings + diff summary + context snapshot to `shadow_comparison_log`
2. Emit V3 ranking as actual injection (user experience unchanged by shadow mode)

### Schema (in `scope_registry.db`)
```sql
CREATE TABLE shadow_comparison_log (
  comparison_id INTEGER PRIMARY KEY AUTOINCREMENT,
  compared_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  scope_id TEXT NOT NULL,
  session_id TEXT,
  hook_type TEXT NOT NULL,              -- L1 | L2
  v1_selected_entry_ids JSON,
  v3_selected_entry_ids JSON,
  overlap_count INTEGER,
  unique_to_v1 INTEGER,
  unique_to_v3 INTEGER,
  divergence_summary JSON,
  context_snapshot JSON
);
```

### Configuration
```toml
[shadow]
enabled = false                         # opt-in; off by default
sampling_rate = 0.1                     # 10% of hook invocations logged
retention_days = 30                     # shadow logs have own retention

[shadow.per_scope]
# Optional per-scope overrides for focused review
```

### Internal mechanics
- `shadow_compare()` is **not** an exposed MCP tool — called internally by hook machinery when shadow mode enabled
- V1 ranking logic maintained in V3's codebase as a pure function (`v1_rank()`) — comparison-only, never used for actual injection
- Removable in a later V3.x version via the standard tool deprecation lifecycle (Topic 7) once V3 is fully trusted

### Analysis tool (master-key-only)
```
analyze_shadow_mode(from_date?, to_date?, scope_id?, hook_type?)
  → {
    total_comparisons,
    overlap_rate,                       -- how often V1 and V3 agreed on selection
    avg_overlap_count_per_hook,
    top_divergences: [up to 10 samples with full context],
    score_distribution_shift: { v1_mean, v3_mean, v1_stdev, v3_stdev }
  }
```

### Retention + deactivation
- Default retention: 30 days (configurable); separate from entry retention (Topic 8) and audit log retention (Topic 7)
- **Manual deactivation** via config flag — maintainer decides based on analysis confidence, not arbitrary timer
- Post-deactivation: V1 pure function removable via tool deprecation lifecycle

### `sys_audit_log` events
- `shadow_mode_enabled`
- `shadow_mode_disabled`
- `shadow_analysis_requested`

**User verbatim:**
- *"Everything looks good and I agree with all your recommendations, no further notes needed for this one. Great job"*

**Alternatives discussed:**
- 100% sampling rate always — rejected; log bloat; per-scope 100% override available when needed
- Auto-disable after N days — rejected; maintainer judgment better than arbitrary timer
- L2-only shadow — rejected; L1 comparison also valuable
- No V1 logic carry-forward in V3 codebase — rejected; real comparison data is the point

**Arranger note:** VERIFIED — dark-launch / shadow-traffic patterns are standard in search-ranking deployments. Opt-in sampling with manual deactivation is the standard rollout-tool pattern.

**Status:** settled
**Supersedes:** —

---

## Phase Progress

- [x] Phase 1: Context Grounding (2026-04-17)
- [x] Phase 2: Vision Loop (2026-04-17) — Vision Baseline settled
- [x] Phase 3: Vision Expansion (2026-04-17) — staged Gemini brainstorm complete; KG deferred to future Dramaturg session; V2 reframed as design-only, V1 → V3 implementation path
- [x] Phase 4: Broad Design Scoping (2026-04-17) — 10-topic map confirmed; V2 naming retained for this session
- [x] Phase 5: Approach Loop (2026-04-17 / 2026-04-18) — all 10 topics settled + Topic 2 amendment for critical-entry scope review
- [x] Phase 6: Review Loop (2026-04-18) — all 6 sections approved; §5 had V3-discretion framing refinement
- [x] Phase 7: Reconciliation (2026-04-18) — 2 cosmetic clarifications (full table enumeration, audit event categorization); no substantive inconsistencies; implementation readiness = YES
- [x] Phase 8: Final Design Doc (2026-04-18) — compiled at `docs/plans/designs/2026-04-17-aletheia-v2-design.md`; Clarification entry added for V2 implementation-path update; KG handoff doc updated accordingly

---

## Session Complete — Hand-off Pointers

**Date session closed:** 2026-04-18
**Topic:** Aletheia V2 design (evolution of V1; KG deferred to V3 Dramaturg session after V2 deployment)

**Artifacts produced:**
- **Final Design Document:** `kyle-projects/aletheia/docs/plans/designs/2026-04-17-aletheia-v2-design.md` — the Arranger's primary input
- **Decision Journal (this file):** `kyle-projects/aletheia/docs/plans/designs/decisions/aletheia-v2/dramaturg-journal.md` — structured decision trail with user verbatim + alternatives + Arranger notes
- **KG Research Hand-off:** `kyle-projects/aletheia/docs/plans/designs/decisions/aletheia-v2/knowledge-graph-research-handoff.md` — for the V3 Dramaturg session, after V2 deployment
- **Staged Brainstorming Technique doc:** `kyle-projects/skills-work/elevated-stage/dramaturg/docs/working/2026-04-17-staged-brainstorming-technique.md` — pattern for future Dramaturg PMs

**Kyle's plan forward:**
1. Arranger session consumes the design doc + this journal → produces V2 implementation plan
2. V2 gets implemented + deployed
3. V3 Dramaturg session runs after V2 deployment, with the KG hand-off doc + deployed V2 as reference

**Invocation for Arranger:** `/arranger docs/plans/designs/2026-04-17-aletheia-v2-design.md`

---

## Section Approved: Architecture & Data Layer (§1)
**Phase:** Phase 6 — Review Loop
**Key decisions reflected:** Research: SQLite ATTACH DATABASE with WAL Mode Verification (Topic 1); Decision: Scope Partitioning Architecture (Topic 1); Decision: Session Locks & Concurrent-Claim Protection (Topic 3 — session_bindings auto-reclaim portion; heartbeat/locks belong to §3)
**User feedback incorporated:** none — approved as presented
**Status:** settled

---

## Section Approved: Entry Model & Lifecycle (§2)
**Phase:** Phase 6 — Review Loop
**Key decisions reflected:** Decision: Append-Only Versioning + Temporal Columns + Tombstoning (Topic 8); content-hash dedup (Topic 2 / Topic 8 integration); `invalidation_reason` conventions; retention policy (Topic 8)
**User feedback incorporated:** none — approved as presented
**Status:** settled

---

## Section Approved: Permission, Authentication & Audit (§3)
**Phase:** Phase 6 — Review Loop
**Key decisions reflected:** Decision: Scope Partitioning Architecture (Topic 1 — permission model portions); Decision: Session Locks & Concurrent-Claim Protection (Topic 3); Decision: SDK Digest Contract (Topic 2 — digest key portion); Decision: Tool Deprecation Lifecycle + sys_audit_log (Topic 7)
**User feedback incorporated:** none — approved as presented
**Status:** settled

---

## Section Approved: Digest Pipeline & Lifecycle Tools (§4)
**Phase:** Phase 6 — Review Loop
**Key decisions reflected:** Decision: SDK Digest Contract (Topic 2); Decision: Feature Lifecycle Tools & State Machine (Topic 5); Decision: Mass-Ingest Supervisor Approval Flow (Topic 6); Decision Amendment: Digest Critical-Entry Scope Review (extends Topic 2)
**User feedback incorporated:** none — approved as presented
**Status:** settled

---

## Section Approved: Injection & Relevance Framework (§5)
**Phase:** Phase 6 — Review Loop
**Key decisions reflected:** Decision: L1/L2 Relevance Framework (Topic 10); Decision: Shadow Mode Testing (Topic 9)
**User feedback incorporated:** Revised V3 extension framing from "locked invariants — V3 cannot change these" to "recommended foundation with full V3 discretion." Kyle clarified V3 KG Dramaturg session has full design authority; V2 provides a strong baseline so modification should rarely be needed, but V3 can redesign anything if its analysis reveals a better path. Underlying architectural decisions (pipeline, weights, signals, tools) are unchanged; only the stance on V3's discretion is refined.
**Status:** settled

---

## Section Approved: Migration Framework (§6)
**Phase:** Phase 6 — Review Loop
**Key decisions reflected:** Decision: Migration Framework (Two-Surface Design) (Topic 4)
**User feedback incorporated:** none — approved as presented
**Status:** settled

---

## Reconciliation
**Phase:** Phase 7 — Reconciliation
**Sections checked:** 6 (Architecture & Data Layer §1, Entry Model & Lifecycle §2, Permission/Authentication/Audit §3, Digest Pipeline & Lifecycle Tools §4, Injection & Relevance Framework §5, Migration Framework §6)

**Inconsistencies found:**

- **Clarification (cosmetic):** §1's enumeration of `scope_registry.db` tables was summary-level ("registry + session_bindings + session_locks + digest_queue + mass_ingest_requests + sys_audit_log + migration state"); later sections added more specific table names. Full inventory across §1–§6:
  - Scope metadata (the registry proper)
  - `session_bindings` (§1 + §3)
  - `session_locks` (§3)
  - `digest_queue` (§4)
  - `mass_ingest_requests` (§4)
  - `mass_ingest_checkpoints` (§4)
  - `sys_audit_log` (§3)
  - `shadow_comparison_log` (§5)
  - `migration_state` (§6)
  - `migration_scope_progress` (§6)
  - Global `migration_in_progress` flag + active-feature-id-on-session flag
  
  **Resolution:** §1's enumeration in the Final Design Doc (Phase 8) will list the complete table set explicitly, not the summary form. No architectural change — same tables, fuller enumeration.

- **Clarification (cosmetic):** `sys_audit_log.event_category` enum in §3 listed {auth | lock | scope | key | digest | migration | deprecation}. §4's mass-ingest events (`mass_ingest_requested`, `mass_ingest_approved`, ...) and feature-lifecycle events (`feature_initiated`, `feature_tabled`, ...) and §5's Shadow Mode events (`shadow_mode_enabled`, ...) nest under the existing categories as follows: mass-ingest and feature events → `digest` category; Shadow Mode events → `deprecation` category (rollout-transition related). §3 explicitly permitted category extensibility for §4/§5 events; this is just the categorization mapping.
  
  **Resolution:** document the categorization in the Final Design Doc's §3 enumeration.

**Substantive inconsistencies:** None. All sections' approaches, schemas, and mechanics are coherent. Connections between sections (feature_id FK from §2 into §4's features table, `critical_entry_promotion_*` audit events in §3 used by §4's amendment, retention purge as a digest_queue trigger type across §2/§4, etc.) all check out.

**Implementation readiness test (could the Arranger produce an executable implementation plan without making design-level decisions?):**

**YES.** Every design-level decision is settled. Arranger has explicit PARTIAL / VERIFIED flags throughout the journal marking which details require implementation-time verification:
- Global data directory path (install-mechanism-dependent; §1)
- Exact MCP/env integration point for `CLAUDE_CODE_SESSION_ID` read (§1)
- SDK-launch flags for tool allowlist + model selection + cwd pinning (§4)
- `claudeMdExcludes` settings.local.json schema per current CC harness version (§4)
- SQLite trigger syntax for audit-log immutability in the deployed SQLite version (§3)

All other content — schemas, state machines, tool signatures, flows, events, retention policies — is settled at the design level.

**Status:** settled — ready for Phase 8

---

## Clarification: V2 Implementation Path (supersedes earlier "V2 won't ship" framing)
**Phase:** Phase 8 — Final Design Doc (pre-compilation)
**Category:** implementation-path clarification

**Clarified (2026-04-18):** V2 **will** be implemented following this design session. Kyle's updated plan, stated at the start of Phase 8 wrap-up:

1. Arranger session produces a V2 implementation plan from this design doc + journal
2. V2 gets actually implemented and deployed
3. V3 Dramaturg session runs **after** V2 is fully built — taking advantage of a real deployed V2 as reference implementation rather than working only from a paper design

**Impact on design doc:** the "V2 won't ship" framing established in Vision Baseline and Vision Expansion is superseded. The Final Design Doc (Phase 8 output) is written for V2 as actual near-term implementation; "V1 → V3 direct jump" phrasing is removed. Migration framing in §6 is the real plan: `migrate_from_v1` executes for the V1 → V2 structural shift, and `start_migration` handles future V2.x → V2.y+1 DDL migrations. V2 → V3 is itself a future `start_migration` invocation (designed by the V3 Dramaturg session).

**Impact on KG handoff doc:** `knowledge-graph-research-handoff.md` updated to reflect V2 as deployed foundation the KG session extends (not a paper spec). The V3 Dramaturg benefits from V1 design + V1 journal + V2 design doc + V2 journal + this handoff + **empirical observations from V2 in production**.

**User verbatim:** *"I think the next step will be the Arranger session for this project, then the V2 implementation, and then I will run the V3 dramaturg once V2 is fully built so the V3 Dramaturg has the advantage of seeing the implementation of the V2 design."*

**Status:** settled
**Supersedes:** Vision Baseline framing "V2 will not be built or released" and Vision Expansion framing "V2 reframed as design-only, V1 → V3 implementation path"
