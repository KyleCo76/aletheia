// Round-3 regression test for the circuit-breaker bulk-write
// bypass paths discovered during the P2 investigation in
// task-bughunt-round3.md.
//
// Two stacking bypasses existed in v0.2.4:
//
//   1. Tag bombing. write_journal / write_memory / create_entry
//      accepted unbounded `tags: string[]` arrays. addTags inserts
//      2 rows per tag (one in `tags` if new, one in `entry_tags`).
//      A single call counted as 1 write against the breaker but
//      could mutate 200+ rows by stuffing 100 tags. Closed by a
//      MAX_TAGS_PER_CALL=32 cap in lib/errors.ts +
//      validateTagCount() called from each affected handler.
//
//   2. Unguarded mutating handlers. Only write_journal,
//      write_memory, and replace_status were subject to the
//      breaker. The other 7 mutating handlers — create_entry,
//      promote_to_memory, retire_memory, update_status,
//      add_section, remove_section, create_handoff — bypassed
//      the breaker entirely. A session could mint unlimited
//      entries / retirements / sections / handoffs without ever
//      tripping the limit. Closed by adding the standard
//      checkGeneralCircuitBreaker + recordWrite pair to each.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';

import { runMigrations } from '../dist/db/schema.js';
import { registerJournalTools } from '../dist/server/tools/journal.js';
import { registerMemoryTools } from '../dist/server/tools/memory.js';
import { registerEntryTools } from '../dist/server/tools/entries.js';
import { registerStatusTools } from '../dist/server/tools/status.js';
import { registerHandoffTools } from '../dist/server/tools/handoff.js';
import { MAX_TAGS_PER_CALL } from '../dist/lib/errors.js';

function setupDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function makeHandlers(db, writeLimit = 5) {
  // Use a small writeLimit so the breaker trips quickly in tests
  // without having to spam hundreds of calls.
  const handlers = {};
  const sessionState = new Map();
  const settings = {
    permissions: { enforce: false },
    digest: { criticalWriteCap: 3 },
    limits: {
      circuitBreakerWritesPerInterval: writeLimit,
      circuitBreakerIntervalMinutes: 5,
      criticalWriteCap: 3,
    },
  };
  registerJournalTools(handlers, db, settings, sessionState);
  registerMemoryTools(handlers, db, settings, sessionState);
  registerEntryTools(handlers, db, settings, sessionState);
  registerStatusTools(handlers, db, settings, sessionState);
  registerHandoffTools(handlers, db, settings, sessionState);
  // Provide a project namespace so create_entry doesn't prompt.
  sessionState.set('projectNamespace', 'test-proj');
  return { handlers, sessionState };
}

