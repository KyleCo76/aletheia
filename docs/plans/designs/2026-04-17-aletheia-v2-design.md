# Aletheia V2 — Design Document

**Design session:** Dramaturg, 2026-04-17 / 2026-04-18
**Decision journal:** `docs/plans/designs/decisions/aletheia-v2/dramaturg-journal.md`
**Knowledge-graph research handoff (for V3 Dramaturg):** `docs/plans/designs/decisions/aletheia-v2/knowledge-graph-research-handoff.md`

---

## Goals

Aletheia V2 is an **evolution** of Aletheia V1 — a structured memory system for Claude Code sessions. V2 preserves V1's successful architectural foundations (SQLite-backed local storage, claim-based hierarchical auth, L1/L2 PreToolUse injection hooks, Dumb-Capture-Smart-Digest pattern, four entry types: journal / memory / status / handoff) and extends them with targeted improvements driven by real-world V1 usage experience and known V1 bugs.

V2 will be implemented via an Arranger pass followed by subsequent development work. The **Knowledge Graph layer** originally scoped for V2 is deliberately deferred to a subsequent V3 Dramaturg session, which will run with V2 deployed as a reference implementation.

### What V2 delivers

- **Scope isolation fix.** V1's cross-scope-leak bug (PM sessions seeing other scopes' entries via `search`) is eliminated by architecting scopes as per-scope SQLite files connected via `ATTACH DATABASE`. Non-attached DBs are physically unreachable at the SQL layer — the entire failure class of filter-logic bugs is eliminated by construction rather than defended against.

- **Multi-writer parallelism.** As a side effect of per-scope partitioning, each scope has an independent writer lock. V1's single-DB single-writer bottleneck is removed; N scopes = N parallel writers.

- **Cross-project injection filtering.** A two-layer active-project / active-context model lets a session (particularly CEO) hold memories spanning multiple projects but inject only the currently-active project's memories into L1/L2 hooks. Threshold-gated Top-K scoring prevents weak-match pollution of the context window.

- **Session reclaim UX.** `claude --resume` automatically re-establishes Aletheia access via session-ID → binding lookup. If a session ID is corrupted or unrecoverable, the user's key still works — they call `claim(key)` with any new session ID and access is restored. **The key is the persistent identity; session-ID is UX convenience.**

- **SDK-based digest.** V1's tmux-spawned teammate for digest synthesis is replaced by a Claude Code SDK subprocess orchestrated by the MCP server via a shared `digest_queue`. Cleaner process isolation, no tmux dependency, first-class crash recovery via lease-lock.

- **First-class feature lifecycle.** New tools — `feature_init`, `table_feature`, `resume_feature`, `feature_wrap_up`, `abandon_feature` — scope work with explicit state machines and automatic memory staging/archival at boundaries. Tabling is first-class, not a workaround for overlap.

- **Mass-ingest with supervisor approval.** Bulk operations (first-run ingest, bulk edits, corpus migrations) bypass normal digest budgets after explicit supervisor approval via a status-document polling flow. First-class progress checkpointing lets long-running ingests resume after crashes.

- **Time-travel memory queries.** Append-only versioning with `valid_from` / `valid_to` columns + `query_past_state` tool provides first-class temporal queries: "what did Claude know at time T?" is a single indexed SQL query.

- **Configurable retention with never-purge-active guarantee.** Retention (default 1 year) applies only to tombstoned/superseded rows. Active entries are never purged by retention.

- **Tool deprecation lifecycle.** MCP tools carry `deprecated` / `removed` states with forward-migration strings. Visible warnings in responses; session-scoped usage dedup in audit log for migration-progress tracking.

- **Comprehensive audit trail.** Immutable `sys_audit_log` captures all security-relevant events (auth, lock transitions, scope lifecycle, key mutations, digest operations, migrations, deprecations). Separate retention (5-year default). SQLite trigger enforces append-only at DB layer.

- **Safe migration framework.** Two migration surfaces: `migrate_from_v1` for the one-shot V1 → V2 structural shift (single DB → per-scope DBs + registry), and `start_migration` for generic V2.x → V2.y+1 DDL migrations. Both use paused-rollover with OS-alerts, require master-key authorization, and record events to the audit log.

- **Shadow Mode for rollout confidence.** A hidden parallel-ranking mechanism computes V1-equivalent and V2 ranking on identical hook invocations, logs diffs for maintainer analysis. User experience stays on V2; comparison data informs tuning before removing V1 fallback logic.

### What V2 explicitly defers

- **Knowledge Graph layer.** V1 and V2 use tag-overlap for relatedness. The KG layer — graph traversal, multi-hop queries, graph-proximity in relevance scoring, graph-linked dedup responses, entity resolution — is deferred to V3. The V2 design is structured so V3 can extend *without* redesigning V2's foundation; a strong baseline the KG session can build upon rather than rework.
- **Automatic entity resolution / tag merging.** Deferred to V3 as a background SDK task using the KG.
- **`down()` migrations.** V2 migrations are forward-only. Rollback requires backup restore. Future versions may add reverse migrations if needed.

### Use cases V2 must support

- **Solo developer** — zero setup, one user, one Claude Code session, scope auto-initializes on first use.
- **Small team / orchestrated project** — PM with own memory + shared project memory writable; TLs with own memory + project memory readable; workers inheriting team + project context.
- **CEO / cross-project session** — multiple projects simultaneously accessible, active project switches via `resume_feature` when PM messages arrive, L1/L2 injection filters to active project automatically.
- **Long-running autonomous session** — session-ID reclaim survives `--resume`; session-ID corruption survives via key-based re-claim; heartbeat + concurrent-claim protection prevents dual-terminal split-brain.
- **Feature-boundary knowledge curation** — `feature_init` stages relevant context as a handoff; `feature_wrap_up` synthesizes feature-level learnings into durable memories.
- **V1 → V2 migration for existing installs** — one-shot `migrate_from_v1` with master key + backup-confirmation flag preserves all V1 data in the new per-scope structure.
- **Claude-facing transparency** — every server-side action that deviates from the agent's request is reported explicitly (write routing, dedup hits, auto-table on feature overlap, context-project mismatch warnings). The agent's mental model is never silently desynchronized from the server's state.

