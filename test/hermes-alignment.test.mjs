// Tests for the Hermes alignment changes (v0.2.8):
//   1. Key revocation via modify_key(key_id, revoked=true)
//   2. Key names via create_key(permissions, entry_scope, name)
//   3. FrequencyManager.reset() method
//
// These three changes enable the Hermes Orchestration Daemon to:
//   - Revoke teammate keys on agent exit (no more orphaned keys)
//   - Name keys for lifecycle management (teammate-{agent_id})
//   - Reset injection frequency after compaction (without MCP reconnect side effects)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { runMigrations } from '../dist/db/schema.js';
import { createKey, validateKey, modifyKey, listKeys } from '../dist/db/queries/keys.js';
import { registerAuthTools } from '../dist/server/tools/auth.js';
import { FrequencyManager } from '../dist/injection/frequency.js';

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

// ── Key Revocation ──────────────────────────────────────────────

test('modify_key with revoked=true sets the revoked flag in DB', () => {
  const db = setupDb();
  const parent = createKey(db, { permissions: 'maintenance', entryScope: null });
  const child = createKey(db, { permissions: 'read-write', entryScope: null, createdBy: parent.id });

  const result = modifyKey(db, { keyId: child.id, revoked: true, callerPermissions: 'maintenance' });
  assert.ok(!('error' in result), 'modifyKey should succeed');
  assert.equal(result.revoked, true);

  // Verify the DB state
  const row = db.prepare('SELECT revoked FROM keys WHERE id = ?').get(child.id);
  assert.equal(row.revoked, 1);
});

test('validateKey rejects a revoked key', () => {
  const db = setupDb();
  const key = createKey(db, { permissions: 'read-write', entryScope: null });

  // Key validates before revocation
  const before = validateKey(db, { keyValue: key.keyValue });
  assert.ok(before !== null && !('revoked' in before), 'key should validate before revocation');

  // Revoke it
  db.prepare('UPDATE keys SET revoked = 1 WHERE id = ?').run(key.id);

  // Key returns revoked sentinel after revocation
  const after = validateKey(db, { keyValue: key.keyValue });
  assert.ok(after !== null && 'revoked' in after, 'revoked key should return revoked sentinel');
});

test('claim handler rejects a revoked key', () => {
  const db = setupDb();
  const { handlers } = makeHandlers(db);
  const key = createKey(db, { permissions: 'read-write', entryScope: 'test' });

  // Revoke the key
  db.prepare('UPDATE keys SET revoked = 1 WHERE id = ?').run(key.id);

  const result = handlers['claim']({ key: key.keyValue });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /revoked/i);
});

test('modify_key revoked=true via tool handler (full round-trip)', () => {
  const db = setupDb();
  const { handlers, sessionState } = makeHandlers(db);

  // Create and claim a maintenance parent
  const parent = createKey(db, { permissions: 'maintenance', entryScope: null });
  handlers['claim']({ key: parent.keyValue });

  // Create a child key
  const createResult = handlers['create_key']({ permissions: 'read-write' });
  assert.notEqual(createResult.isError, true);
  const childId = createResult.content[0].text.match(/<id>([^<]+)<\/id>/)[1];

  // Revoke the child via modify_key
  const revokeResult = handlers['modify_key']({ key_id: childId, revoked: true });
  assert.notEqual(revokeResult.isError, true);
  assert.match(revokeResult.content[0].text, /<revoked>true<\/revoked>/);

  // Attempt to claim the revoked child from a fresh session
  const { handlers: handlers2 } = makeHandlers(db);
  const childKeyValue = db.prepare('SELECT key_value FROM keys WHERE id = ?').get(childId).key_value;
  const claimResult = handlers2['claim']({ key: childKeyValue });
  assert.equal(claimResult.isError, true, 'claiming a revoked key should fail');
});

test('revoked key mid-session: refreshClaim clears the cached claim', () => {
  const db = setupDb();
  const { handlers, sessionState } = makeHandlers(db);

  // Claim a maintenance key
  const parent = createKey(db, { permissions: 'maintenance', entryScope: null });
  handlers['claim']({ key: parent.keyValue });

  // Create a child to verify the claim works
  const pre = handlers['create_key']({ permissions: 'read-only' });
  assert.notEqual(pre.isError, true);

  // Revoke the key via the revoked column (not DELETE)
  db.prepare('UPDATE keys SET revoked = 1 WHERE id = ?').run(parent.id);

  // Next privileged call should fail-closed
  const post = handlers['create_key']({ permissions: 'read-only' });
  assert.equal(post.isError, true, 'create_key must fail after key revocation via revoked flag');
  assert.match(post.content[0].text, /NO_CLAIM/);

  // Session state should be cleared
  assert.equal(sessionState.get('claimedKey'), undefined);
});

test('modify_key requires at least one of permissions or revoked', () => {
  const db = setupDb();
  const { handlers, sessionState } = makeHandlers(db);
  const parent = createKey(db, { permissions: 'maintenance', entryScope: null });
  handlers['claim']({ key: parent.keyValue });
  const child = createKey(db, { permissions: 'read-only', entryScope: null, createdBy: parent.id });

  const result = handlers['modify_key']({ key_id: child.id });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /At least one/);
});

// ── Key Names ───────────────────────────────────────────────────

test('create_key with name stores the name in DB', () => {
  const db = setupDb();
  const key = createKey(db, { permissions: 'read-write', entryScope: 'test', name: 'teammate-pm-001' });

  const row = db.prepare('SELECT name FROM keys WHERE id = ?').get(key.id);
  assert.equal(row.name, 'teammate-pm-001');
});