function seedEntry(db, entryClass) {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO entries (id, entry_class, project_namespace) VALUES (?, ?, 'test-proj')`,
  ).run(id, entryClass);
  return id;
}

// ---------- Bypass 1: tag bombing ----------

test('write_journal rejects more than MAX_TAGS_PER_CALL tags', () => {
  const { handlers } = makeHandlers(setupDb());
  const entryId = seedEntry(setupDb(), 'journal');
  // Need a fresh db whose handler matches the entry. Re-do.
  const db = setupDb();
  const { handlers: h } = makeHandlers(db);
  const eid = seedEntry(db, 'journal');

  const tooMany = Array.from({ length: MAX_TAGS_PER_CALL + 1 }, (_, i) => `t${i}`);
  const r = h['write_journal']({
    entry_id: eid,
    content: 'tag bomb',
    tags: tooMany,
  });

  assert.equal(r.isError, true, 'tag-bomb write_journal must be rejected');
  assert.match(r.content[0].text, /INVALID_INPUT/);
  assert.match(r.content[0].text, /tags array exceeds maximum/);
});

test('write_journal accepts exactly MAX_TAGS_PER_CALL tags (boundary)', () => {
  const db = setupDb();
  const { handlers } = makeHandlers(db, 100);
  const entryId = seedEntry(db, 'journal');

  const exactly = Array.from({ length: MAX_TAGS_PER_CALL }, (_, i) => `t${i}`);
  const r = handlers['write_journal']({
    entry_id: entryId,
    content: 'just at the cap',
    tags: exactly,
  });

  assert.notEqual(r.isError, true, `${MAX_TAGS_PER_CALL} tags should be accepted`);
});

test('write_memory rejects tag bombing', () => {
  const db = setupDb();
  const { handlers } = makeHandlers(db);
  const entryId = seedEntry(db, 'memory');

  const r = handlers['write_memory']({
    entry_id: entryId,
    key: 'k',
    value: 'v',
    tags: Array.from({ length: 100 }, (_, i) => `t${i}`),
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /INVALID_INPUT/);
});

test('create_entry rejects tag bombing', () => {
  const db = setupDb();
  const { handlers } = makeHandlers(db);

  const r = handlers['create_entry']({
    entry_class: 'journal',
    tags: Array.from({ length: 50 }, (_, i) => `t${i}`),
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /INVALID_INPUT/);
});

// ---------- Bypass 2: unguarded mutating handlers ----------

test('create_entry IS now subject to the circuit breaker (was bypass in v0.2.4)', () => {
  // Default writeLimit=5. The 6th create_entry call must be
  // blocked by the breaker; pre-fix it would have succeeded
  // because create_entry never called recordWrite at all.
  const db = setupDb();
  const { handlers } = makeHandlers(db, 5);

  for (let i = 0; i < 5; i++) {
    const r = handlers['create_entry']({ entry_class: 'journal' });
    assert.notEqual(r.isError, true, `call ${i} should succeed`);
  }

  const blocked = handlers['create_entry']({ entry_class: 'journal' });
  assert.equal(blocked.isError, true, 'call 6 should be breaker-blocked');
  assert.match(blocked.content[0].text, /CIRCUIT_BREAKER/);
});

test('retire_memory IS now subject to the circuit breaker', () => {
  const db = setupDb();
  const { handlers } = makeHandlers(db, 3);

  // Seed three memories so we have something to retire.
  const memIds = [];
  for (let i = 0; i < 4; i++) {
    const entryId = seedEntry(db, 'memory');
    const memId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO memory_entries (id, entry_id, key, value, version_id) VALUES (?, ?, ?, ?, ?)`,
    ).run(memId, entryId, `k${i}`, `v${i}`, 'vid');
    memIds.push({ entryId, memId });
  }

  for (let i = 0; i < 3; i++) {
    const r = handlers['retire_memory']({
      entry_id: memIds[i].entryId,
      memory_entry_id: memIds[i].memId,
    });
    assert.notEqual(r.isError, true, `retire ${i} should succeed`);
  }

  const blocked = handlers['retire_memory']({
    entry_id: memIds[3].entryId,
    memory_entry_id: memIds[3].memId,
  });
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /CIRCUIT_BREAKER/);
});

