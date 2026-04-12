import type Database from 'better-sqlite3';

export function getSchemaVersion(db: Database.Database): number {
  const tableExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
  ).get();

  if (!tableExists) {
    return 0;
  }

  const row = db.prepare('SELECT version FROM schema_version').get() as
    | { version: number }
    | undefined;
  return row?.version ?? 0;
}

export function setSchemaVersion(db: Database.Database, version: number): void {
  const count = db.prepare('SELECT COUNT(*) as cnt FROM schema_version').get() as { cnt: number };
  if (count.cnt === 0) {
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version);
  } else {
    db.prepare('UPDATE schema_version SET version = ?').run(version);
  }
}

function runMigration1(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      entry_class TEXT NOT NULL CHECK(entry_class IN ('journal', 'memory', 'handoff')),
      project_namespace TEXT,
      created_by_key TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS journal_entries (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL REFERENCES entries(id),
      content TEXT NOT NULL,
      sub_section TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      digested_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_journal_undigested ON journal_entries(entry_id) WHERE digested_at IS NULL;

    CREATE TABLE IF NOT EXISTS memory_entries (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL REFERENCES entries(id),
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      version_id TEXT NOT NULL,
      archived_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_memory_active ON memory_entries(entry_id) WHERE archived_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_entry_key ON memory_entries(entry_id, key) WHERE archived_at IS NULL;

    CREATE TABLE IF NOT EXISTS memory_versions (
      id TEXT PRIMARY KEY,
      memory_entry_id TEXT NOT NULL REFERENCES memory_entries(id),
      previous_value TEXT NOT NULL,
      previous_version_id TEXT NOT NULL,
      changed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS handoffs (
      target_key TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      tags TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS status_documents (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL REFERENCES entries(id),
      content TEXT NOT NULL,
      undo_content TEXT,
      version_id TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS status_sections (
      id TEXT PRIMARY KEY,
      status_id TEXT NOT NULL REFERENCES status_documents(id),
      section_id TEXT NOT NULL,
      content TEXT NOT NULL,
      state TEXT,
      position INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_status_section ON status_sections(status_id, section_id);

    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS entry_tags (
      entry_id TEXT NOT NULL REFERENCES entries(id),
      tag_id INTEGER NOT NULL REFERENCES tags(id),
      PRIMARY KEY (entry_id, tag_id)
    );
    CREATE INDEX IF NOT EXISTS idx_entry_tags_tag ON entry_tags(tag_id);

    CREATE TABLE IF NOT EXISTS memory_journal_provenance (
      memory_entry_id TEXT NOT NULL REFERENCES memory_entries(id),
      journal_entry_id TEXT NOT NULL REFERENCES journal_entries(id),
      PRIMARY KEY (memory_entry_id, journal_entry_id)
    );

    CREATE TABLE IF NOT EXISTS keys (
      id TEXT PRIMARY KEY,
      key_value TEXT NOT NULL UNIQUE,
      permissions TEXT NOT NULL CHECK(permissions IN ('read-only', 'read-write', 'create-sub-entries', 'maintenance')),
      created_by TEXT,
      entry_scope TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE VIEW IF NOT EXISTS active_tags AS
      SELECT DISTINCT t.id, t.name
      FROM tags t
      JOIN entry_tags et ON t.id = et.tag_id
      JOIN entries e ON et.entry_id = e.id
      LEFT JOIN memory_entries me ON e.id = me.entry_id
      WHERE e.entry_class != 'memory' OR me.archived_at IS NULL;
  `);

  setSchemaVersion(db, 1);
}

function runMigration2(db: Database.Database): void {
  db.exec(`ALTER TABLE memory_entries ADD COLUMN superseded_by TEXT`);
  setSchemaVersion(db, 2);
}

function runMigration3(db: Database.Database): void {
  // Add 'status' to the entries.entry_class CHECK constraint.
  // SQLite doesn't support ALTER CHECK, so recreate the table.
  // Must drop dependent view first, then recreate after.
  //
  // The DROP TABLE entries / RENAME sequence below is only safe
  // because the orchestrating `runMigrations` toggles
  // `PRAGMA foreign_keys = OFF` around this migration. Otherwise
  // SQLite's DROP TABLE would reject entries that have inbound FK
  // references from journal_entries / memory_entries /
  // status_documents / entry_tags, and the operation would fail
  // with SQLITE_CONSTRAINT_FOREIGNKEY on any database with live
  // data. `defer_foreign_keys = ON` is NOT sufficient — it only
  // delays row-level checks, not the DROP TABLE guard, and must be
  // toggled outside a transaction.
  //
  // Prior to the runMigrations-level toggle (added v0.2.3), this
  // migration worked ONLY when the entries table was empty
  // (fresh installs). Any live v0.1.0 → v0.2.x upgrade with
  // populated data would hit SQLITE_CONSTRAINT_FOREIGNKEY.
  db.exec(`
    DROP VIEW IF EXISTS active_tags;

    CREATE TABLE entries_new (
      id TEXT PRIMARY KEY,
      entry_class TEXT NOT NULL CHECK(entry_class IN ('journal', 'memory', 'handoff', 'status')),
      project_namespace TEXT,
      created_by_key TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO entries_new SELECT * FROM entries;
    DROP TABLE entries;
    ALTER TABLE entries_new RENAME TO entries;

    CREATE VIEW active_tags AS
      SELECT DISTINCT t.id, t.name
      FROM tags t
      JOIN entry_tags et ON t.id = et.tag_id
      JOIN entries e ON et.entry_id = e.id
      LEFT JOIN memory_entries me ON e.id = me.entry_id
      WHERE e.entry_class != 'memory' OR me.archived_at IS NULL;
  `);
  setSchemaVersion(db, 3);
}

function runMigration4(db: Database.Database): void {
  db.exec(`ALTER TABLE keys ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0`);
  db.exec(`ALTER TABLE keys ADD COLUMN name TEXT`);
  setSchemaVersion(db, 4);
}

const migrations: Array<(db: Database.Database) => void> = [runMigration1, runMigration2, runMigration3, runMigration4];

/**
 * The schema version this build targets. Any database opened by
 * this build should end up at this version after `runMigrations`.
 * Exposed as a constant so CLI tools (notably `aletheia verify`)
 * can distinguish "needs migration" from "newer than this build".
 */
export const CURRENT_SCHEMA_VERSION = migrations.length;

export function runMigrations(db: Database.Database): void {
  const currentVersion = getSchemaVersion(db);
  if (currentVersion >= migrations.length) return;

  // Some migrations (notably #3, which rebuilds the `entries`
  // table via DROP + CREATE + RENAME) cannot run with FK
  // enforcement on. SQLite requires `PRAGMA foreign_keys` to be
  // toggled OUTSIDE a transaction, so we toggle here at the
  // orchestrator level. The prior value is captured and restored
  // in a finally block so we never leak a changed setting back to
  // the caller. `PRAGMA foreign_key_check` after the migrations
  // run catches any orphaned rows the migration might have
  // introduced by mistake — a belt-and-braces guard since FK
  // enforcement was momentarily disabled.
  const priorFk = db.pragma('foreign_keys', { simple: true }) as number;
  if (priorFk === 1) {
    db.pragma('foreign_keys = OFF');
  }

  try {
    for (let i = currentVersion; i < migrations.length; i++) {
      const migrate = db.transaction(() => {
        migrations[i](db);
      });
      migrate.immediate();
    }

    if (priorFk === 1) {
      const violations = db.pragma('foreign_key_check') as Array<unknown>;
      if (violations.length > 0) {
        throw new Error(
          `runMigrations produced ${violations.length} foreign-key violation(s): ${JSON.stringify(violations)}`,
        );
      }
    }
  } finally {
    if (priorFk === 1) {
      db.pragma('foreign_keys = ON');
    }
  }
}
