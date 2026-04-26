# Aletheia V2 Arranger Implementation Handoff — For V3 Dramaturg & V3 Arranger Sessions

## Purpose

This document captures findings from the Aletheia V2 Arranger session (2026-04-26) that future V3 sessions should inherit rather than re-discover. It complements two existing handoff docs:

- `dramaturg-journal.md` — V2 design rationale (decision-by-decision)
- `knowledge-graph-research-handoff.md` — V3 design-level KG research head-start

This Arranger handoff adds the **implementation-level reality** discovered during V2 planning — specifically:
- Claude Code ecosystem behaviors that constrain or enable design
- Implementation patterns chosen for V2 that affect how V3 must extend them
- Forward-compat seams V2 deliberately preserved
- Known limitations and upstream issues that may resolve later

**Audience:**
- **V3 Dramaturg session** — read this AFTER `knowledge-graph-research-handoff.md` to understand what implementation reality shaped V2 and what reality V3 must respect
- **V3 Arranger session** — read this BEFORE auditing V2's deployed source to understand the architecture choices and where the planned V3 seams live

---

## V2 Arranger session context

- **Date:** 2026-04-26
- **Output:** `docs/plans/designs/aletheia-v2-plan.md` (implementation plan, Tier 2 hybrid format)
- **Decision journal:** `docs/plans/designs/decisions/aletheia-v2/arranger-journal.md`
- **Phase 2 audit findings + Phase 3 decisions (12 questions): see journal**
- **Tech stack chosen:** Rust (`rmcp` 1.5.x + `rusqlite` bundled + `interprocess` v2 + `tokio` + `cargo-dist` for npm distribution)

---

## Findings useful for V3 Dramaturg session

### Claude Code ecosystem realities discovered during Phase 2

These shaped V2 design refinements; V3 design must respect or revisit them.

#### 1. SDK subprocess isolation — `--bare` exists but excludes OAuth

CC 2.1.119 has a `--bare` flag that disables CLAUDE.md walk, hooks, plugins, skills, auto-memory, IDE detection, plugin sync. **Cleanest possible isolation** for SDK subprocesses. Exact behavior verified via live spike testing.

**BUT:** `--bare` also disables OAuth/keychain reads. Subscription users (Anthropic Pro/Max plans) authenticate via OAuth at `~/.claude/.credentials.json`. Using `--bare` would force them to set `ANTHROPIC_API_KEY` env var (pay-per-token billing instead of subscription).

**V2 solution (locked in):** Do NOT use `--bare`. Use the OAuth-preserving combination that achieves equivalent isolation:

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

