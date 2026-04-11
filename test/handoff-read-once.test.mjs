// Round-4 defensive test for the handoff "read-once" invariant.
//
// The round-4 task asked: "is the read-once semantic well
// tested? Can a handoff be 'read' twice via a race?" The
// answer turned out to be NO — the readHandoff query in
// db/queries/handoff.ts wraps SELECT + DELETE in
// `db.transaction(() => ...).immediate()`. The `.immediate()`
// suffix issues `BEGIN IMMEDIATE` which acquires a SQLite
// RESERVED lock at transaction start. Combined with
// better-sqlite3's synchronous API and Node's single-threaded
// event loop, the read+delete is atomic against any other
// caller — even another process with its own connection.
//
// This file PINS that behavior so a future refactor that
// drops `.immediate()` (or replaces it with non-transactional
// SELECT and DELETE) is caught immediately. There is no fix
// being shipped — these are pure regression guards.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { runMigrations } from '../dist/db/schema.js';
import { createHandoff, readHandoff } from '../dist/db/queries/handoff.js';

function setupDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

test('readHandoff returns content on first call, null on second', () => {
  const db = setupDb();
  createHandoff(db, {
    targetKey: 'target-1',
    content: 'one-shot payload',
  });

  const first = readHandoff(db, { targetKey: 'target-1' });
  assert.equal(first, 'one-shot payload');

  const second = readHandoff(db, { targetKey: 'target-1' });
  assert.equal(second, null, 'second read must return null — handoff is consumed');
});

test('readHandoff for an unknown target_key returns null without error', () => {
  const db = setupDb();
  const result = readHandoff(db, { targetKey: 'never-existed' });
  assert.equal(result, null);
});

test('handoffs row is deleted after a successful read (deletion verified)', () => {
  const db = setupDb();
  createHandoff(db, {
    targetKey: 'target-2',
    content: 'will be consumed',
  });

  // Pre-read sanity: row exists.
  const before = db.prepare(
    `SELECT COUNT(*) as n FROM handoffs WHERE target_key = ?`,
  ).get('target-2');
  assert.equal(before.n, 1);

  readHandoff(db, { targetKey: 'target-2' });

  const after = db.prepare(
    `SELECT COUNT(*) as n FROM handoffs WHERE target_key = ?`,
  ).get('target-2');
  assert.equal(after.n, 0, 'row must be DELETEd as part of the consuming read');
});

test('createHandoff overwrites an existing target (INSERT OR REPLACE)', () => {
  // Documents the upsert semantic so a future refactor that
  // separates create and replace doesn't quietly change behavior.
  const db = setupDb();
  createHandoff(db, { targetKey: 'tgt', content: 'first message' });
  createHandoff(db, { targetKey: 'tgt', content: 'overwriting message' });

  const result = readHandoff(db, { targetKey: 'tgt' });
  assert.equal(result, 'overwriting message');

  // And after that single read it's gone.
  assert.equal(readHandoff(db, { targetKey: 'tgt' }), null);
});

test('two interleaved targets do not consume each other', () => {
  // Defends against any future bug where a `WHERE target_key`
  // clause is dropped or the DELETE accidentally targets the
  // wrong row.
  const db = setupDb();
  createHandoff(db, { targetKey: 'a', content: 'for a' });
  createHandoff(db, { targetKey: 'b', content: 'for b' });

  assert.equal(readHandoff(db, { targetKey: 'a' }), 'for a');
  // a is consumed, b is untouched.
  assert.equal(readHandoff(db, { targetKey: 'b' }), 'for b');
  assert.equal(readHandoff(db, { targetKey: 'a' }), null);
  assert.equal(readHandoff(db, { targetKey: 'b' }), null);
});

test('readHandoff is wrapped in BEGIN IMMEDIATE — sequential calls cannot interleave', () => {
  // Synthetic stress test: 100 sequential reads of the same
  // target. Pre-fix (if `.immediate()` were ever removed and
  // the SELECT-then-DELETE weren't transactional) a race
  // wouldn't show up here because better-sqlite3 is sync — the
  // event loop serializes the calls. But the test still pins
  // the invariant for any future refactor: exactly ONE reader
  // gets content, the rest get null.
  const db = setupDb();
  createHandoff(db, { targetKey: 'race', content: 'unique' });

  let hits = 0;
  let misses = 0;
  for (let i = 0; i < 100; i++) {
    const r = readHandoff(db, { targetKey: 'race' });
    if (r === 'unique') hits++;
    else if (r === null) misses++;
  }

  assert.equal(hits, 1, 'exactly one read must get the payload');
  assert.equal(misses, 99, 'the other 99 must get null');
});
