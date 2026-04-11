// Regression test for bug B (PM-Hockey dogfooding, 2026-04-11).
//
// Pre-fix behavior: calling the generic `read` tool on an entry with
// entry_class='status' returned an envelope containing only the
// <related> block (or nothing at all) — the status body was never
// included. The dedicated `read_status` tool worked, but callers who
// used `read` as a uniform entry-type fetcher saw no content.
//
// Root cause: the `read` handler in discovery.ts branched on
// entry_class being journal / memory / handoff but never covered
// status, so execution fell through the if-chain with an empty xml
// buffer.
//
// Post-fix behavior: `read` on a status entry dispatches to the same
// query helper as `read_status` and emits an equivalent <status>
// block. The dedicated read_status tool continues to work unchanged.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';

import { runMigrations } from '../dist/db/schema.js';
import { registerDiscoveryTools } from '../dist/server/tools/discovery.js';

function setupStatusEntry() {
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
  ).run(statusId, entryId, 'status doc preamble body', versionId);

  db.prepare(
    `INSERT INTO status_sections (id, status_id, section_id, content, state, position)
     VALUES (?, ?, 'alpha', 'alpha body', 'done', 0)`,
  ).run(crypto.randomUUID(), statusId);
  db.prepare(
    `INSERT INTO status_sections (id, status_id, section_id, content, state, position)
     VALUES (?, ?, 'beta', 'beta body', 'in_progress', 1)`,
  ).run(crypto.randomUUID(), statusId);

  return { db, entryId, versionId };
}

function makeHandlers(db) {
  const handlers = {};
  const sessionState = new Map();
  const settings = {
    permissions: { enforce: false },
    digest: { criticalWriteCap: 3 },
    limits: {
      circuitBreakerWritesPerInterval: 100,
      circuitBreakerIntervalMinutes: 5,
      criticalWriteCap: 3,
    },
  };
  registerDiscoveryTools(handlers, db, settings, sessionState);
  return handlers;
}

test('read on a status entry returns the status body (bug B)', () => {
  const { db, entryId, versionId } = setupStatusEntry();
  const handlers = makeHandlers(db);

  const result = handlers['read']({ entry_id: entryId });

  assert.notEqual(result.isError, true, 'read on a status entry must succeed');
  const xml = result.content[0].text;

  // Must include a <status ...> block with the document body and both
  // sections. This is the bug-B regression assertion: pre-fix the
  // entire <status>...</status> block was missing.
  assert.match(xml, /<status /, 'Response must contain a <status> block');
  assert.match(xml, new RegExp(`version_id="${versionId}"`), 'Response must carry the current version_id');
  assert.match(xml, /status doc preamble body/, 'Response must contain the document body');
  assert.match(xml, /section id="alpha"/, 'Response must include section "alpha"');
  assert.match(xml, /section id="beta"/, 'Response must include section "beta"');
  assert.match(xml, /alpha body/, 'Response must include section alpha content');
  assert.match(xml, /beta body/, 'Response must include section beta content');
});

test('read on a status entry with show_related:false omits related block', () => {
  const { db, entryId } = setupStatusEntry();
  const handlers = makeHandlers(db);

  const result = handlers['read']({ entry_id: entryId, show_related: false });
  assert.notEqual(result.isError, true);
  const xml = result.content[0].text;
  assert.doesNotMatch(xml, /<related>/);
  assert.match(xml, /<status /);
});

test('read on a status entry whose status document is missing returns NOT_FOUND', () => {
  // Edge case: an entry row exists with entry_class='status' but the
  // status_documents row was never inserted (e.g., created via
  // create_entry without a follow-up replace_status). Treat as
  // NOT_FOUND so the caller has a clear signal.
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const entryId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO entries (id, entry_class, project_namespace) VALUES (?, 'status', 'test-proj')`,
  ).run(entryId);

  const handlers = makeHandlers(db);
  const result = handlers['read']({ entry_id: entryId });

  assert.equal(result.isError, true, 'Missing status doc should surface as an error');
  assert.match(result.content[0].text, /NOT_FOUND/);
});
