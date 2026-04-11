// Test for the Priority-3 investigation: "what happens if a key is
// revoked mid-session?" — does the claim persist and fail-open, or
// does it fail-closed?
//
// Prior behavior (v0.2.2 and earlier): once a session called claim(),
// the validated key record was stored in sessionState and never
// re-checked. A key deleted or modified in the keys table AFTER
// that claim had no effect on the session — the handler kept using
// the cached claim. An admin revoking a compromised key could not
// stop an already-claimed session from continuing to exercise
// privileged operations.
//
// Post-fix (v0.2.3): privileged auth handlers re-validate the
// claimed key against the db at the start of every call. A key
// that's been removed causes the cached claim to be cleared and
// the handler returns NO_CLAIM (fail-closed). A key that's been
// downgraded is refreshed in the cache so subsequent permission
// checks see the authoritative (now-lower) level.
//
// This test pins create_key and list_keys as the privileged paths.
// Non-auth write handlers (write_journal, write_memory, etc.) are
// NOT yet re-validated — a follow-up commit can broaden the
// coverage once we decide the cost model.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';

import { runMigrations } from '../dist/db/schema.js';
import { registerAuthTools } from '../dist/server/tools/auth.js';
import { createKey } from '../dist/db/queries/keys.js';

function setupDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function makeHandlers(db) {
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
  return { handlers, sessionState };
}

test('revoked key mid-session: create_key fails closed (was fail-open)', () => {
  const db = setupDb();
  const { handlers, sessionState } = makeHandlers(db);

  // Set up a maintenance key and claim it.
  const parent = createKey(db, { permissions: 'maintenance', entryScope: null });
  const claimResult = handlers['claim']({ key: parent.keyValue });
  assert.notEqual(claimResult.isError, true);

  // Sanity: create_key works while the claim is valid.
  const pre = handlers['create_key']({ permissions: 'read-write' });
  assert.notEqual(pre.isError, true, 'create_key should succeed with a valid claim');

  // Simulate an admin revoking the key mid-session — e.g. because
  // the key was compromised or the agent was fired.
  db.prepare(`DELETE FROM keys WHERE id = ?`).run(parent.id);

  // The session still has claimedKey in sessionState, but the db
  // says the key no longer exists. Every subsequent privileged
  // operation must fail-closed.
  const post = handlers['create_key']({ permissions: 'read-write' });
  assert.equal(post.isError, true, 'create_key must fail after key revocation');
  assert.match(post.content[0].text, /NO_CLAIM/, 'error should be NO_CLAIM');

  // And the session state should have been cleared so the next
  // call doesn't hit the db lookup twice — the cache is now
  // empty and the session has to re-claim.
  assert.equal(
    sessionState.get('claimedKey'),
    undefined,
    'revoked claim should be cleared from sessionState',
  );
});

test('downgraded key mid-session: cached claim refreshes to the lower level', () => {
  const db = setupDb();
  const { handlers, sessionState } = makeHandlers(db);

  // Maintenance parent, claimed. Mint one child to prove the claim
  // is working at maintenance level.
  const parent = createKey(db, { permissions: 'maintenance', entryScope: null });
  handlers['claim']({ key: parent.keyValue });

  const pre = handlers['create_key']({ permissions: 'create-sub-entries' });
  assert.notEqual(pre.isError, true);

  // Admin downgrades the key in the db (by modifyKey equivalent —
  // direct UPDATE here to avoid the modifyKey "cannot modify at or
  // above caller scope" rule). The session's cached claim still
  // says "maintenance".
  db.prepare(`UPDATE keys SET permissions = 'read-only' WHERE id = ?`).run(parent.id);

  // Try to mint a child at create-sub-entries — this is above
  // read-only, so the (refreshed) claim should reject it.
  const post = handlers['create_key']({ permissions: 'create-sub-entries' });
  assert.equal(
    post.isError,
    true,
    'downgraded claim must reject mints beyond its new (lower) level',
  );

  // Cached claim now reflects the downgrade.
  const refreshed = sessionState.get('claimedKey');
  assert.equal(refreshed.permissions, 'read-only');
});

test('unchanged key mid-session: no-op re-validation succeeds', () => {
  // Regression guard: re-validation must not break the common path
  // where the key hasn't changed between calls.
  const db = setupDb();
  const { handlers } = makeHandlers(db);

  const parent = createKey(db, { permissions: 'maintenance', entryScope: null });
  handlers['claim']({ key: parent.keyValue });

  for (let i = 0; i < 3; i++) {
    const r = handlers['create_key']({ permissions: 'read-only' });
    assert.notEqual(r.isError, true, `call ${i} should still succeed`);
  }
});