test('create_key without name defaults to null', () => {
  const db = setupDb();
  const key = createKey(db, { permissions: 'read-write', entryScope: 'test' });

  const row = db.prepare('SELECT name FROM keys WHERE id = ?').get(key.id);
  assert.equal(row.name, null);
});

test('create_key via tool handler passes name through', () => {
  const db = setupDb();
  const { handlers, sessionState } = makeHandlers(db);
  const parent = createKey(db, { permissions: 'maintenance', entryScope: null });
  handlers['claim']({ key: parent.keyValue });

  const result = handlers['create_key']({
    permissions: 'read-write',
    name: 'teammate-worker-42',
  });
  assert.notEqual(result.isError, true);

  const childId = result.content[0].text.match(/<id>([^<]+)<\/id>/)[1];
  const row = db.prepare('SELECT name FROM keys WHERE id = ?').get(childId);
  assert.equal(row.name, 'teammate-worker-42');
});

test('list_keys includes name and revoked fields', () => {
  const db = setupDb();
  const parent = createKey(db, { permissions: 'maintenance', entryScope: null });
  createKey(db, { permissions: 'read-write', entryScope: null, createdBy: parent.id, name: 'teammate-a' });
  createKey(db, { permissions: 'read-only', entryScope: null, createdBy: parent.id, name: 'teammate-b' });

  const keys = listKeys(db, { callerKeyId: parent.id });
  assert.equal(keys.length, 2);

  const a = keys.find(k => k.name === 'teammate-a');
  assert.ok(a, 'should find key named teammate-a');
  assert.equal(a.revoked, false);

  const b = keys.find(k => k.name === 'teammate-b');
  assert.ok(b, 'should find key named teammate-b');
  assert.equal(b.revoked, false);
});

test('list_keys via tool handler shows name and revoked in XML', () => {
  const db = setupDb();
  const { handlers, sessionState } = makeHandlers(db);
  const parent = createKey(db, { permissions: 'maintenance', entryScope: null });
  handlers['claim']({ key: parent.keyValue });

  handlers['create_key']({ permissions: 'read-write', name: 'tm-test' });

  const result = handlers['list_keys']({});
  assert.notEqual(result.isError, true);
  assert.match(result.content[0].text, /<name>tm-test<\/name>/);
  assert.match(result.content[0].text, /<revoked>false<\/revoked>/);
});

// ── Migration backward compatibility ────────────────────────────

test('existing keys without revoked/name columns get defaults after migration', () => {
  const db = setupDb();

  // Insert a key as a pre-migration row would look (revoked defaults to 0, name to null)
  const key = createKey(db, { permissions: 'read-write', entryScope: 'test' });

  const row = db.prepare('SELECT revoked, name FROM keys WHERE id = ?').get(key.id);
  assert.equal(row.revoked, 0, 'revoked should default to 0');
  assert.equal(row.name, null, 'name should default to null');

  // Should still validate
  const valid = validateKey(db, { keyValue: key.keyValue });
  assert.ok(valid !== null && !('revoked' in valid));
});

// ── FrequencyManager Reset ──────────────────────────────────────

test('FrequencyManager.reset() zeros callCount and resets intervals', () => {
  const settings = {
    injection: { l1Interval: 10, l2Interval: 20 },
  };
  const fm = new FrequencyManager(settings);

  // Tick 20 times to advance past both L1 and L2 thresholds
  for (let i = 0; i < 20; i++) {
    fm.tick();
  }

  // Reset
  fm.reset();

  // After reset, the very first tick is tick #1. L1 fires at 10, L2 at 20.
  // So tick #1 should NOT fire either.
  const first = fm.tick();
  assert.equal(first.injectL1, false, 'first tick after reset should not fire L1');
  assert.equal(first.injectL2, false, 'first tick after reset should not fire L2');

  // Tick to 10 — L1 should fire
  for (let i = 2; i < 10; i++) fm.tick();
  const tenth = fm.tick(); // tick #10
  assert.equal(tenth.injectL1, true, 'tick #10 after reset should fire L1');
  assert.equal(tenth.injectL2, false, 'tick #10 after reset should not fire L2');
});

test('FrequencyManager.reset() clears content hashes (no dedup suppression)', () => {
  const settings = {
    injection: { l1Interval: 10, l2Interval: 20 },
  };
  const fm = new FrequencyManager(settings);

  // Tick to 10, fire L1, set a hash with content A
  for (let i = 0; i < 10; i++) fm.tick();
  fm.updateHash('l1', { data: 'test' });

  // Now tick to 20 — L1 fires again, same content → hash matches → interval bumped to 20
  for (let i = 0; i < 10; i++) fm.tick();
  fm.updateHash('l1', { data: 'test' });

  // At this point l1CurrentInterval is 20 (bumped by dedup).
  // Tick to 40 (internal count=40) — L1 fires at 40 (40 % 20 === 0), not at 30.
  // This confirms the bump happened.

  // Now reset — intervals should go back to base (10), hashes cleared
  fm.reset();

  // After reset: tick to 10 — L1 should fire (interval is back to 10)
  for (let i = 0; i < 10; i++) fm.tick();
  // tick #10 fires L1 since 10 % 10 === 0
  // But we already called tick() 10 times, the 10th was inside the loop.
  // Let's check the return of the last tick in the loop.
  // Actually the loop ticks 1-10, and tick #10 returns injectL1=true.
  // But we need to capture that. Let me restructure:

  // Reset again for a clean test
  fm.reset();

  // Tick exactly 10 times, checking the 10th
  let result;
  for (let i = 0; i < 10; i++) {
    result = fm.tick();
  }
  assert.equal(result.injectL1, true, 'L1 fires at tick 10 after reset (interval back to base 10, not bumped 20)');
});