**Critical flag semantics discovered (don't re-discover):**
- `--setting-sources ""` (empty string) does NOT skip inheritance — falls through to default. Use `--setting-sources local` to skip user/project sources.
- `--settings <inline>` is ADDITIVE without `--setting-sources` constraint — does not replace inherited settings.
- `--disable-slash-commands` is required to suppress Skill auto-discovery.
- `--tools ""` (empty string) is required to disable built-in tools when paired with `--allowed-tools "mcp__*"`.
- `--print` (`-p`) skips workspace trust dialog (per `claude --help`).
- `--no-session-persistence` only works with `--print` mode.

**Cost profile:** ~6.7k cache_create per cold-start with this combo (system prompt baseline). Acceptable.

**If V3 KG adds new SDK-driven background tasks (e.g., KG bootstrap, entity extraction)**, use the same flag combination. Document in the V3 plan; do not introduce new flag patterns.

#### 2. Session ID discovery missing in CC 2.1.x — workaround in V2

There is **no** `CLAUDE_CODE_SESSION_ID` env var for local CLI sessions. The MCP `initialize` handshake does NOT include parent session ID. Only ephemeral `tool_use_id` per-call. Tracked GitHub issue **#41836** (Anthropic-side, may be fixed in future CC versions).

**V2 workaround (locked in):** SessionStart hook (bash + JS) writes session_id from stdin JSON to `~/.aletheia/sessions/<my_pid>.session_id` (single-line plain text, mode 0600). MCP server reads `~/.aletheia/sessions/<my_ppid>.session_id` at startup with up to 2s polling for the race where MCP starts before hook completes. Falls back to no-auto-reclaim (user calls `claim(key)` explicitly) if not found.

**Cloud-runtime exception:** `CLAUDE_CODE_REMOTE_SESSION_ID` is auto-injected for Anthropic-managed cloud routines. Not used for local CLI.

**Forward path:** Monitor CC issue #41836. If/when CC adds a proper env var, V2.x can deprecate the SessionStart hook via the standard tool-deprecation lifecycle. V3 should NOT design around this missing env var — assume the SessionStart hook is the source of truth until upstream fixes it.

#### 3. `claudeMdExcludes` schema confirmed

Field name is `claudeMdExcludes` (camelCase). Type: `string[]` of glob patterns matched against absolute file paths. Lives in `.claude/settings.local.json` or as inline `--settings`. Enterprise/managed CLAUDE.md files cannot be excluded.

V2 uses `claudeMdExcludes: ["**/*"]` inline in `--settings` for the SDK digest subprocess (suppresses ALL CLAUDE.md walk). V3 KG operations launched via SDK should do the same.

#### 4. `.claude/` path protection class (Hermes spike precedent)

Reference: `/home/claude/claude-projects/hermes/docs/permission-hook-spike-fail.md` (2026-04-16). The CC CLI enforces `.claude/` path protection on `Edit`/`Write`/`MultiEdit` tool calls — the prompt fires AFTER PreToolUse shell hook dispatch and CANNOT be suppressed by `permissionDecision: "allow"` in the hook's response.

**Implication for V2 (and V3):** The protection class fires on TOOL invocations to `.claude/` paths, NOT on subprocess launch. Since V2's SDK digest subprocess is locked to `mcp__aletheia__*` tools (no Edit/Write/MultiEdit), this protection class never applies. V3 KG operations must follow the same pattern — never expose Edit/Write/MultiEdit tools to SDK subprocesses.

Server-side writes (the MCP server itself reading/writing Aletheia data files) are NOT subject to CC's tool permission system.

### WAL+ATTACH cross-DB atomicity caveat

Per official SQLite docs (verified): in WAL mode, transactions across ATTACHed databases are atomic for each individual database but **not atomic across the database set**. Power loss during cross-DB commit can tear the transaction (each DB internally consistent, but cross-DB consistency broken).

**V2 design exposes this in a few narrow places:**
- `promote_memory(entry_id, target_scope)` — tombstone source + insert target
- `feature_wrap_up` — synthesized memories may land in different scope from source journals
- `migrate_from_v1` — multi-scope writes (mitigated by master-key + backup-confirmation)

**V2 mitigation (locked in):** Application-level reconciliation pass at MCP server startup + every 5 minutes (background sweep) + on-demand via master-key `reconcile()` tool. Scans `sys_audit_log` for orphaned `*_proposed`/`_started` events without matching `*_committed`/`_completed`. Operations are designed to be idempotent for safe retry.

**V3 KG implications:** If V3 introduces graph-write operations spanning scopes (e.g., entity nodes shared across scopes, edges crossing scope boundaries), they will face the same atomicity caveat. Design KG writes to be:
- Idempotent (same input produces same output if retried)
- Visible in `sys_audit_log` with paired `*_started`/`*_completed` events
- Recoverable via the existing reconciliation framework (extend the reconciler with KG-specific recovery handlers)

**Do NOT design KG to assume cross-DB atomicity.** Design around it.

### Visible-failure principle (V2-new; eliminates V1 silent-failure class)

**Origin:** Late finding from CEO session 2026-04-26 — V1's `write_journal`/`write_memory` accepted an `entry_id` parameter and FK-failed silently on some values. Sessions summarized failed writes as if successful, leading to "claimed-but-non-existent" entries that were never persisted.

**V2 commitment (Phase 5 mandatory):** Every write tool that accepts a reference-parameter (`entry_id`, `target_scope`, `feature_id`, `scope_id`, `section_id`, `journal_id`, `key_id`) MUST validate explicitly via SELECT before the write, AND must wrap any SQL constraint violation that slips through into a structured `<error code="INVALID_*" parameter="..." value="..." reason="..." hint="..."/>` response with all 4 fields populated. NEVER silent failures. NEVER raw rusqlite error pass-throughs to the agent.

**Watch for in V2 deployment:**
1. Any new tool added in V2.x that takes a reference parameter — the helpful-failure mandatory applies; verify in CR.
2. Any code path that catches an error and silently returns success-shaped output. The CI lint should catch most cases; manual review of new write tools is the backup.
3. Cross-scope writes (`promote_memory`, `feature_wrap_up` synthesis) — when these span scopes, the helpful-failure principle extends to validating BOTH source and target before any write begins.

**For V3 KG layer:** All graph-write operations follow the same principle. If V3's KG bootstrap or entity-extraction encounters a missing referent (e.g., entity ID not in scope), it must produce a helpful error, not a silent skip.

**Symmetry with visible-dedup:** Two halves of the same principle — every server-side action must be visible to the agent.

### Multi-MCP-server leader election pattern

Each Claude Code session spawns its own MCP server process. With ~5 concurrent sessions, there are ~5 MCP server processes. All read/write the same `~/.aletheia/scope_registry.db`.

**V2 pattern (locked in):** SQL `UPDATE digest_queue SET leased_by_pid=?, lease_expires_at=? WHERE queue_id=? AND status='pending' RETURNING *`. RETURNING ensures only one process gets the row. Background poller in each MCP server (60s cadence) handles both leasing and crash-recovery (re-queue rows where `lease_expires_at < NOW`).

**V3 KG implications:** If V3 KG adds new background tasks (e.g., periodic graph rebuild, entity-merge sweep), use the same pattern. Add a new `kg_task_queue` table with the same lease semantics; per-MCP-server background poller picks up tasks. Do not invent new leader-election mechanisms.

---

## Findings useful for V3 Arranger session

### Tech stack (V2)

- **Language:** Rust 2024 edition (or whatever's stable at V2 build time)
- **MCP SDK:** `rmcp` 1.5.x — production-ready; expect ~1-3 days migration tax per major upgrade
- **SQLite:** `rusqlite` with `bundled` feature (cross-platform compile; bundles SQLite C source)
- **Cross-platform IPC:** `interprocess` v2 (Unix sockets + Windows named pipes uniformly)
- **Async runtime:** `tokio` (rmcp is tokio-native)
- **Subprocess management:** `tokio::process::Command` with `kill_on_drop(true)` for lease-expiry cleanup
- **TOML config:** `toml` crate (replaces V1's `smol-toml`)
- **JSON Schema:** `schemars` crate (paired with `serde` for tool registration via `#[tool]` macros)
- **npm distribution:** `cargo-dist` configured for `optionalDependencies` pattern (NOT `postinstall`)
  - One wrapper package (JS shim, ~30 lines) + N platform-specific binary packages
  - JS shim MUST use `stdio: 'inherit'` and forward SIGINT/SIGTERM to child Rust binary
  - Platform binaries built per-target via GitHub Actions matrix
- **Hash:** SHA-256 (via `sha2` crate) for content_hash + key_hash
- **UUIDs:** `uuid` crate (v4)

### V2 architectural patterns V3 must respect

#### Pluggable Signal trait for relevance scoring

V2's relevance pipeline defines a `Signal` trait:

```rust
trait Signal: Send + Sync {
    fn name(&self) -> &str;
    fn score(&self, candidate: &Candidate, context: &Context) -> f64;
}
```

V2 ships 4 implementations (`TagOverlapSignal`, `RecencySignal`, `ActiveProjectSignal`, `CriticalSignal`) registered in a `Vec<Box<dyn Signal>>`. The scoring engine iterates registered signals dynamically.

**V3 plugs `GraphProximitySignal` here.** Add the implementation; register it; pipeline picks it up. **No V2 code change needed.**

#### `[injection.weights]` as `HashMap<String, f64>`

Read as map, not fixed-key struct. Missing keys contribute 0 score. V3 adds `graph_proximity = X.Y` to settings.toml; V2's reader picks it up if `GraphProximitySignal` is registered.

#### Forward-compat extensibility in scoring `Context`

V2 `Context` struct uses `Option<>` + serde defaults. V3 adds:
```rust
#[serde(default)]
graph_anchor_nodes: Option<Vec<NodeId>>,
```

#### `memory_journal_provenance` table preserved

V2 keeps this table (per-scope DB schema) even though V2 design didn't explicitly require it. V3 KG uses it directly as a `derived_from` edge type during graph bootstrap.

#### Dedup response struct extensible

V2 returns `<duplicate existing_entry_id="..." existing_version="..." message="..."/>`. V3 adds:
```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
related_entries: Option<Vec<EntryId>>,
```

#### `show_related` tool minimal MCP signature

V2 ships `show_related(entry_id, limit?: int) -> related_entries[]` with tag-overlap algorithm. V3 swaps the implementation to graph-traversal without changing the MCP tool signature.

#### `query_past_state` minimal MCP signature

V2 ships `query_past_state(entry_id, timestamp)`. V3 adds optional `include_graph_context: bool = false` parameter.

### Key implementation patterns V3 should reuse

#### SDK subprocess launch flag combination

See "Findings useful for V3 Dramaturg" §1 above. Locked V2 pattern. V3 must use the same flag set for any SDK-driven KG tasks (KG bootstrap, entity extraction, graph reconciliation).

#### SessionStart hook + per-PPID file handoff

See "Findings useful for V3 Dramaturg" §2. V3 inherits V2's mechanism unchanged. If V3 adds new background processes that need to know session_id, they read the same file using their PPID.

#### Cross-DB reconciliation pattern

See "WAL+ATTACH cross-DB atomicity caveat" above. V3 extends the reconciler with KG-specific recovery handlers if KG adds cross-scope graph operations.

#### Multi-MCP-server queue leader election

See "Multi-MCP-server leader election pattern" above. V3 reuses for any new background-task queues.

#### npm distribution via `optionalDependencies`

V2 ships as `npm install -g aletheia` per CEO Item 2. The wrapper package contains a JS shim; platform-specific binary packages live in `optionalDependencies`. JS shim must:
- Use `stdio: 'inherit'` (no `console.log` — corrupts JSON-RPC)
- Trap SIGINT/SIGTERM and forward to child Rust binary (else zombies on CC exit)
- Keep binaries small (10-15MB target) to fit MCP init timeout (~30s) on first `npx` install

V3 inherits this distribution pattern. V2.x → V3.0 release just bumps version; no install paradigm change.

### Code locations V3 will likely touch (preview based on planned V2 structure)

The plan's phase structure isn't final yet (Phase 4 next), but anticipated module layout:

- `src/db/scope_partition.rs` — ATTACH DATABASE management; V3 KG storage layer plugs in here
- `src/db/migrations/` — V2.x → V2.y SQL migration scripts; V3.0 migration goes here as `v2_x_to_v3_0.sql` (or similar) per generic `start_migration` framework
- `src/server/tools/relevance.rs` (or similar) — Signal trait + 4 V2 implementations; V3 adds GraphProximitySignal
- `src/server/tools/show_related.rs` — V2 tag-overlap implementation; V3 swaps internals
- `src/server/tools/query.rs` — `query_past_state`, `query_entry_history`; V3 may add `find_related_via_graph`, multi-hop query tools
- `src/digest/sdk_subprocess.rs` — SDK launch flag combo + cwd setup; V3 reuses
- `src/reconciler/` — cross-DB reconciliation; V3 adds KG-specific recovery handlers
- `src/lib/settings.rs` — settings.toml parsing; V3 adds `graph_proximity` weight + new sections as needed

(Exact paths will be confirmed in V2 implementation; V3 Arranger should re-verify against deployed source.)

### V2 → V3 migration considerations

#### Migration framework (V2.x → V3.0)

V2 ships `start_migration(target_version, dry_run?)` as the generic DDL migration tool (per design Topic 4). Paused-rollover with per-scope atomicity. V3 is a major-version bump; the migration is **additive DDL**:
- New KG tables (graph_nodes, graph_edges, etc.) per-scope
- New columns on existing tables (if any)
- KG bootstrap over existing V2 corpus (lazy per-scope at first claim, similar to V1→V2 pattern)

V2 already commits to forward-only migrations (no `down()` scripts). V3 migration follows the same constraint.

#### KG bootstrap timing

V1→V2 used "lazy per-scope digest pass at first claim" (CEO Item 4) to avoid first-session storm. V3 should consider the same pattern for KG bootstrap:
- `start_migration` adds KG schema to all scopes structurally (atomic)
- Per-scope `kg_bootstrapped_at` flag in scope_registry
- First V3-aware claim of each scope kicks off KG bootstrap as a `kg_bootstrap` digest_queue trigger
- Inactive scopes never bootstrap until claimed
- Mass-ingest mode available via `--stage-bootstrap-as-mass-ingest` flag for users with large single-scope corpora

This pattern is proven; V3 should reuse it unless analysis reveals a better approach.

#### Settings.toml additions

V3 adds (anticipated):
- `[injection.weights] graph_proximity = X.Y`
- `[kg]` section: bootstrap settings, extraction model selection, entity-merge thresholds, graph store backend choice (if not pure SQLite)
- Possibly `[kg.bootstrap]` per-scope overrides

V2's `HashMap<String, f64>` weights pattern absorbs the first item non-breakingly. V3 adds new sections via standard toml schema extension.

#### New MCP tools (anticipated for V3)

- `find_related_via_graph(entry_id, max_hops?, limit?)` — graph-proximity replacement for tag-overlap show_related
- `query_graph(node, edge_type?, depth?)` — direct graph traversal (master-key or scope-key)
- `find_path(from_entry, to_entry, max_hops?)` — shortest-path between entries
- `bootstrap_kg(scope_id, dry_run?)` — manual trigger for KG bootstrap (auto runs at first claim)
- `analyze_kg_quality(scope_id?)` — entity duplication detection, edge density, etc.

V3 adds these via standard MCP tool registration. Existing V2 tools unchanged.

---

## Open questions / known limitations to monitor

### Upstream Claude Code

- **CC issue #41836** — `CLAUDE_CODE_SESSION_ID` env var. If/when fixed, V2.x deprecates SessionStart hook approach.
- **`.claude/` path protection** — currently fires on Edit/Write/MultiEdit. If CC ever expands this to MCP tools that write to .claude/ paths, V2/V3 design must adapt. Currently NOT a concern since SDK subprocesses use `mcp__aletheia__*` tools only.
- **`--bare` evolution** — if CC adds a `--bare-but-keep-oauth` mode in the future, V2 can simplify the SDK launch flag set.

### Rust ecosystem

- **rmcp API churn** — ~quarterly migrations expected. Budget ~1-3 days per upgrade. Watch the rmcp 2.x release if/when it happens.
- **rusqlite** — stable; no concerns expected.
- **interprocess crate** — v2 stable; if v3 introduces breaking changes, evaluate.
- **cargo-dist** — actively evolving; track for `optionalDependencies` pattern improvements.

### npm distribution

- **First-run `npx` cold-start vs MCP init timeout** — real risk with 10-15MB Rust binaries on slow connections. If users report MCP init failures on first install, evaluate: (a) smaller stripped binaries, (b) pre-install hint in install docs, (c) different distribution channel.
- **Windows code-signing** — may be needed for Windows binaries to avoid SmartScreen warnings. Out-of-scope for initial V2 release; revisit if user reports surface.

### SQLite

- **WAL+ATTACH atomicity** — known SQLite limitation. V2 reconciliation pattern handles it. V3 must respect.
- **Attached DB count** — default max 10, hard max 125. Practical V2 hierarchies (CEO → TL → subTL → worker = 4 attaches) well within. If V3 KG introduces wider hierarchies (e.g., cross-project graph queries), revisit.

### Performance unknowns (revisit empirically post-V2 deployment)

- **L1/L2 hot-path latency** with 5-10 attached scope DBs per connection
- **SDK subprocess cold-start cost** (CEO Item 3 accepted as bounded; verify in production)
- **`digest_queue` poll contention** with N MCP servers polling every 60s
- **`scope_registry.db` write contention** under heavy multi-session activity (audit log, session_locks heartbeats, etc.)

V3 Dramaturg session has the advantage of empirical V2 production data. Use it.

---

## Recommendations to next sessions

### For V3 Dramaturg session

1. **Read `knowledge-graph-research-handoff.md` first** — it's your design-level starting point for KG architecture decisions.
2. **Then read this Arranger handoff** — implementation reality and constraints discovered during V2 build that constrain or enable design.
3. **Then inspect V2's deployed source** — empirical ground truth.
4. **Pay attention to which V2 patterns held up under real multi-agent load.** Patterns documented as "locked" here should remain locked unless reality proves them wrong.
5. **The V2 design was not perfectly accurate to V1 (e.g., YAML-in-XML claim was wrong, V1 returns JSON).** When V3 design references V2 behavior, verify against deployed source, not just design doc.

### For V3 Arranger session

1. **Read this handoff before auditing V2 source.** The 7 KG-stub patterns + tech stack + flag combinations are pre-decided; don't re-litigate.
2. **The reconciliation framework is your friend.** If V3 KG operations span scopes, add KG-specific recovery handlers to `src/reconciler/`. Don't invent a new mechanism.
3. **Settings.toml extensions are non-breaking when done right.** HashMap<String, f64> weights + new sections + serde defaults absorb V3 additions.
4. **Don't reinvent the SDK launch flag set.** V2 spent measurable Phase 2 time discovering the OAuth-preserving combination. Reuse it.
5. **The V2 `start_migration` framework handles V2.x → V3.0.** Design V3 migration as additive DDL + lazy per-scope KG bootstrap; don't introduce a new migration mechanism.
6. **rmcp upgrade tax is real.** If V3 build-out spans a rmcp major version bump, budget time for it.

---

## Status

**Written:** 2026-04-26
**Source:** Aletheia V2 Arranger session — Phases 1-3 (ingestion, feasibility audit, implementation discussion)
**Companion docs:**
- Decision journal: `arranger-journal.md`
- V2 design: `../../2026-04-17-aletheia-v2-design.md`
- V2 dramaturg journal: `dramaturg-journal.md`
- V3 KG handoff: `knowledge-graph-research-handoff.md`
- CEO review feedback: `ceo-review-feedback.md`
- V1 design (predecessor): `../../../2026-04-08-aletheia-design.md`
- Hermes spike-fail (precedent for `.claude/` protection): `/home/claude/claude-projects/hermes/docs/permission-hook-spike-fail.md`

**Maintainer:** Future Aletheia sessions. Updates welcome from V2 implementation experience and V3 sessions as findings evolve.
