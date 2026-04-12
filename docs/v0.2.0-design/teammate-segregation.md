# Design: Teammate memory segregation

**Status:** v0.2.x design, Dramaturg-reviewed 2026-04-12.
Implementation deferred pending CEO + Kyle review.
**Author:** PM-Aletheia (v0.2.0 draft 2026-04-11, Dramaturg revision 2026-04-12)
**Target audience:** Kyle, CEO, future implementer
**Decision journal:** `docs/plans/designs/decisions/teammate-segregation/dramaturg-journal.md`
**Mode note:** The 2026-04-12 revision used the Dramaturg skill's 8-phase
structure as a self-reflection framework (no live user, no Gemini MCP in
tool surface). The task file explicitly permitted this fallback. Every
Decision entry in the journal carries an Arranger note flagging whether
it's VERIFIED, PARTIAL, or UNRESEARCHED for downstream audit.

## Goals

G1. **Provenance at write-level granularity:** every row in the child
    write tables (journal_entries, memory_entries, status_documents,
    status_sections) records which sub-key wrote it, not just which
    parent. A teammate writing a journal line into the PM's shared
    entry must be distinguishable from the PM writing the same line.
G2. **Read-side inclusion of ancestors:** a teammate reads the parent's
    memory by default. Worker contexts depend on parent setup; cutting
    that link would force every worker to replicate context via
    explicit prompts.
G3. **Read-side exclusion of peers:** a teammate does NOT see other
    peer teammates' writes by default — workers are isolated from each
    other to prevent cross-contamination.
G4. **Parent visibility of descendants:** the parent PM can read all
    descendants' writes — both for review and for triggering memory
    promotion of interesting findings.
G5. **Backward compatibility:** v0.1.x sessions that don't use
    teammate sub-keys continue to behave as today. NULL `owner_chain`
    is interpreted as "visible to any reader in this namespace".

## Non-goals

- Per-table or per-row ACLs. Permissions stay key-level.
- Cryptographic isolation. This is logical scoping, not sandboxing.
- Cross-PM teammate sharing. A PM-A teammate cannot read a PM-B
  teammate's writes; that's just G3 applied across PMs.
- Retrofit of v0.1.x entries with reconstructed owner_chains. NULL is
  the right "I don't know" sentinel; the alternative is guessing,
  which corrupts audit.
- Chain rewriting / ownership transfer. No current use case.

## The shipped foundation (v0.2.4, commit e3254d3)

These pieces are already in place and the implementation phase should
NOT redo them:

- `getKeyChain(db, keyId): string` in `db/queries/keys.ts`. Walks
  `keys.created_by` upward with depth cap 16 and a visited-set cycle
  defence. Returns a slash-joined root-to-leaf ancestor chain.
- `claim` and `bootstrap` handlers in `auth.ts` call `getKeyChain` at
  auth time and stash the result on `sessionState.keyChain`.
- 7 regression tests in `test/key-chain.test.mjs` pinning chain
  semantics (root, 2-level, 3-level, unknown-key, self-loop, 20-deep
  cap, claim-handler storage).

## Core design decision: owner_chain lives on CHILD rows, not on `entries`

The original v0.2.0 draft was ambiguous about which table owns the
`owner_chain` column. The Dramaturg session resolved it.

The shipped Aletheia model has only ONE tool-level `INSERT INTO entries`
call (`entries.ts:64` in `create_entry`). Every subsequent write —
`write_journal`, `write_memory`, `replace_status`, `add_section`,
`retire_memory`, `promote_to_memory` — writes to a CHILD table that
references an existing `entries.id`. The concrete problem case is:

> "The worker's write_journal calls land in the PM's journal entry
> with created_by_key pointing at the PM's key. A later read call
> cannot tell which lines the PM wrote vs. which the worker wrote."