---

## 1. Architecture & Data Layer

V2 partitions Aletheia's data store into per-scope SQLite `.db` files connected via SQLite's `ATTACH DATABASE`. This replaces V1's single-DB model, providing mathematically-leakproof scope isolation (native SQLite semantics, not filter logic), per-scope writer independence, and clean cross-scope inheritance via readonly-attached ancestors.

### Design rationale

V1 used a single SQLite DB with a `namespace_id` column for scope separation. The cross-scope-leak bug exposed the failure class: filter-logic bugs fail silently, leaking data across scope boundaries. V2 eliminates this class of failure by partitioning at the **file level** — non-attached DBs are physically unreachable at the SQL layer.

Additionally, V1's single-writer SQLite limitation serialized writes across the whole system. V2's per-scope files give each scope its own writer lock — N scopes = N independent writers. Multi-agent parallelism is free.

Research against SQLite official docs confirmed ATTACH + WAL + readonly-URI is fully supported natively: per-file pagers, separate `-wal`/`-shm` per DB, no cross-file interference, default max 10 attached DBs (hard max 125 via `SQLITE_MAX_ATTACHED`).

### Global data directory

V3 install decides the exact path — standalone npm-install uses V1 precedent `~/.aletheia/`; CC plugin install uses a plugin-provided directory under `~/.claude/plugins/...`. Structure is location-agnostic:

```
<global-data-dir>/
├── settings.toml                       # user config (injection intervals, retention, model selection)
├── scopes/<scope_uuid>.db              # per-scope entry data (UUID-named, rename-safe)
├── scopes/archived/<scope_uuid>.db     # retired but not purged
├── scope_registry.db                   # global metadata; tables:
│                                       #   scopes (the registry proper)
│                                       #   session_bindings
│                                       #   session_locks
│                                       #   digest_queue
│                                       #   mass_ingest_requests
│                                       #   mass_ingest_checkpoints
│                                       #   sys_audit_log
│                                       #   shadow_comparison_log
│                                       #   migration_state
│                                       #   migration_scope_progress
├── keys/                               # master + digest + issued sub-keys (file perms 0600)
├── templates/                          # user-added (defaults ship read-only from npm install dir)
└── sockets/aletheia-<pid>.sock         # per-MCP-server UDS for hook queries (V1 hybrid preserved)
```

### Per-cwd SDK runtime

```
<parent_session_cwd>/.aletheia/
├── .gitignore                          # single line "*" — hides from git without touching parent .gitignore
└── sdk-agent/
    ├── CLAUDE.md                       # digest agent constitution
    ├── .mcp.json                       # registers aletheia MCP only (no other tools)
    ├── .claude/
    │   └── settings.local.json         # claudeMdExcludes — suppresses parent CLAUDE.md harness-injection
    └── digest-context-<queue_id>.md    # per-run transient; cleaned on commit
```

Exists in the parent session's cwd so the SDK digest subprocess launches within the parent's filesystem permission scope. CLAUDE.md walk isolation is handled by `claudeMdExcludes` at the harness layer, not by a Claude-readable terminator.

### Scope partitioning mechanics

```sql
-- After claim, the MCP server has opened:
-- main  <primary_scope>.db                                     -- writable
-- ATTACH DATABASE 'file:<writable_sibling>.db' AS w_hockey     -- writable
-- ATTACH DATABASE 'file:<ancestor>.db?mode=ro' AS r_system     -- readonly (URI-flagged)
```

Readonly enforcement (belt-and-suspenders): `mode=ro` URI at attach time + server-side write-guard rejecting writes to readonly-attached schemas + `PRAGMA query_only = ON` per-schema where supported.

### Claim flow

A single `claim(key)` resolves into a permission set:
```
claim(key) → {
  primary_scope_id,
  writable_scope_ids: [primary + any shared writable],
  readonly_scope_ids: [ancestors + explicit read grants]
}
```

**Example — PM claim:** `primary = pm_alice_scope` (writable `main`), `writable = [pm_alice_scope, hockey_project_scope]` (project attached as `w_hockey`), `readonly = [system_scope]` (attached as `r_system` readonly).

### Auto-claim on resumed session

`session_bindings` table in `scope_registry.db` maps `session_id → key_hash + primary_scope_id`. On MCP server startup, session_id is read from env/handshake; a matching binding triggers silent auto-reclaim. Session-ID corruption is survivable via explicit `claim(key)` with any new session_id — scope .db files are untouched.

### Write routing transparency

Existing-entry writes infer scope from `entry_id` lookup. New-entry creation takes `target_scope` param (defaults to primary). Write guard rejects targets outside `writable_scope_ids`. Every write response includes:
```xml
<entry id="..." scope="<scope_name>" scope_alias="main|w_<label>" routing="primary|inferred|explicit"/>
```

### Security-relevant aspects

- Data files and key files at 0600 perms within the data directory
- Master key written to file at bootstrap; user records and deletes; never echoed to TUI
- Cross-scope read leakage prevented at the SQL layer by requiring explicit ATTACH
- Session-ID is not authentication material — it's a cache identifier for auto-reclaim UX

### Constraints & assumptions

- SQLite default max attached DBs = 10 (hard max 125). Practical hierarchies (CEO → TL → subTL → worker = 4 attaches) are well within defaults.
- WAL mode required for multi-writer concurrency
- Cross-database transaction atomicity lost on hardware crash — irrelevant here (writes to `main` only)
- Long-running readers on ancestor scope can prevent that scope's WAL checkpoint truncation

---

## 2. Entry Model & Lifecycle

V2 replaces V1's diff-based in-place storage with **append-only versioned rows**. Every mutation creates a new row with `version++`; the prior row's `valid_to` is set. Status entries use section-granular append-only (via `status_sections` companion table) so V1's section-CRUD tool surface is preserved without full-doc rewrites on each mutation.

