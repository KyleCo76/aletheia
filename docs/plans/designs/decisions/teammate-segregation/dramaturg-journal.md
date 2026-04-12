# Dramaturg Decision Journal — Teammate Memory Segregation

**Topic:** teammate-segregation
**Session:** autonomous PM-Aletheia, 2026-04-12
**Mode:** fallback (Dramaturg skill 8-phase structure followed manually; no live user, no Gemini MCP in tool surface). Task `task-dramaturg-32-design.md` explicitly permits this fallback.
**Design doc target:** `docs/v0.2.0-design/teammate-segregation.md` (UPDATE in place per task spec, not the Dramaturg default location).

---

## Vision Baseline
**Phase:** 2 (Vision Loop)
**Category:** goal
**Decided:** Write-side teammate memory segregation — every record written to a child table (journal_entries, memory_entries, status_documents, status_sections) must carry a provenance chain identifying the writer's sub-key ancestry, so that (a) a teammate's writes can be distinguished from the parent PM's within the same entry, (b) peer teammates do not see each other's writes by default, and (c) the parent PM can see all descendants' writes.

**User verbatim** (from original design doc + task-dramaturg-32-design.md):
> "The worker's write_journal calls land in the PM's journal entry with created_by_key pointing at the PM's key. A later read call cannot tell which lines the PM wrote vs. which the worker wrote."
>
> "Write-side teammate segregation is a security invariant and affects every write_* handler; it needs more design rigor than round-3-round-4 commits got."

**User context:** The v0.2.0 design doc (commit 261c74c) proposed a hybrid key-chain-walking + denormalized owner_chain column approach. The smallest slice shipped in v0.2.4 (commit e3254d3): getKeyChain helper + sessionState wiring. Write-side is the remaining gap.

**Alternatives discussed:** Option A (sub-namespace string convention), Option B (recursive CTE at query time), Option C (subscope_of_entry_id FK). Original doc settled on hybrid B+denormalized column; this session re-examines at the level of which table(s) the column lives on.

**Status:** settled

---

## Vision Expansion
**Phase:** 3
**Accepted enrichments:**
- Digest-system interaction: when a digest teammate synthesizes journal entries into memories via promote_to_memory, the resulting memory's owner_chain is the digest teammate's chain, NOT the source journal entries' chains. Source provenance is preserved in memory_journal_provenance. This is a consequence of "whoever writes owns it".
- Status sections co-editing: sections within a shared status document may have different writers. Each section row needs its own owner_chain so peer teammates can update their assigned sections without their writes being attributed to the document creator.
- Handoff table exemption: handoffs are caller-scoped (target_key IS the reader); writer tracked via handoffs.created_by. No owner_chain needed — the read path is WHERE target_key = ?, not affected by segregation.

**Rejected enrichments:**
- Cryptographic isolation: out of scope (non-goal from original doc).
- Per-table ACLs: out of scope (non-goal from original doc).
- Retrofitting v0.1.x entries with reconstructed chains: "what I would NOT do" from original doc; NULL is the right sentinel.

**Tabled enrichments:**
- Chain-rewriting tools (e.g., "transfer ownership" for when a teammate is promoted to PM-equivalent): too speculative for v0.2.x, no current use case.

**Status:** settled

---

## Topic Map
**Phase:** 4
**Topics to explore in Phase 5:**
1. Chain granularity: `owner_chain` on `entries` only vs on child rows?
2. Write-side enforcement point: handler layer vs query layer?
3. Teammate-spawns-teammate chain append semantics
4. Read-side visibility rules and index performance
5. Migration plan (add column, NULL semantics, backup interaction)
6. Failure modes (getKeyChain errors, key revocation mid-session)
7. Test strategy (minimum 3 regression cases)
8. Resolution of the 4 open questions from the original doc

**Status:** settled

---

## Decision: Chain granularity — owner_chain on child rows, NOT on entries
**Phase:** 5
**Question:** Where does owner_chain live? On `entries` only, on child rows only, or both?

