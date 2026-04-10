import type Database from 'better-sqlite3';
import crypto from 'crypto';

export function writeMemory(
  db: Database.Database,
  params: {
    entryId: string;
    key: string;
    value: string;
    versionId?: string;
    enforcePermissions?: boolean;
    supersedes?: string;
  }
): { id: string; versionId: string; created: boolean } | { conflict: true; currentVersionId: string; currentValue: string } {
  return db.transaction(() => {
    const existing = db.prepare(
      `SELECT id, value, version_id FROM memory_entries
       WHERE entry_id = ? AND key = ? AND archived_at IS NULL`
    ).get(params.entryId, params.key) as
      | { id: string; value: string; version_id: string }
      | undefined;

    if (existing) {
      if (params.enforcePermissions && params.versionId) {
        if (params.versionId !== existing.version_id) {
          return {
            conflict: true as const,
            currentVersionId: existing.version_id,
            currentValue: existing.value,
          };
        }
      }

      // Save previous value to memory_versions
      const versionRecordId = crypto.randomUUID();
      db.prepare(
        `INSERT INTO memory_versions (id, memory_entry_id, previous_value, previous_version_id)
         VALUES (?, ?, ?, ?)`
      ).run(versionRecordId, existing.id, existing.value, existing.version_id);

      const newVersionId = crypto.randomBytes(8).toString('hex');
      db.prepare(
        `UPDATE memory_entries SET value = ?, version_id = ?, updated_at = datetime('now')
         WHERE id = ?`
      ).run(params.value, newVersionId, existing.id);

      if (params.supersedes) {
        db.prepare(
          `UPDATE memory_entries SET archived_at = datetime('now'), superseded_by = ? WHERE id = ?`
        ).run(existing.id, params.supersedes);
      }

      return { id: existing.id, versionId: newVersionId, created: false };
    }

    // New entry
    const id = crypto.randomUUID();
    const versionId = crypto.randomBytes(8).toString('hex');
    db.prepare(
      `INSERT INTO memory_entries (id, entry_id, key, value, version_id)
       VALUES (?, ?, ?, ?, ?)`
    ).run(id, params.entryId, params.key, params.value, versionId);

    if (params.supersedes) {
      db.prepare(
        `UPDATE memory_entries SET archived_at = datetime('now'), superseded_by = ? WHERE id = ?`
      ).run(id, params.supersedes);
    }

    return { id, versionId, created: true };
  }).immediate();
}

export function readMemory(
  db: Database.Database,
  params: { entryId: string; key?: string }
): Array<{ id: string; key: string; value: string; versionId: string; updatedAt: string }> {
  const conditions: string[] = ['entry_id = ?', 'archived_at IS NULL'];
  const bindings: unknown[] = [params.entryId];

  if (params.key) {
    conditions.push('key = ?');
    bindings.push(params.key);
  }

  const sql = `SELECT id, key, value, version_id, updated_at
               FROM memory_entries
               WHERE ${conditions.join(' AND ')}`;

  const rows = db.prepare(sql).all(...bindings) as Array<{
    id: string;
    key: string;
    value: string;
    version_id: string;
    updated_at: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    value: r.value,
    versionId: r.version_id,
    updatedAt: r.updated_at,
  }));
}

export function retireMemory(
  db: Database.Database,
  params: { entryId: string; memoryEntryId: string; reason?: string }
): { retired: true } {
  db.transaction(() => {
    db.prepare(
      `UPDATE memory_entries SET archived_at = datetime('now') WHERE id = ?`
    ).run(params.memoryEntryId);

    if (params.reason) {
      const journalId = crypto.randomUUID();
      db.prepare(
        `INSERT INTO journal_entries (id, entry_id, content)
         VALUES (?, ?, ?)`
      ).run(journalId, params.entryId, params.reason);
    }
  }).immediate();

  return { retired: true };
}

export function searchMemory(
  db: Database.Database,
  params: { entryId?: string; query?: string; tags?: string[]; includeArchived?: boolean }
): Array<{ id: string; key: string; value: string; versionId: string; updatedAt: string }> {
  const conditions: string[] = [];
  const bindings: unknown[] = [];

  if (!params.includeArchived) {
    conditions.push('m.archived_at IS NULL');
  }

  if (params.entryId) {
    conditions.push('m.entry_id = ?');
    bindings.push(params.entryId);
  }

  if (params.query) {
    conditions.push('(m.key LIKE ? OR m.value LIKE ?)');
    bindings.push(`%${params.query}%`, `%${params.query}%`);
  }

  let joinClause = '';
  let groupByClause = '';
  let havingClause = '';
  if (params.tags && params.tags.length > 0) {
    joinClause = `
      JOIN entry_tags et ON m.entry_id = et.entry_id
      JOIN tags t ON et.tag_id = t.id`;
    const placeholders = params.tags.map(() => '?').join(', ');
    conditions.push(`t.name IN (${placeholders})`);
    bindings.push(...params.tags);
    groupByClause = 'GROUP BY m.id';
    havingClause = 'HAVING COUNT(DISTINCT t.id) = ?';
    bindings.push(params.tags.length);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const sql = `SELECT m.id, m.key, m.value, m.version_id, m.updated_at
               FROM memory_entries m
               ${joinClause}
               ${where}
               ${groupByClause}
               ${havingClause}`;

  const rows = db.prepare(sql).all(...bindings) as Array<{
    id: string;
    key: string;
    value: string;
    version_id: string;
    updated_at: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    value: r.value,
    versionId: r.version_id,
    updatedAt: r.updated_at,
  }));
}

export function readMemoryHistory(
  db: Database.Database,
  params: { entryId: string; key: string; limit?: number }
): Array<{ value: string; versionId: string; changedAt: string }> {
  const limit = params.limit ?? 10;

  // First get the current entry
  const current = db.prepare(
    `SELECT id, value, version_id, updated_at FROM memory_entries
     WHERE entry_id = ? AND key = ? AND archived_at IS NULL`
  ).get(params.entryId, params.key) as
    | { id: string; value: string; version_id: string; updated_at: string }
    | undefined;

  if (!current) {
    return [];
  }

  const history: Array<{ value: string; versionId: string; changedAt: string }> = [
    { value: current.value, versionId: current.version_id, changedAt: current.updated_at },
  ];

  const versions = db.prepare(
    `SELECT previous_value, previous_version_id, changed_at
     FROM memory_versions
     WHERE memory_entry_id = ?
     ORDER BY changed_at DESC
     LIMIT ?`
  ).all(current.id, limit - 1) as Array<{
    previous_value: string;
    previous_version_id: string;
    changed_at: string;
  }>;

  for (const v of versions) {
    history.push({
      value: v.previous_value,
      versionId: v.previous_version_id,
      changedAt: v.changed_at,
    });
  }

  return history;
}
