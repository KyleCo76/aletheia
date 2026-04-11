import type Database from 'better-sqlite3';
import crypto from 'crypto';

export const PERMISSIONS_HIERARCHY = ['read-only', 'read-write', 'create-sub-entries', 'maintenance'] as const;
export type Permission = typeof PERMISSIONS_HIERARCHY[number];

export function permissionLevel(p: string): number {
  return PERMISSIONS_HIERARCHY.indexOf(p as Permission);
}

/**
 * Item #16 — cascading key delegation, axis 1 (permission level).
 *
 * Returns true iff a parent with `parentPermissions` is allowed to
 * mint a child with `childPermissions`. Children must be at or below
 * the parent's level (denials only grow). Unknown permission strings
 * always return false — fail closed.
 *
 * The dual of this rule for in-place modifications already lives in
 * `modifyKey` (see the `targetLevel >= callerLevel` check below); this
 * helper exists so the equivalent invariant can be enforced at create
 * time too, plugging the v0.1.x escalation hole where a
 * create-sub-entries holder could mint a maintenance key.
 */
export function canDelegatePermission(
  parentPermissions: string,
  childPermissions: string,
): boolean {
  const parentLevel = permissionLevel(parentPermissions);
  const childLevel = permissionLevel(childPermissions);
  if (parentLevel < 0 || childLevel < 0) return false;
  return childLevel <= parentLevel;
}

/**
 * Item #16 — cascading key delegation, axis 2 (entry scope).
 *
 * Returns true iff a parent with `parentScope` is allowed to mint a
 * child with `childScope`.
 *
 *   - A globally-scoped parent (parentScope === null) can delegate
 *     to any scope including null (full delegation).
 *   - A project-scoped parent can ONLY delegate to its own scope —
 *     no upward (to global), no lateral (to a different project).
 *     `undefined` from a tool args object is treated as null/global,
 *     so a scoped parent that omits entry_scope is treated as trying
 *     to escalate.
 */
export function canDelegateScope(
  parentScope: string | null,
  childScope: string | null | undefined,
): boolean {
  if (parentScope === null) return true; // global parent: anywhere
  // Scoped parent: child must match exactly. Both null/undefined and
  // a different string are rejected.
  return childScope === parentScope;
}

export function createKey(
  db: Database.Database,
  params: { permissions: string; entryScope?: string; createdBy?: string }
): { id: string; keyValue: string; permissions: string } {
  const id = crypto.randomUUID();
  const keyValue = crypto.randomBytes(32).toString('hex');

  db.prepare(
    `INSERT INTO keys (id, key_value, permissions, entry_scope, created_by)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, keyValue, params.permissions, params.entryScope ?? null, params.createdBy ?? null);

  return { id, keyValue, permissions: params.permissions };
}

/**
 * Smallest shippable slice of item #32 (teammate memory
 * segregation). Walks the `keys.created_by` chain upward from a
 * given key id and returns a slash-joined ancestor path from the
 * root down to the key itself.
 *
 * For a root key with no parent, returns the key's own id. For a
 * key created by parent P which was created by root R, returns
 * `R/P/id`. Meant to be stored on `sessionState` at claim time
 * and read by future injection builders (owner_chain migration
 * pending; see docs/v0.2.0-design/teammate-segregation.md).
 *
 * Cycle defence:
 *   - Depth cap of 16 — more than any realistic PM hierarchy. A
 *     longer chain is almost certainly a data corruption bug;
 *     the function stops walking and returns the prefix it has.
 *   - Visited-id set catches literal cycles (a key pointing to
 *     itself through any number of intermediate hops).
 *
 * Unknown key id (not in `keys` table): returns an empty string.
 * Caller should treat that the same as "no claim / no chain".
 */
const KEY_CHAIN_MAX_DEPTH = 16;

export function getKeyChain(db: Database.Database, keyId: string): string {
  const stmt = db.prepare(`SELECT id, created_by FROM keys WHERE id = ?`);
  const chain: string[] = [];
  const visited = new Set<string>();

  let currentId: string | null = keyId;
  while (currentId && chain.length < KEY_CHAIN_MAX_DEPTH) {
    if (visited.has(currentId)) break; // literal cycle
    visited.add(currentId);

    const row = stmt.get(currentId) as
      | { id: string; created_by: string | null }
      | undefined;
    if (!row) {
      // Unknown key id encountered mid-walk. Abandon the rest of
      // the chain — this typically means the key was deleted
      // after a session started. Return whatever prefix we built.
      break;
    }

    chain.push(row.id);
    currentId = row.created_by;
  }

  // We built the chain child-first; reverse so the root is at
  // the head. Format matches the design doc's owner_chain column.
  return chain.reverse().join('/');
}

export function validateKey(
  db: Database.Database,
  params: { keyValue: string }
): { id: string; permissions: string; entryScope: string | null } | null {
  const row = db.prepare(
    `SELECT id, permissions, entry_scope FROM keys WHERE key_value = ?`
  ).get(params.keyValue) as
    | { id: string; permissions: string; entry_scope: string | null }
    | undefined;

  if (!row) return null;

  return { id: row.id, permissions: row.permissions, entryScope: row.entry_scope };
}

export function modifyKey(
  db: Database.Database,
  params: { keyId: string; permissions: string; callerPermissions: string }
): { id: string; permissions: string } | { error: string } {
  const callerLevel = permissionLevel(params.callerPermissions);
  const targetLevel = permissionLevel(params.permissions);

  if (targetLevel >= callerLevel) {
    return { error: 'Cannot set permissions at or above caller scope' };
  }

  const existing = db.prepare(`SELECT id, permissions FROM keys WHERE id = ?`).get(params.keyId) as
    | { id: string; permissions: string }
    | undefined;

  if (!existing) {
    return { error: 'Key not found' };
  }

  const existingLevel = permissionLevel(existing.permissions);
  if (existingLevel >= callerLevel) {
    return { error: 'Cannot modify key at or above caller scope' };
  }

  db.prepare(`UPDATE keys SET permissions = ? WHERE id = ?`).run(params.permissions, params.keyId);

  return { id: params.keyId, permissions: params.permissions };
}

export function listKeys(
  db: Database.Database,
  params: { callerKeyId?: string }
): Array<{ id: string; permissions: string; entryScope: string | null; createdAt: string }> {
  if (params.callerKeyId) {
    const caller = db.prepare(`SELECT permissions FROM keys WHERE id = ?`).get(params.callerKeyId) as
      | { permissions: string }
      | undefined;

    if (!caller) return [];

    const callerLevel = permissionLevel(caller.permissions);
    const belowPermissions = PERMISSIONS_HIERARCHY.filter(
      (_, i) => i < callerLevel
    );

    if (belowPermissions.length === 0) return [];

    const placeholders = belowPermissions.map(() => '?').join(', ');
    const rows = db.prepare(
      `SELECT id, permissions, entry_scope, created_at FROM keys
       WHERE permissions IN (${placeholders})`
    ).all(...belowPermissions) as Array<{
      id: string;
      permissions: string;
      entry_scope: string | null;
      created_at: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      permissions: r.permissions,
      entryScope: r.entry_scope,
      createdAt: r.created_at,
    }));
  }

  const rows = db.prepare(
    `SELECT id, permissions, entry_scope, created_at FROM keys`
  ).all() as Array<{
    id: string;
    permissions: string;
    entry_scope: string | null;
    created_at: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    permissions: r.permissions,
    entryScope: r.entry_scope,
    createdAt: r.created_at,
  }));
}