**Findings** (from codebase inspection):
- Only ONE `INSERT INTO entries` call in the tool handlers (`entries.ts:64` in `create_entry`). Everything else (write_journal, write_memory, replace_status, add_section, retire_memory, promote_to_memory) writes to child tables (journal_entries, memory_entries, status_documents, status_sections) via existing `entries.id` references.
- Original design doc said "compute owner_chain at insert time from claimedKey.id" but did NOT specify which table(s). The ambiguity matters because the concrete problem case is "a teammate writes a journal LINE into the PM's entry and the line is indistinguishable from the PM's lines" — that's a CHILD-row problem, not an entries-row problem.
- If owner_chain lives only on `entries`, a teammate writing into the PM's entry inherits the PM's chain (the entry was created by the PM). Segregation goal fails for the most common use case.
- If owner_chain lives on child rows, each write records its own writer's chain. Shared entries work correctly.

**Decision:** owner_chain on child rows only (journal_entries, memory_entries, status_documents, status_sections). NOT on entries.

**Rationale:**
1. Solves the actual problem (shared entries with distinct writers).
2. `entries.created_by_key` already records who CREATED the entry — adding a second column with similar but not identical semantics would confuse readers.
3. 4 child tables × 1 column each = manageable migration surface.
4. Small extra cost per INSERT (~16 bytes, an indexed text column); rows are already wider than that.
5. `list_entries` remains unfiltered by chain — returns all entries in the namespace. If Kyle later wants list_entries to filter by visible child rows, an EXISTS subquery can be added without schema change.

**Arranger note:** UNRESEARCHED — decision based on codebase inspection, no Gemini verification because Gemini is not available in this session. The Arranger should confirm: (a) no other INSERT site into entries exists that I missed, (b) SQLite ALTER TABLE ADD COLUMN performance on the actual production data volume, (c) the index on owner_chain plays well with existing indexes.

**Status:** settled

---

## Decision: Write-side enforcement lives at the handler layer
**Phase:** 5
**Question:** Where does the chain get passed into the INSERT? The query layer (e.g., appendJournalEntry pulls sessionState via an import)? Or the handler layer (write_journal reads sessionState and passes it to appendJournalEntry)?

