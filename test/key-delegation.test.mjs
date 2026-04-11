// Tests for v0.2.0 item #16 — cascading key delegation.
//
// Pre-fix behavior: create_key only checked that the caller had
// create-sub-entries or maintenance permission, then handed back a
// new key with whatever permissions and entry_scope the caller asked
// for. This was a privilege escalation surface — a create-sub-entries
// holder could mint a maintenance key, and a project-scoped parent
// could mint a global child.
//
// Post-fix behavior:
//   1. permission level subset: child level <= parent level
//      (modifyKey already enforces the analogous invariant for updates)
//   2. entry scope subset: a scoped parent can only delegate the same
//      scope; a global parent can delegate to any scope
//   3. The check is gated on settings.permissions.enforce — dev mode
//      (enforce=false) still bypasses, matching the existing handler
//      contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { runMigrations } from '../dist/db/schema.js';
import { createKey } from '../dist/db/queries/keys.js';
import { registerAuthTools } from '../dist/server/tools/auth.js';

function setupDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function makeHandlers(db, enforce = true) {
  const handlers = {};
  const sessionState = new Map();
  const settings = {
    permissions: { enforce },
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

function claimAs(handlers, sessionState, parentInfo) {
  // Bypass the claim handler's DB lookup by writing the session state
  // directly. The auth handlers read from sessionState.get('claimedKey'),
  // and parentInfo matches the shape they expect. This keeps the test
  // hermetic — we don't need to round-trip a real key value.
  sessionState.set('claimedKey', parentInfo);
}

function extractCode(text) {
  const m = text.match(/code="([^"]+)"/);
  return m ? m[1] : null;
}

test('maintenance parent CAN delegate maintenance child (equal level)', () => {
  const db = setupDb();
  const { handlers, sessionState } = makeHandlers(db);
  const parent = createKey(db, { permissions: 'maintenance', entryScope: null });
  claimAs(handlers, sessionState, {
    id: parent.id,
    permissions: parent.permissions,
    entryScope: null,
  });

  const r = handlers['create_key']({ permissions: 'maintenance' });
  assert.notEqual(r.isError, true, `expected success, got ${r.content[0].text}`);
});

test('maintenance parent CAN delegate read-only child (downgrade)', () => {
  const db = setupDb();
  const { handlers, sessionState } = makeHandlers(db);
  const parent = createKey(db, { permissions: 'maintenance', entryScope: null });
  claimAs(handlers, sessionState, {
    id: parent.id,
    permissions: parent.permissions,
    entryScope: null,
  });

  const r = handlers['create_key']({ permissions: 'read-only' });
  assert.notEqual(r.isError, true);
});

test('create-sub-entries parent CANNOT delegate maintenance child (escalation)', () => {
  const db = setupDb();
  const { handlers, sessionState } = makeHandlers(db);
  const parent = createKey(db, {
    permissions: 'create-sub-entries',
    entryScope: 'proj-a',
  });
  claimAs(handlers, sessionState, {
    id: parent.id,
    permissions: parent.permissions,
    entryScope: 'proj-a',
  });

  const r = handlers['create_key']({
    permissions: 'maintenance',
    entry_scope: 'proj-a',
  });
  assert.equal(r.isError, true, 'escalation should be blocked');
  assert.equal(extractCode(r.content[0].text), 'INSUFFICIENT_PERMISSIONS');
});

test('create-sub-entries parent CAN delegate create-sub-entries child (equal)', () => {
  const db = setupDb();
  const { handlers, sessionState } = makeHandlers(db);
  const parent = createKey(db, {
    permissions: 'create-sub-entries',
    entryScope: 'proj-a',
  });
  claimAs(handlers, sessionState, {
    id: parent.id,
    permissions: parent.permissions,
    entryScope: 'proj-a',
  });

  const r = handlers['create_key']({
    permissions: 'create-sub-entries',
    entry_scope: 'proj-a',
  });
  assert.notEqual(r.isError, true);
});

test('scoped parent CANNOT delegate global (null) scope (escalation)', () => {
  const db = setupDb();
  const { handlers, sessionState } = makeHandlers(db);
  const parent = createKey(db, {
    permissions: 'maintenance',
    entryScope: 'proj-a',
  });
  claimAs(handlers, sessionState, {
    id: parent.id,
    permissions: parent.permissions,
    entryScope: 'proj-a',
  });

  // Omitting entry_scope from args resolves to undefined, which is
  // semantically "global" — child has no scope binding.
  const r = handlers['create_key']({ permissions: 'read-only' });
  assert.equal(r.isError, true, 'scoped parent must not delegate global scope');
  assert.equal(extractCode(r.content[0].text), 'INSUFFICIENT_PERMISSIONS');
});

test('scoped parent CANNOT delegate to a different scope (lateral move)', () => {
  const db = setupDb();
  const { handlers, sessionState } = makeHandlers(db);
  const parent = createKey(db, {
    permissions: 'maintenance',
    entryScope: 'proj-a',
  });
  claimAs(handlers, sessionState, {
    id: parent.id,
    permissions: parent.permissions,
    entryScope: 'proj-a',
  });

  const r = handlers['create_key']({
    permissions: 'read-only',
    entry_scope: 'proj-b',
  });
  assert.equal(r.isError, true);
  assert.equal(extractCode(r.content[0].text), 'INSUFFICIENT_PERMISSIONS');
});

test('scoped parent CAN delegate to its own scope', () => {
  const db = setupDb();
  const { handlers, sessionState } = makeHandlers(db);
  const parent = createKey(db, {
    permissions: 'maintenance',
    entryScope: 'proj-a',
  });
  claimAs(handlers, sessionState, {
    id: parent.id,
    permissions: parent.permissions,
    entryScope: 'proj-a',
  });

  const r = handlers['create_key']({
    permissions: 'read-write',
    entry_scope: 'proj-a',
  });
  assert.notEqual(r.isError, true);
});

test('global parent CAN delegate to any scope (downward)', () => {
  const db = setupDb();
  const { handlers, sessionState } = makeHandlers(db);
  const parent = createKey(db, {
    permissions: 'maintenance',
    entryScope: null,
  });
  claimAs(handlers, sessionState, {
    id: parent.id,
    permissions: parent.permissions,
    entryScope: null,
  });

  const r = handlers['create_key']({
    permissions: 'read-write',
    entry_scope: 'proj-x',
  });
  assert.notEqual(r.isError, true);
});

test('dev mode with NO claim allows arbitrary create_key (unsecured context)', () => {
  // An unclaimed dev-mode session has no parent to compare against,
  // so subset enforcement is vacuous. create_key must still work
  // end-to-end — this is the first-run / unbootstrapped path.
  const db = setupDb();
  const { handlers } = makeHandlers(db, false);

  const r = handlers['create_key']({
    permissions: 'maintenance',
    entry_scope: 'proj-fresh',
  });
  assert.notEqual(r.isError, true, 'unclaimed dev mode should allow minting freely');
});

test('dev mode WITH a claim STILL enforces subset (security invariant)', () => {
  // Prior to v0.2.1 this path let a create-sub-entries claim mint a
  // maintenance child in dev mode — a privilege escalation dressed
  // up as "permission enforcement is off". Subset delegation is a
  // security invariant, not a permission check: if you're claimed
  // as X, you cannot mint a key that exceeds X, full stop.
  const db = setupDb();
  const { handlers, sessionState } = makeHandlers(db, false);
  const parent = createKey(db, {
    permissions: 'create-sub-entries',
    entryScope: 'proj-a',
  });
  claimAs(handlers, sessionState, {
    id: parent.id,
    permissions: parent.permissions,
    entryScope: 'proj-a',
  });

  // Permission-level escalation: blocked even in dev mode.
  const rPerm = handlers['create_key']({
    permissions: 'maintenance',
    entry_scope: 'proj-a',
  });
  assert.equal(rPerm.isError, true, 'permission-level escalation must be blocked even in dev mode');
  assert.match(rPerm.content[0].text, /Cannot delegate.*maintenance.*create-sub-entries/);

  // Scope lateral move: also blocked even in dev mode.
  const rScope = handlers['create_key']({
    permissions: 'create-sub-entries',
    entry_scope: 'proj-b',
  });
  assert.equal(rScope.isError, true, 'scope lateral move must be blocked even in dev mode');
  assert.match(rScope.content[0].text, /Cannot delegate scope.*proj-b.*proj-a/);
});

test('the audit chain is recorded — created_by points at the parent key', () => {
  const db = setupDb();
  const { handlers, sessionState } = makeHandlers(db);
  const parent = createKey(db, { permissions: 'maintenance', entryScope: null });
  claimAs(handlers, sessionState, {
    id: parent.id,
    permissions: parent.permissions,
    entryScope: null,
  });

  const r = handlers['create_key']({
    permissions: 'read-write',
    entry_scope: 'audit-test',
  });
  assert.notEqual(r.isError, true);

  // Pull the new key out of the response and check its created_by
  const idMatch = r.content[0].text.match(/<id>([^<]+)<\/id>/);
  assert.ok(idMatch, 'response should embed the new key id');
  const childId = idMatch[1];

  const row = db.prepare(
    `SELECT created_by, entry_scope, permissions FROM keys WHERE id = ?`,
  ).get(childId);
  assert.equal(row.created_by, parent.id);
  assert.equal(row.entry_scope, 'audit-test');
  assert.equal(row.permissions, 'read-write');
});
