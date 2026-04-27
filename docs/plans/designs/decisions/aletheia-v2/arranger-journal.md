# Arranger Journal: Aletheia V2

**Started:** 2026-04-26
**Design doc:** `docs/plans/designs/2026-04-17-aletheia-v2-design.md`
**Companion docs:**
- Dramaturg journal: `docs/plans/designs/decisions/aletheia-v2/dramaturg-journal.md`
- CEO review feedback (9 resolved decisions): `docs/plans/designs/decisions/aletheia-v2/ceo-review-feedback.md`
- KG research handoff (V3 forward-look): `docs/plans/designs/decisions/aletheia-v2/knowledge-graph-research-handoff.md`

---

## Phase 1: Ingestion & Overview

### Inputs already absorbed by main session

- Design doc (V2 architectural spec, 6 sections + Goals + Arranger Notes appendix) — read in full
- CEO review feedback — 9 resolved decisions to fold into the design before planning, plus 4 implementation flags requiring spike-tests
- KG handoff — V3 forward-look establishing what V2 must support as KG foundation (Shadow Mode infrastructure, threshold-gated relevance, content-hash dedup, temporal columns, scope partitioning all already locked)

### Config
- `use_gemini = true` (defaults; no project-level config file)
- Gemini MCP available in session

### Journal Distillation Summary (subagent)
**Strength:** mandatory — distillation findings drive Phase 2 audit scope.

**VERIFIED (skip in Phase 2 audit):**
- SQLite ATTACH + WAL + readonly URI compatibility (sqlite.org docs)
- Per-scope `.db` partitioning + `PRAGMA user_version` per-scope migrations
- Append-only versioning + temporal columns + tombstoning (event-sourcing precedent)
- Feature-as-state-machine pattern (VCS branches, ALM tools)
- Approval-via-status-doc + first-class checkpointing (CI/CD precedent)
- Tool deprecation via metadata + audit log (DB migration tooling, OS package managers)
- Dark-launch shadow-mode sampling (search ranking deployments)
- Two-surface migration (Rails/Django + per-DB pragma version-bumping)

**PARTIAL (Phase 2 follow-up required):**
1. `CLAUDE_CODE_SESSION_ID` exact MCP/env integration point — needs negative test for missing/malformed
2. SDK subprocess cold-start cost — CEO resolved as acceptable; entry_threshold should be tunable upward (not a blocker, but document)
3. `claudeMdExcludes` settings.local.json schema — verify current CC harness supports + exact syntax
4. SQLite trigger DDL syntax for audit-log immutability — pin minimum SQLite version
5. **CRITICAL spike-test:** SDK subprocess permission-prompt behavior — Hermes precedent (2026-04-17) found `.claude/` path protection bypasses tool-allowlist. Audit digest write surface

**UNRESEARCHED (mandatory verification in Phase 2):**
- Per-scope DDL writability for ATTACH'd readonly DBs (assumed: needs direct writable connection)
- SDK-launch flag combinations (`--allowed-tools`, `--model`, cwd pinning) against current CC SDK API
- Global data dir path: CEO resolved → `~/.aletheia/` (V1 precedent; standalone npm install)

**Goal/use-case constraints (inviolable):**
- CEO multi-project workflow — multiple projects accessible; injection filters to active project
- Session-ID recovery with data persistence — key is identity, session-id is UX; corruption survivable via `claim(key)`
- Multi-scope memory for PMs — own + project-shared writable
- First ingestion / mass edit with rate-limit override (mass-ingest approval flow)
- First-upgrade KG bootstrap (V2 must provide data foundation V3 KG can traverse)
- Status section CRUD cost profile preservation (single-task = single-row)
- Write-routing transparency (server never silently modifies agent intent)

**Tensions (carry as constraints, not problems to solve):**
- Storage cost vs query simplicity → query simplicity wins (storage cheap)
- Transparency overhead vs silent efficiency → transparency wins (system-wide principle)
- Cold-start cost vs fresh context → fresh context wins (CEO accepted)
- Supervisor overhead vs rate-limit bypass → solo_only default mitigates
- Multi-machine heartbeat sensitivity → 60s/180s default + configurable

**Key abandoned approaches (do NOT rediscover):**
- Unified DB + namespace_id filter (the V1 leak-bug failure class)
- Persistent digest daemon (context pollution risk)
- Terminator CLAUDE.md (wrong layer — `claudeMdExcludes` is correct)
- Auto critical-entry promotion in V2 (deferred to V3 with KG signals)
- Silent auto-table on feature overlap (replaced with two-call confirmation)
- `cancel_mass_ingest` post-approval (race conditions; first-approval-locks)

### CEO Feedback Integration (9 resolved decisions)
**Strength:** mandatory — these supersede / amend the original design and MUST be folded into the implementation plan.

| # | Topic | Resolution |
|---|---|---|
| 1 | Shadow Mode | Build infrastructure in V2; V2's own V1-vs-V2 comparison optional. `v1_rank` pluggable, pulled at V3-build time |
| 2 | Install mechanism | Standalone npm install (`~/.aletheia/`); no plugin in V2 |
| 3 | SDK cold-start | Stay fresh-launch; `entry_threshold` configurable upward; document trigger priority order |
| 4 | Post-migration digest storm | Structural migration atomic; digest pass LAZY per-scope at first claim. Marker per scope; `--stage-digest-as-mass-ingest` flag available |
| 5 | Critical-entry scope-review | DEFER auto-promotion to V3. V2 ships manual `promote_memory(entry_id, target_scope)` only |
| 6 | Auto-table feature overlap | Two-call confirmation pattern (warn → `confirm_table_current=true`); no silent auto-table |
| 7 | Feature name uniqueness | Keep UNIQUE(name); collision returns helpful error with state + since + hint |
| 8 | Mass-ingest approval | First-approval-locks; subsequent flips ignored until re-issue. Document explicitly |
| 9 | Heartbeat default | 60s/180s (was 30s/90s); 30s remains "aggressive" config option |

### Completeness Assessment
**Outcome:** PASS. Design + CEO feedback + KG handoff form a complete spec. PARTIAL items are implementation-time verification, not design gaps. No upstream referral needed.

---

## Phase 2: Feasibility Audit

### Audit Item Classification

Per `repertoire/verification-rules.md` — items requiring external verification:

