// Tests for the v0.2.0 tool response format module (item #31).
//
// The response-format module is the single source of truth for the
// shape and error-code vocabulary of MCP tool responses. These tests
// pin the contract:
//   - ERROR_CODES is exported as an enumerable list (not buried in
//     types-only TypeScript that gets erased at runtime).
//   - isKnownErrorCode acts as a runtime guard for callers and tests.
//   - toolError produces the wire-compatible {content, isError} shape
//     that the MCP SDK expects, and the embedded XML body uses the
//     existing formatError encoding so v0.1.x consumers don't need to
//     change anything.
//   - Every error path in the migrated status tools (the v0.2.0
//     pilot module) emits a code that is in ERROR_CODES — no
//     free-string codes survive the migration.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';

import {
  ERROR_CODES,
  isKnownErrorCode,
  toolError,
} from '../dist/server/tools/response-format.js';
import { runMigrations } from '../dist/db/schema.js';
import { registerStatusTools } from '../dist/server/tools/status.js';

test('ERROR_CODES is a non-empty exported list of the v0.1.x core codes', () => {
  assert.ok(Array.isArray(ERROR_CODES), 'ERROR_CODES should be an array');
  assert.ok(ERROR_CODES.length >= 10, 'ERROR_CODES should be non-trivial');
  for (const expected of [
    'INVALID_INPUT',
    'MISSING_FIELD',
    'NOT_FOUND',
    'NO_CLAIM',
    'INVALID_KEY',
    'INSUFFICIENT_PERMISSIONS',
    'CIRCUIT_BREAKER',
    'VERSION_CONFLICT',
    'CONTENT_TOO_LARGE',
  ]) {
    assert.ok(
      ERROR_CODES.includes(expected),
      `ERROR_CODES should include ${expected}`,
    );
  }
});

test('isKnownErrorCode returns true for enum members and false otherwise', () => {
  assert.equal(isKnownErrorCode('NOT_FOUND'), true);
  assert.equal(isKnownErrorCode('INVALID_INPUT'), true);
  assert.equal(isKnownErrorCode('TOTALLY_FAKE_CODE_xyz'), false);
  assert.equal(isKnownErrorCode(''), false);
});

test('toolError produces a wire-compatible {content, isError:true} response', () => {
  const r = toolError('NOT_FOUND', 'thing missing');
  assert.equal(r.isError, true);
  assert.equal(Array.isArray(r.content), true);
  assert.equal(r.content.length, 1);
  assert.equal(r.content[0].type, 'text');
  assert.match(r.content[0].text, /code="NOT_FOUND"/);
  assert.match(r.content[0].text, /thing missing/);
});

// Integration: every error path the migrated status tools take must
// emit a code that's in ERROR_CODES. This is the regression check
// that catches a future "let me add a quick custom code here" that
// bypasses the response-format module.

function setupDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  const entryId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO entries (id, entry_class, project_namespace) VALUES (?, 'status', 'test-proj')`,
  ).run(entryId);

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
  registerStatusTools(handlers, db, settings, sessionState);
  return handlers;
}

function extractErrorCode(text) {
  const m = text.match(/code="([^"]+)"/);
  return m ? m[1] : null;
}

test('migrated status tools emit only known ERROR_CODES on every error path', () => {
  const { db, entryId } = setupDb();
  const handlers = makeHandlers(db);

  // 1. read_status missing entry_id  → INVALID_INPUT
  // 2. read_status on nonexistent doc → NOT_FOUND
  // 3. replace_status missing fields  → INVALID_INPUT
  // 4. update_status missing fields   → INVALID_INPUT
  // 5. update_status no doc           → NOT_FOUND
  // 6. add_section missing fields     → INVALID_INPUT
  // 7. add_section no doc             → NOT_FOUND
  // 8. remove_section missing fields  → INVALID_INPUT
  // 9. remove_section no doc          → NOT_FOUND
  const errorCalls = [
    handlers['read_status']({}),
    handlers['read_status']({ entry_id: 'nope' }),
    handlers['replace_status']({}),
    handlers['update_status']({}),
    handlers['update_status']({ entry_id: 'nope', section_id: 'x' }),
    handlers['add_section']({}),
    handlers['add_section']({ entry_id: 'nope', section_id: 'x', content: 'c' }),
    handlers['remove_section']({}),
    handlers['remove_section']({ entry_id: 'nope', section_id: 'x' }),
  ];

  for (const r of errorCalls) {
    assert.equal(r.isError, true, 'expected an error response');
    const code = extractErrorCode(r.content[0].text);
    assert.ok(code, `error response should embed code="..." attribute: ${r.content[0].text}`);
    assert.ok(
      isKnownErrorCode(code),
      `error code ${code} must be in ERROR_CODES (response: ${r.content[0].text})`,
    );
  }

  // Spot-check the bug #27 path uses NOT_FOUND specifically and names
  // the missing section, since that's the v0.1.2 fix being preserved.
  const statusEntry = entryId;
  // Create a status doc + section so we can target a missing-section.
  const statusId = crypto.randomUUID();
  const versionId = crypto.randomBytes(8).toString('hex');
  db.prepare(
    `INSERT INTO status_documents (id, entry_id, content, version_id) VALUES (?, ?, ?, ?)`,
  ).run(statusId, statusEntry, 'body', versionId);
  db.prepare(
    `INSERT INTO status_sections (id, status_id, section_id, content, position) VALUES (?, ?, ?, ?, ?)`,
  ).run(crypto.randomUUID(), statusId, 'real', 'c', 0);

  const r = handlers['update_status']({
    entry_id: statusEntry,
    section_id: 'fake-id',
    state: 'done',
  });
  assert.equal(r.isError, true);
  assert.equal(extractErrorCode(r.content[0].text), 'NOT_FOUND');
  assert.match(r.content[0].text, /fake-id/);
});
