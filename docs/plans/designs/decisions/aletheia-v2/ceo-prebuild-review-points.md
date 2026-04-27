# Aletheia V2 — Pre-Build Review Points for the Arranger

**Author:** CEO session (post-compact 2026-04-26), with Gemini brainstorm and journal-recon teammate
**Sources read:** `aletheia-v2-plan.md` (full), `2026-04-17-aletheia-v2-design.md` (full), `arranger-handoff.md` (full), `knowledge-graph-research-handoff.md` (full), Kyle's `kyle-response.md`, Gemini brainstorm round, journal teammate's synthesis of `dramaturg-journal.md` + `arranger-journal.md` + `ceo-review-feedback.md`
**Audience:** the Arranger session that produced `aletheia-v2-plan.md` — Kyle will hand this to you for review and corrective action
**Tone:** direct. The plan's foundation is strong; this doc focuses on what needs hardening before build commits.

---

## Executive summary

1. **The plan is build-ready architecturally** — Rust + per-scope ATTACH + append-only versioning + visible-failure principle + 7 V3 KG-stub seams. Foundation is solid; Phase 8 (V1→V2 Migration) and the kickoff/install story need work.
2. **Phase 8 ships with acknowledged TODOs in the migration code path** — the highest-stakes one-shot operation in the entire plan is also the least-finished. Plan must close those before Phase 1 starts.
3. **Side-by-side install + real-data dry-run are missing** — Kyle's explicit ask. Current plan has V2 overwriting the `aletheia` npm package name and tests migration only against synthetic V1 data. Needs concrete change.

---

## Part 1 — Concrete answers Kyle is asking for

### Comment 1 — *"How do we operate this re-build?"*

Recommendation (Arranger: please challenge if you disagree):

| Aspect | Recommendation | Rationale |
|---|---|---|
| **Workspace** | New directory: `kyle-projects/aletheia/aletheia-v2/` (own Cargo workspace, fresh git history or branch) | Greenfield Rust; no in-place edits to V1 TS source. V1 source remains read-only reference at `kyle-projects/aletheia/src/` and stays the production system until V2 ships. |
| **PM session** | **Fresh PM**, not reuse of current Aletheia PM | Gemini's argument: the V1 PM's context window is loaded with V1 paradigms (`namespace_id`, single-DB, Node/TS idioms) that V2 explicitly eliminates. A fresh PM seeded only with the V2 plan + V1 README/schema (as reference) avoids hallucinating V1 patterns into V2 Rust code. Trade-off: ~10% lost institutional context, recoverable from the journals. |
| **V1 archival** | Don't archive yet. V1 source + production V1 install both stay live during the V2 build. Archive after V2 deploys cleanly and a stability window passes. | V1 is the rollback target. Archive too early and the rollback path goes cold. |
| **Conductor pattern** | Kyle invokes `/conductor docs/plans/designs/aletheia-v2-plan.md` to dispatch Phase 1; Conductor's per-phase Conductor Review checkpoints are Kyle's approval gates. | Plan already structured for this; the per-phase verification checklists work as-is. |

Open question to confirm: **does Kyle approve the fresh-PM call?** It's the one item where I changed my mind mid-review based on Gemini's pushback.

### Comment 2 — *"Dry-run + safe install + real-file walkthrough using CEO entries"*

This is the largest concrete plan change requested. Three specific deliverables:

**(2a) Side-by-side install architecture (NEW — replaces "V2 npm overwrites V1" in current plan):**