| # | Item | Source | Method | Verdict |
|---|---|---|---|---|
| 1 | `claudeMdExcludes` schema in `.claude/settings.local.json` | Design §1 PARTIAL | Gemini | **VERIFIED** |
| 2 | Parent CC session ID source for MCP server startup | Design §1 PARTIAL | Gemini + spike | **DESIGN CONFLICT** |
| 3 | SDK subprocess permission-prompt behavior | Design §1 PARTIAL + Hermes precedent | Live spike | **VERIFIED — better than design assumed** |
| 4 | `claude` CLI flag set (--allowed-tools, --model, --bare, --strict-mcp-config, --print, --no-session-persistence, --permission-mode) | Design §4 UNRESEARCHED | `claude --help` inspection | **VERIFIED** |
| 5 | SQLite ATTACH + WAL behavior under load | Design §1 PARTIAL/VERIFIED | Gemini deep query | **VERIFIED with caveat** |
| 6 | DDL writability against attached readonly DBs | Design §6 UNRESEARCHED | SQLite docs (subagent) | **VERIFIED** — direct writable connection required |
| 7 | Rust MCP ecosystem maturity (rmcp + rusqlite + npm distribution) | New (Phase 2 surfaced from Kyle's preference) | Subagent + Gemini | **VERIFIED feasible with caveats** |
| 8 | V1 codebase architecture (for greenfield V2 to know what it replaces) | New | Subagent code-trace | **VERIFIED + 10 deltas mapped** |
| 9 | digest_queue multi-MCP-process leader election | Cross-cutting design analysis | Direct analysis | **NEW DESIGN CONCERN** |
| 10 | `migration_in_progress` global flag staleness across processes | Cross-cutting design analysis | Direct analysis | **NEW DESIGN CONCERN** |

Items audited: 10. Gemini queries: 4. Subagents: 2 (under cap of 3). Live spike-test: 1.

---

### Finding 1 — `claudeMdExcludes` schema VERIFIED
**Strength:** core
- Field name: `claudeMdExcludes` (camelCase). Other names ignored.
- Type: `string[]` of glob patterns, matched against absolute file paths.
- Lives in `.claude/settings.local.json` or `.claude/settings.json`.
- **Note:** Enterprise/managed CLAUDE.md files (MDM, IT-distributed) cannot be excluded via this setting.
- Inline override available: `claude --settings '{"claudeMdExcludes": ["**/*"]}'`
- **Source:** Anthropic Claude Code official docs (claude.com), Mintlify docs.

### Finding 2 — Session ID source: DESIGN CONFLICT
**Strength:** mandatory — surface to Kyle for resolution.
- **Original design assumption:** "session_id is read from env/handshake" — this does not exist in Claude Code 2.1.x.
- **Reality:**
  - No `CLAUDE_CODE_SESSION_ID` env var (only `CLAUDECODE=1`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_EXECPATH`)
  - MCP `initialize` handshake does NOT include parent session ID
  - `tool_use_id` per call is ephemeral, not session-stable
  - **GitHub issue #41836** tracks this as a known gap in CC 2.1.x
- **Cloud-runtime exception:** `CLAUDE_CODE_REMOTE_SESSION_ID` is injected for Anthropic-managed cloud routines, but not local CLI sessions.
- **Workaround A — SessionStart hook + file-handoff (RECOMMENDED):** Install a `SessionStart` hook (stdin receives JSON containing `session_id`). The hook writes session_id to a per-PPID file under `~/.aletheia/sessions/<my_pid>.session_id`. The MCP server, on startup, reads `~/.aletheia/sessions/<my_ppid>.session_id` (PPID = the CC process that spawned us). Auto-reclaim then queries `session_bindings[session_id]` for the key.
- **Workaround B — Skill template variable `${CLAUDE_SESSION_ID}`:** Only works when MCP is invoked via a custom Skill, not for general MCP usage.
- **Implication for plan:** V2 must ship a `SessionStart` hook (sh + js for Unix/Windows) similar to existing V1 hooks. The hook is a NEW file; the MCP server adds a session_id discovery step on startup.
- **Race condition:** SessionStart hook fires before tool calls; MCP server may start before hook completes. Need brief retry/wait loop in MCP server (e.g., poll `~/.aletheia/sessions/<ppid>.session_id` for up to 2s with 100ms backoff).
- **Fallback if no session_id available:** Auto-reclaim silently skipped; user calls `claim(key)` explicitly. Still works.

### Finding 3 — SDK subprocess permission-prompts VERIFIED clean
**Strength:** core — design assertion verified, with refinement.
- Live spike: launched `claude` subprocess from a never-before-seen cwd `/home/claude/kyle-projects/aletheia/temp/sdk-spike-fresh-cwd` with `--bare --strict-mcp-config --mcp-config <empty> --tools "" --permission-mode bypassPermissions --model haiku --no-session-persistence --output-format json`. Result: `permission_denials: []`, exited cleanly. No `~/.claude/projects/<path>/` trust dir created (counter unchanged at 12).
- Second spike WITHOUT `--bare`: also `permission_denials: []`, exit 0, but **inherited 11k cache_read tokens from parent CLAUDE.md walk**. This is the contamination the design warns against.
- **Design simplification recommended:** `--bare` flag does in 1 flag what the design's `<parent_cwd>/.aletheia/sdk-agent/` + `claudeMdExcludes` setup does in 4 files. Strictly cleaner.
- **`--bare` caveat:** Disables OAuth/keychain auth. SDK subprocess needs `ANTHROPIC_API_KEY` env var or `apiKeyHelper` via `--settings`. For users who CC-OAuth (no API key), this is a UX impact.
- **Recommended SDK launch (subject to Phase 3 confirmation):**
  ```bash
  ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  ALETHEIA_DIGEST_QUEUE_ID=<id> ALETHEIA_DIGEST_KEY=<key> \
  claude -p "<digest synthesis prompt>" \
    --bare \
    --mcp-config /tmp/aletheia-mcp.json \
    --strict-mcp-config \
    --allowed-tools "mcp__aletheia__*" \
    --permission-mode bypassPermissions \
    --model opus \
    --no-session-persistence \
    --output-format stream-json
  ```
- **Hermes precedent reread:** `.claude/` path protection fires on `Edit`/`Write`/`MultiEdit` tool calls. Since SDK subprocess is locked to `mcp__aletheia__*` (no Edit/Write/MultiEdit), this protection class never fires. The MCP server's own writes (creating sdk-agent setup files) are not subject to CC's tool permission system.

### Finding 4 — `claude` CLI flag set VERIFIED
**Strength:** core — verified against `claude --help` output (CC 2.1.119).
- All design-assumed flags exist: `--allowed-tools`, `--model`, `--session-id`, `--mcp-config`, `--strict-mcp-config`, `--permission-mode`
- Bonus flags discovered: `--bare`, `--no-session-persistence`, `--print`/`-p`, `--disable-slash-commands`, `--tools ""`
- `--print` skips workspace trust dialog (per help text)
- `--bare` skips: hooks, LSP, plugin sync, attribution, auto-memory, background prefetches, keychain reads, CLAUDE.md auto-discovery
- Auth in `--bare`: strictly `ANTHROPIC_API_KEY` env or `apiKeyHelper` via `--settings`

### Finding 5 — SQLite ATTACH + WAL behavior VERIFIED with critical caveat
**Strength:** mandatory — surface caveat to Kyle for design awareness.
- **Confirmed:** ATTACH + WAL + readonly URI fully supported. 10-DB default attach limit (125 hard max). Per-file pagers, separate `-wal`/`-shm` per DB.
- **Critical caveat (per official SQLite docs):** *"Transactions that involve changes against multiple ATTACHed databases are atomic for each individual database, but are not atomic across all databases as a set."* In WAL mode specifically, there is no master-journal mechanism — a power loss during cross-DB commit can tear the transaction (some DBs commit, some don't).
- **Each individual .db remains internally consistent.** What's lost is cross-database consistency.
- **Design impact analysis:**
  - `write_memory` to primary: NO RISK (single DB write).
  - `write_memory` to writable sibling (e.g., PM writes to project memory): NO RISK (single DB write).
  - **`promote_memory(entry_id, target_scope)`:** RISK. Tombstones source + inserts target = 2-DB write. Power loss could leave source tombstoned with no target, or target without source tombstoned.
  - **`feature_wrap_up` synthesis:** RISK if synthesized memories land in different scope from source journals. Cross-DB writes possible.
  - **`migrate_from_v1`:** RISK by definition (writes to N scope DBs in one transaction). Mitigated by being one-shot, master-key gated, with `confirm_backup_taken=true`.
  - **`start_migration` per-scope DDL:** SAFE per-scope (per the design — each scope COMMIT is atomic; failure mid-migration leaves partial state, recoverable via `resume_migration`).
- **Mitigation paths:**
  - Application-level reconciliation on MCP server startup: scan recent audit log for `*_proposed`/`*_started` events without matching `*_committed`/`*_completed`; verify source/target consistency; clean up.
  - Make cross-scope writes idempotent (same input produces same output, retryable).
  - Document this in implementation plan as a known property of WAL+ATTACH; don't pretend it's atomic.
- **Performance:** 5-10 attached DBs per connection = 30 file descriptors. Negligible. `PRAGMA synchronous = NORMAL` (default) gives fast writes; `FULL` would force fsync per-DB on multi-DB commit (slow). Recommend `NORMAL`.
- **Source:** sqlite.org official docs.

### Finding 6 — DDL on attached DBs VERIFIED
**Strength:** core
- DDL (CREATE/ALTER/DROP) requires a writable connection to the target DB.
- Per design `start_migration` flow: iterates scopes; for each, opens a direct writable connection (not via ATTACH). This is correct.
- ATTACH'd readonly DBs cannot run DDL. ATTACH'd writable DBs CAN run DDL but each must be opened individually for clean migration.

### Finding 7 — Rust ecosystem VERIFIED feasible
**Strength:** context — Phase 3 decision input for Rust vs Node.
- **Verdict:** Rust feasible with bounded risks. Node.js safer if the tool surface is still iterating.
- **Per-area findings:**
  - **`rmcp 1.5.x`:** Production-ready (used by `rustfs-mcp`, `containerd-mcp-server`); recent API churn (`#[non_exhaustive]` builder patterns, `#[tool]` macro changes). Expect ~1-3 days migration tax per major upgrade.
  - **SQLite — `rusqlite` is correct choice.** ATTACH semantics map perfectly to per-connection lifetime. `sqlx` would require `after_connect` re-attach hooks. `bundled` feature for cross-platform builds.
  - **npm distribution of Rust binary** — `optionalDependencies` pattern (esbuild/swc/biome model) works. `cargo-dist` automates most of it. **Critical caveats for MCP:** JS wrapper shim must (1) use `stdio: 'inherit'` (no `console.log` — corrupts JSON-RPC), (2) trap SIGINT/SIGTERM and forward to child Rust process (or Rust binary becomes zombie on CC exit), (3) keep binaries small to avoid first-run `npx` timeout vs CC's MCP init timeout (~30s).
  - **Cross-platform Unix socket / Named pipe:** `interprocess` crate v2.x (Tokio-integrated, single API). Solved problem.
  - **Subprocess spawning:** `tokio::process::Command` works; needs `kill_on_drop(true)` for lease-expiry cleanup.
- **Key tradeoff:** Iteration speed (Rust 5-30s incremental compiles vs Node sub-second). Strong factor IF Aletheia's tool surface is still being explored. Less strong if surface is settling.
- **Memory: ~5-15MB resident vs Node's 80-150MB.** Real win if user runs many MCP servers concurrently.
- **Distribution win neutered:** `npm install -g aletheia` is locked in → user already has Node → Rust's "no runtime needed" advantage doesn't apply.

### Finding 8 — V1 codebase architecture VERIFIED, 10 deltas mapped
**Strength:** core
- V1 stack: TypeScript/Node, MCP SDK 1.29+, better-sqlite3 12.8+, smol-toml, proper-lockfile.
- Schema version 4 (current). 12 tables across `entries` / `journal_entries` / `memory_entries` / `memory_versions` / `handoffs` / `status_documents` / `status_sections` / `tags` / `entry_tags` / `memory_journal_provenance` / `keys` / `schema_version`.
- 25 MCP tools. Dual transport: stdio MCP + Unix socket HTTP API for hook-time injection (`/state`, `/context`, `/handoff`, `/session-info`, `/health`, `/reset-frequency`, `/claim`).
- Hooks: bash on Unix, JS on Windows. `startup.sh` + `l1-inject.sh` + `l2-inject.sh` + `memory-intercept.sh`.
- Session state in memory only — **no `session_bindings` persistence** (V2 adds).
- Auth: 4-level hierarchy (read-only / read-write / create-sub-entries / maintenance). Revocation supported via `revoked` flag (added in migration 4).
- **Major V1→V2 deltas:**
  1. Single `aletheia.db` → per-scope `.db` files via ATTACH (architectural shift)
  2. In-place UPDATE on memory_entries → append-only INSERT with `valid_from`/`valid_to`
  3. No `content_hash` column → V2 adds for dedup
  4. `version_id` opaque hex → INTEGER `version` starting at 1
  5. No `digested_at` workflow → V2 adds for journal absorption tracking
  6. No `session_bindings` → V2 adds (with the workaround above)
  7. No `sys_audit_log` → V2 adds + SQLite trigger for immutability
  8. No feature lifecycle → V2 adds (features table + state machine)
  9. No SDK digest subprocess → V2 adds (V1 has critical-flag promotion only, no LLM digest)
  10. No `scope_registry.db` → V2 adds (V1's project_namespace is implicit on entries)
- **Status section in V1:** Already has `status_sections` table with section/state/position. **V2's section-granular append-only just adds version_id + valid_from/valid_to to this table.** Cost-profile preservation verified.
- **YAML-in-XML claim:** V1 actually returns **JSON** (not YAML-in-XML). Design doc claim is incorrect. Verify with Kyle whether the format change is intentional or doc-error.

### Finding 9 — digest_queue multi-MCP-process: NEW DESIGN CONCERN
**Strength:** mandatory — surface to Kyle.
- **Concern:** Each Claude Code session spawns its own MCP server (separate Node process). With 5 concurrent sessions (CEO + 2 PMs + 2 TLs), there are 5 MCP server processes. All 5 read/write the same `~/.aletheia/scope_registry.db` and the same `digest_queue` table.
- **Race conditions to handle:**
  - **Lease acquisition:** Two MCP servers see same pending queue row → both try to lease. Solution: SQL `UPDATE digest_queue SET leased_by_pid=?, lease_expires_at=? WHERE queue_id=? AND status='pending' RETURNING *`. RETURNING ensures only one process gets the row. Standard pattern.
  - **SDK subprocess spawning leadership:** Who actually spawns the `claude -p` subprocess after lease? The MCP server that won the lease. The other MCP servers see `leased_by_pid != my_pid` and skip. ✓ Solvable.
  - **Crash recovery:** Lease TTL expiry triggers re-queue. The MCP server that detects expiry (via background poll or next-write check) does the requeue. Standard pattern.
- **Implementation requirements (must be in plan):**
  - Background poller in each MCP server (e.g., every 60s) checks `digest_queue` for: (a) pending rows it could lease, (b) leased rows whose `lease_expires_at < NOW` (re-queue with retry_count++).
  - Lease acquisition uses single-row UPDATE with WHERE clause to prevent races.
  - Spawned SDK subprocess writes `committed_at` on success, `error_message` + `failed` status on failure.
- **Not a blocker, but plan must explicitly address.**

### Finding 10 — `migration_in_progress` global flag: NEW DESIGN CONCERN
**Strength:** mandatory — surface to Kyle.
- **Concern:** Design says "hard-block all tool calls during `applying`." With multiple MCP server processes, the flag in `scope_registry.db` is the single source of truth. But each MCP server has its own settings/state cache. Does each tool call hit `scope_registry.db` to check the flag, or is the flag cached?
- **Recommended:** Every tool call checks `migration_state.is_applying` via fast indexed read on `scope_registry.db` (which is always attached). Cost: ~1ms per tool call. Cheap.
- **Alternative:** OS-alert broadcast triggers per-process cache invalidation. More complex; not needed for V2 if per-call check is acceptable.
- **Edge case:** A tool call in flight when migration starts → call completes its current SQL transaction, but next call blocks. The 30s "write drain" in the design accommodates this.
- **Plan implication:** Document that all tool handlers must `SELECT is_applying FROM migration_state LIMIT 1` (or equivalent) as their first step, returning `MIGRATION_IN_PROGRESS` error if true. Trivial to implement; just must not be forgotten.

---

### Audit summary
- **VERIFIED:** Items 1, 4, 6, 7 (Rust feasibility), 8 (V1 codebase) — no further action required.
- **VERIFIED with caveat:** Items 3 (SDK launch — design simplification recommended), 5 (cross-DB atomicity — application reconciliation needed).
- **DESIGN CONFLICT (mandatory user input):** Item 2 (session ID source — workaround needed; affects scope of plan: new SessionStart hook + new MCP server startup logic).
- **NEW DESIGN CONCERN (mandatory user input):** Item 9 (multi-process digest leader election — implementable but must be explicit), Item 10 (migration flag check pattern — trivial but must not be forgotten).
- **Minor doc-error:** Item 8 sub-finding — design says hooks return YAML-in-XML; V1 actually returns JSON. Confirm format choice.

### User Decisions (2026-04-26 first round)

**Strength:** mandatory.

- **A1 session-ID workaround:** APPROVED — implement SessionStart hook + per-PPID file-handoff pattern. Plan must include `sessionstart-bind.sh` (Unix) + `.js` (Windows) hook files, MCP server startup logic to read `~/.aletheia/sessions/<my_ppid>.session_id` with brief retry/wait, graceful degradation when discovery fails (fall back to user calling `claim(key)` explicitly).

- **A2 SDK launch — `--bare` REJECTED.** Reason: Kyle has Anthropic top-tier subscription and explicitly does NOT want to introduce ANTHROPIC_API_KEY billing. `--bare` skips OAuth/keychain reads, so subscription billing would not apply.

- **A3 WAL+ATTACH atomicity caveat:** APPROVED — accept caveat, add startup reconciliation pass scanning `sys_audit_log` for orphaned cross-DB operations.

- **B1 multi-process digest leader election:** APPROVED — SQL `UPDATE ... WHERE status='pending' RETURNING *` lease pattern + per-MCP-server background poller for leasing and crash-recovery.

- **B2 migration flag check pattern:** APPROVED — every tool handler checks `migration_state.is_applying` as first step.

- **C hooks payload format:** Pending Kyle confirmation in next round (JSON vs YAML-in-XML).

### Finding 11 — OAuth-preserving SDK isolation (post-A2 spike)
**Strength:** core — unblocks A2 with a different mechanism than `--bare`.

After A2 rejected `--bare`, ran 5 diagnostic spikes (B-F) testing flag combinations to find an OAuth-compatible isolation pattern. **Spike E succeeded:**

```bash
claude -p "<prompt>" \
  --mcp-config <inline-or-file> \
  --strict-mcp-config \
  --settings '{"claudeMdExcludes":["**/*"],"hooks":{},"enabledPlugins":{}}' \
  --setting-sources local \
  --disable-slash-commands \
  --allowed-tools "mcp__aletheia__*" \
  --tools "" \
  --permission-mode bypassPermissions \
  --no-session-persistence \
  --model opus \
  --output-format stream-json
```

**Spike comparison (haiku, OAuth, "Reply READY" prompt, empty MCP config):**

| Spike | Flags | cache_read | cache_create | Contamination |
|---|---|---:|---:|---|
| B | `--setting-sources ""` only | 26848 | 5998 | Auto-memory loaded ("SQLite migrations, token-budget loops, Hermes alignment" mentioned) |
| C | claudeMdExcludes inline only | 31872 | 9566 | Project context fully visible ("v0.2.8 with key revocation, Hermes alignment, OAuth isolation spike") |
| D | C + disable-slash + tools "" | 0 | 10310 | Branch + git status leaked ("you're working in the sdk-spike-oauth-isolation branch") |
| **E** | D + `--setting-sources local` | **0** | **6698** | **None — minimal "READY" reply** |

**Findings on flag semantics:**
- `--setting-sources ""` (empty string) does NOT skip inheritance — falls through to default (user, project, local).
- `--setting-sources local` correctly skips user (`~/.claude/`) and project (`<project-root>/.claude/`) settings, loading only the cwd's `.claude/`.
- `--settings <inline>` is ADDITIVE to whatever sources are loaded — without `--setting-sources` constraint, it merges into inherited settings rather than replacing them.
- `--disable-slash-commands` is required to suppress Skill auto-discovery (else skill descriptions load into context).
- `--tools ""` (empty string) is required to disable built-in tools when paired with `--allowed-tools "mcp__aletheia__*"` (allowedTools alone doesn't restrict built-in tools).
- `--print` (`-p`) skips the workspace trust dialog (per `claude --help`).
- `--no-session-persistence` only works with `--print` mode.
- `--permission-mode bypassPermissions` is defense-in-depth; not strictly required since tools are already restricted.

**Design implication — `<parent_cwd>/.aletheia/sdk-agent/` is no longer needed.** With `--setting-sources local` + inline `--settings`, the subprocess can launch from ANY cwd (even `/tmp`) and pull no contamination. The design's per-cwd setup was a workaround for a problem that this flag combination solves directly. **Simplification:**
- Drop the `<parent_cwd>/.aletheia/sdk-agent/CLAUDE.md` file (claudeMdExcludes covers it)
- Drop the `<parent_cwd>/.aletheia/sdk-agent/.mcp.json` file (--strict-mcp-config + inline --mcp-config covers it)
- Drop the `<parent_cwd>/.aletheia/sdk-agent/.claude/settings.local.json` file (--setting-sources local + inline --settings covers it)
- Drop the `<parent_cwd>/.aletheia/sdk-agent/digest-context-<queue_id>.md` file (pass digest context inline via prompt)
- Drop the `<parent_cwd>/.aletheia/.gitignore` file (no `.aletheia/` directory created)
- Drop the entire `<parent_cwd>/.aletheia/sdk-agent/` directory creation step from MCP server bootstrap

**The MCP server can launch the subprocess from its own working directory or `/tmp/aletheia-digest-<queue_id>/`.** The latter is recommended for any tooling that does inspect cwd (none expected, but it's free).

**Cost profile:** ~6.7k cache_create per cold start with this flag combination (system prompt baseline). For opus digest runs, this is a small overhead vs the actual digest workload. Acceptable.

**This resolves A2 cleanly:**
- OAuth preserved (subscription billing intact)
- Equivalent isolation to `--bare`
- Per-cwd setup eliminated (material simplification)

**Plan must specify the exact flag combination above; no flag is optional.**

### Phase 2 closeout

All audit items resolved. Ready to proceed to Phase 3 (Implementation Discussion). Outstanding for Phase 3:
- Rust vs Node language decision (Rust feasibility data ready)
- Hooks payload format confirmation (JSON or YAML-in-XML)
- V1→V2 row-transform details for `migrate_from_v1` (10 deltas catalogued, mechanics need walking through)
- Settings.toml schema delta (V1 has 6 sections; V2 adds at least retention, mass_ingest, shadow, injection.weights, injection.relevance)
- KG-stub surface design (where do V3 graph_proximity hooks plug into V2's relevance pipeline)
- Cross-DB reconciliation logic specifics
- npm packaging caveats applied to chosen language

---

## Phase 3: Implementation Discussion

### Decision Q1 — Implementation language: Rust

**Strength:** core
**Decision:** Rust (rmcp + rusqlite + interprocess + tokio + cargo-dist for npm distribution).
**Rationale:** Memory footprint at scale is the primary technical driver — Kyle envisions many concurrent CC sessions, each spawning its own Aletheia MCP server. Node baseline is ~80-150MB resident vs Rust ~5-15MB. With ~5 active sessions today and growth toward "many," the difference compounds (5 sessions × 100MB = 500MB Node vs ~50MB Rust; 20 sessions = 2GB vs ~250MB). Single-binary distribution is cleaner than npm + node_modules + native bindings. Type-system discipline on SQL paths catches bugs.
**Alternatives considered:** Node.js (TypeScript) with @modelcontextprotocol/sdk + better-sqlite3 — preserves V1 stack continuity, faster iteration speed (sub-second vs 5-30s), more mature MCP SDK ecosystem, simpler npm distribution. The Arranger's honest assessment (Kyle confirmed): technical merits roughly 55/45 toward Node, tipped to ~60/40 toward Rust by Kyle's preference + memory-at-scale reasoning. Rust selected on the back of memory considerations + single-binary distribution + Kyle's stated preference where it makes sense.
**Impact:**
- Build pipeline: cargo-dist with optionalDependencies pattern (esbuild/swc/biome model). Multi-target CI matrix. ~3 days setup budget.
- MCP server: rmcp 1.5.x. Tool registration via `#[tool]` macros + `schemars` for JSON Schema. ~2 days setup boilerplate.
- SQLite: rusqlite with `bundled` feature for cross-platform. Per-connection ATTACH lifecycle. Standard rust patterns.
- Cross-platform IPC: `interprocess` crate v2.x abstracts Unix sockets / Windows named pipes uniformly.
- Subprocess spawning: tokio::process::Command + `kill_on_drop(true)` for lease-expiry cleanup.
- npm distribution: tiny wrapper package + N platform-specific binary packages in `optionalDependencies`. JS wrapper shim must use `stdio: 'inherit'` and forward SIGINT/SIGTERM to child Rust binary (else zombie processes on CC exit).
- rmcp upgrade tax: ~1-3 days every 3-4 months.
- V1 hooks (bash on Unix, JS on Windows) remain unchanged — they're CC-installed user hooks, not Aletheia binaries. Language choice doesn't affect hook scripts; only the server binary changes.
**External input:** Phase 2 Rust ecosystem subagent findings + Gemini "rmcp 1.5.x maturity + npm Rust distribution" query.

### Decision Q2 — Hooks payload format: JSON

**Strength:** core
**Decision:** L1/L2 hook responses use **JSON** (preserving V1's actual behavior).
**Rationale:** V1 returns JSON via `endpoints.ts` (`res.end(JSON.stringify(payload ?? {}))`). The V2 design's "YAML-in-XML inherited from V1" is a doc-error: the parenthetical "inherited from V1" implies the Dramaturg believed V1 was YAML-in-XML, but it isn't. Switching to YAML-in-XML would force a rewrite of all V1 hook scripts (bash + JS) and require a YAML parser in user shell environments (`yq` not universally installed; `jq` is). LLM consumption: no quality difference between JSON and YAML-in-XML for hook payloads.
**Alternatives considered:** YAML-in-XML — rejected as design doc-error; no rationale offered for the change.
**Impact:** V2 design doc §5 should be amended to say "Emit JSON injection payload (V1 format inherited)." The plan inherits V1's hook script behavior unchanged. No new hook-side parsing libraries needed.

### Decision Q3 — Digest subprocess working directory: `~/.aletheia/sdk-runtime/<queue_id>/`

**Strength:** core
**Decision:** Each digest subprocess launches with cwd = `~/.aletheia/sdk-runtime/<queue_id>/`. MCP server creates the directory before spawn (`mkdir -p`, idempotent); deletes on success commit; preserves on failure for post-mortem inspection. Background retention sweep (in MCP server) cleans orphans older than 24 hours.
**Rationale:** Lives within Aletheia's blast radius (user already trusts `~/.aletheia/`). Per-queue-id subdirectory naturally isolates parallel digest runs (different scopes can run concurrent digests; only the lease-winner creates each subdir). Survives reboot for forensics. Easy to enumerate via `ls ~/.aletheia/sdk-runtime/`. With OAuth-preserving isolation flags (Q1 from Phase 2 Finding 11), no setup files needed in the cwd.
**Alternatives considered:**
- Inherit MCP server's cwd — rejected: opaque in `ps aux`, mixes inadvertent debris with project files.
- `/tmp/aletheia-digest-<queue_id>/` — rejected: `/tmp` may be size-limited tmpfs, lost on reboot.
**Impact:** Plan must include MCP server function `prepare_digest_cwd(queue_id) -> PathBuf` (mkdir before spawn) and `cleanup_digest_cwd(queue_id, success: bool) -> ()` (delete on success). Background retention sweep added to `digest_queue` background poller (60s cadence) — sweep `sdk-runtime/` for dirs older than 24h with no corresponding active queue row.

### Decision Q4 — session_id discovery file format: single-line plain text

**Strength:** core
**Decision:** SessionStart hook writes `~/.aletheia/sessions/<my_pid>.session_id` containing the session_id UUID followed by a single newline. No JSON wrapper, no metadata. File mode 0600.
**Rationale:** Trivial to write/read from bash + Windows JS hooks (`echo "$session_id" > file`); trivial to read from MCP server (Rust `fs::read_to_string()?.trim()`); no parsing failure modes; immediately auditable by user (`cat`). PID in filename + file mtime provide all metadata without serialization.
**Alternatives considered:** JSON wrapper (`{"session_id":"...","pid":...,"claimed_at":"..."}`) — rejected as overkill; metadata redundantly available from filename + filesystem.
**Impact:**
- New file: `hooks/unix/sessionstart-bind.sh` — parses stdin JSON for `session_id`, writes file
- New file: `hooks/windows/sessionstart-bind.js` — same logic, JS implementation
- New `~/.aletheia/sessions/` directory created at bootstrap (mode 0700)
- MCP server startup: read `~/.aletheia/sessions/<my_ppid>.session_id` with up to 2s polling (100ms backoff) for the race where MCP starts before hook completes; fall back to no-auto-reclaim if not found
- Background retention sweep: prune `sessions/<pid>.session_id` files where the PID no longer exists (process.kill(pid, 0) check) — every 5 minutes, no LLM

### Decision Q5 — V1→V2 row-transform mechanics

**Strength:** core
**Decision:** Per-table transform plan documented in Phase 3 conversation. Migration is largely 1-to-N row expansion (V1's 2-level hierarchy → V2's flat model), not 1-to-1 rename. Atomic structural migration for ALL scopes; lazy per-scope digest pass at first claim per CEO Item 4.
**Sub-decisions confirmed:**
- **Q5A — V1 memory_entries' `key` field:** V1.key → tag prefix (`key:<v1_key_value>`); plus `entry_id_legacy:<v1-uuid>` tag preserves grouping for "show me all memories under V1 entry X" queries.
- **Q5B — `memory_journal_provenance`:** KEPT in V2 per-scope schema. Useful for synthesis lineage queries; supports V3 KG as a `derived_from` edge type.
- **Q5C — Keys metadata location:** `scope_registry.db.keys` table (alongside session_bindings, scopes). Raw key values stay in `~/.aletheia/keys/<name>.key` files (mode 0600). Auth: `claim(key_value)` → SHA-256 hash → lookup by `key_hash` in DB. Raw key value never stored in DB.
- **Q5D — `journal_entries.sub_section`:** Tag prefix `sub_section:<value>` on V2 entry.
**Per-table transform plan (locked):**

| V1 source | V2 destination | Key transformations |
|---|---|---|
| `schema_version` | `migration_state` row | V1 schema_version=4 recorded in metadata |
| `entries` (container) | drives scope assignment + joins, NOT migrated as row | `project_namespace` → scope; null → `default` |
| `journal_entries` | `entries` (entry_class='journal') | new entry_id; content_hash computed; `valid_from`=created_at; `valid_to=NULL`; `digested_at` preserved; tags joined+sub_section tag |
| `memory_entries` (active) | `entries` (entry_class='memory') | new entry_id; key→tag; entry_id_legacy→tag; content=value; `valid_from`=updated_at; `valid_to=NULL`; version=1 |
| `memory_entries` (archived) | `entries` (entry_class='memory', tombstoned) | as above + `valid_to`=archived_at; `invalidation_reason`="retired:migrated_from_v1" |
| `memory_versions` (history) | `entries` (entry_class='memory', tombstoned) | sequential version numbers per V1 memory_entry |
| `handoffs` | `entries` (entry_class='handoff') | new entry_id; V1.target_key → `target_key:<v1_target_key>` tag |
| `status_documents` | `entries` (entry_class='status') | new entry_id; undo_content+version_id DROPPED |
| `status_sections` | `status_sections` (per-scope) | preserved + new version=1, valid_from=NOW, valid_to=NULL |
| `tags`+`entry_tags` | DROPPED (denormalized into entries.tags JSON) | tag arrays serialized per entry during migration |
| `memory_journal_provenance` | KEPT in V2 per-scope | preserved as-is (Q5B) |
| `keys` | `scope_registry.db.keys` + `~/.aletheia/keys/<name>.key` files | metadata in DB; raw value in file (Q5C) |

**Other migration mechanics (no user input needed):**
- All `created_by_key_hash` for migrated entries = NULL (V1 stored UUID not raw key; original raw value not recoverable)
- `content_hash` computed during migration: SHA-256(content+scope_id)
- Sequential `version` numbers assigned per (entry_id) ordered by created_at/updated_at
- `feature_id = NULL` (V1 had no features)
- `reasoning_trace = NULL` (V1 had no TiM pattern)
- `critical_flag = 0` (V1's critical was on writes; default 0 for migration; user re-flags manually)
- Per-scope `.db` file naming: `<scope_uuid>.db` (UUIDs minted during migration)
- V1 DB renamed to `aletheia-v1-pre-migration.db.bak` post-migration; never deleted
- Migration audit logged via `v1_migration_*` event types in `sys_audit_log`
- Migration report includes per-scope row counts, dropped table data summary
- All keys retain working credentials post-migration (no user re-bootstrap needed)
**Impact:** Plan must include a dedicated phase or section for `migrate_from_v1` implementation: V1 schema introspection, per-scope partitioning logic, row-transform functions per V1 table, content_hash computation, sequential version numbering, scope_registry seeding, key migration logic, audit log seeding. Implementation can be shared between Rust binary and a thin npm-distributed migration tool that wraps it.

### Decision Q6 — settings.toml schema

**Strength:** core
**Decision:** V2 ships a complete `settings.toml` with sections per the Phase 3 conversation. New sections: `[injection.relevance]`, `[injection.weights]` (HashMap-typed), `[injection.recency]`, `[digest_queue]`, `[mass_ingest]`, `[shadow]`, `[session_locks]`, `[retention]`, `[features]`, `[migration]`, `[scopes]`. Existing V1 sections preserved with only one change: `[digest].entry_threshold` raised from 15 → 50 default + per-scope override capability (`[digest.per_scope]`) per CEO Item 3. `[hooks]` adds `session_start_bind = true` for the new SessionStart hook (Q4).
**Defaults:** all values per Phase 3 conversation (heartbeat 60/180, mass_ingest approval_ttl 24h, retention 365d/audit 1825d, shadow disabled, etc.) — design + CEO feedback values used throughout.
**Critical implementation note:** `[injection.weights]` MUST be parsed as `HashMap<String, f64>` (not a fixed-key struct). V3 will add `graph_proximity` key without V2 code change.
**Impact:** Plan includes settings.toml schema as part of foundation phase. `src/lib/settings.rs` (or equivalent Rust module) handles deserialization with serde + smol-toml-equivalent (Rust: `toml` crate). All defaults baked in via `getDefaults()` pattern (V1 inheritance).

### Decision Q7 — KG-stub surface design

**Strength:** core
**Decision:** V2 ships 7 architectural patterns that allow V3 KG extensions without V2 code changes:
1. **Pluggable `Signal` trait** in scoring pipeline (Rust trait with `name()` + `score()`); V2 ships 4 implementations (TagOverlap, Recency, ActiveProject, Critical); V3 adds GraphProximity as 5th
2. **`[injection.weights]` as HashMap** (Q6) — V3 adds key non-breaking
3. **`Context` struct extensible via `Option<>` + serde defaults** — V3 adds `graph_anchor_nodes: Option<Vec<NodeId>>`
4. **`memory_journal_provenance` table preserved** (Q5B) — V3 KG uses as `derived_from` edge type
5. **Dedup response struct extensible** — V3 adds `related_entries: Option<Vec<EntryId>>` field
6. **`show_related` tool minimal signature** — V2 implements with tag-overlap; V3 swaps to graph-traversal without MCP surface change
7. **`query_past_state` minimal signature** — V3 adds optional `include_graph_context: bool` param (backward-compatible)

**Impact:** Plan must include explicit notes in code-comments at all 7 stub locations referencing the V3 KG handoff doc. Forward-compat verification step in Phase 6 — verify all 7 patterns are in place before commit.

### Decision Q8 — Cross-DB reconciliation logic

**Strength:** core
**Decision:** Reconciliation runs at MCP server startup + every 5 minutes (background sweep, no LLM) + on-demand via master-key `reconcile()` tool. Scans `sys_audit_log` for recent (24h) `*_proposed`/`_started` events without matching `*_committed`/`_completed`. Per operation type:
- `promote_memory`: idempotent recovery (insert target if missing, tombstone source if missing, back-fill `_committed` event if both done)
- `feature_wrap_up`: re-run synthesis (idempotent via content_hash dedup)
- `migrate_from_v1`: mark migration_state failed; require user intervention
- `start_migration`: per-scope; resume_migration() continues from last completed scope

Reconciliation logs each action as `reconciliation_*` audit events. If reconciliation itself fails (e.g., DB corruption), surfaces error; doesn't retry indefinitely.
**Impact:** Plan adds dedicated `reconciler` module in MCP server. New `reconcile()` MCP tool (master-key only). Background poller invokes reconciler periodically.

### Decision Q9 — Poll cadences

**Strength:** core
**Decision:**
- Mass-ingest approval polling: 30s (configurable `[mass_ingest.approval_polling_interval_seconds]`)
- Digest queue background poller: 60s (configurable `[digest_queue.poll_interval_seconds]`)
- Reconciliation periodic sweep: 5 minutes (configurable `[scopes.reconciliation_interval_minutes]`)
- Session_id file orphan sweep: 5 minutes (configurable `[scopes.session_orphan_sweep_minutes]`)
- sdk-runtime/ orphan cleanup: 24h (already settled in Q3 via `[scopes.sdk_runtime_cleanup_hours]`)
**Impact:** All cadences in `[digest_queue]`, `[mass_ingest]`, and `[scopes]` settings sections. Background poller in MCP server implements all of them with proper graceful-shutdown handling.

---

### Phase 3 Decision Inventory (checkpoint)

All settled implementation-level decisions for V2:
1. **Q1** — Implementation language: Rust (rmcp + rusqlite + interprocess + tokio + cargo-dist)
2. **Q2** — Hooks payload format: JSON (preserves V1 actual behavior; design's "YAML-in-XML" was doc-error)
3. **Q3** — Digest subprocess cwd: `~/.aletheia/sdk-runtime/<queue_id>/` per-run
4. **Q4** — session_id discovery file: single-line plain text at `~/.aletheia/sessions/<my_pid>.session_id` (mode 0600)
5. **Q5** — V1→V2 row-transform mechanics (4 sub-decisions: key→tag, provenance kept, keys metadata in scope_registry.db, sub_section→tag)
6. **Q6** — settings.toml schema (V1 sections preserved + 11 new V2 sections)
7. **Q7** — KG-stub surface design (7 architectural patterns for V3 forward-compat)
8. **Q8** — Cross-DB reconciliation logic (startup + 5min sweep + master-key on-demand)
9. **Q9** — Poll cadences (mass-ingest 30s, digest queue 60s, reconciliation 5min, session orphan 5min, sdk-runtime cleanup 24h)

Plus carried-from-Phase-2:
- **A1** — SessionStart hook + file-handoff pattern for session_id discovery
- **A2** — OAuth-preserving SDK isolation flag combination (NOT --bare; eliminates per-cwd setup files)
- **A3** — Accept WAL+ATTACH cross-DB atomicity caveat + add reconciliation
- **B1** — SQL `UPDATE...RETURNING` lease pattern for multi-MCP-server queue leader election
- **B2** — `migration_in_progress` per-handler check pattern

**Inventory confirmation:** all decisions needed for plan structuring are settled. No outstanding implementation-level questions identified. Ready to proceed to Phase 4 (Phase Structuring).

---

## Phase 4: Phase Structuring

### Strategic decomposition rationale

**Greenfield V2 in Rust** — most files are wholly new, eliminating most "danger file" coordination but elevating internal phase parallelization as the primary lever. Decomposition driven by: (1) early foundation phases unblock everything, (2) auth+sessions and MCP server core are independent and can run parallel, (3) tool surface is the largest phase (8+ tools by category, all parallel within), (4) digest pipeline depends on tools but is otherwise independent, (5) V1→V2 migration tool is mostly independent of digest pipeline, (6) reconciliation + Shadow Mode infrastructure are operational polish that can backfill late.

### Phase plan (10 phases)

| # | Phase | Depends on | Internal parallelism | Outputs |
|---|---|---|---|---|
| 1 | Foundation | — | low (early bootstrap) | Cargo workspace, types, settings.toml parser+schema, basic CI |
| 2 | Storage Foundation | 1 | medium (5 subtasks parallel) | Per-scope DB schema, scope_registry schema, sys_audit_log + immutability trigger, ATTACH wiring, generic migration framework |
| 3 | Auth + Sessions | 2 | high (5 subtasks parallel) | Keys (file+hash+metadata), session_bindings, session_locks+heartbeat, claim/whoami/refresh, SessionStart hooks (sh + js) |
| 4 | MCP Server Core + Hook Endpoint | 2 (parallel with 3) | medium (4 subtasks parallel) | rmcp setup, server lifecycle, interprocess Unix socket / Windows named pipe, HTTP endpoint server (V1 hook injection compat) |
| 5 | Tools (V1-Equivalent + V2-New) | 3, 4 | very high (8+ subtasks parallel by category) | All 25 V1-equivalent tools + V2-new (feature lifecycle, time-travel, promote_memory, active project/context, append-only versioning enforcement) |
| 6 | Hook Layer + Injection Pipeline | 4, 5 | high (6 subtasks parallel) | V1 hook scripts (sh/.js compat), Signal trait + 4 V2 implementations (Q7 stubs), threshold-gated Top-K scorer, L1/L2 builders, frequency manager, KG-stub verification |
| 7 | Digest Pipeline + Mass-Ingest | 5 | high (6 subtasks parallel) | digest_queue + leasing pattern, SDK subprocess launch (OAuth flag combo), digest agent prompt template, background poller (lease+crash recovery), mass_ingest approval polling, checkpointing |
| 8 | V1→V2 Migration Tool | 2, 3, 7 | very high (6+ subtasks — one per V1 table) | migrate_from_v1, V1 schema introspection, per-scope partitioning, row-transform functions, content_hash+sequential versions, scope_registry seeding, key migration, lazy first-claim digest trigger marker |
| 9 | Reconciliation + Operational Polish + Shadow Mode | 6, 7 | high (4 subtask groups parallel) | Reconciler module + cross-DB recovery handlers, reconcile() MCP tool, background sweeps, tool deprecation lifecycle, session_id+sdk-runtime orphan sweepers, shadow_comparison_log + sampling hook + analyze_shadow_mode tool + v1_rank pluggable signal interface |
| 10 | Distribution + Release | All previous | medium (4 subtasks parallel) | cargo-dist (optionalDependencies pattern), JS wrapper shim (stdio inherit + signal forwarding), GitHub Actions multi-target matrix, npm publish workflow, documentation |

### Critical path

`1 → 2 → (3 ∥ 4) → 5 → (6 ∥ 7) → (8 ∥ 9) → 10`

Sequential depth: 7 phase-steps. With internal parallelism, total wall-clock time depends on Conductor's parallelism budget. Phase 5 (tools) is the longest single phase by token count; Phase 8 (migration) is the most parallelizable by sub-task count.

### Cross-task integration surfaces

| # | Surface | Phases involved | Contract |
|---|---|---|---|
| IS-1 | Per-scope DB schema → all consumers | Phase 2 → 3, 4, 5, 6, 7, 8, 9 | Schema is fixed in Phase 2; consumers query via established columns. Conductor checkpoint: verify schema_version matches expected |
| IS-2 | scope_registry.db schema → cross-MCP-server queries | Phase 2 → 3, 4, 7, 9 | Tables (scopes, session_bindings, session_locks, digest_queue, mass_ingest_requests, sys_audit_log, shadow_comparison_log, migration_state) all defined in Phase 2; downstream phases query via specified column contracts |
| IS-3 | claim() result → all tool handlers | Phase 3 → 5 | Permission set struct {primary_scope_id, writable_scope_ids[], readonly_scope_ids[]} consumed by every write handler's `target_scope ∈ writable` check |
| IS-4 | rmcp tool registration framework → tool implementations | Phase 4 → 5 | Tools register via `#[tool]` macro; framework dispatches; conventions for response-format struct (XML emission) |
| IS-5 | Hook endpoint server → Hook scripts | Phase 4 → 6 | Endpoints (`/state`, `/context`, `/handoff`, `/session-info`, `/health`, `/reset-frequency`) return JSON; hook scripts (sh/.js) consume |
| IS-6 | Signal trait + scoring engine → KG forward-compat | Phase 6 → V3 | V2 ships pluggable trait + HashMap weights; V3 plugs GraphProximitySignal without V2 code change. Phase 6 adds explicit code-comment markers |
| IS-7 | digest_queue + SDK subprocess → MCP tool calls | Phase 7 → 5 | Subprocess invokes `mcp__aletheia__*` tools via MCP protocol; tools accept digest key for narrow auth |
| IS-8 | Migration framework → V1→V2 migration | Phase 2 → 8 | `migrate_from_v1` is gated separately from `start_migration` (per Topic 4); both share the migration_state table; both record events to sys_audit_log via `migration` event_category |
| IS-9 | Audit log → Reconciler | Phase 2 → 9 | Reconciler scans `sys_audit_log` for orphaned events; depends on stable event_type vocabulary established in Phase 2/3/4/5/7 |
| IS-10 | Tool deprecation lifecycle → all V2 tools | Phase 9 → 5 | Tool metadata fields (deprecated, deprecated_since, removal_planned_for, migration_hint); response wrapping convention; framework added in Phase 9 wraps Phase 5's tools retroactively |

### Danger files (multi-phase touch)

Greenfield V2 has few traditional danger files. Mitigation strategy: split shared concerns into per-phase submodules where possible, with a top-level `mod` file aggregating them.

| File | Phases that touch | Mitigation |
|---|---|---|
| `Cargo.toml` (workspace + main) | 1 (create), 10 (release version) | Phase 10 only bumps version; bounded change |
| `src/lib/settings.rs` (or equivalent settings module) | 1 (create), 2, 3, 5, 6, 7, 8, 9, 10 (each adds config sections) | **Mitigation:** split into `src/lib/settings/` directory with per-section submodules (`storage.rs`, `auth.rs`, `injection.rs`, `digest.rs`, `mass_ingest.rs`, `shadow.rs`, `migration.rs`, etc.) loaded by a thin `mod.rs`. Each phase adds its own submodule file. Top-level `mod.rs` is touched once in Phase 1 to declare submodules. **Danger reduced to soft conflict.** |
| `src/server/index.rs` (or main MCP server bootstrap) | 4 (create), 5 (tool registration), 6 (hook endpoint integration), 7 (digest poller registration), 9 (reconciler poller registration) | **Mitigation:** establish a `Registrar` pattern in Phase 4 — each subsequent phase adds a `register_X()` function in its own module; `index.rs` calls them in a fixed sequence at startup. New `register_X()` calls are appended; minimal merge conflict surface. |
| `src/server/tools/mod.rs` | 4 (create), 5 (tool category registration) | Phase 4 creates skeleton; Phase 5's parallel tool sub-tasks each add `mod auth; mod journal;` etc. lines. **Mitigation:** Phase 4 stubs all category modules in advance; Phase 5 sub-tasks fill them in. |
| `src/db/registry_schema.rs` | 2 (initial schema), 3 (session_bindings/session_locks columns if added later), 7 (digest_queue, mass_ingest_requests, mass_ingest_checkpoints), 9 (shadow_comparison_log) | **Mitigation:** all registry tables defined in Phase 2 SQL constants — Phases 3/7/9 query existing tables. **No multi-phase modification of this file.** Mark in plan: registry schema is fully specified in Phase 2; subsequent phases consume only. |

**No `Cargo.toml` (lib dependencies) danger** — each phase MAY add new deps; conflicts resolved trivially (alphabetical merge).

### Parallelization assessment

**High-parallelism phases** (Conductor can launch many concurrent tasks):
- Phase 5 (Tools): 8+ tool category sub-tasks (auth, entry, status, discovery, handoff, system, features, time-travel, promote, active-context) all parallel
- Phase 8 (Migration): 6+ row-transform sub-tasks (per V1 table) all parallel
- Phase 6 (Injection): 6 sub-tasks parallel
- Phase 7 (Digest): 6 sub-tasks parallel

**Cross-phase parallelism:**
- Phases 3 + 4 run in parallel after Phase 2
- Phases 6 + 7 run in parallel after Phase 5
- Phases 8 + 9 run in parallel after Phase 7

**Sequential bottlenecks:**
- Phase 1 must complete before any other work
- Phase 2 must complete before Phases 3, 4, 8
- Phase 5 must complete before Phases 6, 7
- Phase 10 must wait for all implementation phases

### Phase Summary draft (will go in plan during Phase 5)

[Drafted; will be transcribed to plan file Overview/Phase Summary section in Phase 5]

### Phase 4 checkpoint state

All structural decisions complete. Phase 5 (writing) can resume in either this session or a fresh session — full state is preserved in this journal entry + the decision entries above. Plan file path: `docs/plans/designs/aletheia-v2-plan.md` (target).

**Strength:** core for the phase decomposition; context for the danger-file mitigation strategies (those are recommendations, not contracts).

---

## Phase 5: Section Writing & Review

### Plan file: `docs/plans/designs/aletheia-v2-plan.md`

**Final structure (6294 lines):**
- YAML frontmatter + sections index (22 sections total)
- Overview section (`<core>` summarizing all 9 Phase 3 decisions; `<context>` with V1 reference + V3 handoff pointers)
- Phase Summary section (10-phase table + critical path + parallelization strategy + integration surfaces + danger files)
- 10 phase sections each with: Objective, Prerequisites, Implementation (with mandatory tags + code blocks + danger-file annotations + guidance blocks), Integration Points, Expected Outcomes, Testing Recommendations
- 10 Conductor Review sections each with: Verification Checklist (mandatory), Known Risks, Guidance for next phase

### Section approvals (chronological)
| Sections | User feedback | Resolution |
|---|---|---|
| Overview + Phase Summary | "looks good, let's continue" | Approved |
| Phase 1 + CR-1 + Phase 2 + CR-2 | "looks good, let's proceed" | Approved |
| Phase 3 + CR-3 + Phase 4 + CR-4 | "looks good, let's proceed" | Approved |
| Phase 5 + CR-5 + Phase 6 + CR-6 | "looks good, continue" | Approved |
| Phase 7 + CR-7 + Phase 8 + CR-8 | "looks good, let's proceed" | Approved |
| Phase 9 + CR-9 + Phase 10 + CR-10 | "looks good, let's proceed" | Approved |

### Critical retroactive amendments surfaced during Phase 5 writing
**Strength:** mandatory — Conductor must apply these to early phases BEFORE later phases begin.

1. **Phase 2 schema additions** (surfaced in CR-5):
   - `session_locks` table needs columns: `active_feature_id`, `active_project_id`, `active_project_source`, `active_project_expires_at`, `active_context_tags_json`, `active_context_source`, `active_context_expires_at`
   - Per-scope schema needs FTS5 virtual table + sync triggers: `entries_fts USING fts5(content, content=entries, content_rowid=internal_id)` + INSERT/UPDATE triggers
2. **Phase 2 helper functions** (surfaced in CR-8):
   - `crate::db::scope_schema::install_all(&conn)` and `crate::db::registry_schema::install_all(&conn)` need to exist (currently only the constants are defined)
3. **Phase 5 retroactive amendment** (surfaced in CR-9):
   - `AuthContext::precheck()` adds `deprecation::check_and_log` call
4. **Phase 6 retroactive amendment** (surfaced in CR-9):
   - `ScoringEngine.top_k_filtered` accepts `Option<&ShadowObserver>` parameter
   - L1/L2 builders pass it through

### Phase 5 closeout
All 10 phase section + conductor review pairs written and approved. Plan ready for Phase 6 (Finalization & Commit) — verification subagent dispatch + plan-index generation + commit protocol.

### Late amendment — Visible-failure principle (Phase 5 + handoff)

**Strength:** mandatory.
**Source:** CEO session report 2026-04-26 surfacing an active V1 bug class.
**Issue reported:** V1's `write_journal`/`write_memory` accept an `entry_id` parameter and FK-fail silently on some values. The session that surfaced this had pre-compact summaries of "successful" writes that didn't actually persist (claimed-but-non-existent entries `33c5a863`, `d3eb2c85`, `69f31364`, `86e02c85`). The constitution's gotcha mentions "entry_id is the scope's entry ID, NOT the claim ID" but the actual rules for which IDs qualify aren't documented.

**Resolution:**
1. Added a 5th `<mandatory>` to Phase 5 Implementation: "Helpful-failure principle — all reference-parameter validation MUST produce explicit, actionable errors. NEVER silent FK failures, NEVER vague rusqlite error pass-throughs." Specifies: SELECT-validate before write; wrap any leaked SQL constraint violation; specify valid-ID contract in tool descriptions; standard error response shape with parameter/value/reason/hint fields.
2. Added 4 verification items to CR-5: per-reference-parameter validation, no-silent-FK CI test, tool-description contracts, structured error shape verification.
3. Added a "Visible-failure principle" section to `arranger-handoff.md` (V3 forward-look) — frames it as the symmetric companion to the visible-dedup principle and notes things to watch for in V2 deployment + V3 KG layer extension.

**Why this matters:** V1's silent-failure class is exactly the same failure mode as V1's scope-leak bug — failure-by-omission rather than explicit error. V2's architectural fixes (per-scope ATTACH for scope-leak; per-row entries model partly removing entry_id confusion) reduce the surface area but don't eliminate the bug class — explicit code discipline is still required. The mandatory makes the discipline non-negotiable.

---

## Phase 6: Finalization & Commit

### Verification

**Subagent dispatched:** Read-only verification subagent ran the full structural + content + domain-specific checklist (14 items: 11 standard + D1 KG forward-compat seams + D2 helpful-failure principle + D3 SDK launch flag combination).

**Result:** VERIFICATION PASS with 1 minor advisory.

| # | Check | Result |
|---|---|---|
| 1 | Sentinel marker pair matching (44 markers) | PASS |
| 2 | Header-sentinel consistency | PASS |
| 3 | YAML frontmatter validation (6 required fields) | PASS |
| 4 | `<sections>` index completeness (22 entries) | PASS |
| 5 | `<section>` tag matching (22 opens + 22 closes) | PASS |
| 6 | Authority tag well-formedness (90 opens / 90 closes; only `<mandatory>`, `<core>`, `<guidance>`, `<context>`) | PASS |
| 7 | Self-containment (Copyist test, 6 H3 components × 10 phases = 60 entries) | PASS |
| 8 | User override propagation | N/A — none |
| 9 | Danger file annotation (prose + `⚠ DANGER FILE` markers) | PASS |
| 10 | Large document marker test (`<!-- /conductor-review:10 -->` at line 6314) | PASS |
| 11 | Bidirectional section check | PASS |
| D1 | KG forward-compat seam markers (all 7 IS-6 stubs documented in Phase 6) | PASS |
| D2 | Helpful-failure principle (mandatory + 3 verification items in CR-5) | PASS (advisory: 3 items vs journal's claimed 4 — substance fully covered, count was a journal bookkeeping error) |
| D3 | SDK launch flag combination (11 flags + `--output-format` + "Do NOT use --bare" mandatory) | PASS |

**Verification iterations:** 1 (no fixes required).

### Plan-index generation

Plan-index inserted between H1 title and `<sections>` block (lines 12-37). Block size: 25 lines (1 start + 1 verified + 1 overview + 1 phase-summary + 20 phase/CR pairs + 1 end). Insertion shifted all sentinel positions by +26 (25 index + 1 blank).

Verified timestamp: `2026-04-26T07:50:17`. All sentinel line numbers spot-checked against post-insertion file (overview at 63-122 ✓, phase-summary at 124-151 ✓, phase:1 at 153-578 ✓, phase:10 at 5816-6271 ✓, conductor-review:10 at 6273-6340 ✓).

Final plan size: 6340 lines.

### Commit

**Commit hash:** `9bd917f` on branch `master`.
**Files committed (7 files, 10400 insertions):**
- `docs/plans/designs/aletheia-v2-plan.md` — implementation plan (locked)
- `docs/plans/designs/2026-04-17-aletheia-v2-design.md` — Dramaturg input (was untracked; included for completeness)
- `docs/plans/designs/decisions/aletheia-v2/dramaturg-journal.md` — Dramaturg journal (was untracked)
- `docs/plans/designs/decisions/aletheia-v2/ceo-review-feedback.md` — CEO 9 resolved decisions (was untracked)
- `docs/plans/designs/decisions/aletheia-v2/knowledge-graph-research-handoff.md` — V3 KG forward-look (was untracked)
- `docs/plans/designs/decisions/aletheia-v2/arranger-journal.md` — this journal
- `docs/plans/designs/decisions/aletheia-v2/arranger-handoff.md` — V3 implementation handoff

**Commit message format:** standard `feat:` prefix per Arranger protocol; named the feature, phase count, journal location, and inline-listed all companion docs with their provenance.

**NOT committed:** pre-existing modifications to `pm-instructions.md` (Kyle's work outside Arranger scope) and other untracked files in repo root (PM workflow artifacts unrelated to V2).

**NOT pushed:** per Arranger protocol — branch management is the Conductor's concern.

### Session complete

The Arranger's work is done. Plan is locked. Conductor pipeline takes over.

**Next steps for Kyle (out of Arranger scope, FYI only):**
1. (Optional) Push commit to origin: `git push origin master`
2. Invoke Conductor with: `/conductor docs/plans/designs/aletheia-v2-plan.md` (or whatever the Conductor invocation pattern is in Kyle's setup)
3. Per the V3 forward-look in `arranger-handoff.md`: V3 Dramaturg session runs AFTER V2 is implemented and deployed.

---

## Phase 6 Re-Open: Post-CEO-Pre-Build-Review Plan Corrections

**Date:** 2026-04-26 (same day as initial finalization)
**Trigger:** CEO + Gemini + journal-recon teammate produced `decisions/aletheia-v2/ceo-prebuild-review-points.md` flagging substantive issues with the locked plan: (a) V2's npm-package-overwrites-V1 model is unsafe for rollback + incompatible with side-by-side validation workflow, (b) Phase 8 ships with 10 acknowledged TODOs that should be closed before implementation begins, (c) master-key flow is unspecified across `setup` + `migrate-from-v1`, (d) ATTACH 10-DB ceiling deserves explicit handling, (e) several retroactive amendments scattered across phases need consolidation, (f) Shadow Mode dead-code framing + Phase 9 reconciler stubs need attention.

**Kyle's scope decision:** approved all CEO recommendations; in-place amendment of original phases (NOT a separate Phase 0 doc); walkthrough doc + plan corrections committed together (one review cycle); pm-aletheia scope name preserved across migration (PM session name `pm-aletheia-v2` is orthogonal to scope naming).

### Corrections folded into the plan

**Strength:** mandatory.

| Item | Resolution |
|---|---|
| **Side-by-side install** (CEO Comment 2) | Overview "Install model" section added; npm package + binary + data dir all renamed to `aletheia-v2`; migration tool no longer renames V1 DB; cutover documented in MIGRATION-FROM-V1.md |
| **Master-key flow Option 1** (CEO Part 2.B) | Phase 8 mandatory + keys::transform: V2 setup mints fresh master; migration imports V1 keys with is_master_key=0; V1 master becomes maintenance-permission V2 sub-key |
| **A1 — Memory version numbering** | Two-pass algorithm specified: count history → INSERT versions 1..N → INSERT current at N+1 |
| **A2 — `fetch_v1_tags_for_entry`** | Concrete SQL JOIN added |
| **A3 — provenance translation pass** | New `crate::migrate::provenance::translate_all` module specified; runs after all per-scope transforms; uses id_mapping populated by journal + memory transforms |
| **A4 — `count_handoffs_per_scope`** | Implemented via JOIN through V1 `keys.entry_scope` (no longer hardcoded 0) |
| **A5 — Post-migration validation** | New `crate::migrate::validation::verify_row_counts` module; asserts V2 sums match V1 sums per entry_class |
| **A6 — Active V1 session detection** | `scan_active_v1_sessions` mandatory; refuses with `V1_SESSIONS_ACTIVE` error unless `--ignore-active-sessions` |
| **A7 — Dry-run report schema** | Full `MigrationReport` struct with `ScopePlanReport` + `KeyPlanReport` + `RowsByClass`; deterministic scope_uuid (SHA-256 of namespace) so dry-run + actual match; written to both JSON + markdown at `~/.aletheia-v2/dry-run-reports/` |
| **A8 — V1 schema version constraint** | Mandatory: refuse V1 schema_version < 4 with clear error; future contributor task documented for v3 fallback |
| **A9 — Failure cleanup includes key files** | `created_key_files: Vec<PathBuf>` populated by keys::transform; on failure, both scope DBs AND key files deleted |
| **A10 — `is_applying` state machine** | Differentiated: full cleanup → flip to false; partial state → safe-hold true |
| **B (master-key flow)** | See above — Option 1 locked |
| **C (ATTACH 10-DB ceiling)** | Phase 1 build.rs + `[workspace.dependencies]` note: SQLITE_MAX_ATTACHED=125 build flag |
| **D (Phase 0 consolidation)** | Replaced with **in-place amendment** of original phases — see "In-place amendments" section below |
| **E (Shadow Mode framing)** | Validation-mode default disabled (Option 1 from CEO); plan documentation already aligned |
| **F (Phase 9 reconciler stubs)** | `check_source_tombstoned`, `check_target_inserted`, `tombstone_source`, `insert_target` all closed with concrete implementations |
| **Open Q1 — manual stop sessions** | Resolved by A6 active session detection + override flag |
| **Open Q2 — `--stage-digest-as-mass-ingest` criteria** | Documented: use when single scope >500 V1 entries OR estimated digest >200k tokens |
| **Open Q3 — CC settings.json co-existence** | Resolved: V2 hooks at `~/.aletheia-v2/hooks/` registered as separate entries; V1 hooks at original paths stay as-is |
| **Open Q4 — Cutover ceremony** | Documented in MIGRATION-FROM-V1.md cutover section |
| **Open Q5 — PM scope naming** | `pm-aletheia-v2` is the build PM SESSION name (orthogonal to scope); CEO V1's `pm-aletheia` scope migrates with name preserved (new scope_uuid in V2's partition; same logical name) |

### In-place amendments (replaces CEO Part 2.D Phase 0 consolidation)

Rather than create a separate "Phase 0 Final State Reference" document, the original phase sections were amended in-place so a Conductor reading Phase N sees the FINAL spec without cross-referencing:

- **Phase 1**: Cargo workspace's binary name updated to `aletheia-v2`; SQLITE_MAX_ATTACHED=125 build.rs note added
- **Phase 2**: `SESSION_LOCKS_TABLE` constant now includes 6 active_project/context columns + active_feature_id; `ENTRIES_FTS_TABLE` constant added with sync triggers; `install_all` helper functions added on both `scope_schema` and `registry_schema` modules
- **Phase 5**: `AuthContext::precheck` includes `deprecation::check_and_log` call from the start (no longer a "retroactive amendment"); `active_context_tools` simplified note removed (Phase 2 has the columns)
- **Phase 6**: `ScoringEngine.top_k_filtered` signature includes `Option<&ShadowObserver>` + `Option<ObservationMetadata>` parameters from the start; observation deferred via `tokio::spawn` to avoid blocking
- **Phase 8**: Substantive rework per CEO items A1-A10 + side-by-side install + master-key flow Option 1 (orchestrator + keys::transform + provenance + validation modules)
- **Phase 9**: ShadowObserver renamed to `observe_sync` matching Phase 6 signature; reconciler stubs closed; `write_comparison` accepts `ranker_name` parameter
- **Phase 10**: Package + binary + path renamed to `aletheia-v2`; INSTALL.md and MIGRATION-FROM-V1.md content rewritten for side-by-side install model + cutover ceremony

All "Phase N retroactive amendment" callouts in conductor reviews replaced with past-tense verification items confirming the amended state.

### New artifact: migration-walkthrough.md

Per CEO Comment 2c, a pre-build deliverable using CEO's actual V1 data (22 entries, 217 journal_entries, 89 memory_entries across 5 scopes) traces the migration through all classes (journal, memory with 6-key container demonstrating Q5A, status with sections, handoff, provenance with 3 rows, keys with V1 master + 8 sub-keys). Lives at `decisions/aletheia-v2/migration-walkthrough.md`. The 5 acceptance criteria at the end define what "Phase 8 is implementation-validated" looks like.

### Re-verification + commit

After plan corrections complete: re-run verification subagent against the corrected plan; regenerate plan-index (line numbers shifted significantly — the plan grew from ~6340 to ~7000+ lines); commit corrections + walkthrough + handoff update + this journal entry as one logical revision.

**Verified-timestamp** in plan-index will reflect the post-correction verification, NOT the initial 2026-04-26T07:50:17 timestamp.

