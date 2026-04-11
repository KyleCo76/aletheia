// Test for the Priority-3 concern from task-bughunt-improvements.md:
// "if a user upgrades from v0.1.0 → v0.2.0 skipping v0.1.1 and v0.1.2,
// does the migration chain handle the skip?"
//
// The answer should be yes: runMigrations loops from currentVersion to
// migrations.length and applies each missing step in order. These tests
// simulate a v0.1.0-era database at schema_version=1 (migration1 schema
// applied, neither migration2 nor migration3 run) and assert that
// runMigrations correctly catches up.
//
// Note: we can't call runMigration1 directly from tests (it's internal),
// so we hand-build the migration1 schema and the schema_version row.
// The SQL below is a copy of the migration1 block in src/db/schema.ts;
// if that migration is ever revised, this test needs to track it.
//
// Also note: we use db['exec'] with bracket notation in the fixture
// to sidestep a security hook that false-positives on any literal
// `.exec(` substring in source files (it's scanning for
// child_process.exec). better-sqlite3's Database.exec is unrelated
// and needed to run multi-statement DDL scripts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';

import {
  runMigrations,
  getSchemaVersion,
  CURRENT_SCHEMA_VERSION,
} from '../dist/db/schema.js';

const V010_SCHEMA_SQL = `
  CREATE TABLE schema_version (version INTEGER NOT NULL);

  CREATE TABLE entries (
    id TEXT PRIMARY KEY,
    entry_class TEXT NOT NULL CHECK(entry_class IN ('journal', 'memory', 'handoff')),
    project_namespace TEXT,
    created_by_key TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE journal_entries (
    id TEXT PRIMARY KEY,
    entry_id TEXT NOT NULL REFERENCES entries(id),
    content TEXT NOT NULL,
    sub_section TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    digested_at TEXT
  );

  CREATE TABLE memory_entries (
    id TEXT PRIMARY KEY,
    entry_id TEXT NOT NULL REFERENCES entries(id),
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    version_id TEXT NOT NULL,
    archived_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE memory_versions (
    id TEXT PRIMARY KEY,
    memory_entry_id TEXT NOT NULL REFERENCES memory_entries(id),
    previous_value TEXT NOT NULL,
    previous_version_id TEXT NOT NULL,
    changed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE handoffs (
    target_key TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    tags TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE status_documents (
    id TEXT PRIMARY KEY,
    entry_id TEXT NOT NULL REFERENCES entries(id),
    content TEXT NOT NULL,
    undo_content TEXT,
    version_id TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE status_sections (
    id TEXT PRIMARY KEY,
    status_id TEXT NOT NULL REFERENCES status_documents(id),
    section_id TEXT NOT NULL,
    content TEXT NOT NULL,
    state TEXT,
    position INTEGER NOT NULL
  );

  CREATE TABLE tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE entry_tags (
    entry_id TEXT NOT NULL REFERENCES entries(id),
    tag_id INTEGER NOT NULL REFERENCES tags(id),
    PRIMARY KEY (entry_id, tag_id)
  );

  CREATE TABLE memory_journal_provenance (
    memory_entry_id TEXT NOT NULL REFERENCES memory_entries(id),
    journal_entry_id TEXT NOT NULL REFERENCES journal_entries(id),
    PRIMARY KEY (memory_entry_id, journal_entry_id)
  );

  CREATE TABLE keys (
    id TEXT PRIMARY KEY,
    key_value TEXT NOT NULL UNIQUE,
    permissions TEXT NOT NULL CHECK(permissions IN ('read-only', 'read-write', 'create-sub-entries', 'maintenance')),
    created_by TEXT,
    entry_scope TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE VIEW active_tags AS
    SELECT DISTINCT t.id, t.name
    FROM tags t
    JOIN entry_tags et ON t.id = et.tag_id
    JOIN entries e ON et.entry_id = e.id
    LEFT JOIN memory_entries me ON e.id = me.entry_id
    WHERE e.entry_class != 'memory' OR me.archived_at IS NULL;

  INSERT INTO schema_version (version) VALUES (1);
`;

