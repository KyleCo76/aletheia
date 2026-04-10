import type Database from 'better-sqlite3';
import crypto from 'crypto';

const PERMISSIONS_HIERARCHY = ['read-only', 'read-write', 'create-sub-entries', 'maintenance'] as const;
type Permission = typeof PERMISSIONS_HIERARCHY[number];

function permissionLevel(p: string): number {
  return PERMISSIONS_HIERARCHY.indexOf(p as Permission);
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
