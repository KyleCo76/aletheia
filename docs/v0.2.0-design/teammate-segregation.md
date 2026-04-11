# Design: Teammate memory segregation

**Status:** v0.2.0 design draft (item #32). Implementation deferred.
**Author:** PM-Aletheia, autonomous session 2026-04-11
**Target audience:** Kyle, future Dramaturg session, future implementer

## Problem

Aletheia's permission model is currently per-key, and a teammate
spawned by a parent session inherits the parent's claimed key. The
result: every entry the teammate writes to the journal, memory, or
status tables is indistinguishable from an entry the parent wrote
itself. The two share `entries.project_namespace`, share
`entries.created_by_key`, and surface together in injection.

Concrete case from PM-Aletheia: when the PM spawns a worker to run a
codebase exploration, the worker's `write_journal` calls land in the
PM's journal entry with `created_by_key` pointing at the PM's key.
A later `read` call cannot tell which lines the PM wrote vs. which
the worker wrote — the only signal is the journal text itself, which
the worker had no convention to mark.

This contaminates two things:
1. **Audit:** the PM can't review "what did the worker decide" without
   re-reading the worker's full journal contribution.
2. **Memory injection:** a worker's exploratory note (e.g., "tried
   approach X, didn't work") gets injected into the next session's
   L1/L2 context with the same weight as the PM's confirmed
   architectural memories. Speculative fragments leak into long-term
   memory.

The v0.2.0 cascading-key-delegation work (item #16, commit `6d9f6ec`)
makes the *creation* of teammate-specific keys safe, but doesn't
automatically segregate their writes. That's the gap this design
addresses.

## Goals

Numbered for cross-reference, not priority:

G1. **Provenance:** every entry must record which teammate (sub-key)
    wrote it, not just which parent.
G2. **Read-side inclusion:** a teammate must be able to read the
    parent's memory by default. Worker contexts depend on parent
    setup; cutting that link cripples the worker.
G3. **Read-side exclusion:** a teammate should NOT see other peer
    teammates' writes by default — workers should be isolated from
    each other to prevent cross-contamination.
G4. **Parent visibility:** the parent can read all descendants' writes
    (it's the supervisor) — both for review and for triggering memory
    promotion of interesting findings.
G5. **Backward compatibility:** v0.1.x sessions that don't use
    teammate sub-keys must continue to behave as today (one shared
    namespace per key).

## Non-goals

- Per-table or per-row ACLs. Permissions stay key-level.
- Cryptographic isolation. This is logical scoping, not sandboxing.
- Cross-PM teammate sharing. A PM-A teammate cannot read a PM-B
  teammate's writes; that's just G3 applied across PMs.

## Approach options

### Option A — Sub-namespace strings

Use the existing `entries.project_namespace` column with a delimiter
convention: parent has `project_namespace = 'aletheia-pm'`, teammate
has `'aletheia-pm/worker-7'`. Reads query with prefix matching:
`WHERE project_namespace LIKE 'aletheia-pm/%' OR project_namespace = 'aletheia-pm'`.

**Pros:** zero schema change. The injection builders already query
by namespace and can be retrofitted with prefix logic.

**Cons:** delimiter conventions are fragile (`/` collisions with
project names that contain slashes); query plans on `LIKE 'x/%'`
don't use the existing index on `project_namespace`; "is X a
descendant of Y?" requires string parsing in app code.

### Option B — Parent key chain

Use the existing `keys.created_by` column and walk the chain at
query time. The teammate's key has `created_by = parent_key_id`;
the parent's key has `created_by = grandparent` or `null`.

A read by teammate `T` with parent chain `T → P → root`:

```
SELECT * FROM entries
WHERE created_by_key IN (
  WITH RECURSIVE ancestors(id) AS (
    SELECT id FROM keys WHERE id = :T_id
    UNION ALL
    SELECT k.created_by FROM keys k
    JOIN ancestors a ON k.id = a.id
    WHERE k.created_by IS NOT NULL
  )
  SELECT id FROM ancestors
)
```

**Pros:** schema is already in place (`created_by`); naturally
captures arbitrary depth; no string parsing.

**Cons:** every read becomes a recursive CTE; injection-builder query
plans get slower; the same key shared across PMs (multi-PM bootstrap)
gets confused chain semantics.

### Option C — Explicit `subscope_of` foreign key on entries

Add `entries.subscope_of_entry_id` (nullable, references entries.id).
A teammate's entries point at the parent entry; reads filter on
`subscope_of_entry_id IS NULL OR subscope_of_entry_id IN (...)`.

**Pros:** the filter is a simple equality / IN, indexable; the schema
makes the relationship explicit and self-documenting.

**Cons:** requires a migration adding a new column + an index; the
"parent entry" concept doesn't exist yet (entries currently belong to
keys, not to other entries).

## Recommended approach: hybrid B + provenance column

Combine Option B's key-chain walking with a small denormalized
column to keep the hot read path fast.

### Schema change (migration 4)

```sql
ALTER TABLE entries ADD COLUMN owner_chain TEXT;
-- owner_chain is a slash-separated path from root key to the writing
-- teammate, written at INSERT time and never updated. Example:
-- 'a8f9...c0/b3e2...12/47c4...da' (root → PM → worker).
CREATE INDEX idx_entries_owner_chain ON entries(owner_chain);
```

The chain is computed once, at write time, by walking `keys.created_by`
upward. Reads filter with `WHERE owner_chain LIKE :prefix || '%'` —
LIKE-with-prefix DOES use the index, unlike LIKE with leading `%`.

The recursive CTE from Option B becomes a one-time computation in the
write path, not a per-read tax.

### Read semantics

When a teammate `T` reads, the injection builders compute T's
`own_chain` (walk `keys.created_by` up to root) and filter:

- **My writes only:** `owner_chain = T's_own_chain`
- **My writes + ancestors (G2):** `T's_own_chain LIKE owner_chain || '%'`
- **My writes + descendants (G4, parent reading children):**
  `owner_chain LIKE T's_own_chain || '%'`
- **All writes in my namespace (legacy v0.1.x behavior, default for
  read_status / read_memory in compatibility mode):** no
  `owner_chain` filter.

The default for v0.2.0 should be **own + ancestors** for memory injection
(L1/L2): teammates see what they need from above, but don't pollute each
other. Explicit tools (`read_memory_from_descendants`) can opt into
G4 visibility for the parent.

### Backward compatibility (G5)

`owner_chain` is nullable. v0.1.x entries written before the migration
have `owner_chain = NULL`. The injection-builder filter treats NULL as
"global to namespace" — it's included in every read regardless of who
the reader is. v0.1.x sessions that don't claim teammate sub-keys still
write `NULL` because the writer is the namespace root, and the
read-side default doesn't filter them out.

### Tools impact

- `claim`: no change. The teammate calls claim with its own delegated
  key (created via item #16's hardened create_key).
- `write_journal` / `write_memory` / `replace_status` / `add_section`:
  compute owner_chain at insert time from claimedKey.id. The chain
  computation goes in `db/queries/keys.ts` as `getKeyChain(keyId)`.
- `read*` / injection builders: compute reader's own chain on session
  claim (cache it on sessionState), apply the prefix filter on the
  shared SQL helper.
- `list_entries`: gain an optional `--scope mine|ancestors|all` flag.

## Read-side implementation (the time-permits piece)

Of the full design, the smallest shippable slice is:

1. Add `getKeyChain(db, keyId): string` to `db/queries/keys.ts`. Returns
   the slash-joined ancestor chain. Walks `created_by` iteratively
   (bounded loop with depth cap to defend against cycles).
2. On `claim`, call `getKeyChain` and store the result on
   `sessionState.set('keyChain', chain)`.
3. Add a new exported helper `readMemoriesByChain(db, chain)` in
   `db/queries/memory.ts` that runs the prefix LIKE filter (when
   the migration ships) or falls back to namespace-only (until then).

That gives the read side wired up with no schema migration yet —
the writes stay namespace-only in v0.2.0, the reads are aware but
no-op until owner_chain is populated. v0.2.1 adds the migration and
the write-time chain computation; v0.2.2 hooks the reads up.

I have NOT implemented even this read-side slice in the current
session — the design discovery above ate the time budget. The
implementation is a follow-up task.

## Open questions for Kyle / Dramaturg

1. **Does the L1/L2 default match operator intent?** I argued for
   own + ancestors. Kyle should confirm this matches how he uses
   PMs and workers in practice. If a worker should NOT see the PM's
   memory, that flips the default — and probably means workers
   need explicit "give me PM context" calls.
2. **Cycle defence depth:** what's a sane cap on key-chain depth?
   I suggest 16 (more than any realistic PM hierarchy).
3. **Cross-PM peer keys:** if Kyle creates two PMs that both
   delegate from `ceo-system`, are they peers (G3 says they
   shouldn't see each other's writes) or co-tenants (they both
   inherit ceo-system's chain prefix and naturally see each other
   via G2)? Item #16's scope-subset rule already prevents the
   schema from getting weird, but the read semantics need a
   decision.
4. **Migration safety:** the v0.2.x backup/restore framework
   (item #24) makes adding the `owner_chain` column safe to ship —
   operators back up before migration 4 runs. Should the migration
   be opt-in (operator runs `aletheia migrate-owner-chain`) or
   automatic? I lean automatic with the v0.2.x setup auto-running
   `aletheia backup` first.

## What I would NOT do

- Don't add per-table ACLs. The two-axis subset (item #16) covers
  the security surface; segregation is about UX and signal-to-noise
  for memory injection, not enforcement.
- Don't try to retrofit v0.1.x entries with reconstructed
  owner_chains. NULL is the right "I don't know" sentinel; the
  alternative is guessing, which corrupts audit.
- Don't expose owner_chain in tool responses. It's an internal
  implementation detail that should stay invisible to LLM callers
  (who would otherwise start crafting queries against it and lock
  in a representation that future versions might want to change).
