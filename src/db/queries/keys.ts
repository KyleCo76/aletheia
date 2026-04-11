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
