// Tests for the v0.2.0 backup/restore framework (item #24).
//
// Each test runs in its own mktemp dir so the live ~/.aletheia
// database is never touched. The functions under test are imported
// from compiled dist (compiled-dist pattern, same as the v0.1.2
// regression tests).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { runMigrations, CURRENT_SCHEMA_VERSION } from '../dist/db/schema.js';
import {
  backupDatabase,
  restoreDatabase,
  verifyDatabase,
} from '../dist/cli/backup.js';

function withTmp(fn) {
  return async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aletheia-test-'));
    try {
      await fn(tmp);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
}

function makePopulatedDb(p) {
  const db = new Database(p);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  db.prepare(
    `INSERT INTO entries (id, entry_class, project_namespace) VALUES (?, ?, ?)`,
  ).run('test-mem-1', 'memory', 'test-proj');
  db.prepare(
    `INSERT INTO entries (id, entry_class, project_namespace) VALUES (?, ?, ?)`,
  ).run('test-jrn-1', 'journal', 'test-proj');
  db.prepare(
    `INSERT INTO entries (id, entry_class, project_namespace) VALUES (?, ?, ?)`,
  ).run('test-jrn-2', 'journal', 'test-proj');

  db.close();
}

test(
  'backupDatabase produces a readable copy with the same row counts',
  withTmp(async (tmp) => {
    const sourcePath = path.join(tmp, 'source.db');
    const targetPath = path.join(tmp, 'backup.db');
    makePopulatedDb(sourcePath);

    const result = await backupDatabase({ sourcePath, targetPath });

    assert.equal(result.path, targetPath);
    assert.ok(result.bytes > 0, 'backup file should not be empty');
    assert.ok(fs.existsSync(targetPath));

    const backupDb = new Database(targetPath, { readonly: true });
    try {
      const total = backupDb.prepare(
        `SELECT COUNT(*) as n FROM entries`,
      ).get();
      assert.equal(total.n, 3);

      const journals = backupDb.prepare(
        `SELECT COUNT(*) as n FROM entries WHERE entry_class = 'journal'`,
      ).get();
      assert.equal(journals.n, 2);
    } finally {
      backupDb.close();
    }
  }),
);

test(
  'verifyDatabase reports ok for a healthy populated db',
  withTmp(async (tmp) => {
    const dbPath = path.join(tmp, 'good.db');
    makePopulatedDb(dbPath);

    const result = await verifyDatabase({ path: dbPath });

    assert.equal(result.ok, true, `expected ok, got ${result.error}`);
    assert.equal(result.integrity, 'ok');
    assert.ok(result.schemaVersion >= 1, 'schema version should be set');
    assert.equal(result.expectedSchemaVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(result.needsMigration, false, 'fresh db should not need migration');
    assert.equal(result.entryCounts.memory, 1);
    assert.equal(result.entryCounts.journal, 2);
  }),
);

test(
  'verifyDatabase flags a db at an older schema version (needsMigration)',
  withTmp(async (tmp) => {
    const dbPath = path.join(tmp, 'stale.db');
    makePopulatedDb(dbPath);

    // Forcibly roll schema_version backwards to simulate a backup
    // made by an earlier release of Aletheia. The restore path
    // should accept this — the server migrates on next startup —
    // but verify should flag needsMigration:true.
    const db = new Database(dbPath);
    db.prepare('UPDATE schema_version SET version = ?').run(CURRENT_SCHEMA_VERSION - 1);
    db.close();

    const result = await verifyDatabase({ path: dbPath });
    assert.equal(result.ok, true, 'older schema should still verify as ok');
    assert.equal(result.schemaVersion, CURRENT_SCHEMA_VERSION - 1);
    assert.equal(result.needsMigration, true);
    assert.equal(result.fromFuture, false);
  }),
);

test(
  'verifyDatabase rejects a db at a newer schema version (fromFuture)',
  withTmp(async (tmp) => {
    const dbPath = path.join(tmp, 'future.db');
    makePopulatedDb(dbPath);

    // Write a schema_version value this build doesn't know about —
    // simulates a backup from a newer Aletheia being fed to an
    // older binary. Must be a hard fail: silently accepting it would
    // let us overwrite a future-schema live db with something this
    // binary can't actually read.
    const db = new Database(dbPath);
    db.prepare('UPDATE schema_version SET version = ?').run(CURRENT_SCHEMA_VERSION + 5);
    db.close();

    const result = await verifyDatabase({ path: dbPath });
    assert.equal(result.ok, false, 'future-schema db must not verify ok');
    assert.equal(result.fromFuture, true);
    assert.equal(result.schemaVersion, CURRENT_SCHEMA_VERSION + 5);
    assert.match(result.error, /newer than this build/);
  }),
);

test(
  'verifyDatabase reports not-ok for a non-sqlite file',
  withTmp(async (tmp) => {
    const dbPath = path.join(tmp, 'garbage.db');
    fs.writeFileSync(dbPath, 'this is not a sqlite database, just plain text');

    const result = await verifyDatabase({ path: dbPath });

    assert.equal(result.ok, false);
    assert.ok(result.error, 'failure should include an error message');
  }),
);

test(
  'verifyDatabase reports not-ok for a missing file',
  withTmp(async (tmp) => {
    const result = await verifyDatabase({ path: path.join(tmp, 'no-such.db') });
    assert.equal(result.ok, false);
    assert.match(result.error, /not found/i);
  }),
);

test(
  'restoreDatabase replaces target with source contents (round-trip)',
  withTmp(async (tmp) => {
    const sourcePath = path.join(tmp, 'source.db');
    const targetPath = path.join(tmp, 'target.db');
    makePopulatedDb(sourcePath);

    // Stand up a target db that's empty (no migrations yet) so we can
    // see whether the restore actually overwrote it.
    const empty = new Database(targetPath);
    empty.close();

    const result = await restoreDatabase({ sourcePath, targetPath });

    assert.equal(result.path, targetPath);
    assert.ok(result.restoredFromSchema >= 1);
    assert.ok(
      result.safetyBackupPath,
      'restore should have produced a safety backup of the previous target',
    );
    assert.ok(fs.existsSync(result.safetyBackupPath));

    // Verify the target db now has the source's data
    const restored = new Database(targetPath, { readonly: true });
    try {
      const total = restored.prepare(
        `SELECT COUNT(*) as n FROM entries`,
      ).get();
      assert.equal(total.n, 3);
    } finally {
      restored.close();
    }
  }),
);

test(
  'restoreDatabase refuses to overwrite from a corrupt source',
  withTmp(async (tmp) => {
    const sourcePath = path.join(tmp, 'corrupt.db');
    const targetPath = path.join(tmp, 'target.db');
    fs.writeFileSync(sourcePath, 'not a real sqlite file');
    makePopulatedDb(targetPath);

    await assert.rejects(
      restoreDatabase({ sourcePath, targetPath }),
      /cannot restore/,
    );

    // The target should still have its original 3 rows — restore
    // must not have touched it.
    const stillThere = new Database(targetPath, { readonly: true });
    try {
      const n = stillThere.prepare(
        `SELECT COUNT(*) as n FROM entries`,
      ).get().n;
      assert.equal(n, 3, 'restore must not corrupt the target on source failure');
    } finally {
      stillThere.close();
    }
  }),
);
