// Round-3 P3 regression test for the "oversized item halts the
// injection loop" bug found in the frequency tuning investigation.
//
// Pre-fix behavior: l1-builder and l2-builder iterated their
// candidate items (memories, journal entries) in recency order
// and used `break` when an item exceeded the remaining token
// budget. The result: a single memory larger than the budget
// would halt the loop and prevent EVERY subsequent (older,
// smaller) memory from being injected. Because the recency sort
// puts the freshest item first — and the freshest item tends to
// be the one actively being edited and not yet distilled — this
// was the worst possible heuristic for a memory injection
// system.
//
// Post-fix behavior: oversized items get skipped (`continue`)
// instead, so smaller items in the same iteration still get a
// shot at the remaining budget.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';

import { runMigrations } from '../dist/db/schema.js';
import { buildL1Payload } from '../dist/injection/l1-builder.js';
import { buildL2Payload } from '../dist/injection/l2-builder.js';

function setupDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function makeSettings(tokenBudget = 1500) {
  return {
    permissions: { enforce: false },
    digest: { criticalWriteCap: 3, entryThreshold: 5 },
    limits: {
      circuitBreakerWritesPerInterval: 100,
      circuitBreakerIntervalMinutes: 5,
      criticalWriteCap: 3,
    },
    injection: { tokenBudget },
    memory: { rollingDefault: 10 },
  };
}

function seedMemoryEntry(db, projectNamespace) {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO entries (id, entry_class, project_namespace) VALUES (?, 'memory', ?)`,
  ).run(id, projectNamespace);
  return id;
}

function seedMemory(db, entryId, key, value) {
  db.prepare(
    `INSERT INTO memory_entries (id, entry_id, key, value, version_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    entryId,
    key,
    value,
    crypto.randomBytes(8).toString('hex'),
    new Date().toISOString(),
  );
}

test('L1: oversized recent memory does not block smaller older memories (bug P3)', () => {
  const db = setupDb();
  const settings = makeSettings(1500);

  const proj = 'test-proj';
  const entryId = seedMemoryEntry(db, proj);

  // Insert in order: oldest first, then a fat one, then a small
  // recent one. Recency sort puts FAT_NEW first because it's
  // freshest.
  const yesterday = new Date(Date.now() - 86400 * 1000).toISOString();
  db.prepare(
    `INSERT INTO memory_entries (id, entry_id, key, value, version_id, updated_at)
     VALUES (?, ?, 'old-tiny', 'just five words', ?, ?)`,
  ).run(crypto.randomUUID(), entryId, 'vid', yesterday);

  // Fat blob: 8KB ≈ 2000 tokens by the 4-chars-per-token estimate.
  // Larger than budget — must be skipped.
  const fatValue = 'x'.repeat(8000);
  db.prepare(
    `INSERT INTO memory_entries (id, entry_id, key, value, version_id, updated_at)
     VALUES (?, ?, 'fat-recent', ?, ?, ?)`,
  ).run(crypto.randomUUID(), entryId, fatValue, 'vid', new Date().toISOString());

  const sessionState = new Map();
  sessionState.set('projectNamespace', proj);

  const payload = buildL1Payload(db, settings, sessionState);
  assert.ok(payload, 'should produce a payload');
  assert.ok(payload.memories, 'should include the memories field');

  // The oversized "fat-recent" must NOT be in the payload.
  // The "old-tiny" memory MUST be in the payload despite being
  // older than the skipped fat one. Pre-fix, the fat memory's
  // break would have prevented old-tiny from ever being tried.
  const keys = payload.memories.map((m) => m.key);
  assert.ok(!keys.includes('fat-recent'), 'fat memory must be skipped');
  assert.ok(
    keys.includes('old-tiny'),
    `old-tiny should still be injected (got keys: ${JSON.stringify(keys)})`,
  );
});

test('L2: oversized memory does not block smaller older memories', () => {
  const db = setupDb();
  const settings = makeSettings(1500);

  const proj = 'test-proj';
  const entryId = seedMemoryEntry(db, proj);

  const yesterday = new Date(Date.now() - 86400 * 1000).toISOString();
  db.prepare(
    `INSERT INTO memory_entries (id, entry_id, key, value, version_id, updated_at)
     VALUES (?, ?, 'old-tiny', 'short value', ?, ?)`,
  ).run(crypto.randomUUID(), entryId, 'vid', yesterday);

  const fatValue = 'y'.repeat(8000);
  db.prepare(
    `INSERT INTO memory_entries (id, entry_id, key, value, version_id, updated_at)
     VALUES (?, ?, 'fat-recent', ?, ?, ?)`,
  ).run(crypto.randomUUID(), entryId, fatValue, 'vid', new Date().toISOString());

  const sessionState = new Map();
  sessionState.set('projectNamespace', proj);

  const payload = buildL2Payload(db, settings, sessionState);
  assert.ok(payload);
  assert.ok(payload.memories);

  const keys = payload.memories.map((m) => m.key);
  assert.ok(!keys.includes('fat-recent'), 'fat memory must be skipped');
  assert.ok(keys.includes('old-tiny'), 'old-tiny should still be injected');
});

test('L2: oversized journal entry does not block smaller subsequent ones', () => {
  const db = setupDb();
  const settings = makeSettings(1500);

  const proj = 'test-proj';
  const entryId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO entries (id, entry_class, project_namespace) VALUES (?, 'journal', ?)`,
  ).run(entryId, proj);

  // Journal sort by created_at DESC — newest first. Insert oldest
  // (small) first, then a fat one (newer). The fat one will be
  // first in the rolling window iteration.
  db.prepare(
    `INSERT INTO journal_entries (id, entry_id, content, created_at)
     VALUES (?, ?, 'small earlier', '2026-04-10T12:00:00')`,
  ).run(crypto.randomUUID(), entryId);
  db.prepare(
    `INSERT INTO journal_entries (id, entry_id, content, created_at)
     VALUES (?, ?, ?, '2026-04-11T12:00:00')`,
  ).run(crypto.randomUUID(), entryId, 'z'.repeat(8000));

  const sessionState = new Map();
  sessionState.set('projectNamespace', proj);

  const payload = buildL2Payload(db, settings, sessionState);
  assert.ok(payload);
  assert.ok(payload.journal, 'should include journal field');

  // Small earlier entry must still be present despite the fat
  // newer one being skipped.
  const contents = payload.journal.map((e) => e.content);
  assert.ok(
    contents.includes('small earlier'),
    `small earlier journal entry should be injected (got: ${JSON.stringify(contents)})`,
  );
  assert.ok(
    !contents.some((c) => c.startsWith('zzzzz')),
    'fat journal entry must be skipped',
  );
});