This is a **child-row granularity problem**. A teammate writing into the
PM's entry should record THEIR own chain, not inherit the PM's. Putting
`owner_chain` on `entries` alone would leave the shared-entry case
unsolved — the most common case.

**Decision:** `owner_chain` lives on the four child write tables:

- `journal_entries.owner_chain TEXT NULL`
- `memory_entries.owner_chain TEXT NULL`
- `status_documents.owner_chain TEXT NULL`
- `status_sections.owner_chain TEXT NULL`

Each column is indexed: `CREATE INDEX idx_<table>_owner_chain ON <table>(owner_chain)`.

The `entries` table gains NO new column. Its existing
`created_by_key` captures "who created the entry shell" and that remains
the correct semantic — entries are containers, not the unit of
authorship. `list_entries` is therefore NOT filtered by chain in v0.2.x;
it returns all entries in the namespace regardless of writer. A future
release could add an EXISTS-subquery scope flag without a schema change.

The `handoffs` table gains NO new column either. Handoffs are
caller-scoped (the target_key IS the reader); writer tracked via
`handoffs.created_by`. The read path is `WHERE target_key = ?`, not
affected by segregation.

## Write-side enforcement

### Where the chain comes from

`sessionState.keyChain` is populated at claim time (v0.2.4). Reading it
is free at any point after claim. Write handlers read it and pass it
to the query function:

```ts
// Handler (src/server/tools/journal.ts)
const ownerChain = sessionState.get('keyChain') as string | undefined;
const result = appendJournalEntry(db, {
  entryId,
  content,
  ownerChain: ownerChain ?? null,  // null = legacy / dev mode
});
```

```ts
// Query layer (src/db/queries/journal.ts)
export function appendJournalEntry(
  db: Database.Database,
  params: { entryId: string; content: string; ownerChain: string | null },
): { id: string; createdAt: string } {
  // INSERT now includes owner_chain column
}
```

The query layer gains one new parameter; no session import. This
matches the architectural pattern established by v0.2.4's `claimGuard`
helper — session context lives in handlers, data access stays pure.

### Handlers that need the change

Every write handler that inserts into one of the four child tables:

| Handler | Child table | Current INSERT site |
|---|---|---|
| `write_journal` (standard) | journal_entries | `appendJournalEntry` |
| `write_journal` (critical) | journal_entries + memory_entries + memory_journal_provenance | inline |
| `write_memory` | memory_entries | `writeMemory` |
| `promote_to_memory` | memory_entries + memory_versions | inline transaction |
| `replace_status` | status_documents | `replaceStatus` |
| `add_section` | status_sections | `addSection` |
| `update_status` | status_sections (UPDATE, not INSERT) | `updateStatusSection` |
| `remove_section` | status_sections (DELETE) | `removeSection` |
| `retire_memory` | memory_entries (UPDATE archived_at) | `retireMemory` |

Notes:
- UPDATE and DELETE operations do NOT need to re-assign owner_chain —
  the chain is immutable once written. A teammate updating a section
  they originally wrote doesn't change the owner_chain; a teammate
  updating a section someone else wrote does NOT overwrite the original
  chain (the update happens within the existing row, so the row's
  chain is unchanged).
- The `memory_versions` table stores historical memory values; it does
  NOT get an owner_chain column. The active memory's chain is the
  authoritative writer; version history is provenance, not authorship.
- `memory_journal_provenance` links memories to source journal
  entries; no chain needed because both sides already have their own.

### Teammate-spawns-teammate chain append

Verified against v0.2.4's create_key handler: `createdBy: claimed?.id`.
A teammate T1 creating a sub-teammate T2 results in T2's keys row
having `created_by = T1.id`. When T2 claims its key, `getKeyChain`
walks upward: `T2 → T1 → PM → root`, returning `root/PM/T1/T2`. No
additional work needed. v0.2.4's tests already cover 2-level and
3-level chains; a 4-level test is worth adding for the write-side
implementation phase.

## Read-side visibility

