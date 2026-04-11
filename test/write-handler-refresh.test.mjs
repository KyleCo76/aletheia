// Round-2 regression test for the key-rotation fix coverage gap.
//
// Round 1 (v0.2.3, commit c4c1d91) fixed the three privileged
// auth handlers — create_key, modify_key, list_keys — to
// re-validate the cached claim against the keys table on every
// call so a key deleted or downgraded mid-session no longer
// keeps working.
//
// Round 1 explicitly left the write handlers unfixed: write_journal,
// write_memory, replace_status, update_status, add_section,
// remove_section, create_handoff, create_entry, retire_memory,
// and promote_to_memory all trusted sessionState.claimedKey
// without any db check. A revoked read-write key could still
// pump data into the journal, mint memories, and overwrite
// status documents until the session died.
//
// Round 2 closes that gap via a shared `claimGuard` helper
// exported from auth.ts and called at the start of every write
// handler. This test pins write_journal and write_memory as
// representatives — if those two are fixed, the same pattern
// applied mechanically to the other eight is correct too.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';

import { runMigrations } from '../dist/db/schema.js';
import { registerAuthTools } from '../dist/server/tools/auth.js';
import { registerJournalTools } from '../dist/server/tools/journal.js';
import { registerMemoryTools } from '../dist/server/tools/memory.js';
import { registerStatusTools } from '../dist/server/tools/status.js';
import { registerEntryTools } from '../dist/server/tools/entries.js';
import { registerHandoffTools } from '../dist/server/tools/handoff.js';
import { createKey } from '../dist/db/queries/keys.js';

function setupDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function makeHandlers(db) {
  // enforce=true — the failure mode we're testing. Dev mode
  // write handlers are intentionally unguarded.
  const handlers = {};
  const sessionState = new Map();
  const settings = {
    permissions: { enforce: true },
    digest: { criticalWriteCap: 3 },
    limits: {
      circuitBreakerWritesPerInterval: 100,
      circuitBreakerIntervalMinutes: 5,
      criticalWriteCap: 3,
    },
  };
  registerAuthTools(handlers, db, settings, sessionState);
  registerJournalTools(handlers, db, settings, sessionState);
  registerMemoryTools(handlers, db, settings, sessionState);
  registerStatusTools(handlers, db, settings, sessionState);
  registerEntryTools(handlers, db, settings, sessionState);
  registerHandoffTools(handlers, db, settings, sessionState);
  return { handlers, sessionState };
}

function seedAndClaim(db, handlers, sessionState) {
  // Mint a maintenance key so it has enough permission for every
  // write handler we might test. Claim it directly via the tool
  // handler path so sessionState matches what claim() would set.
  const key = createKey(db, { permissions: 'maintenance', entryScope: null });
  handlers['claim']({ key: key.keyValue });
  // Set a projectNamespace so create_entry doesn't prompt.
  sessionState.set('projectNamespace', 'test-proj');
  return key;
}

function seedEntry(db, entryClass) {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO entries (id, entry_class, project_namespace) VALUES (?, ?, 'test-proj')`,
  ).run(id, entryClass);
  return id;
}

test('write_journal fails closed after key revocation (round-2 gap)', () => {
  const db = setupDb();
  const { handlers, sessionState } = makeHandlers(db);
  const key = seedAndClaim(db, handlers, sessionState);
  const entryId = seedEntry(db, 'journal');

  // Sanity: the write works while claim is valid.
  const pre = handlers['write_journal']({
    entry_id: entryId,
    content: 'pre-revocation journal line',
  });
  assert.notEqual(pre.isError, true, 'write_journal should succeed with a valid claim');

  // Admin revokes the key in the db mid-session.
  db.prepare(`DELETE FROM keys WHERE id = ?`).run(key.id);

  // Post-revocation writes must fail closed. Prior to this fix,
  // the handler would happily continue using the stale cached
  // claim.
  const post = handlers['write_journal']({
    entry_id: entryId,
    content: 'post-revocation journal line',
  });
  assert.equal(post.isError, true, 'write_journal must fail after key revocation');
  assert.match(post.content[0].text, /NO_CLAIM/);
  assert.equal(sessionState.get('claimedKey'), undefined, 'stale cache should be cleared');
});

test('write_memory fails closed after key revocation (round-2 gap)', () => {
  const db = setupDb();
  const { handlers, sessionState } = makeHandlers(db);
  const key = seedAndClaim(db, handlers, sessionState);
  const entryId = seedEntry(db, 'memory');

  const pre = handlers['write_memory']({
    entry_id: entryId,
    key: 'pre-revocation',
    value: 'body',
  });
  assert.notEqual(pre.isError, true);

  db.prepare(`DELETE FROM keys WHERE id = ?`).run(key.id);

  const post = handlers['write_memory']({
    entry_id: entryId,
    key: 'post-revocation',
    value: 'body',
  });
  assert.equal(post.isError, true);
  assert.match(post.content[0].text, /NO_CLAIM/);
});

test('create_entry fails closed after key revocation (replaces local requireClaim)', () => {
  // create_entry used its own local requireClaim helper that read
  // sessionState without db validation. The round-2 fix swaps it
  // out for the shared claimGuard. This test pins the new
  // behavior so the local helper can't quietly return.
  const db = setupDb();
  const { handlers, sessionState } = makeHandlers(db);
  const key = seedAndClaim(db, handlers, sessionState);

  const pre = handlers['create_entry']({ entry_class: 'journal' });
  assert.notEqual(pre.isError, true);

  db.prepare(`DELETE FROM keys WHERE id = ?`).run(key.id);

  const post = handlers['create_entry']({ entry_class: 'journal' });
  assert.equal(post.isError, true);
  assert.match(post.content[0].text, /NO_CLAIM/);
});

test('replace_status fails closed after key revocation', () => {
  const db = setupDb();
  const { handlers, sessionState } = makeHandlers(db);
  const key = seedAndClaim(db, handlers, sessionState);
  const entryId = seedEntry(db, 'status');

  const pre = handlers['replace_status']({
    entry_id: entryId,
    content: 'pre-revocation status body',
    version_id: '',
  });
  assert.notEqual(pre.isError, true);

  db.prepare(`DELETE FROM keys WHERE id = ?`).run(key.id);

  const post = handlers['replace_status']({
    entry_id: entryId,
    content: 'post-revocation status body',
    version_id: '',
  });
  assert.equal(post.isError, true);
  assert.match(post.content[0].text, /NO_CLAIM/);
});

test('dev mode write handlers remain unguarded (no regression)', () => {
  // Coverage guarantee: enforce=false callers must continue to
  // write without any claim, since dev mode is the opt-out for
  // the whole authorization layer. Prior to this test the
  // guard's design note said "dev mode is a no-op" — this pins
  // that promise.
  const db = setupDb();
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

  const entryId = seedEntry(db, 'journal');
  const r = handlers['write_journal']({
    entry_id: entryId,
    content: 'dev mode write with no claim at all',
  });
  assert.notEqual(r.isError, true, 'dev mode must accept unclaimed writes');
});
