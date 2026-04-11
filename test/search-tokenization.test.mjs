// Regression test for bug C (PM-Hockey dogfooding, 2026-04-11).
//
// Symptom: task templates reference memories via descriptive English
// phrases like "the bootstrap info memory" or "load the project setup
// instructions". The search tool used a single substring LIKE match
// against the query as-a-whole, so a multi-word descriptive phrase
// would fail to match a concisely-named memory like "bootstrap-info"
// even when the target was obvious to a human reader.
//
// Post-fix behavior: search tokenizes multi-word queries and matches
// on any meaningful token (length >= 3). Short stop-word-ish tokens
// are skipped to reduce noise. The exact-phrase match is preserved
// so existing single-word callers behave identically and a query
// that happens to be a phrase in the corpus still hits.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';

import { runMigrations } from '../dist/db/schema.js';
import { searchMemory } from '../dist/db/queries/memory.js';
import { searchJournal } from '../dist/db/queries/journal.js';

function seedMemory(db, entryId, key, value) {
  db.prepare(
    `INSERT INTO memory_entries (id, entry_id, key, value, version_id) VALUES (?, ?, ?, ?, ?)`,
  ).run(crypto.randomUUID(), entryId, key, value, crypto.randomBytes(8).toString('hex'));
}

function setupDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  const entryId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO entries (id, entry_class, project_namespace) VALUES (?, 'memory', 'proj')`,
  ).run(entryId);
  return { db, entryId };
}

test('searchMemory finds a memory when the query is a descriptive phrase (bug C)', () => {
  const { db, entryId } = setupDb();
  seedMemory(db, entryId, 'bootstrap-info', 'project initialization sequence');

  // Pre-fix: this returned []. The literal substring
  // "load the bootstrap info" doesn't appear in the key or value.
  const results = searchMemory(db, { query: 'load the bootstrap info' });

  assert.equal(results.length, 1, 'Should find the bootstrap-info memory by descriptive phrase');
  assert.equal(results[0].key, 'bootstrap-info');
});

test('searchMemory still matches single-keyword queries (no regression)', () => {
  const { db, entryId } = setupDb();
  seedMemory(db, entryId, 'bootstrap-info', 'project initialization sequence');
  seedMemory(db, entryId, 'cleanup-routine', 'teardown sequence');

  const results = searchMemory(db, { query: 'bootstrap' });
  assert.equal(results.length, 1);
  assert.equal(results[0].key, 'bootstrap-info');
});

test('searchMemory skips stop-word-ish short tokens to avoid false positives', () => {
  // Tokens shorter than 3 chars (the, a, in, of, to, on...) get
  // dropped so that "the a of" alone does not match arbitrary rows.
  const { db, entryId } = setupDb();
  seedMemory(db, entryId, 'unrelated', 'nothing to do with the query');

  const results = searchMemory(db, { query: 'a of to in' });
  assert.equal(results.length, 0, 'All-short-tokens query should not match arbitrary rows');
});

test('searchMemory returns empty when no tokens match', () => {
  const { db, entryId } = setupDb();
  seedMemory(db, entryId, 'bootstrap-info', 'project initialization sequence');

  const results = searchMemory(db, { query: 'database replication coordinator' });
  assert.equal(results.length, 0);
});

test('searchJournal tokenizes descriptive-phrase queries symmetrically (bug C)', () => {
  const { db, entryId } = setupDb();
  db.prepare(
    `INSERT INTO journal_entries (id, entry_id, content) VALUES (?, ?, ?)`,
  ).run(crypto.randomUUID(), entryId, 'decided to rewrite the bootstrap sequence');

  const results = searchJournal(db, { query: 'load the bootstrap info' });
  assert.equal(results.length, 1, 'Multi-word journal queries should also tokenize');
});