**Findings:**
- sessionState.keyChain is already populated at claim time (v0.2.4). Reading it is free at any point after claim.
- The query layer (src/db/queries/*) currently has no dependency on sessionState — it's a pure data-access layer. Threading sessionState into query functions would be a layering violation.
- The handler layer (src/server/tools/*) already owns auth context (see v0.2.4's claimGuard helper). Reading sessionState is the handlers' job.

**Decision:** Handlers read `sessionState.get('keyChain')` and pass it as a parameter to query functions. Query functions gain an `ownerChain: string | null` parameter that is threaded into the INSERT statement. The query layer's type signature becomes more explicit; no session coupling.

**Rationale:**
1. Preserves the query layer's purity (no session imports).
2. The chain is already cached on sessionState; reading is free.
3. Matches the pattern established by v0.2.4's claimGuard (session context lives in handlers).
4. Tests can pass null for ownerChain (fresh dbs, unclaimed writes) or a synthetic chain without mocking sessionState.

**Arranger note:** VERIFIED (architectural pattern, established in v0.2.4).

**Status:** settled

---

## Decision: Teammate-spawns-teammate chain appends naturally
**Phase:** 5
**Question:** If a teammate T1 creates a sub-teammate T2 via create_key, does T2's chain correctly become `root/PM/T1/T2`?

**Findings:**
- auth.ts create_key handler sets `createdBy: claimed?.id` — the calling session's claimed key id. So T2's row in `keys` has `created_by = T1.id`. ✓
- getKeyChain walks created_by upward from the starting key. Starting from T2: T2 → T1 → PM → root. Returns `root/PM/T1/T2`. ✓
- T2's claim then stashes this chain on its own sessionState.
- No additional work needed for chain append — the v0.2.4 implementation already handles it.

**Decision:** No code change needed. Document the property in the design doc so future implementers know the invariant.

**Arranger note:** VERIFIED (v0.2.4 test/key-chain.test.mjs already covers 2-level and 3-level chains).

**Status:** settled

---

## Decision: Read-side visibility uses precomputed ancestor-list IN filter
**Phase:** 5
**Question:** What's the SQL pattern for "my writes + my ancestors' writes" (the default L1/L2 injection scope)? The original design proposed LIKE-prefix, but that only uses the index for "descendants" queries (`WHERE owner_chain LIKE 'mychain/%'`), NOT for "ancestors" queries (`WHERE 'mychain' LIKE owner_chain || '%'`).

**Findings:**
- LIKE with a constant prefix uses the index (SQLite optimizer rewrites to a range query).
- LIKE with a column-derived prefix does NOT use the index — it has to evaluate the expression row-by-row.
- The default L1/L2 injection filter is "mine + ancestors" which is the column-derived-prefix case.
- Alternative: precompute the ancestor list at claim time. Reader with chain `root/PM/T` has ancestor prefixes `['root', 'root/PM', 'root/PM/T']`. Filter becomes `owner_chain IN (?, ?, ?) OR owner_chain IS NULL`. IN uses the index.
- Cost of precomputation: O(chain depth), bounded at 16 by the v0.2.4 cycle defence. Free at claim time.

**Decision:** Store two fields on sessionState at claim time:
- `sessionState.keyChain` = full chain string (already populated, v0.2.4)
- `sessionState.ancestorChains` = array of prefix strings including self (new)

Injection builders and filtered read queries use IN with the ancestorChains array plus `IS NULL` for v0.1.x backward compat.

**Rationale:**
1. "Mine + ancestors" is the hot path (every injection); must be indexable.
2. "Mine + descendants" (parent review) remains LIKE-prefix, which is also indexable.
3. Precomputation cost is negligible and amortized over every read during the session.
4. The IN approach degrades gracefully: an unclaimed session has ancestorChains = undefined, queries fall back to legacy "no filter" behavior.

**Arranger note:** UNRESEARCHED — SQLite query planner behavior for IN with small lists vs index range scans should be verified with EXPLAIN QUERY PLAN on representative data. For small chains (typical depth 2-3), either approach is fine in practice.

**Status:** settled

---

## Decision: Migration 4 adds owner_chain to 4 child tables in one pass
**Phase:** 5
**Question:** Should the migration add owner_chain to all 4 tables at once, or one at a time across multiple migrations?

**Findings:**
- ALTER TABLE ADD COLUMN is O(1) in SQLite regardless of row count (metadata-only).
- Adding 4 columns = 4 ALTER statements inside a single migration function.
- The v0.2.3 migration3 FK-toggle fix applies uniformly — migrations run with `PRAGMA foreign_keys = OFF` at the orchestrator level, so ALTER TABLE operations don't trip FK constraints.
- Read-side compatibility: NULL owner_chain means "legacy, visible to everyone in namespace". Write-side code that lands after migration 4 but before the full read-side filter will write real chains while readers treat NULL and non-NULL uniformly. Graceful rollout.

**Decision:** Migration 4 adds `owner_chain TEXT` nullable + index `idx_<table>_owner_chain` to journal_entries, memory_entries, status_documents, status_sections — all in one migration function. Runs automatically via the v0.2.3-fixed runMigrations orchestrator.

**Rationale:**
1. One migration is easier to reason about than four.
2. ALTER is cheap on SQLite even for populated dbs.
3. Index creation is the slower step but still acceptable for any realistic Aletheia db (thousands to tens of thousands of rows).
4. The v0.2.3 FK-toggle ensures the migration is safe on populated dbs.

**Arranger note:** PARTIAL — migration passes on empty/fresh dbs by construction. Arranger should add a test that runs migration 4 on a seeded pre-migration db (populated with journal/memory rows) and verifies the index is created and existing rows have NULL owner_chain.

**Status:** settled

---

## Decision: Chain staleness on key revocation is harmless
**Phase:** 5
**Question:** What happens if a key is revoked mid-session? The cached sessionState.keyChain is stale. Are subsequent writes incorrect?

**Findings:**
- v0.2.3's refreshClaim helper clears `sessionState.claimedKey` when the key is deleted. Subsequent writes hit claimGuard → NO_CLAIM → fail-closed. The stale keyChain is never used for a write because no write fires.
- If a key is MODIFIED (permissions downgraded), the chain doesn't change — key_id is the same, created_by is the same, the chain is valid.
- If a key's created_by is modified (shouldn't happen; no handler exposes this), the chain becomes stale. But this path doesn't exist, so not a concern.
- Minor find: refreshClaim on delete path clears claimedKey but NOT keyChain. Harmless (the chain is never read after claim clears) but untidy. Worth a small cleanup in the implementation phase.

**Decision:**
- No new runtime logic needed. The v0.2.3 fail-closed behavior prevents stale-chain writes.
- Implementation-phase cleanup: refreshClaim's delete branch should also delete sessionState.keyChain and sessionState.ancestorChains for cleanliness.

**Arranger note:** VERIFIED (v0.2.3's write-handler-refresh.test.mjs already covers the revocation path; the cleanup is a 2-line addition).

**Status:** settled

---

## Decision: Resolution of 4 original open questions
**Phase:** 5

**Q1. Does the L1/L2 default match operator intent (own + ancestors)?**
**A:** Yes. Teammate workers depend on parent context (PM's setup memories, architectural constraints). Cutting the ancestor link forces every worker to replicate context via explicit prompts — wasteful and fragile. The common case is "worker needs PM's context but shouldn't leak its own findings into peers' contexts" — own + ancestors is the right default. Parents who want truly isolated workers can set sessionState-level scope overrides in a future tool.

**Q2. Cycle defence depth?**
**A:** 16, as implemented in v0.2.4's getKeyChain. Rationale: deeper than any realistic PM hierarchy (Kyle's current org has depth 3-4); depth > 16 almost certainly indicates data corruption and should surface visibly rather than silently walk forever.

**Q3. Cross-PM peer keys?**
**A:** Two PMs delegating from ceo-system are PEERS. Their chains are `ceo-system/PM-A` and `ceo-system/PM-B`. The "own + ancestors" filter for PM-A includes `ceo-system` and `ceo-system/PM-A` but NOT `ceo-system/PM-B`. Correct peer isolation by default. Kyle can read from a ceo-system-scoped key to see the global view when needed.

**Q4. Migration opt-in vs automatic?**
**A:** Automatic. The v0.2.3 runMigrations FK-toggle fix makes migrations safe on populated dbs. Operators with concerns can always run `aletheia backup` first (the #24 framework is in place). An opt-in migration would strand v0.2.x users on the old schema until they remembered to run it — worse UX.

**Status:** all 4 settled

---

## Test Strategy Topic Map
**Phase:** 5
**Minimum cases** (from task spec):
1. **Parent-only write visible to parent.** PM writes a journal line, reads it back — present in injection.
2. **Teammate-child write visible to parent.** Teammate writes a line into PM's entry; parent PM reads (own + descendants scope) — line present.
3. **Peer isolation.** Teammate A writes a line; teammate B reads with own + ancestors scope — line NOT present.

**Additional regression guards the design demands:**
4. NULL owner_chain (v0.1.x backward compat) visible to any reader.
5. Migration 4 idempotence (run twice, no error).
6. Migration 4 on populated db (rows preserved, new column = NULL).
7. Chain append through 2 levels of delegation (root → PM → T1 → T2).
8. refreshClaim on key deletion clears both claimedKey and keyChain.
9. Indexable IN query performance (EXPLAIN QUERY PLAN shows index usage).

**Status:** settled

---

## Section Approval — Goals, Non-goals, Approach
**Phase:** 6
**Key decisions reflected:** Original doc's goals are preserved. Approach now specifies CHILD-ROW chain scope, not entries-row. Read-side filter uses precomputed ancestor IN list instead of LIKE-prefix for the hot path.
**Feedback incorporated:** N/A (autonomous session)
**Status:** approved

---

## Section Approval — Migration & rollout
**Phase:** 6
**Key decisions reflected:** One migration function adds owner_chain to 4 child tables + indexes. Automatic migration via v0.2.3 orchestrator. NULL sentinel for v0.1.x rows remains readable.
**Status:** approved

---

## Section Approval — Test strategy
**Phase:** 6
**Key decisions reflected:** 3 minimum cases + 6 regression guards enumerated.
**Status:** approved