### Precomputed ancestor-list filter (the hot path)

The original design proposed a LIKE-prefix filter:
`WHERE owner_chain LIKE 'mychain%'`. This works for "own + descendants"
(parent reading children — the constant is the prefix, SQLite's query
planner uses the index). It does NOT work for "own + ancestors"
(the default L1/L2 injection scope), because that inverts the
comparison: `WHERE 'mychain' LIKE owner_chain || '%'`. The column is on
the right side of the expression, so the index is unusable and the
query plan degenerates to a full scan.

**Decision:** Precompute the ancestor list at claim time and use an IN
filter.

A reader with chain `root/PM/T` has ancestor prefixes
`['root', 'root/PM', 'root/PM/T']`. The query becomes:

```sql
SELECT ... FROM journal_entries
WHERE (owner_chain IN (?, ?, ?) OR owner_chain IS NULL)
  AND <other filters>
```

IN-with-literals is indexable. The precomputation cost is O(chain
depth), bounded at 16 by the cycle defence. It's amortized over every
read in the session.

**New sessionState field:** `sessionState.ancestorChains: string[]` —
array of prefix strings INCLUDING self. Computed at claim time next
to `keyChain`. Populated by `claim` and `bootstrap` handlers.

### The four read scopes

The injection builders and explicit read tools support four scopes:

1. **own** — `owner_chain = :myChain`. Most restrictive. Used by a
   teammate that wants to see only its own writes.
2. **own + ancestors (DEFAULT)** — `owner_chain IN (:prefix0, :prefix1, ...)`.
   What a teammate sees by default. Includes the PM's setup memories
   and architectural context while excluding peer teammates.
3. **own + descendants** — `owner_chain = :myChain OR owner_chain LIKE :myChain || '/%'`.
   What a PM sees when reviewing what children have written. Used by
   explicit review tools, NOT the default injection path.
4. **all** — no `owner_chain` filter. Legacy v0.1.x behavior and the
   escape hatch for debugging. `list_entries` uses this.

For all four scopes, `owner_chain IS NULL` is unioned in for backward
compatibility — v0.1.x rows written before migration 4 remain visible
to every reader. New rows written post-migration always carry a
non-NULL chain (or `''` for unclaimed dev-mode writes, which read the
same way).

### Default is own+ancestors for injection builders

The v0.2.x L1 and L2 injection builders (`l1-builder.ts`,
`l2-builder.ts`) switch to the own+ancestors scope as their default.
Explicit tools gain optional scope parameters for callers that want
to peek at descendants or at all.

**Tools impact:**

| Tool | Current scope | New default |
|---|---|---|
| L1 injection builder | all-in-namespace | own + ancestors |
| L2 injection builder | all-in-namespace | own + ancestors |
| `read_memory_history` | by entry_id only | own + ancestors |
| `search` (memory, journal) | by namespace | own + ancestors + optional `scope: 'all'` |
| `read` (generic) | by entry_id | own + ancestors + optional `scope` |
| `list_entries` | by namespace | no change (still all) |

Scope flags appear in the tool input schema. The default matches the
security-invariant intent.

## Migration plan

**Migration 4: add owner_chain to child write tables.**

```sql
-- Runs inside runMigrations' PRAGMA foreign_keys = OFF block
-- (v0.2.3 orchestrator-level fix).
ALTER TABLE journal_entries  ADD COLUMN owner_chain TEXT;
ALTER TABLE memory_entries   ADD COLUMN owner_chain TEXT;
ALTER TABLE status_documents ADD COLUMN owner_chain TEXT;
ALTER TABLE status_sections  ADD COLUMN owner_chain TEXT;

CREATE INDEX idx_journal_entries_owner_chain  ON journal_entries(owner_chain);
CREATE INDEX idx_memory_entries_owner_chain   ON memory_entries(owner_chain);
CREATE INDEX idx_status_documents_owner_chain ON status_documents(owner_chain);
CREATE INDEX idx_status_sections_owner_chain  ON status_sections(owner_chain);
```

