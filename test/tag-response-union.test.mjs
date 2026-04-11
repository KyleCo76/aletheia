// Regression test for bug A (PM-Hockey dogfooding, 2026-04-11).
//
// Pre-fix behavior: write_journal and write_memory responses echoed only
// "newly added" tags — tags that flipped a 0→1 junction row. Tags that
// were ALREADY on the entry (from a prior call) were silently dropped
// from the response even though they were still attached to the entry.
// Callers saw a subset of their submitted tags and assumed the missing
// ones hadn't been stored, which forced confusing dogfooding loops.
//
// Post-fix behavior: responses include the COMPLETE current tag set on
// the target entry after the write — union of pre-existing and newly
// submitted tags.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';

import { runMigrations } from '../dist/db/schema.js';
import { registerJournalTools } from '../dist/server/tools/journal.js';
import { registerMemoryTools } from '../dist/server/tools/memory.js';

function setupDb(entryClass = 'journal') {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  const entryId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO entries (id, entry_class, project_namespace) VALUES (?, ?, 'test-proj')`,
  ).run(entryId, entryClass);

  // Seed two pre-existing tags so subsequent writes have overlap.
  db.prepare(`INSERT INTO tags (name) VALUES ('pre-existing-1')`).run();
  db.prepare(`INSERT INTO tags (name) VALUES ('pre-existing-2')`).run();
  const t1 = db.prepare(`SELECT id FROM tags WHERE name = ?`).get('pre-existing-1');
  const t2 = db.prepare(`SELECT id FROM tags WHERE name = ?`).get('pre-existing-2');
  db.prepare(`INSERT INTO entry_tags (entry_id, tag_id) VALUES (?, ?)`).run(entryId, t1.id);
  db.prepare(`INSERT INTO entry_tags (entry_id, tag_id) VALUES (?, ?)`).run(entryId, t2.id);

  return { db, entryId };
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
  registerJournalTools(handlers, db, settings, sessionState);
  registerMemoryTools(handlers, db, settings, sessionState);
  return handlers;
}

function extractTagNames(xml) {
  // Pull tag names out of the first <tags>...</tags> block, avoiding
  // <tags_similar> which uses a different shape. Uses String.matchAll
  // rather than regex.exec to sidestep tooling that flags .exec()
  // invocations as child_process false positives.
  const outer = xml.match(/<tags>([\s\S]*?)<\/tags>/);
  if (!outer) return [];
  const names = [];
  for (const m of outer[1].matchAll(/<tag>([^<]*)<\/tag>/g)) {
    names.push(m[1]);
  }
  return names;
}

test('write_journal response includes pre-existing tags (bug A, journal path)', () => {
  const { db, entryId } = setupDb('journal');
  const handlers = makeHandlers(db);

  const result = handlers['write_journal']({
    entry_id: entryId,
    content: 'a journal line',
    tags: ['pre-existing-1', 'brand-new-1'],
  });

  assert.notEqual(result.isError, true, 'write_journal should succeed');
  const xml = result.content[0].text;
  const tags = extractTagNames(xml);
  assert.deepEqual(
    tags.sort(),
    ['brand-new-1', 'pre-existing-1', 'pre-existing-2'].sort(),
    'Response tags should be the union of pre-existing + newly submitted',
  );
});

test('write_journal critical path response includes pre-existing tags (bug A)', () => {
  const { db, entryId } = setupDb('journal');
  const handlers = makeHandlers(db);

  const result = handlers['write_journal']({
    entry_id: entryId,
    content: 'urgent journal line',
    tags: ['pre-existing-2', 'brand-new-2'],
    critical: true,
    memory_summary: 'distilled critical knowledge',
  });

  assert.notEqual(result.isError, true, 'critical write_journal should succeed');
  const xml = result.content[0].text;
  const tags = extractTagNames(xml);
  assert.deepEqual(
    tags.sort(),
    ['brand-new-2', 'pre-existing-1', 'pre-existing-2'].sort(),
    'Critical-write response tags should be the complete current set',
  );
});

test('write_memory response includes pre-existing tags (bug A, memory path)', () => {
  const { db, entryId } = setupDb('memory');
  const handlers = makeHandlers(db);

  const result = handlers['write_memory']({
    entry_id: entryId,
    key: 'some-key',
    value: 'some-value',
    tags: ['pre-existing-1', 'brand-new-3'],
  });

  assert.notEqual(result.isError, true, 'write_memory should succeed');
  const xml = result.content[0].text;
  const tags = extractTagNames(xml);
  assert.deepEqual(
    tags.sort(),
    ['brand-new-3', 'pre-existing-1', 'pre-existing-2'].sort(),
    'Response tags should be the union, not just "added"',
  );
});

test('write_journal with no tags on empty entry emits no <tags> block', () => {
  // Empty entry, no tags submitted. Must NOT fabricate an empty block.
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const entryId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO entries (id, entry_class, project_namespace) VALUES (?, 'journal', 'test-proj')`,
  ).run(entryId);

  const handlers = makeHandlers(db);
  const result = handlers['write_journal']({
    entry_id: entryId,
    content: 'no-tags journal line',
  });

  assert.notEqual(result.isError, true);
  const xml = result.content[0].text;
  assert.doesNotMatch(xml, /<tags>/, 'Should not emit an empty <tags> block');
});