- V2 publishes as a **distinct npm package name** (proposal: `aletheia-v2`, or `@aletheia/mcp-v2` if scoped) — NOT as `aletheia@2.0.0` overwriting V1's `aletheia@0.2.8`.
- V2 binary name: `aletheia-v2` (CLI), distinct from V1's `aletheia`.
- V2 data directory: `~/.aletheia-v2/` (mirrors V1's `~/.aletheia/` layout but separate). Key files at `~/.aletheia-v2/keys/`. Sockets at `~/.aletheia-v2/sockets/`.
- Both V1 and V2 can be installed AND running simultaneously. Different MCP server registrations in `~/.claude/settings.json` — `aletheia` (V1) and `aletheia-v2` (V2).
- Migration tool reads V1 from its current path (`~/.aletheia/data/aletheia.db`), writes V2 into `~/.aletheia-v2/`. V1 untouched until user explicitly removes it.
- Cutover happens by: user validates V2, updates CC settings to point sessions at `aletheia-v2`, eventually removes V1 (`npm uninstall -g aletheia`). No "one command from no-launch."

**(2b) Real-data dry-run command:**

- `aletheia-v2 migrate-from-v1 --dry-run --v1-db-path ~/.aletheia/data/aletheia.db` MUST be runnable against the actual CEO V1 database.
- Output: a structured JSON document AND a human-readable markdown rendering, written to `~/.aletheia-v2/dry-run-reports/<timestamp>.{json,md}`.
- Plan currently defines `MigrationReport::dry_run(v1_meta)` but doesn't specify the report structure. **Define this structure explicitly in Phase 8** (proposed schema below).

Proposed dry-run report structure (please refine):
```yaml
v1_source: { path, schema_version, file_size, total_entries, total_keys }
scopes_planned:
  - v1_namespace: ceo-system
    v2_scope_uuid: <generated>      # stable across dry-run + real-run via deterministic hash of namespace
    v2_scope_db_path: ~/.aletheia-v2/scopes/<uuid>.db
    rows_planned:
      memory: { active: N, archived: M, history_versions: K }
      journal: { count: N, with_provenance: M }
      status: { documents: N, sections: M }
      handoff: { count: N }   # FIX the hardcoded-0 bug
    estimated_disk_bytes: N
    risks_detected:
      - "1 entry has NULL value — will be migrated as empty string with warning"
keys_planned:
  - v1_key_id: <uuid>
    v2_key_hash: <sha256>
    v2_key_file: ~/.aletheia-v2/keys/<name>.key
    permissions: read-write
    primary_scope: ceo-system
estimated_duration_seconds: N
estimated_disk_required_gb: N
will_rename_v1: false   # NEW — dry-run never renames anything
will_write: false       # NEW — emphasized
warnings: []
errors: []
```

**(2c) Migration walkthrough document (Arranger deliverable BEFORE Phase 1 build starts):**

A markdown doc that walks through migration of the actual CEO Aletheia data. The current CEO V1 DB has:
- `ceo-system`: 8 entries (3 journal, 2 memory, 3 status)
- `pm-aletheia`: 3 entries
- `pm-hermes`: 4 entries
- `pm-hockey`: 4 entries
- `pm-skills`: 3 entries
- Total ~22 entries, ~360KB
- V1 schema_version = 4

The walkthrough should trace, for at least one entry per scope and per entry-class, exactly what gets read from V1, what transformation runs, and what V2 row(s) result. Memory entries with version history get extra attention (the version-numbering TODO is a key risk).

This is what Kyle meant by "I want a real file to be used for this walk-through." It's a deliverable, not just dry-run output — written prose that Kyle (and CEO) can review for completeness/correctness before building anything.

**Recommendation:** Arranger pauses after producing this walkthrough document and waits for Kyle's explicit approval before proceeding into Phase 1.

---

## Part 2 — Required plan changes (HIGH priority)

### A. Phase 8 (V1→V2 Migration) — close the acknowledged TODOs

The migration tool is the riskiest one-shot operation in the entire plan. The plan currently ships with multiple `todo!()` stubs and "implementation simplified" notes. Each must be closed before Phase 1.

| ID | Issue | What's needed |
|----|-------|---------------|
| **A1** | Memory version numbering for V1 history rows: plan has `idx as u32 + 1` for history versions and `version=1` for the current row, then says "implementation detail: a full impl assigns version numbers atomically." | Specify the two-pass algorithm: (1) count V1 history rows N; (2) INSERT history rows with versions 1..N (ordered by `changed_at`); (3) INSERT current row with version N+1. Lock the algorithm in the plan; remove the "simplified" hand-wave. |
| **A2** | `fetch_v1_tags_for_entry()` is `todo!()` in the shown code | Provide the actual JOIN: `SELECT t.name FROM tags t JOIN entry_tags et ON et.tag_id = t.id WHERE et.entry_id = ?` plus error handling. |
| **A3** | `memory_journal_provenance` translation is half-shown — `id_mapping` populated for memory IDs only, never for journal IDs, and the final "walk V1 provenance and INSERT translated rows" pass isn't in the orchestrator | Add the journal-side `id_mapping` population in `journal::transform`. Add an explicit "post-all-transforms" step in `orchestrator.rs` that walks V1's `memory_journal_provenance` and inserts translated rows into each scope's V2 `memory_journal_provenance`. |
| **A4** | `handoff_count` is hardcoded to 0 in `v1_intro::introspect` | Actually count handoffs. V1's `handoffs` table has its own primary key but a `target_key_id` and `entry_scope` (or similar) — query per namespace. |
| **A5** | No row-count / checksum validation post-migration | Add a post-migration validation pass: `assert(sum(V2 rows by entry_class) == V1 rows by entry_class + V1 memory_versions count)`; emit per-scope counts in the migration report; fail the migration if counts diverge. |
| **A6** | No detection of running V1 MCP servers during migration | Before migration begins: scan `~/.aletheia/sockets/aletheia-*.sock` for live processes; check `~/.aletheia/sockets/claude-*.sock.path` pointer files for active sessions. If any found, refuse with a clear error listing the live PIDs. Document the override flag (`--ignore-active-sessions`) but make the default safe. |
| **A7** | `dry_run` mode supported but report structure undefined | Define structure (proposed in Part 1.2b above). |
| **A8** | V1 schemas pre-version-4 not handled | Either (a) document minimum supported V1 version explicitly and refuse lower versions with a clear error, or (b) make introspection schema-version-aware with default fallbacks for missing columns (e.g., `revoked` column). |
| **A9** | Failure cleanup deletes V2 scope `.db` files but NOT V2 key files | Add to cleanup: delete `~/.aletheia-v2/keys/*.key` files written during the failed migration. Track them in a `created_key_files: Vec<PathBuf>` similar to `created_scope_files`. |
| **A10** | `migration_state.is_applying=true` STAYS true on failure → V2 hard-locked until admin force_unlock | Reconsider: on failure with all V2 files cleaned up, `is_applying` should flip back to `false` automatically (no V2 state exists, nothing to lock against). The "safe-hold" stance is right WHEN partial V2 state exists, but the failure path with full cleanup is a different case. Refine the failure logic to distinguish the two. |

### B. First-time install + first-time migration master-key flow

Plan describes two entry points but doesn't reconcile them:

- `aletheia-v2 setup` → generates a NEW V2 master key, writes to `~/.aletheia-v2/keys/master.key`, registers hooks
- `aletheia-v2 migrate-from-v1 <path> --confirm-backup-taken` → master-key gated; reads V1 keys table (V1 stored raw values directly in DB)

What's the canonical flow when the same user does both?

Three plausible options — please pick one and document explicitly:
1. **Setup-first, then migrate**: setup generates V2 master key; migrate reads V1 keys and creates V2 sub-keys under V2 master. V1 master key becomes a regular sub-key in V2.
2. **Migrate-first, then setup is no-op**: migrate creates V2 master key derived from V1 master key (continuity of identity); setup detects existing master and is idempotent.
3. **Migrate uses V1 master directly**: setup is skipped; migrate-from-v1 reads V1 key files, writes V2 directory, V1's master key becomes V2's master.

My read: **option 1** is cleanest (clean break, V1 keys become migrated sub-keys, fresh V2 master) but requires every existing CC session to claim with the new V2 master key. Side-by-side install model accommodates this — sessions running V1 keep V1 master, sessions opting into V2 use V2 master. Arranger: please confirm or counter-propose.

### C. SQLite ATTACH 10-DB ceiling — explicit handling

V2's design acknowledges: "SQLite default max attached DBs = 10 (hard max 125). Practical hierarchies (CEO → TL → subTL → worker = 4 attaches) are well within defaults."

Today's CEO has CEO + 4 PM scopes = 5 attaches; 5 within budget. But:
- If CEO ever spans more than 10 writable + readonly scopes (cross-project, future PM proliferation), ATTACH fails.
- Plan should specify either (a) compile rusqlite with `SQLITE_MAX_ATTACHED=125` so the hard ceiling is the practical one, or (b) implement dynamic attach/detach with an LRU policy on the connection's attached scopes.

Recommendation: option (a) — bundle SQLite with the higher cap; document that `claim()` operations exceeding 125 attaches fail with a clear error. This is a one-line build config change vs. a non-trivial connection-management feature.

### D. Plan organization — Phase 0 consolidation document

Five+ retroactive amendments are scattered across phases (Phase 5 amends Phase 2 schema for active_project columns; Phase 5 amends Phase 6 for FTS5; Phase 8 amends Phase 2 with `install_all` functions; Phase 9 amends Phase 5 for `deprecation::check_and_log`; Phase 9 amends Phase 6 for `ScoringEngine` signature).

These are not a "smell" per se (Gemini: "standard LLM planning artifact") but they make sequential execution risky — a Phase 2 builder reading the current Phase 2 spec doesn't see the amendments stashed in Phase 5 and Phase 8.

**Proposal:** Add a Phase 0 deliverable: a "Final State Reference" document that consolidates:
- Final schema for every table in `scope_registry.db` and per-scope `.db` (with all retroactive columns merged in)
- Final `Cargo.toml` dependency set
- Final tool registration list (all 30+ tools with their final signatures)
- Final master-key flow (per Part 2.B)
- Final settings.toml schema (already mostly captured in Phase 1)

Phase 1 builders read the Phase 0 doc and the relevant phase-N section in tandem. The phase sections become "how to build it"; Phase 0 becomes "what the final state must look like."

---

## Part 3 — Recommended polish (MEDIUM priority)

### E. Shadow Mode dead-code framing

V2 ships Shadow Mode infrastructure with `NoOpComparisonRanker` as default. The infra is fully wired but produces zero useful data in V2 — the `analyze_shadow_mode` MCP tool returns "no comparison data available" for the V2 lifetime.

This is per CEO Item 1 ("V2 plumbs, V3 fills"), but it means production V2 carries dead code paths that never exercise.

Two options:
1. **Validation-mode default**: `[shadow] enabled = false` in settings.toml by default. Master-key opt-in for V2 users who want to experiment. Documentation makes clear V2 has no comparison data to analyze; the infra is for V3.
2. **Self-comparison default**: Have V2 ship a `SelfComparisonRanker` that emits the V2 ranking as its own comparison (no diff, but exercises the log-write path). At least the schema gets exercised; integration test passes; bugs surface before V3 swaps in the real ranker.

I lean toward (1) — simpler, more honest. Option (2) creates noise. Arranger: pick.

### F. Phase 9 reconciler stubs

`promote_memory` recovery handlers have multiple `todo!()` calls (`check_source_tombstoned`, `check_target_inserted`, `tombstone_source`, `insert_target`). These need to be implemented before V2 ships.

Lower urgency than Phase 8 TODOs (reconciler handles edge-case recovery), but should not ship as `todo!()` panics in production.

---

## Part 4 — Open questions for the Arranger to answer

1. **Manual "stop all CC sessions" step in MIGRATION-FROM-V1.md** — combined with A6 (active-session detection), can we make this automatic-with-override rather than manual? Side-by-side install model softens this concern but doesn't fully eliminate it.
2. **`--stage-digest-as-mass-ingest` decision criteria** — when should a user pick this vs. default lazy-claim digest? Plan offers the option but no guidance on when to use it.
3. **CC `~/.claude/settings.json` co-existence** — with side-by-side install, both `aletheia` and `aletheia-v2` are MCP servers. Do hooks (SessionStart, L1, L2) need separate paths per server, or can both share the same hook scripts?
4. **Cutover ceremony** — once V2 is validated by user, what's the recommended sequence to retire V1? `npm uninstall -g aletheia` + remove its MCP entry from `~/.claude/settings.json`?
5. **Aletheia PM session naming** — if we go fresh PM (Part 1 Comment 1), what's the PM scope name? `pm-aletheia-v2`? Or rename current `pm-aletheia` after V2 deploys? The current PM has memories tied to V1 build context.

---

## Part 5 — Out of scope / dropped concerns

These came up in review but I'm dropping them — Arranger, no action needed unless you disagree:

| Concern | Why dropped |
|---|---|
| Rust language choice vs Node | Settled. Gemini: "water under the bridge." Cold-start cost + permission precision + zero-copy SQLite are real wins; language-switch tax is acceptable. |
| Registrar pattern (Phase 4 → 9 uncomment-a-line) brittleness | For sequential AI Conductor execution, the pattern is safe and predictable. Concern was a human-multi-developer transposition error. |
| Append-only storage cost | Kyle accepted explicitly per dramaturg-journal.md ("storage cost concern is almost completely irrelevant"). |
| `migration_in_progress` per-tool indexed point-lookup overhead | ~1ms per tool call; profile if observed. Not a blocker. |
| KG layer absence in V2 | By design, deferred to V3. |
| First-install MCP timeout on slow connections | Documented as known risk; mitigations in INSTALL.md. |
| Code signing for macOS/Windows | Documented as future work; user-overridable warnings acceptable for V2.0.0. |

---

## Part 6 — Suggested order of corrective work

If Arranger agrees with most of Part 1-3, the recommended sequence is:

1. **First**: Address Part 1 Comment 2 — define the side-by-side install architecture, the dry-run report structure, and produce the migration walkthrough using CEO data. This is the deliverable that gates Phase 1 build approval.
2. **Second**: Close Part 2.A TODOs (Phase 8 implementation gaps). These are inline plan corrections.
3. **Third**: Resolve Part 2.B (master-key flow) and Part 2.C (ATTACH ceiling). Both are short documentation/decision items.
4. **Fourth**: Produce Part 2.D (Phase 0 Final State Reference). This integrates the retroactive amendments into a single readable artifact.
5. **Fifth**: Polish (Part 3) — Shadow Mode framing decision + reconciler stub implementations. These can land any time before Phase 9 begins.
6. **Last**: Answer Part 4 open questions, surfacing any that need Kyle's input rather than Arranger autonomy.

---

## Closing

The V2 plan reflects substantial design work and the architectural backbone is sound. The corrective work above tightens the riskiest bits (migration, install) and resolves some honest-but-loose ends in the plan. Once these land, V2 should be in a state where Phase 1 can begin with high confidence.

Arranger: please respond by either incorporating these into the plan directly (preferred where you agree) or flagging back to Kyle/CEO with counter-proposals where you disagree. Where my reasoning is weak, push back — Gemini already corrected me on the PM-reuse and Registrar concerns, and the doc above reflects those corrections, but I'm sure there are more.