test('add_section IS now subject to the circuit breaker', () => {
  const db = setupDb();
  const { handlers } = makeHandlers(db, 3);

  // Seed a status doc so add_section has somewhere to go.
  const entryId = seedEntry(db, 'status');
  const statusId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO status_documents (id, entry_id, content, version_id) VALUES (?, ?, '', 'vid')`,
  ).run(statusId, entryId);

  for (let i = 0; i < 3; i++) {
    const r = handlers['add_section']({
      entry_id: entryId,
      section_id: `s${i}`,
      content: `body ${i}`,
    });
    assert.notEqual(r.isError, true, `add ${i} should succeed`);
  }

  const blocked = handlers['add_section']({
    entry_id: entryId,
    section_id: 'overflow',
    content: 'body',
  });
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /CIRCUIT_BREAKER/);
});

test('create_handoff IS now subject to the circuit breaker', () => {
  const db = setupDb();
  const { handlers } = makeHandlers(db, 2);

  for (let i = 0; i < 2; i++) {
    const r = handlers['create_handoff']({
      target_key: `key-${i}`,
      content: 'note',
    });
    assert.notEqual(r.isError, true);
  }

  const blocked = handlers['create_handoff']({
    target_key: 'key-overflow',
    content: 'note',
  });
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /CIRCUIT_BREAKER/);
});

test('promote_to_memory IS now subject to the circuit breaker', () => {
  const db = setupDb();
  const { handlers } = makeHandlers(db, 2);

  // Seed two journal entries so we have something to promote.
  const journalIds = [];
  for (let i = 0; i < 3; i++) {
    const entryId = seedEntry(db, 'journal');
    const jid = crypto.randomUUID();
    db.prepare(
      `INSERT INTO journal_entries (id, entry_id, content) VALUES (?, ?, ?)`,
    ).run(jid, entryId, `journal ${i}`);
    journalIds.push(jid);
  }

  for (let i = 0; i < 2; i++) {
    const r = handlers['promote_to_memory']({
      journal_id: journalIds[i],
      synthesized_knowledge: `distilled ${i}`,
      key: `prom${i}`,
    });
    assert.notEqual(r.isError, true);
  }

  const blocked = handlers['promote_to_memory']({
    journal_id: journalIds[2],
    synthesized_knowledge: 'overflow',
    key: 'overflow',
  });
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /CIRCUIT_BREAKER/);
});

// ---------- v0.2.9: default raised 20 → 100 + per-call bypass with
//                    permission gate.
//
// Bulk memory ingest workflows (PM-Lethe class ~800k-conversation
// subset promotion) blast through the old 20/5min default on
// bootstrap. The new default is 100/5min; runaway loops still trip.
// For workloads that legitimately exceed 100, a per-call
// `bypass_circuit_breaker: true` flag opts out — but only when the
// claimed key has create-sub-entries or maintenance permissions.
// Lower tiers (read-only, read-write) silently ignore the flag.

import { DEFAULTS } from '../dist/lib/constants.js';

test('default circuitBreakerWritesPerInterval is 100 (v0.2.9 loosened from 20)', () => {
  assert.equal(
    DEFAULTS.circuitBreakerWritesPerInterval,
    100,
    'v0.2.9 raised the default to 100/5min for PM-tier bulk ingest',
  );
  assert.equal(
    DEFAULTS.circuitBreakerIntervalMinutes,
    5,
    'interval unchanged',
  );
});

function makeHandlersWithClaim(db, permissions, writeLimit = 3) {
  // Variant of makeHandlers that pre-populates sessionState with a
  // claimed key at the requested permission level. enforce stays
  // false so claimGuard remains a no-op — we're testing the bypass
  // permission gate, which keys off sessionState.claimedKey
  // independently of enforce-mode.
  const handlers = {};
  const sessionState = new Map();
  const settings = {
    permissions: { enforce: false },
    digest: { criticalWriteCap: 3 },
    limits: {
      circuitBreakerWritesPerInterval: writeLimit,
      circuitBreakerIntervalMinutes: 5,
      criticalWriteCap: 3,
    },
  };
  registerJournalTools(handlers, db, settings, sessionState);
  registerMemoryTools(handlers, db, settings, sessionState);
  registerEntryTools(handlers, db, settings, sessionState);
  registerStatusTools(handlers, db, settings, sessionState);
  registerHandoffTools(handlers, db, settings, sessionState);
  sessionState.set('projectNamespace', 'test-proj');
  sessionState.set('claimedKey', {
    id: 'test-key-id',
    permissions,
    entryScope: null,
  });
  return { handlers, sessionState };
}

test('write_journal: bypass_circuit_breaker honored for maintenance claims', () => {
  const db = setupDb();
  const { handlers } = makeHandlersWithClaim(db, 'maintenance', 2);
  const entryId = seedEntry(db, 'journal');

  // Burn through the (small) limit
  for (let i = 0; i < 2; i++) {
    const r = handlers['write_journal']({ entry_id: entryId, content: `n${i}` });
    assert.notEqual(r.isError, true, `call ${i} should succeed`);
  }

  // Without bypass, next call trips
  const blocked = handlers['write_journal']({ entry_id: entryId, content: 'over' });
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /CIRCUIT_BREAKER/);

  // With bypass, the same call goes through
  const allowed = handlers['write_journal']({
    entry_id: entryId,
    content: 'bypass me',
    bypass_circuit_breaker: true,
  });
  assert.notEqual(allowed.isError, true, 'bypass must skip the breaker for maintenance');
});

test('write_memory: bypass_circuit_breaker honored for create-sub-entries claims', () => {
  const db = setupDb();
  const { handlers } = makeHandlersWithClaim(db, 'create-sub-entries', 2);
  const entryId = seedEntry(db, 'memory');

  for (let i = 0; i < 2; i++) {
    const r = handlers['write_memory']({
      entry_id: entryId, key: `k${i}`, value: `v${i}`,
    });
    assert.notEqual(r.isError, true);
  }

  const blocked = handlers['write_memory']({
    entry_id: entryId, key: 'over', value: 'over',
  });
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /CIRCUIT_BREAKER/);

  const allowed = handlers['write_memory']({
    entry_id: entryId,
    key: 'bypass',
    value: 'me',
    bypass_circuit_breaker: true,
  });
  assert.notEqual(allowed.isError, true, 'bypass must skip the breaker for create-sub-entries');
});

test('replace_status: bypass_circuit_breaker silently ignored for read-write claims', () => {
  const db = setupDb();
  const { handlers } = makeHandlersWithClaim(db, 'read-write', 2);

  // No pre-seeded status_doc — replace_status creates one on first
  // call (versionId is ignored when the doc doesn't exist), and we
  // chain subsequent version_id values from each result's XML.
  const entryId = seedEntry(db, 'status');

  function extractVersionId(result) {
    const m = result.content[0].text.match(/version_id="([^"]+)"/);
    return m ? m[1] : '';
  }

  // Burn through limit with replace_status itself.
  let versionId = '';
  for (let i = 0; i < 2; i++) {
    const r = handlers['replace_status']({
      entry_id: entryId, content: `c${i}`, version_id: versionId,
    });
    assert.notEqual(r.isError, true, `call ${i} should succeed`);
    versionId = extractVersionId(r);
  }

  // Asking for bypass at read-write level must NOT succeed —
  // the flag is silently ignored, throttle proceeds.
  const blocked = handlers['replace_status']({
    entry_id: entryId,
    content: 'over',
    version_id: versionId,
    bypass_circuit_breaker: true,
  });
  assert.equal(blocked.isError, true, 'read-write must not be able to bypass');
  assert.match(blocked.content[0].text, /CIRCUIT_BREAKER/);
});

test('write_journal: bypass_circuit_breaker silently ignored for read-only claims', () => {
  const db = setupDb();
  const { handlers } = makeHandlersWithClaim(db, 'read-only', 1);
  const entryId = seedEntry(db, 'journal');

  // One successful write to exhaust the (tiny) limit.
  const r1 = handlers['write_journal']({ entry_id: entryId, content: 'first' });
  assert.notEqual(r1.isError, true);

  // Bypass attempt at read-only must still get throttled.
  const blocked = handlers['write_journal']({
    entry_id: entryId,
    content: 'sneaky',
    bypass_circuit_breaker: true,
  });
  assert.equal(blocked.isError, true, 'read-only must not be able to bypass');
  assert.match(blocked.content[0].text, /CIRCUIT_BREAKER/);
});

test('bypass_circuit_breaker: omitted / false behaves identically (no implicit bypass)', () => {
  const db = setupDb();
  const { handlers } = makeHandlersWithClaim(db, 'maintenance', 2);
  const entryId = seedEntry(db, 'journal');

  for (let i = 0; i < 2; i++) {
    const r = handlers['write_journal']({ entry_id: entryId, content: `n${i}` });
    assert.notEqual(r.isError, true);
  }

  // Explicitly false — should still trip.
  const blockedFalse = handlers['write_journal']({
    entry_id: entryId,
    content: 'no bypass',
    bypass_circuit_breaker: false,
  });
  assert.equal(blockedFalse.isError, true);
  assert.match(blockedFalse.content[0].text, /CIRCUIT_BREAKER/);

  // Omitted — should also trip (same behavior as false).
  const blockedOmit = handlers['write_journal']({
    entry_id: entryId,
    content: 'no bypass',
  });
  assert.equal(blockedOmit.isError, true);
});