### Design rationale

Tombstoning + `query_past_state` + validity windows collectively implied append-only (any two imply the third):

- `query_past_state` on diff-storage requires reconstructing state by walking diff chains — complex, fragile
- Append-only with `(entry_id, version, valid_from, valid_to)` makes "what was this at time T?" a single indexed query
- Tombstoning (never DELETE) is trivial in append-only, awkward in diff-storage

Storage tradeoff explicitly accepted: query simplicity + free history + trivial time-travel outweigh the row-count overhead.

### Main `entries` schema

```sql
CREATE TABLE entries (
  internal_id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id TEXT NOT NULL,                -- stable user-facing ID
  version INTEGER NOT NULL,
  entry_class TEXT NOT NULL,             -- journal | memory | status | handoff
  content TEXT,                          -- for status: container metadata; section data in status_sections
  content_hash TEXT NOT NULL,            -- SHA-256 over (content + scope_id) for dedup
  tags JSON,
  valid_from TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  valid_to TIMESTAMP,                    -- NULL = currently valid
  invalidation_reason TEXT,              -- convention-based TEXT (see below)
  supersedes_entry_id TEXT,              -- single-level supersedes
  reasoning_trace TEXT,                  -- optional: TiM pattern
  critical_flag INTEGER DEFAULT 0,
  digested_at TIMESTAMP,                 -- journal only: set when absorbed by digest
  feature_id TEXT REFERENCES features(feature_id),
  created_by_key_hash TEXT,
  UNIQUE(entry_id, version),
  INDEX idx_entries_entry_id_current (entry_id, valid_to),
  INDEX idx_entries_class_valid (entry_class, valid_to),
  INDEX idx_entries_content_hash (content_hash),
  INDEX idx_entries_digested (entry_class, digested_at) WHERE entry_class = 'journal',
  INDEX idx_entries_feature (feature_id)
);
```

### `status_sections` companion schema

The `entries` row with `entry_class='status'` carries container metadata. Actual section data lives in:
```sql
CREATE TABLE status_sections (
  internal_id INTEGER PRIMARY KEY AUTOINCREMENT,
  status_entry_id TEXT NOT NULL,         -- FK to entries.entry_id where entry_class='status'
  section_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT,                          -- NULL when section was removed
  state TEXT,                            -- optional state-machine value
  position INTEGER,
  valid_from TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  valid_to TIMESTAMP,
  invalidation_reason TEXT,              -- "updated" | "state_changed" | "removed"
  changed_by_key_hash TEXT,
  UNIQUE(status_entry_id, section_id, version),
  INDEX idx_status_current (status_entry_id, section_id, valid_to)
);
```

Preserves V1's section-CRUD cost profile (one section row per mutation, not one full-status row).

### State transitions & tool semantics

| Event | Effect |
|---|---|
| Create new entry | INSERT row version=1, valid_to=NULL |
| Update (memory) | INSERT new row version+1; prior.valid_to=NOW, reason=`updated` |
| Supersede B → A | Insert A; B.valid_to=NOW, reason=`superseded_by:<A.entry_id>` |
| Retire | valid_to=NOW, reason=`retired:<user reason>` |
| Digest absorbs journal | Set journal's digested_at=NOW (valid_to stays NULL unless retired) |

Status tools preserve V1 API with append-only semantics under the hood: `update_status`, `add_section`, `remove_section` all operate on `status_sections` rows; `replace_status` does a transactional per-section INSERT/tombstone diff against the new content.

### Query semantics

| Intent | WHERE clause |
|---|---|
| Current state (default) | `valid_to IS NULL` |
| As of time T | `valid_from <= T AND (valid_to IS NULL OR valid_to > T)` |
| Full history of an entry | `entry_id = ? ORDER BY version` |

New MCP tools: `query_past_state(entry_id, timestamp)`, `query_entry_history(entry_id)`.

### Content-hash dedup

