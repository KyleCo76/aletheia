// Regression test for bug #27.
//
// Pre-fix behavior: calling update_status with a section_id that does not
// exist in the target entry's status document was a silent no-op — the
// handler returned a success response and callers had no way to detect
// that nothing actually changed.
//
// Post-fix behavior: handler returns an isError response with code
// NOT_FOUND that names the missing section_id, while the existing happy
// path (section exists, state updated) continues to work.
//
// Tests run against the compiled dist/ output, so `npm run build` must
// have been executed at least once. The npm `test` script does this
// automatically.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';

import { runMigrations } from '../dist/db/schema.js';
import { registerStatusTools } from '../dist/server/tools/status.js';

function setupDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  const entryId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO entries (id, entry_class, project_namespace) VALUES (?, 'status', 'test-proj')`,
  ).run(entryId);

  const statusId = crypto.randomUUID();
  const versionId = crypto.randomBytes(8).toString('hex');
  db.prepare(
    `INSERT INTO status_documents (id, entry_id, content, version_id) VALUES (?, ?, ?, ?)`,
  ).run(statusId, entryId, 'doc body', versionId);

  db.prepare(
    `INSERT INTO status_sections (id, status_id, section_id, content, position) VALUES (?, ?, ?, ?, ?)`,
  ).run(crypto.randomUUID(), statusId, 'section-a', 'real section content', 0);

  return { db, entryId };
}

function makeHandlers(db) {
  const handlers = {};
  const sessionState = new Map();
  // update_status doesn't read settings, but registerStatusTools accepts
  // the full AletheiaSettings shape. Pass a minimal stub so the call
  // succeeds without pulling in loadSettings/disk I/O.
  const settings = {
    permissions: { enforce: false },
    digest: { criticalWriteCap: 3 },
    limits: {
      circuitBreakerWritesPerInterval: 100,
      circuitBreakerIntervalMinutes: 5,
      criticalWriteCap: 3,
    },
  };
  registerStatusTools(handlers, db, settings, sessionState);
  return handlers;
}

test('update_status returns NOT_FOUND when section_id does not exist (bug #27)', () => {
  const { db, entryId } = setupDb();
  const handlers = makeHandlers(db);

  const result = handlers['update_status']({
    entry_id: entryId,
    section_id: 'nonexistent-section-xyz',
    state: 'done',
  });

  assert.equal(
    result.isError,
    true,
    'Expected isError=true when targeting a missing section',
  );
  const text = result.content[0].text;
  assert.match(text, /NOT_FOUND/, 'Expected NOT_FOUND error code in response text');
  assert.match(
    text,
    /nonexistent-section-xyz/,
    'Expected error message to name the missing section_id',
  );
});

test('update_status succeeds when section exists (happy-path regression)', () => {
  const { db, entryId } = setupDb();
  const handlers = makeHandlers(db);

  const result = handlers['update_status']({
    entry_id: entryId,
    section_id: 'section-a',
    state: 'in_progress',
  });

  assert.notEqual(
    result.isError,
    true,
    'Existing section update should not be reported as an error',
  );

  // Verify the database state actually changed — guard against a fix
  // that detects existence but forgets to perform the UPDATE.
  const row = db.prepare(
    `SELECT state FROM status_sections
     WHERE status_id = (SELECT id FROM status_documents WHERE entry_id = ?)
       AND section_id = ?`,
  ).get(entryId, 'section-a');
  assert.equal(row.state, 'in_progress', 'state column should reflect the update');
});

test('update_status returns NOT_FOUND when status document is missing entirely', () => {
  const { db } = setupDb();
  const handlers = makeHandlers(db);

  const result = handlers['update_status']({
    entry_id: 'no-such-entry-id',
    section_id: 'section-a',
    state: 'done',
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /NOT_FOUND/);
});