- Every ALTER is metadata-only (SQLite).
- Index creation is the slower step; acceptable for any realistic
  Aletheia db (thousands to tens of thousands of rows).
- Existing rows get `owner_chain = NULL`, interpreted as legacy-visible
  to every reader.
- Automatic, not opt-in. v0.2.3's FK-toggle makes migrations safe on
  populated dbs. Operators with concerns run `aletheia backup` first
  (the v0.2.0 framework is in place).
- Backup/restore (#24) survives the migration: `db.backup()` is a
  page-level copy that preserves the schema plus data. Post-migration
  backups include the column; pre-migration backups restored into a
  v0.2.x install get the column added automatically on next server
  startup.

## Failure modes

**getKeyChain throws at claim time.** Claim fails, session stays
unauthenticated, all subsequent writes hit `claimGuard` → NO_CLAIM →
fail-closed. The caller sees an error on claim() and cannot do anything
without a valid claim.

**getKeyChain returns an empty string** (unknown key id). This
shouldn't happen in normal operation — by the time claim stores a chain,
the key has been validated. If it does happen, the chain is stored as
`""` and subsequent writes record `""` as the owner_chain. Reads with
an empty ancestorChains array match no rows (IN clause with a single
empty string matches only empty strings). Fail-quiet but not
fail-silent — the write is durable, just invisible to normal reads.
The debug path (`scope: 'all'`) still surfaces it.

**Key revoked mid-session.** v0.2.3's `refreshClaim` clears
`sessionState.claimedKey` on key deletion. Writes hit claimGuard →
NO_CLAIM → fail-closed before touching the stale chain. Harmless.

**refreshClaim cleanup gap.** v0.2.3's refreshClaim clears
`claimedKey` but NOT `keyChain` or `ancestorChains`. Harmless (the
chain is never read after claim is cleared), but untidy. The
implementation phase should tighten refreshClaim to delete all three.

## Test strategy

Minimum cases from the task spec (all MUST be present in the
implementation commit):

1. **Parent-only write visible to parent.** PM writes a journal line,
   L1 injection with own+ancestors scope returns the line.
2. **Teammate-child write visible to parent.** PM creates an entry,
   teammate writes a line into that entry, PM reads with
   own+descendants scope — the teammate's line is present.
3. **Peer isolation.** Teammate A writes, teammate B reads with
   own+ancestors scope — A's line is NOT present. A's line IS present
   in PM's descendants scope.

Additional regression guards mandated by the design:

4. **NULL compatibility.** Pre-migration row (owner_chain = NULL) is
   visible to every reader regardless of scope.
5. **Migration 4 idempotence.** Running migration 4 twice on the same
   db is a no-op the second time (standard migration gate).
6. **Migration 4 on populated db.** Seed journal/memory rows, run
   migration, verify rows preserved with owner_chain = NULL.
7. **4-level chain append.** Root → PM → T1 → T2. T2's write is
   visible to T1, PM, and root under descendants scope; visible only
   to T2 and ancestors under own+ancestors scope.
8. **refreshClaim cleanup.** On key deletion, sessionState.keyChain
   and sessionState.ancestorChains are cleared alongside claimedKey.
9. **Index usage.** `EXPLAIN QUERY PLAN` shows index usage for the
   own+descendants LIKE-prefix query and the own+ancestors IN query.
10. **Critical write path.** `write_journal(critical: true)` inserts
    journal + memory + provenance; only journal and memory carry
    owner_chain (provenance is a link table).
11. **promote_to_memory chain.** Memory synthesized from source
    journal entries gets the CALLER's chain, not the source entries'.
    Source provenance is preserved in memory_journal_provenance.
12. **status_sections peer-editing.** PM creates status doc, teammate
    A adds section s1, teammate B adds section s2. A can see s1 under
    own+ancestors but NOT s2. PM sees both under own+descendants.

## Implementation phasing

Single-phase ship. The earlier draft proposed splitting into "schema
only" and "read wiring" but the child-row decision above makes the
schema incomplete without the read-side wiring — a v0.2.x release with
the column populated but no filter would silently break the default
injection scope for any claimed session.

**One commit set:**

1. Migration 4 (schema)
2. Handler updates: pass ownerChain to query functions
3. Query layer updates: INSERT includes owner_chain; SELECT accepts
   optional ancestor list and scope enum
4. Injection builder updates: default to own+ancestors
5. sessionState.ancestorChains computation at claim + bootstrap
6. refreshClaim cleanup for keyChain and ancestorChains
7. All 12 tests above
8. CHANGELOG entry for v0.2.x (probably v0.3.0 given the scope)

Rough commit size estimate: ~500 lines of implementation +
~600 lines of tests. Comparable to the v0.2.3 round-2 batch.

## Security invariants (CEO review lens)

The design must preserve these across implementation:

- **Denials only grow.** A teammate cannot see writes that its parent
  cannot see. Chain filter is strictly more restrictive, never less.
  The IN-list approach enforces this: the list is derived from the
  reader's own chain upward; no downward-reaching entries.
- **Backward compat is one-way.** NULL rows are visible to everyone;
  non-NULL rows obey the chain filter. A v0.1.x caller writing into a
  v0.2.x db gets NULL rows (no claim → unclaimed writes) and its
  writes remain universally visible — matching v0.1.x semantics.
- **Forward-compat with #16 key delegation.** The chain is derived
  from `keys.created_by`, which is set via the hardened create_key
  handler (item #16, v0.2.0). #16 enforces subset rules on delegation;
  a teammate cannot mint a sibling with a shorter chain. Correctness
  of segregation inherits correctness of #16.
- **Fail-closed on authentication errors.** v0.2.3's claimGuard is
  unchanged by this design. A revoked key cannot write, so cannot
  poison the chain with stale data.

## Arranger Notes

The Arranger consuming this design should know:

- **Gemini was not available.** All Decision entries in the journal
  carry an Arranger note marked UNRESEARCHED, PARTIAL, or VERIFIED.
  UNRESEARCHED entries specifically need Gemini-backed validation
  before implementation: (a) the child-row-granularity choice against
  any alternative schemas Gemini surfaces, (b) SQLite query-plan
  behavior for the IN-list read pattern on representative data
  volumes.
- **Implementation is a single migration release**, not the multi-phase
  split the original draft suggested. Do not re-propose splitting.
- **The v0.2.4 foundation is already shipped.** getKeyChain,
  sessionState.keyChain, and their tests exist. Implementation starts
  from "compute ancestorChains at claim" and "thread ownerChain
  through each write handler" — it does not re-implement the chain
  walker.
- **Wire format is unchanged.** owner_chain is an internal
  implementation detail and is NOT exposed in any tool response. The
  existing tool response shapes carry through unmodified. A future
  release may add a scope flag to read tools' input schemas, but the
  response XML is unchanged.
- **The implementation commit should be test-first (TDD).** All 12
  test cases should be written and RED before the handler / query /
  migration code lands. Existing tests stay green (no regressions in
  write_journal, write_memory, etc. when owner_chain defaults to
  null).

## What I would NOT do

- Don't retrofit v0.1.x entries with reconstructed owner_chains. NULL
  is the right sentinel.
- Don't expose owner_chain in tool responses. Internal detail.
- Don't filter list_entries by chain in v0.2.x. Keep scope minimal.
- Don't add owner_chain to `entries`, `handoffs`, `memory_versions`,
  or `memory_journal_provenance`. They don't need it.
- Don't add the chain to `keys` table either — it's computed, not
  stored, and would be a cache invalidation nightmare.
