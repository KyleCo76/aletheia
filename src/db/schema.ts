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

const migrations: Array<(db: Database.Database) => void> = [runMigration1, runMigration2, runMigration3];

export function runMigrations(db: Database.Database): void {
  const currentVersion = getSchemaVersion(db);

  for (let i = currentVersion; i < migrations.length; i++) {
    const migrate = db.transaction(() => {
      migrations[i](db);
    });
    migrate.immediate();
  }
}
