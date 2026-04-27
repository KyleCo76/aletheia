# Migration Walkthrough — V1 → V2 against actual CEO data

**Author:** Arranger session, post-CEO-pre-build review (2026-04-26)
**Source data:** `~/.aletheia/data/aletheia.db` (CEO's live V1 install)
**Purpose:** Validate the Phase 8 transform plan against real V1 data BEFORE implementation begins. This document is the initial dry-run — when Phase 8's `aletheia-v2 migrate-from-v1 --dry-run` runs against this V1 DB, the output should match the values traced here.

## V1 source inventory (queried directly via sqlite3)

```
CEO V1 install: ~/.aletheia/data/aletheia.db
  schema_version = 4
  file_size      = ~360 KB

Top-level entries (containers): 22
Detail tables:
  journal_entries:           217   (one V1 entries.id can have many journal rows)
  memory_entries (active):    89   (one V1 entries.id can have many memory key-value rows)
  memory_entries (archived):   0
  memory_versions:             0   (no V1 memory has been updated since creation)
  status_documents:           11   (more than 5 entries.id of class 'status' due to V1 multi-version-doc semantic)
  status_sections:             4   (only one status doc has sections; the rest hold their content in document body)
  handoffs:                    1   (single pending handoff to orchestrator-daemon key)
  tags:                      204   (rich tag vocabulary)
  entry_tags:                324
  memory_journal_provenance:   3   (only 3 memories explicitly link back to journals via provenance)
  keys:                        9
```

Top-level entries by namespace + class:

| namespace | journal | memory | status | totals |
|---|---:|---:|---:|---:|
| `ceo-system` | 3 | 2 | 3 | 8 |
| `pm-aletheia` | 1 | 1 | 1 | 3 |
| `pm-hermes` | 1 | 1 | 2 | 4 |
| `pm-hockey` | 2 | 1 | 1 | 4 |
| `pm-skills` | 1 | 1 | 1 | 3 |

Keys table (CEO V1 install):

| key_id (V1) | name | permissions | scope | revoked |
|---|---|---|---|---|
| `034bb6fb-17ba-46e3-9845-6ad1ff0966c3` | (unnamed) | `maintenance` | NULL | 0 |
| `0bb192c9-0f98-4b3c-ba90-e9ce0843562b` | (unnamed) | `maintenance` | `ceo-system` | 0 |
| `7ced4cc0-390e-42fa-a621-531d163bdfa7` | (unnamed) | `create-sub-entries` | `ceo-system` | 0 |
| `d9ff6121-262b-42d3-8b41-02cb377d40af` | (unnamed) | `create-sub-entries` | `pm-aletheia` | 0 |
| `44cbeff5-0426-437f-83ee-21175f87f83a` | (unnamed) | `create-sub-entries` | `pm-hockey` | 0 |
| `a2423f7d-4445-4c7b-9dfc-6ceb8e72a212` | (unnamed) | `create-sub-entries` | `pm-skills` | 0 |
| `346df4bb-fdb8-4fe8-8d31-b6fe80803f7a` | (unnamed) | `create-sub-entries` | `pm-hermes` | 0 |
| `fe3d653a-440b-4316-a7aa-fc8787be67d8` | `tl-hermes-daemon` | `read-write` | `pm-hermes` | 0 |
| `34c84bc5-2041-411e-bba4-173c19503e6b` | `tl-hermes-wrapper` | `read-write` | `pm-hermes` | 0 |

V1's master key is `034bb6fb` (NULL scope + maintenance permission). Per **CEO pre-build review master-key flow Option 1**, this becomes a regular V2 sub-key with `is_master_key=0`; the V2 master is a fresh key minted by `aletheia-v2 setup`.

---

## Pre-migration prerequisites (run BEFORE `migrate-from-v1`)

```bash
# 1. Backup V1 (Aletheia doesn't verify; user acknowledges)
cp ~/.aletheia/data/aletheia.db ~/aletheia-v1-backup-2026-04-26.db

# 2. Stop V1 sessions (or pass --ignore-active-sessions to override; default is safe-refuse)
# Verify: ls ~/.aletheia/sockets/aletheia-*.sock — should be no live PIDs

# 3. Install V2 alongside V1
npm install -g aletheia-v2

# 4. Run V2 setup (generates fresh V2 master key + V2 directory structure)
aletheia-v2 setup
# → ~/.aletheia-v2/keys/master.key  (V2 master, is_master_key=1)
# → ~/.aletheia-v2/scope_registry.db  (with scopes table seeded with a 'default' scope)
# → registers V2 hooks in ~/.claude/settings.json (separate from V1's hook entries)
```

After setup, V2 has 1 scope (`default`) and 1 key (the fresh V2 master) — empty otherwise.

---

## Dry-run output (what `aletheia-v2 migrate-from-v1 --dry-run` produces)

```bash
aletheia-v2 migrate-from-v1 ~/.aletheia/data/aletheia.db --dry-run
```

Expected output (markdown rendering of the JSON report):

```markdown
# Aletheia V1 → V2 Migration Dry-Run Report

## V1 source
- path: /home/claude/.aletheia/data/aletheia.db
- schema_version: 4
- file_size_bytes: ~368640
- total_entries: 22
- total_keys: 9
- total_status_documents: 11
- total_handoffs: 1
- total_memory_versions: 0
- total_provenance_rows: 3

## V2 target
- data_dir: /home/claude/.aletheia-v2/
- will_rename_v1: false (side-by-side install; V1 untouched)
- will_write: false (dry-run)
- estimated_duration_seconds: ~12
- estimated_disk_required_bytes: ~720000 (V1 + V2 sum)

## Scopes planned

### ceo-system
- v2_scope_uuid: <SHA-256-derived deterministic UUID>
- v2_scope_db_path: ~/.aletheia-v2/scopes/<uuid>.db
- rows_planned:
  - memory_active: 89                  ← actually distributed across 22 entries; this scope holds 2 containers with multiple keys each
  - memory_archived: 0
  - memory_history_versions: 0
  - journal_count: 3                   ← V1 has 3 entries.id of class journal; each has many V1 journal_entries rows (most rows belong to ceo-system)
  - journal_with_provenance: 2         ← 2 of 3 provenance rows reference journals in this scope
  - status_documents: 3
  - status_sections: 4                 ← all 4 sections in V1 belong to one ceo-system status doc
  - handoff_count: 1                   ← orchestrator-daemon key 7ced4cc0 belongs to ceo-system per A4 query
- estimated_disk_bytes: ~200000
- risks_detected: []

### pm-aletheia
- v2_scope_uuid: <deterministic UUID>
- rows_planned: { memory_active: ~10, journal_count: 1, status_documents: 1, handoff_count: 0 }
  (actual counts derived per-scope at dry-run time)

### pm-hermes
- rows_planned: { ..., handoff_count: 0 }
  (tl-hermes-daemon and tl-hermes-wrapper keys are scoped pm-hermes; no handoffs target them)

### pm-hockey
### pm-skills
  (similar structure)

## Keys planned (V1 → V2 import; V2 master from setup is the trust root, NOT listed here)

| v1_key_id | v1 was master? | permissions | primary_scope | v2_key_file |
|---|---|---|---|---|
| 034bb6fb-... | YES (V1 master) | maintenance | default | ~/.aletheia-v2/keys/master-v1.key (or original name if any) |
| 0bb192c9-... | no | maintenance | ceo-system | ~/.aletheia-v2/keys/<name-or-id>.key |
| 7ced4cc0-... | no | create-sub-entries | ceo-system | ~/.aletheia-v2/keys/<name-or-id>.key |
| d9ff6121-... | no | create-sub-entries | pm-aletheia | ~/.aletheia-v2/keys/<name-or-id>.key |
| 44cbeff5-... | no | create-sub-entries | pm-hockey | ~/.aletheia-v2/keys/<name-or-id>.key |
| a2423f7d-... | no | create-sub-entries | pm-skills | ~/.aletheia-v2/keys/<name-or-id>.key |
| 346df4bb-... | no | create-sub-entries | pm-hermes | ~/.aletheia-v2/keys/<name-or-id>.key |
| fe3d653a-... | no | read-write | pm-hermes | ~/.aletheia-v2/keys/tl-hermes-daemon.key |
| 34c84bc5-... | no | read-write | pm-hermes | ~/.aletheia-v2/keys/tl-hermes-wrapper.key |

(All inserted into V2 keys with is_master_key=0; V2's master is the fresh `~/.aletheia-v2/keys/master.key` minted by setup.)
```

The dry-run writes both `<timestamp>.json` (machine-parseable) and `<timestamp>.md` (human-readable) to `~/.aletheia-v2/dry-run-reports/`.

---

## Per-class transform traces

The following sections trace specific V1 entries through the Phase 8 transforms to demonstrate the design works against real data.

### Trace 1 — `ceo-system` JOURNAL container `e27f8a31`

**V1 source row** (entries):
```sql
SELECT * FROM entries WHERE id = 'e27f8a31-fbc3-447b-be12-fd62df7015d7';
-- id: e27f8a31-fbc3-447b-be12-fd62df7015d7
-- entry_class: journal
-- project_namespace: ceo-system
-- created_by_key: 0bb192c9-... (CEO scope-key)
-- created_at: 2026-04-10 07:36:36
```

**V1 source row** (journal_entries — one example child of this entry):
```sql
SELECT * FROM journal_entries WHERE entry_id = 'e27f8a31-fbc3-447b-be12-fd62df7015d7';
-- (multiple rows; example):
-- id: 2b8095e7-07be-4648-beaa-9a106689e249
-- entry_id: e27f8a31-fbc3-447b-be12-fd62df7015d7
-- sub_section: NULL
-- content: "..." (length 194)
-- created_at: 2026-04-10 07:43:19
-- digested_at: NULL
```

**V1 tags for entry e27f8a31** (joined via entry_tags + tags):
```
(query: SELECT t.name FROM tags t JOIN entry_tags et ON et.tag_id=t.id WHERE et.entry_id='e27f8a31-...')
→ ["activity-log", "current-state", "main-memory", "live", "2026-04-10"]   (example tag set)
```

**V2 result** (per Phase 8 journal::transform): each V1 journal_entries row becomes ONE V2 entries row in the `ceo-system` scope's `.db` file:
```sql
-- V2 row for journal_entry 2b8095e7-... (one of N journal_entries rows for this V1 entry):
INSERT INTO entries (entry_id, version, entry_class, content, content_hash, tags, valid_from, valid_to, digested_at, ...)
VALUES (
  '<new V2 UUID>',                     -- new V2 entry_id (unique per V1 journal_entries row)
  1,                                   -- version 1 (journals are append-only; no chain)
  'journal',
  '...' (V1 journal_entries.content),
  SHA-256('...' || ceo_v2_scope_uuid), -- per-scope dedup hash
  '["activity-log","current-state","main-memory","live","2026-04-10","entry_id_legacy:e27f8a31-fbc3-447b-be12-fd62df7015d7"]',  -- V1 tags + entry_id_legacy tag (Q5A)
  '2026-04-10 07:43:19',               -- valid_from = V1.created_at
  NULL,                                -- valid_to = NULL (active)
  NULL,                                -- digested_at preserved (V1 was NULL → V2 NULL too; the lazy first-claim digest pass will set this later)
  ...
);
```

If the V1 journal_entries row had `sub_section='Phase 1'`, the V2 tags JSON would include `"sub_section:Phase 1"` per Q5D.

The V1 entries row for `e27f8a31` itself is NOT migrated as a V2 row — it's a container in V1's 2-level model that V2's flat model doesn't have. Its `id` survives as the `entry_id_legacy:` tag on every V2 row that came from one of its journal_entries.

**Sanity check post-migration**: `SELECT COUNT(*) FROM main.entries WHERE entry_class='journal' AND tags LIKE '%entry_id_legacy:e27f8a31%'` against the ceo-system V2 .db should equal the number of V1 journal_entries rows for this entry_id (visible via `SELECT COUNT(*) FROM journal_entries WHERE entry_id='e27f8a31-...'`).

---

### Trace 2 — `ceo-system` MEMORY container `1800d294` with 5 keys (the Q5A demonstration)

**V1 source rows** (memory_entries with this entry_id):
```sql
SELECT id, key, length(value) FROM memory_entries WHERE entry_id = '1800d294-3ddc-4547-b714-4efa24c668aa' ORDER BY key;
-- ce296965-... | feedback_delegate_dont_do          | 867
-- eed39841-... | feedback_idle_infrastructure       | 985
-- a9d9f308-... | feedback_journal_ownership         | 424
-- 2163a971-... | feedback_launch_skepticism         | 713
-- 95ecf238-... | kyle_vision_autonomous_business    | 2211
-- 3b3cfe23-... | user_kyle_profile                   | 946
```

(Actually 6 keys, not 5 — confirmed by query. The CEO doc said 5; actual is 6.)

V1's `memory_versions` for these is empty (no key has been updated since creation), so each V2 entry has version=1, no history rows.

**V2 result** (per Phase 8 memory::transform with Q5A "key → tag" rule): each V1 memory_entries row becomes ONE V2 entries row. 6 keys → 6 V2 entries:

```sql
-- V2 row for memory_entries ce296965-... (key=feedback_delegate_dont_do):
INSERT INTO entries (entry_id, version, entry_class, content, content_hash, tags, valid_from, valid_to, ...)
VALUES (
  '<new V2 UUID>',                                         -- new entry_id (unique per V2 row)
  1,
  'memory',
  '...' (V1 memory_entries.value, 867 chars),
  SHA-256('...' || ceo_v2_scope_uuid),
  '["<V1 tags joined from entry_tags>", "key:feedback_delegate_dont_do", "entry_id_legacy:1800d294-3ddc-4547-b714-4efa24c668aa"]',
  '<V1 memory_entries.updated_at>',
  NULL,                                                    -- active (no archived_at)
  ...
);

-- 5 more rows analogous: each with key:<v1_key> tag and entry_id_legacy:1800d294-... tag

-- The V1 entries.id 1800d294-... is NOT directly migrated as a V2 row.
-- All 6 V2 memories share the entry_id_legacy:1800d294-... tag, enabling the
-- "show me memories that were under V1 entry X" query Kyle wanted preserved (per Q5A).
```

**Sanity check**: `SELECT COUNT(*) FROM main.entries WHERE entry_class='memory' AND tags LIKE '%entry_id_legacy:1800d294%'` against the ceo-system V2 .db should equal 6.

**No memory_versions in CEO data** means no version-chain demonstration is possible against this dataset — but the algorithm still runs (Phase 8 A1 two-pass: count history → INSERT history versions 1..N → INSERT current version N+1; with N=0, only the current row is INSERTed at version 1, which matches the observed pattern).

If a V1 memory had been updated 3 times, V2 would have 4 rows: versions 1, 2, 3 (history rows from `memory_versions` ordered by `changed_at`, each with `valid_to` set to the next change's timestamp + `invalidation_reason='updated'`) and version 4 (the current row from `memory_entries.value`, with `valid_to=NULL`).

---

### Trace 3 — `ceo-system` STATUS container `127c0a00`

**V1 source row** (status_documents):
```sql
SELECT id, content, version_id FROM status_documents WHERE entry_id = '127c0a00-e94c-470b-9161-680a1469f6be';
-- id: 58a670ab-bb3e-4ede-b8d0-2a10a0155676
-- content: "..." (2307 chars; full markdown body)
-- version_id: 1798c59bc7151458   (V1 opaque OCC token; dropped in V2)
-- updated_at: ...
```

**V1 status_sections for this status_document**: zero (this status doc carries its content in document body; no per-section rows).

**V2 result** (per Phase 8 status::transform):
```sql
-- V2 entries row (status container):
INSERT INTO entries (entry_id, version, entry_class, content, content_hash, tags, valid_from, valid_to, ...)
VALUES (
  '<new V2 UUID>',
  1,
  'status',
  '...' (full V1 status_documents.content),    -- content in entries row when no per-section rows
  SHA-256(...),
  '["<V1 tags joined>", "entry_id_legacy:127c0a00-..."]',
  '<V1 updated_at>',
  NULL,
  ...
);

-- No V2 status_sections rows for this entry (V1 had none).
-- V1's status_documents.version_id and undo_content fields are DROPPED (V2 uses INTEGER version + append-only).
```

**Status doc with sections** (separate V1 entry — there's exactly one in CEO's data, status_id `fa9e547b-c0d9-4655-adb3-5c1ccebf0ac6`):

V1 status_sections rows for that doc:
| section_id | state | position |
|---|---|---|
| `phase_1_bugs` | complete | 0 |
| `phase_2_create_and_replace` | complete | 1 |
| `phase_3_sections` | complete | 2 |
| `phase_4_teammate` | complete | 3 |

V2 result:
```sql
-- One V2 entries row (status container) — same pattern as 127c0a00 above
-- PLUS 4 V2 status_sections rows:
INSERT INTO status_sections (status_entry_id, section_id, version, content, state, position, valid_from, valid_to, ...)
VALUES
  ('<v2 status entry_id>', 'phase_1_bugs',                1, '...', 'complete', 0, '<v1 ss.created_at_unknown>', NULL, ...),
  ('<v2 status entry_id>', 'phase_2_create_and_replace',  1, '...', 'complete', 1, ...),
  ('<v2 status entry_id>', 'phase_3_sections',            1, '...', 'complete', 2, ...),
  ('<v2 status entry_id>', 'phase_4_teammate',            1, '...', 'complete', 3, ...);
-- Each section: version=1, valid_to=NULL (active; first version in V2's append-only model)
```

---

### Trace 4 — HANDOFF (single row in CEO V1)

**V1 source**:
```sql
SELECT * FROM handoffs;
-- target_key: 7ced4cc0-390e-42fa-a621-531d163bdfa7   (orchestrator-daemon key, scope=ceo-system)
-- content: "..." (4180 chars)
-- tags: "pre-relaunch, cc-update, 2026-04-16"
-- created_by: 0bb192c9-...   (CEO scope-key)
```

**V2 result**: a V2 entries row (entry_class='handoff') in the `ceo-system` scope (because `target_key=7ced4cc0` belongs to ceo-system per V1 keys table):

```sql
INSERT INTO entries (entry_id, version, entry_class, content, content_hash, tags, valid_from, valid_to, ...)
VALUES (
  '<new V2 UUID>',
  1,
  'handoff',
  '...' (V1 handoffs.content),
  SHA-256(...),
  '["pre-relaunch","cc-update","2026-04-16","target_key:7ced4cc0-390e-42fa-a621-531d163bdfa7"]',  -- V1 tags split + target_key tag
  '<V1 created_at>',
  NULL,                              -- pending (V1 stores handoffs only when pending; row presence = pending)
  ...
);
```

**Note on Phase 8 A4 fix** (handoff_count per scope): the CEO doc claimed handoff_count was hardcoded to 0 in the original plan. Now `count_handoffs_per_scope()` JOINs through V1's `keys.entry_scope` to count handoffs whose target_key belongs to keys in each namespace. For CEO V1: ceo-system gets 1 handoff (target=7ced4cc0 which has entry_scope=ceo-system); other scopes get 0.

---

### Trace 5 — PROVENANCE (3 V1 rows; the Q5B + IS-6 forward-compat demonstration)

**V1 source**:
```sql
SELECT memory_entry_id, journal_entry_id FROM memory_journal_provenance;
-- 86e02c85-7b8b-4695-b3c8-83da508ef261 ↔ 1fdf2c16-7138-4a58-bb77-e20443b63d59
-- 69f31364-a08a-4c02-b809-76fbedf06341 ↔ beaecb43-0352-4fe7-9e61-3de3743f5374
-- 33c5a863-a83f-448f-86aa-f261a4f7a543 ↔ d3eb2c85-323a-4ab3-a132-76b5dc8d9523
```

**V2 result** (per Phase 8 A3 — `provenance::translate_all`): runs AFTER all per-scope transforms. Walks V1's provenance, looks up V1_id → V2_entry_id via the `id_mapping` populated by journal::transform and memory::transform, INSERTs translated rows into the appropriate scope's V2 `memory_journal_provenance`:

```sql
-- For memory_entry 86e02c85, look up: which scope did it migrate into? Which V2 entry_id was assigned?
-- Per the id_mapping: 86e02c85 (V1 memory_id) → <new V2 entry_id> in scope <X>
-- Same for journal_entry 1fdf2c16 → <new V2 entry_id> in scope <Y>
-- (X and Y should match — V1 provenance is intra-scope by construction)

-- V2 row in scope X's .db:
INSERT INTO memory_journal_provenance (memory_entry_id, journal_entry_id)
VALUES ('<v2 memory entry_id from 86e02c85 mapping>', '<v2 journal entry_id from 1fdf2c16 mapping>');

-- 2 more rows for the other V1 provenance pairs.
```

If id_mapping is missing either side (shouldn't happen if all transforms ran correctly), the row is logged as orphan and skipped — see Phase 8 A3 implementation.

V3's KG layer will use `memory_journal_provenance` directly as a `derived_from` graph edge type per IS-6 forward-compat — no V2 code changes needed.

---

### Trace 6 — KEYS (V1's 9 keys + V2's fresh master)

**Pre-migration state (after `aletheia-v2 setup`):**
- `~/.aletheia-v2/keys/master.key` — **V2 master** (fresh, `is_master_key=1` in V2 keys table)
- V2 `keys` table has 1 row: the V2 master, scoped to `default`

**Per Phase 8 keys::transform (Option 1 master-key flow):**

For each V1 key, read raw value (preferring V1 file at `~/.aletheia/keys/<name>.key` if present; falling back to V1 `keys.key_value` column), compute SHA-256, INSERT into V2 `keys` table preserving `key_id` + permissions, write file at `~/.aletheia-v2/keys/<name>.key`.

V2 `keys` table after migration (10 rows total — V2 master + 9 V1-imports):

| key_id | name | key_hash | permissions | primary_scope_id | is_master_key | source |
|---|---|---|---|---|---|---|
| `<fresh V2 UUID>` | (none) | `<SHA-256 of fresh value>` | `maintenance` | `<default scope_uuid>` | **1** | V2 setup |
| `034bb6fb-...` | (V1 name if any) | `SHA-256(V1 raw)` | `maintenance` | `<default scope_uuid>` | 0 | V1 import (was V1 master) |
| `0bb192c9-...` | (V1 name if any) | `SHA-256(V1 raw)` | `maintenance` | `<ceo-system scope_uuid>` | 0 | V1 import |
| `7ced4cc0-...` | (V1 name if any) | `SHA-256(V1 raw)` | `create-sub-entries` | `<ceo-system scope_uuid>` | 0 | V1 import |
| `d9ff6121-...` | (V1 name if any) | `SHA-256(V1 raw)` | `create-sub-entries` | `<pm-aletheia scope_uuid>` | 0 | V1 import |
| `44cbeff5-...` | (V1 name if any) | `SHA-256(V1 raw)` | `create-sub-entries` | `<pm-hockey scope_uuid>` | 0 | V1 import |
| `a2423f7d-...` | (V1 name if any) | `SHA-256(V1 raw)` | `create-sub-entries` | `<pm-skills scope_uuid>` | 0 | V1 import |
| `346df4bb-...` | (V1 name if any) | `SHA-256(V1 raw)` | `create-sub-entries` | `<pm-hermes scope_uuid>` | 0 | V1 import |
| `fe3d653a-...` | `tl-hermes-daemon` | `SHA-256(V1 raw)` | `read-write` | `<pm-hermes scope_uuid>` | 0 | V1 import |
| `34c84bc5-...` | `tl-hermes-wrapper` | `SHA-256(V1 raw)` | `read-write` | `<pm-hermes scope_uuid>` | 0 | V1 import |

**Critical Option 1 invariant**: row 1 (V2 master) has `is_master_key=1`; ALL OTHER rows have `is_master_key=0`. The V1 master `034bb6fb` is NOT marked as master in V2 — it's a regular maintenance-permission sub-key that happens to have full permissions. Sessions can claim with EITHER the V2 master OR `034bb6fb` (or any other V1-imported maintenance key) and get maintenance-level access.

V2 `~/.aletheia-v2/keys/` directory after migration:
```
master.key                       (V2 master from setup; record + delete or keep for solo)
<v1-master-name-or-default>.key  (V1 master imported with original raw value)
<other V1 keys' files copied over with their original names + raw values>
```

V1 install at `~/.aletheia/` is UNTOUCHED. V1's keys files at `~/.aletheia/keys/` remain exactly as they were.

---

## Post-migration validation (Phase 8 A5)

`crate::migrate::validation::verify_row_counts` runs at the end of every actual migration (not dry-run) and asserts:

```
sum across V2 scope DBs of entries(entry_class='memory')
  == V1 memory_entries (89) + V1 memory_versions (0) = 89
sum across V2 scope DBs of entries(entry_class='journal')
  == V1 journal_entries (217)
sum across V2 scope DBs of entries(entry_class='status')
  == V1 status_documents (11)
sum across V2 scope DBs of entries(entry_class='handoff')
  == V1 handoffs (1)
```

If any sum diverges, migration fails with `Migration validation failed: <diff>` AND the failure cleanup deletes ALL V2 files created (per Phase 8 A9). User re-runs after fixing the cause; V1 is untouched throughout.

`scopes.digest_pending_v1_migration` is set to 1 for each scope created by migration. First claim of each scope in V2 enqueues an `entry_threshold` digest_queue trigger, then flips the flag to 0 (per CEO Item 4 lazy storm prevention).

---

## Post-validation cutover (user-driven, OPTIONAL — V1 can stay alongside V2 indefinitely)

```bash
# 1. Validate V2 by claiming one scope, performing reads/writes, checking visible-dedup metadata,
#    checking that entry_id_legacy: tags let you find old V1 groupings via list_entries(tags=[...]).

# 2. When confident V2 is working as expected:
#    a. Edit ~/.claude/settings.json — remove the "aletheia" MCP server entry + its hook entries
#       (leave the "aletheia-v2" entry in place)
#    b. Restart any active CC sessions that were using V1
#    c. npm uninstall -g aletheia
#    d. Optionally: rm -rf ~/.aletheia/  (V1 data dir; backup at ~/aletheia-v1-backup-2026-04-26.db remains)
```

V1 is now retired. V2 is the active install.

---

## Acceptance criteria for this walkthrough

1. **Dry-run command** `aletheia-v2 migrate-from-v1 ~/.aletheia/data/aletheia.db --dry-run` produces output structurally matching the dry-run sample above. Counts match the V1 inventory exactly.

2. **Actual migration** against this V1 DB produces:
   - 5 V2 scope `.db` files (one per V1 namespace)
   - V2 keys table with 10 rows (V2 master + 9 V1-imports)
   - V2 entries: 89 memory + 217 journal + 11 status + 1 handoff = 318 rows total across all scopes
   - V2 status_sections: 4 rows
   - V2 memory_journal_provenance: 3 rows
   - V1 install untouched: `~/.aletheia/` exists, V1 DB exists, V1 sessions can still run on V1

3. **First claim** of each V2 scope kicks off a digest pass (lazy per-scope; per CEO Item 4) — `digest_pending_v1_migration` flag flips from 1 to 0 post-enqueue.

4. **Failure path test**: corrupt one V1 row mid-migration → all created V2 files (scope DBs + key files) deleted; `migration_state.is_applying=0` (per A10 full-cleanup case); V1 untouched.

5. **`aletheia-v2 reconcile`** (master-key only) finds zero orphans on a successful clean migration.

When all 5 acceptance criteria pass against CEO's actual V1 data, Phase 8 is implementation-validated and Phase 1 build can begin with confidence.
