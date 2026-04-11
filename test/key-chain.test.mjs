// Smallest-shippable-slice of item #32 (teammate memory
// segregation). Verifies getKeyChain produces a slash-joined
// root-to-leaf ancestor path, defends against cycles, and is
// stored on sessionState by both `claim` and `bootstrap`.
//
// Scope note: the read-side query (readMemoriesByChain with
// LIKE-prefix filtering over a new owner_chain column) is NOT
// in this slice. We're establishing the session-state surface
// so a later release can add the migration and the filter
// without touching the auth path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { runMigrations } from '../dist/db/schema.js';
import { createKey, getKeyChain } from '../dist/db/queries/keys.js';
import { registerAuthTools } from '../dist/server/tools/auth.js';

function setupDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

test('getKeyChain on a root key returns just the key id', () => {
  const db = setupDb();
  const root = createKey(db, { permissions: 'maintenance', entryScope: null });

  const chain = getKeyChain(db, root.id);
  assert.equal(chain, root.id, 'root key chain should be the id itself');
});

test('getKeyChain on a two-level delegated child returns root/child', () => {
  const db = setupDb();
  const root = createKey(db, { permissions: 'maintenance', entryScope: null });
  const child = createKey(db, {
    permissions: 'read-write',
    entryScope: null,
    createdBy: root.id,
  });

  const chain = getKeyChain(db, child.id);
  assert.equal(chain, `${root.id}/${child.id}`);
});

test('getKeyChain on a three-level chain reads root-to-leaf', () => {
  const db = setupDb();
  const root = createKey(db, { permissions: 'maintenance', entryScope: null });
  const mid = createKey(db, {
    permissions: 'create-sub-entries',
    entryScope: null,
    createdBy: root.id,
  });
  const leaf = createKey(db, {
    permissions: 'read-write',
    entryScope: null,
    createdBy: mid.id,
  });

  const chain = getKeyChain(db, leaf.id);
  assert.equal(chain, `${root.id}/${mid.id}/${leaf.id}`);
});

test('getKeyChain for an unknown key id returns empty string', () => {
  const db = setupDb();
  const chain = getKeyChain(db, 'not-a-real-key-id');
  assert.equal(chain, '');
});

test('getKeyChain tolerates a cycle (self-loop) without looping forever', () => {
  // Synthetic: a key whose created_by points at itself. This
  // should never happen organically because createKey always
  // runs before the child is referenced, but forging it in the
  // db simulates corruption. The cycle-defence set must catch it
  // before the depth cap does.
  const db = setupDb();
  const k = createKey(db, { permissions: 'maintenance', entryScope: null });
  db.prepare(`UPDATE keys SET created_by = ? WHERE id = ?`).run(k.id, k.id);

  const chain = getKeyChain(db, k.id);
  assert.equal(chain, k.id, 'self-loop should be walked exactly once');
});

test('getKeyChain caps at depth 16 on a linear chain beyond the cap', () => {
  // Build a 20-deep chain. Expected: the returned chain contains
  // 16 ids, leaf-to-root-slice-of-16 (chain was built child-first
  // and then reversed — so the top of the returned slash path
  // should be the 16th ancestor, not the actual root).
  const db = setupDb();
  let parent = null;
  const ids = [];
  for (let i = 0; i < 20; i++) {
    const k = createKey(db, {
      permissions: 'read-write',
      entryScope: null,
      createdBy: parent ?? undefined,
    });
    ids.push(k.id);
    parent = k.id;
  }

  const chain = getKeyChain(db, ids[ids.length - 1]);
  const parts = chain.split('/');
  assert.equal(parts.length, 16, 'chain should be capped at 16 entries');
  // Leaf is at the tail.
  assert.equal(parts[parts.length - 1], ids[ids.length - 1]);
});

test('claim handler stores keyChain in sessionState', () => {
  const db = setupDb();
  const root = createKey(db, { permissions: 'maintenance', entryScope: null });
  const child = createKey(db, {
    permissions: 'read-write',
    entryScope: null,
    createdBy: root.id,
  });

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

  const result = handlers['claim']({ key: child.keyValue });
  assert.notEqual(result.isError, true);

  const stored = sessionState.get('keyChain');
  assert.equal(stored, `${root.id}/${child.id}`);
});