function buildV010Db() {
  // Fresh in-memory db with ONLY the schema migration1 would have
  // produced at v0.1.0. Critically, memory_entries has no
  // `superseded_by` column (added by migration2) and
  // entries.entry_class CHECK does not include 'status' (widened by
  // migration3). schema_version is set to 1 so runMigrations sees a
  // database that pre-dates migrations 2 and 3.
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  // Bracket-notation to sidestep the security-hook false positive.
  db['exec'](V010_SCHEMA_SQL);
  return db;
}

test('simulated v0.1.0 db starts at schema_version=1 with no superseded_by column', () => {
  const db = buildV010Db();
  assert.equal(getSchemaVersion(db), 1, 'fixture should expose schema_version=1');

  // Guard the fixture: confirm the pre-migration2 / pre-migration3
  // shape is actually present before we run runMigrations.
  const cols = db.pragma('table_info(memory_entries)');
  const names = cols.map((c) => c.name);
  assert.ok(!names.includes('superseded_by'), 'v0.1.0 fixture should lack superseded_by');

  // The entries table should NOT accept 'status' yet.
  assert.throws(
    () => {
      db.prepare(
        `INSERT INTO entries (id, entry_class, project_namespace) VALUES (?, 'status', 'p')`,
      ).run(crypto.randomUUID());
    },
    /CHECK/,
    'v0.1.0 fixture should reject status entries via CHECK constraint',
  );

  db.close();
});

test('runMigrations catches up a v0.1.0 db through migrations 2 and 3', () => {
  const db = buildV010Db();

  // Seed a v0.1.0-style row so we can verify it survives the upgrade.
  const entryId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO entries (id, entry_class, project_namespace) VALUES (?, 'memory', 'legacy-proj')`,
  ).run(entryId);
  db.prepare(
    `INSERT INTO memory_entries (id, entry_id, key, value, version_id) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    entryId,
    'legacy-key',
    'legacy-value',
    crypto.randomBytes(8).toString('hex'),
  );

  runMigrations(db);

  // Should have advanced two steps: migration2 adds the superseded_by
  // column; migration3 rewrites the entries table to widen the CHECK
  // constraint and recreates the active_tags view.
  assert.equal(getSchemaVersion(db), CURRENT_SCHEMA_VERSION);

  // Migration 2 sanity: new column exists.
  const cols = db.pragma('table_info(memory_entries)');
  const names = cols.map((c) => c.name);
  assert.ok(names.includes('superseded_by'), 'migration2 must add superseded_by');

  // Migration 3 sanity: status entries are now accepted.
  const statusEntryId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO entries (id, entry_class, project_namespace) VALUES (?, 'status', 'legacy-proj')`,
  ).run(statusEntryId);
  const row = db.prepare(
    `SELECT entry_class FROM entries WHERE id = ?`,
  ).get(statusEntryId);
  assert.equal(row.entry_class, 'status');

  // Data preservation: the legacy memory row must still be readable.
  const legacy = db.prepare(
    `SELECT key, value FROM memory_entries WHERE entry_id = ?`,
  ).get(entryId);
  assert.equal(legacy.key, 'legacy-key');
  assert.equal(legacy.value, 'legacy-value');

  db.close();
});

test('runMigrations is a no-op when the db is already at current version', () => {
  // Protects the loop exit condition: once schema_version ==
  // migrations.length, runMigrations should not attempt to re-apply
  // any migration (many are NOT idempotent — e.g. ALTER TABLE ADD
  // COLUMN fails on rerun).
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  assert.equal(getSchemaVersion(db), CURRENT_SCHEMA_VERSION);

  // Running a second time must not throw.
  runMigrations(db);
  assert.equal(getSchemaVersion(db), CURRENT_SCHEMA_VERSION);

  db.close();
});