At the MCP tool boundary, `write_memory` computes `content_hash = SHA-256(content + scope_id)`. On match against an active entry in the same scope, response is:
```xml
<duplicate existing_entry_id="<id>" existing_version="<v>" message="Identical content already stored"/>
```
Visible, not silent — dedup is a learning signal (Claude didn't read existing memories). V3 with KG will add graph-linked neighbors to the response.

### `invalidation_reason` conventions

| Reason | Meaning |
|---|---|
| `superseded_by:<entry_id>` | Another entry replaced this |
| `retired:<user reason>` | `retire_memory` called with reason |
| `retired:digest_stale` | Digest judged stale during synthesis |
| `updated` | Regular update |
| `state_changed` | Status section state transition |
| `removed` | Status section deleted |
| `promoted_to:<new_entry_id>@<target_scope>` | Critical-entry promoted by digest |

### Retention policy

```toml
[retention]
enable = true
default_days = 365
# Per-entry-type override optional; runs as digest_queue 'retention_purge' trigger (in-process, no LLM)
```

- Applies only to `valid_to IS NOT NULL AND valid_to < NOW - retention_days`
- **Active rows never purged**
- Applies uniformly to both `entries` and `status_sections`

### Security-relevant aspects

- Entry content may contain sensitive user data; access control is upstream (§1 + §3); §2 defines *how long* data persists
- Tombstoning (never DELETE during mutation) supports time-travel debugging; retention-purge is the actual data-deletion mechanism
- `content_hash` is for dedup only; it does NOT protect integrity against an attacker with write access

### Constraints & assumptions

- Append-only increases row count vs V1; retention purge reclaims space for tombstoned rows after `retention_days`
- Same content in different scopes is NOT deduplicated (by design — each scope is independent)
- Version numbers start at 1 per entry_id; no cross-entry version correlation

---

## 3. Permission, Authentication & Audit

### Claim permission model

A key grants a **permission set across multiple scopes**. V1's "one writable scope per claim" is replaced by `{primary_scope_id, writable_scope_ids[], readonly_scope_ids[]}`. Mutable permissions (creator can promote/demote sub-keys; no self-promotion; downward-only scoping) are inherited from V1. Write guard enforces `target_scope ∈ writable_scope_ids`.

### Concurrent-claim protection: `session_locks`

Distinct from `session_bindings` (long-lived credential binding from §1). `session_locks` is the short-lived lock preventing dual-terminal concurrent use:

```sql
CREATE TABLE session_locks (
  session_id TEXT PRIMARY KEY,
  active_pid INTEGER NOT NULL,
  hostname TEXT NOT NULL,
  claimed_at TIMESTAMP NOT NULL,
  last_heartbeat_at TIMESTAMP NOT NULL,
  FOREIGN KEY(session_id) REFERENCES session_bindings(session_id)
);
```

Heartbeat cadence **30s** (configurable); stale threshold **90s**. On new claim: fresh heartbeat → **FATAL** refusal; stale heartbeat → orphan-recover with audit entry; no row → INSERT new. Graceful shutdown DELETEs the row; crash leaves the row for orphan-recovery.

### Dedicated digest keys per scope

Each scope has its own digest key (`<global-data-dir>/keys/digest-<scope_uuid>.key`, 0600). Permissions: read journal/memory in own scope + readable ancestors; write memory in own scope; retire memory in own scope; update `digested_at`. NOT allowed: write to ancestors, `create_key`/`modify_key`/`retire_scope`, cross-scope writes. Rotatable via `rotate_digest_key(scope_id)`.

### `sys_audit_log` — immutable event store

```sql
CREATE TABLE sys_audit_log (
  audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  event_category TEXT NOT NULL,         -- auth | lock | scope | key | digest | migration | deprecation
  event_type TEXT NOT NULL,
  scope_id TEXT,                        -- NULL for system-level events
  actor_key_hash TEXT,
  subject_key_hash TEXT,                -- for key mutations
  pid INTEGER,
  hostname TEXT,
  details JSON,
  INDEX idx_audit_event_at (event_at),
  INDEX idx_audit_scope (scope_id, event_at),
  INDEX idx_audit_category (event_category, event_at)
);
```

**Event categorization:**
- `auth`: `claim`, `whoami`, `auto_reclaim`, `claim_rejected`
- `lock`: `lock_acquired`, `lock_released`, `lock_orphan_recovered`, `lock_fatal_conflict`, `heartbeat_stolen`
- `scope`: `scope_created`, `scope_retired`, `scope_archived`, `scope_purged`, `scope_forked`
- `key`: `key_issued`, `key_modified`, `key_rotated`, `digest_key_created`
- `digest`: `digest_queued`, `digest_leased`, `digest_committed`, `digest_failed`, `digest_retried`, `critical_entry_promotion_proposed`, `critical_entry_promotion_approved`, `critical_entry_promotion_committed`, `critical_entry_promotion_denied`, `mass_ingest_requested`, `mass_ingest_approved`, `mass_ingest_denied`, `mass_ingest_expired`, `mass_ingest_started`, `mass_ingest_checkpoint`, `mass_ingest_completed`, `mass_ingest_failed`, `feature_initiated`, `feature_tabled`, `feature_resumed`, `feature_wrapped_up`, `feature_abandoned`, `feature_auto_tabled`
- `migration`: `migration_started`, `migration_*_{started|completed|failed}`, `v1_migration_*`, `migration_force_unlocked`
- `deprecation`: `tool_deprecated_usage`, `tool_removed_usage_attempt`, `shadow_mode_enabled`, `shadow_mode_disabled`, `shadow_analysis_requested`

**Append-only enforcement:** no MCP tools for UPDATE/DELETE; SQLite trigger blocks UPDATE/DELETE on `sys_audit_log` unless the session is master-key-authenticated running `purge_audit_log`.

**Retention (separate from entry retention):** default 1825 days (5 years); per-category override. Manual purge via `purge_audit_log(older_than, master_key)`.

**Visibility:** master key sees all; scope key sees own + readable ancestors + NULL scope_id events; digest key sees own scope only.

### Tool deprecation lifecycle

Tool metadata: `deprecated`, `deprecated_since`, `removal_planned_for`, `migration_hint`. States:
- `active` — normal execution
- `deprecated` — execute + wrap response with `<deprecated since="..." removal="..." hint="..."/>` + log `tool_deprecated_usage` (session-scoped dedup: one event per (session_id, tool_name) per day)
- `removed` — FATAL `<error code="TOOL_REMOVED" since="..." hint="..."/>` + log `tool_removed_usage_attempt`

### Security-relevant aspects

- Master key file-based delivery; user records and deletes; never TUI-echoed; one-per-install
- Sub-key escalation prevented: downward-only scoping, no self-promotion, mutable only by creator
- Digest key least-privilege as tabled above
- Audit log immutability two-layer defense: MCP tool surface + SQLite trigger
- Audit log retention 5y > entry retention 1y (security forensics need longer lifetime)
- Session_id is not authentication; the key is the authenticator
- Concurrent-claim = FATAL (prevents split-brain writes); false-positive is user annoyance, false-negative is data corruption

### Constraints & assumptions

- No external IdP in V2; auth is key-based, self-managed
- SQLite trigger support assumed (3.6+; ubiquitous)
- Heartbeat assumes reasonable clock sync across machines (<30s drift) for multi-machine deployments

---

## 4. Digest Pipeline & Lifecycle Tools

V2 replaces V1's tmux-spawned teammate with a Claude Code SDK subprocess orchestrated by the MCP server. A shared `digest_queue` provides dispatch + audit + crash-recovery. On top of this pipeline sit three lifecycle tools: feature lifecycle, mass-ingest approval, and critical-entry scope-review.

### SDK digest subprocess model

Orchestrator: MCP server spawns + tracks the subprocess, PID + lease coordination via `digest_queue`. V1's isolation preserved without tmux dependency.

Launch (conceptual):
```bash
cd <parent_cwd>/.aletheia/sdk-agent/ && \
ALETHEIA_DIGEST_QUEUE_ID=<id> \
ALETHEIA_DIGEST_KEY=<key> \
claude --model <model-per-trigger> \
       --allowed-tools "mcp__aletheia__*" \
       --session-id digest-<queue_id>
```

Tool surface locked to `mcp__aletheia__*` — no Bash/Edit/Write. Subprocess never touches scope .db files directly; data access flows through the MCP layer.

### `digest_queue` schema

```sql
CREATE TABLE digest_queue (
  queue_id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_id TEXT NOT NULL,
  trigger_type TEXT NOT NULL,        -- entry_threshold | time_threshold | session_end | feature_wrap | feature_init | manual | mass_ingest | retention_purge
  trigger_metadata JSON,
  requested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status TEXT NOT NULL DEFAULT 'pending',
  leased_by_pid INTEGER,
  lease_expires_at TIMESTAMP,
  started_at TIMESTAMP,
  committed_at TIMESTAMP,
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,
  INDEX idx_digest_status_scope (status, scope_id)
);
```

### Lifecycle flow

1. Trigger fires (entry threshold / time / session end / feature ops / manual / mass-ingest / retention purge)
2. Dedup: if pending/leased exists for same `(scope, trigger_class)` → `DUPLICATE_QUEUED` response (visible dedup)
3. INSERT queue row
4. Worker dispatch:
   - `retention_purge` → MCP server processes **in-process** (pure SQL DELETE, no LLM)
   - Everything else → spawn SDK subprocess
5. Subprocess atomically leases, executes, commits
6. Crash → lease TTL expires → next dispatch re-queues with `retry_count+1`

### Lease TTL tiers & model selection

| Trigger | Lease TTL | Model |
|---|---|---|
| `digest` (normal) | 30 min | `opus` (200k) |
| `feature_wrap` / `feature_init` | 30 min | `opus` |
| `session_end` | 30 min | `opus` |
| `mass_ingest` | 3 h | `opus[1m]` (1M context) |
| `retention_purge` | 15 min | n/a (in-process) |

All configurable; override per-run via `trigger_metadata.lease_override_minutes`.

### Failure handling

| Failure | Action |
|---|---|
| Rate limit | Exponential backoff (base 60s, cap 1h) up to `max_retries` |
| Invalid digest key | Logged + manual intervention |
| Crash / timeout | Lease expiry triggers retry |
| OCC conflict | V1 hybrid OCC state-forwarding error; retry with fresh state |

### Feature lifecycle

**State machine:**

| From | Event | To |
|---|---|---|
| (none) | `feature_init(name)` | `active` |
| `active` | `table_feature(id)` | `tabled` |
| `tabled` | `resume_feature(id)` | `active` |
| `active` OR `tabled` | `feature_wrap_up(id)` | `wrapped_up` |
| `active` OR `tabled` | `abandon_feature(id, reason)` | `abandoned` |

**`features` schema (per-scope .db):**
```sql
CREATE TABLE features (
  feature_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,                       -- unique within scope
  description TEXT,
  state TEXT NOT NULL,
  initiated_at TIMESTAMP NOT NULL,
  tabled_at TIMESTAMP,
  wrapped_at TIMESTAMP,
  abandoned_at TIMESTAMP,
  abandonment_reason TEXT,
  initiated_by_key_hash TEXT,
  last_tabled_by_key_hash TEXT,
  last_tabled_by_session_id TEXT,
  wrapped_by_key_hash TEXT,
  feature_tags JSON,
  metadata JSON,
  UNIQUE(name)
);
```

Session's active feature tracked via `session_locks.active_feature_id`. One active per session at a time.

**Auto-table on overlap:** `feature_init` or `resume_feature` with different active feature → auto-table current, surface `<auto_tabled .../>` notice. **Cross-session resume allowed:** features belong to scopes; any authorized session can resume. Response surfaces `last_tabled_by` for context.

**Auto-tagging:** writes during active feature get `feature_id = session.active_feature_id` + `features.feature_tags` merged. Per-call `skip_feature_association=true` override available.

**SDK synthesis:**
- `feature_init` SDK reads memories matching `feature_tags` across scope + readable ancestors → creates staged context handoff
- `feature_wrap_up` SDK reads feature-linked entries → synthesizes durable memory entries → marks source journals `digested_at`; if `archive_policy='tombstone'` (default `retain`), sets `valid_to` on feature-only ephemerals absorbed into synthesis

**Scope retirement cascade:** `retire_scope` requires all features in scope in terminal state (`wrapped_up` / `abandoned`).

### Mass-ingest approval flow

For bulk operations bypassing normal digest budgets.

**Flow:** `request_mass_ingest(...)` creates `mass_ingest_requests` row + approval status entry → supervisor reviews via `read_status` / `update_status(section='approval', ...)` → server polls every 30s → on `approved=true`, enqueue `digest_queue` with `trigger_type='mass_ingest'` → SDK subprocess runs with 1M model + 3h lease + higher max_retries.

**`mass_ingest_requests` schema** (see journal Topic 6 Decision for full schema).

**First-class checkpointing:**
```sql
CREATE TABLE mass_ingest_checkpoints (
  request_id TEXT NOT NULL,
  checkpoint_at TIMESTAMP NOT NULL,
  processed_count INTEGER NOT NULL,
  resume_state JSON NOT NULL,
  PRIMARY KEY (request_id, checkpoint_at)
);
```
SDK writes checkpoints every N entries or M minutes; resume reads the latest checkpoint rather than restarting.

**Authorization:**
- Can approve: parent-scope key (hierarchical supervisor) OR master key
- Cannot approve: the requester themselves
- Self-approval policy: default `solo_only` (allowed when `enforce_permissions=false`); configurable `forbidden | solo_only | allowed`

**Approval expiry:** 24h default (configurable). No post-approval cancellation — approval is the final gate; emergency cancel via process-kill.

### Critical-entry scope-review (extends Topic 2)

During digest synthesis, active entries with `critical_flag=1` get a scope-appropriateness pass:
- Is this feature-scoped when project-scoped would fit better? Project-scoped when ancestor-scoped fits better?
- If mismatched, propose promotion (`critical_entry_promotion_proposed`)

**Promotion is a proposal, not automatic.** Master key executes directly; non-master requires supervisor approval via the same status-doc polling pattern; solo mode allows self-approval. On commit: new memory entry at target scope; original's `valid_to=NOW`, reason=`promoted_to:<new_entry_id>@<target_scope>`. Transaction atomic.

Rationale: critical entries accumulate at session/feature level without a promotion path; broad-applicability knowledge gets trapped. Promotion routes it to where it's most useful without flooding a single session's L1/L2.

### Security-relevant aspects

- SDK subprocess tool surface locked to `mcp__aletheia__*`; no filesystem/Bash/web access
- Digest key compromise blast radius = that scope only
- Mass-ingest approval gate + 24h expiry + full audit trail
- Checkpoint `resume_state` JSON should not contain raw sensitive content (SDK contract; Arranger verifies)
- Feature auto-tagging can spread sensitive tag labels; users choose `feature_tags` deliberately
- Critical-entry promotion crosses scope boundaries — requires supervisor auth equivalent to normal cross-scope write

### Constraints & assumptions

- SDK subprocess costs real tokens; 200k default cap prevents runaway; mass-ingest 1M is the exception
- Queue dedup is best-effort within transaction window; lease mechanism absorbs race-condition duplicates
- Feature overlap auto-table is opinionated UX; manual table/resume still works
- Mass-ingest 30s polling introduces brief latency between approval and execution

---

## 5. Injection & Relevance Framework

V2 introduces a relevance-scored injection pipeline replacing V1's tag-overlap-only hook behavior. Each L1/L2 hook invocation gathers candidates, scores each against a weighted-signal function, applies a threshold gate, and Top-K sorts by score until token budget is reached. A two-layer model separates **active project** (scope-level) from **active context** (tag-level).

### Two-layer model

**Active project** — which project the session is working on (coarse). Priority chain: explicit `set_active_project` > session's `active_feature_id` → feature's scope > session's primary scope from claim > cwd (git root) > inferred from recent tool calls.

**Active context** — which tags drive relevance scoring (fine). Priority chain: explicit `set_active_context(tags)` > session's `active_feature_id` → `features.feature_tags` > active project's project-tags (auto-derived) > inferred from recent tool calls.

**Auto-derivation:** setting an active project (via `set_active_project`, `resume_feature`, `feature_init`, or cwd detection) auto-resets active context to the project's tags. Explicit `set_active_context` overrides.

**Mismatch detection:** `set_active_context(tags)` with zero tag-overlap against active project → response includes `<warn code="CONTEXT_PROJECT_MISMATCH" .../>`.

### Injection pipeline

L1 every ~10 tool calls; L2 every ~20 (V1's adaptive frequency preserved).

```
1. Gather candidates
   L1: session's active-feature entries + unconsumed handoffs + current status
   L2: all accessible memories + recent journal tail (undigested) + tag catalog

2. Score each candidate: score(c, ctx) = Σ (signal_i(c, ctx) × weight_i)

3. Threshold gate: drop candidates scoring below hook_threshold
   (If nothing scores above threshold, hook injects nothing — better than polluting)

4. Top-K sort + budget fill (tie-break order):
   a. Memory > Journal (refined knowledge > raw capture)
   b. Recent > Older (within same entry class)
   c. Critical > Non-critical

5. Emit YAML-in-XML injection payload (V1 format inherited)
```

### V2 baseline scoring signals

| Signal | Definition |
|---|---|
| `tag_overlap` | `overlap_count(candidate.tags, active_context_tags) / max(len(active_context_tags), 1)` |
| `recency` | `exp(-age_days / half_life_days)` |
| `active_project` | 1.0 if `candidate.project_tag` matches `session.active_project`, else 0.0 |
| `critical` | 1.0 if `candidate.critical_flag = 1`, else 0.0 |

### Configuration

```toml
[injection.relevance]
l1_threshold = 0.7
l2_threshold = 0.5
l1_token_budget = 1000
l2_token_budget = 3000
inferred_context_window = 20

[injection.weights]
tag_overlap = 0.4
active_project = 0.3
critical = 0.2
recency = 0.1
# V3 KG session will add (non-breaking):
# graph_proximity = ???

[injection.recency]
half_life_days = 30
```

### New MCP tools

```
set_active_project(scope_id? | project_tag?, ttl_minutes?: int)
  → { active_project, active_context: <auto-derived>, expires_at? }

set_active_context(tags: list, ttl_minutes?: int)
  → { active_context, source: "explicit_override", expires_at?, warn? }

clear_active_project()
clear_active_context()
```

Both active project and active context surface in `whoami` response with source annotations.

### V3 extension foundation (not a locked contract)

V2 ships a complete framework intended as a **strong foundation** for V3's KG extensions — strong enough that the V3 Dramaturg session shouldn't *need* to revisit V2's pipeline, configuration, or tool surface. **Recommended continuity, not mandatory inheritance. V3 has full design authority.**

Happy path (V3 extends without modification):
1. V3 adds `graph_proximity(candidate, context_anchor_nodes) → float` signal
2. V3 adds `graph_proximity` key under `[injection.weights]` (non-breaking — missing defaults to 0 in V2)
3. V3 extends context type with graph-anchor nodes derived from active context
4. V3 enhances `show_related` using graph-traversal (also applies to dedup response per §2)
5. V3 introduces multi-hop relatedness queries as first-class

V3 may redesign anything if its analysis reveals a better architecture. V2's strength is that modification should rarely be necessary — but when it is, V3 should take the better path without hesitation.

### Shadow Mode

Opt-in, rollout-scoped parallel-ranking mechanism. On sampled hook invocations when `[shadow.enabled] = true`: compute V3 ranking (emit), compute V1-equivalent ranking in parallel via a pure function `v1_rank(candidates, context)` maintained in V2's codebase for comparison, log both + diff to `shadow_comparison_log`. User experience identical.

```toml
[shadow]
enabled = false
sampling_rate = 0.1              # 10% of hook invocations logged
retention_days = 30              # separate from entry + audit retention
```

Master-key-only analysis tool `analyze_shadow_mode(...)` for maintainer review. Manual deactivation; V1 `v1_rank` function removable via standard tool deprecation lifecycle once V2's ranking quality is confirmed.

### Security-relevant aspects

- Injection directly shapes Claude's reasoning; misrouted injection = cross-project context leak. Mitigations: scope candidate-gathering bounded by §1's claim rules; `set_active_*` cannot target scopes outside claim's visibility; mismatch warning on context override
- Tag-based scoring does not leak metadata outside scope (no enumeration of other scopes' tags)
- Shadow Mode logs contain entry IDs (refs, not content); master-key-only analysis; 30-day retention
- `set_active_context` TTL prevents forgotten overrides from persisting across sessions

### Constraints & assumptions

- V2 scoring weights are provisional; tuned during early rollout via Shadow Mode analysis
- `half_life_days=30` is heuristic; tunable per deployment
- Tag overlap is set-based (no semantic similarity in V2); V3 KG may add semantic proximity
- L1/L2 cadence inherited from V1's adaptive frequency; this framework is selection, not firing

---

## 6. Migration Framework

V2 defines two distinct migration surfaces: **`migrate_from_v1`** is a one-shot structural restructuring of V1's single-DB layout into V2's per-scope layout (run once per install when upgrading from V1); **`start_migration`** is the generic DDL-migration flow for V2.x → V2.y+1 (run every minor/patch release, including V2.x → V3.0 once V3 is designed). Both use paused-rollover for in-flight protection, master-key authorization, per-scope transactional atomicity. Forward-only — no `down()` in V2.

### Generic migration framework (V2.x → V2.y+1)

**State machine:**
```
queued → paused_for_writes → applying → completed
                               ↓
                            failed (manual intervention)
```

**Schema** (see journal Topic 4 Decision for full detail): `migration_state` + `migration_scope_progress` in `scope_registry.db`.

**Paused-rollover flow:**
1. `start_migration(target_version)` verifies master key, state=`queued`
2. Pause phase: global `migration_in_progress=true`; OS-alert broadcast; 30s write-drain
3. Applying phase: iterate scopes → open each .db writable → apply DDL from `user_version+1` to target → bump user_version → COMMIT per-scope (atomic)
4. Completion: flag false, broadcast complete, sessions resume
5. Failure: global flag stays true (safe-hold); `resume_migration` retries; `force_unlock` (dangerous, audited) unblocks

**In-flight protection:** hard-block all tool calls (reads and writes) during `applying`. Brief; simpler than reasoning about cross-scope partial-migration read consistency.

**Dry-run mode:** `dry_run=true` parses target DDL, validates against current schemas, estimates duration. No writes.

**Forward-only:** per-scope COMMIT/ROLLBACK handles per-scope failure. True rollback requires backup restore.

### V1 → V2 structural migration (`migrate_from_v1`)

Tool: `migrate_from_v1(v1_db_path, target_v2_path?, confirm_backup_taken=true, dry_run?=false)` — master key required; `confirm_backup_taken=true` required.

Flow:
1. Analyze V1 DB: identify unique scopes via V1's `entry_scope` column
2. For each unique scope: mint scope_uuid → INSERT `scope_registry.db` row → create per-scope `.db` with V2 schema → copy V1 entries transforming schema (`valid_from`=V1 `created_at`, `valid_to=NULL`, `version=1`, `content_hash` computed, supersedes preserved, `digested_at=NULL` so all V1 entries are undigested for post-migration digest pass)
3. Status entries: section data split into `status_sections` rows
4. Migrate keys → V2 `keys/` with scope-mapping preserved
5. Migrate settings → V2 `settings.toml` with new keys defaulted
6. Archive V1 DB: rename to `aletheia-v1-pre-migration.db.bak`; **never delete**
7. Emit migration report

Post-migration: first V2 session triggers a digest pass on imported entries (all `digested_at=NULL`).

### Migration script location

```
<npm-install-dir>/migrations/
├── v1_to_v2/
│   ├── structural_migration.js
│   ├── schema_v2.sql
│   └── helpers/
└── v2_x_to_v2_y.sql                 # forward DDL per version step
```

Read-only; user never modifies. Later, `v2_x_to_v3_0.sql` will appear when V3 is designed.

### Authorization

- `migrate_from_v1` — master key + `confirm_backup_taken=true`
- `start_migration`, `resume_migration`, `force_unlock` — master key
- `get_migration_status(migration_id?)` — any authenticated caller

### Security-relevant aspects

- Master-key gate on all migration tools; migrations touch all scopes
- Backup-enforcement flag on V1 → V2 (user acknowledgment; Aletheia doesn't verify the backup actually exists)
- Hard-block during `applying` prevents partial-migration data corruption
- V1 DB preserved via rename, not deletion
- `force_unlock` dangerous; every use audited
- Migration scripts ship read-only; prevents accidental/malicious schema divergence
- Keys migrate with scope hierarchy preserved; no privilege escalation through migration

### Constraints & assumptions

- V1 → V2 is one-shot per install; tool refuses if V2 data already exists at target (unless `force=true`, audited)
- DDL migrations assumed fast (seconds per scope); 30s write-drain assumes this
- Multi-machine deployments during migration: admin coordinates single-machine execution; V2 doesn't design for distributed multi-machine migration
- Large V1 corpora (tens of thousands of entries) may take minutes to migrate; pre-migration report suggests low-activity windows

---

## Arranger Notes

### New Protocols / Unimplemented Patterns

- **SDK subprocess orchestration via MCP server + shared queue** — parent MCP server spawns detached Claude Code SDK subprocess; coordination via `digest_queue` lease mechanism. *Reference:* Decision: SDK Digest Contract (Topic 2) in journal.
- **ATTACH DATABASE per-scope partitioning with readonly-attached ancestors** — native SQLite mechanism; no application-layer filter logic for isolation. *Reference:* Research: SQLite ATTACH DATABASE with WAL Mode Verification + Decision: Scope Partitioning Architecture (Topic 1).
- **Append-only versioning at two granularities** — `entries` table append-only per-entry; `status_sections` append-only per-section (preserves V1's section-CRUD cost profile). *Reference:* Decision: Append-Only Versioning + Temporal Columns + Tombstoning (Topic 8).
- **Two-layer active project / context model with mismatch detection** — new in V2; no V1 precedent. Warning-on-overlap captures transparency principle. *Reference:* Decision: L1/L2 Relevance Framework (Topic 10).
- **Session_bindings + session_locks as distinct tables** — auto-reclaim credential lookup (long-lived) separated from concurrent-use lock (short-lived). *Reference:* Decision: Session Locks & Concurrent-Claim Protection (Topic 3).
- **Status-document-as-approval primitive** for mass-ingest — reuses existing status primitive with section-CRUD rather than inventing new approval surface. *Reference:* Decision: Mass-Ingest Supervisor Approval Flow (Topic 6).
- **Feature state machine with cross-session resume** — features belong to scopes, not sessions; any authorized session can resume a tabled feature. Auto-table on overlap with transparency notice. *Reference:* Decision: Feature Lifecycle Tools & State Machine (Topic 5).
- **Critical-entry scope-review during digest** — digest proposes promotion of critical entries to higher-scope locations; promotion requires supervisor auth (similar to mass-ingest). *Reference:* Decision Amendment: Digest Critical-Entry Scope Review (extends Topic 2).
- **Visible-dedup principle as system-wide rule** — queue dedup, content-hash dedup, write-routing all emit visible notices to the caller. *Reference:* extends from Topic 1's write-routing transparency.
- **Shadow Mode parallel ranking** — dark-launch pattern adapted for LLM relevance tuning. *Reference:* Decision: Shadow Mode Testing (Topic 9).

### Implementation-Verification Points (flagged PARTIAL in journal)

These need verification during implementation but are not design-level decisions:

- **Global data directory path** — depends on install mechanism (standalone npm vs CC plugin). Architecture is location-agnostic; Arranger picks the install mechanism.
- **Exact MCP / env integration point for `CLAUDE_CODE_SESSION_ID` read** — verify against current MCP spec + Claude Code session-handshake docs.
- **SDK-launch flag combinations** — `--allowed-tools "mcp__aletheia__*"`, `--model <per-trigger>`, cwd pinning against current Claude Code SDK.
- **`claudeMdExcludes` settings.local.json schema** — verify current CC harness version supports this; confirm exact syntax.
- **SQLite trigger syntax** — for audit-log immutability, verify against the SQLite version pinned at deployment.
- **Permission-prompt behavior for SDK subprocess** — empirically validate that `--allowed-tools` + per-cwd `.aletheia/sdk-agent/` avoids all permission-prompt scenarios.
- **Session_bindings `session_id` source** — exact env var name / MCP handshake field containing the session ID.

### Open Questions

- **V2 ships standalone (npm install -g) or as a CC plugin?** Plugin is preferred if the CC plugin API supports required capabilities (writable plugin data directory, MCP registration, hook registration); standalone is fallback. Arranger reviews CC plugin API and decides.
- **SDK subprocess initialization cost vs persistent daemon.** Per-dispatch spawn is the V2 design assumption; latency + cold-start token cost may warrant a daemon. Revisit empirically after deployment if problems surface.

### Key Design Decisions (pointers to journal entries)

For full context — user verbatim, alternatives discussed, Arranger notes — see the decision journal:

- **Scope partitioning via ATTACH DATABASE** — Decision: Scope Partitioning Architecture (Topic 1). Foundational; affects §1, §3, §6.
- **Append-only replaces V1 diff-storage** — Decision: Append-Only Versioning + Temporal Columns + Tombstoning (Topic 8). Most directly affects §2; implicit in §5 (active-only candidates) and §6 (V1 row transform).
- **SDK subprocess replaces tmux teammate** — Decision: SDK Digest Contract (Topic 2) + Decision Amendment (critical-entry scope-review).
- **Two-layer active project / context** — Decision: L1/L2 Relevance Framework (Topic 10).
- **V2 foundation is recommended continuity for V3, not locked contract** — §5 refinement captured in Section Approved journal entry for §5.
- **Separate `migrate_from_v1` vs `start_migration`** — Decision: Migration Framework (Two-Surface Design) (Topic 4).
- **Visible-dedup + write-routing transparency as system-wide principle** — articulated in Topic 2's Decision; carried through all other decisions.
- **KG deferred to V3 Dramaturg** — Vision Expansion entry + `knowledge-graph-research-handoff.md` companion document at `docs/plans/designs/decisions/aletheia-v2/knowledge-graph-research-handoff.md`.
- **V2 will be implemented** — Clarification entry confirming Arranger → implementation → V3 Dramaturg sequence (supersedes earlier "V2 won't ship" framing from Vision Baseline + Vision Expansion).

### Post-Implementation Hand-off to V3 Dramaturg

When V2 is deployed and the V3 Dramaturg session begins, the V3 session inherits:
- This design document (V2's architectural spec)
- The full decision journal (`dramaturg-journal.md`)
- The KG research handoff (`knowledge-graph-research-handoff.md`) capturing Stage 1-3 KG research + locked V2 items KG must respect + V2 items deferred pending KG decisions
- **Empirical observations from V2 in production** — which V2 items held up under real multi-agent workloads, which needed tuning, what patterns emerged that the design didn't anticipate
- The deployed V2 source code as reference implementation

V3's scope, per the `knowledge-graph-research-handoff.md`, is to add the KG layer on top of this V2 foundation via a V2.x → V3.0 migration designed in the V3 Dramaturg session.
