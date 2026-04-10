import type Database from 'better-sqlite3';
import crypto from 'crypto';
import { DEFAULTS } from '../../lib/constants.js';

export function appendJournalEntry(
  db: Database.Database,
  params: { entryId: string; content: string; subSection?: string }
): { id: string; createdAt: string } {
  const id = crypto.randomUUID();
  const result = db.transaction(() => {
    db.prepare(
      `INSERT INTO journal_entries (id, entry_id, content, sub_section)
       VALUES (?, ?, ?, ?)`
    ).run(id, params.entryId, params.content, params.subSection ?? null);

    const row = db.prepare(
      `SELECT created_at FROM journal_entries WHERE id = ?`
    ).get(id) as { created_at: string };

    return { id, createdAt: row.created_at };
  }).immediate();

  return result;
}

export function readJournalEntries(
  db: Database.Database,
  params: {
    entryId: string;
    mode?: 'open' | 'rolling';
    limit?: number;
    includeDigested?: boolean;
  }
): Array<{
  id: string;
  entryId: string;
  content: string;
  subSection: string | null;
  createdAt: string;
  digestedAt: string | null;
}> {
  const conditions: string[] = ['entry_id = ?'];
  const bindings: unknown[] = [params.entryId];

  if (!params.includeDigested) {
    conditions.push('digested_at IS NULL');
  }

  const where = conditions.join(' AND ');
  const limit =
    params.mode === 'rolling'
      ? params.limit ?? DEFAULTS.rollingDefault
      : params.limit;

  let sql = `SELECT id, entry_id, content, sub_section, created_at, digested_at
             FROM journal_entries
             WHERE ${where}
             ORDER BY created_at DESC`;
  if (limit !== undefined) {
    sql += ` LIMIT ?`;
    bindings.push(limit);
  }

  const rows = db.prepare(sql).all(...bindings) as Array<{
    id: string;
    entry_id: string;
    content: string;
    sub_section: string | null;
    created_at: string;
    digested_at: string | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    entryId: r.entry_id,
    content: r.content,
    subSection: r.sub_section,
    createdAt: r.created_at,
    digestedAt: r.digested_at,
  }));
}

/**
 * Read journal entries across all entries in a project namespace.
 * Used by the L2 injection builder to surface journals by project scope
 * rather than by a specific entry UUID.
 */
export function readJournalEntriesByProject(
  db: Database.Database,
  params: {
    projectNamespace: string;
    mode?: 'open' | 'rolling';
    limit?: number;
    includeDigested?: boolean;
  }
): Array<{
  id: string;
  entryId: string;
  content: string;
  subSection: string | null;
  createdAt: string;
  digestedAt: string | null;
}> {
  const conditions: string[] = ['e.project_namespace = ?'];
  const bindings: unknown[] = [params.projectNamespace];

  if (!params.includeDigested) {
    conditions.push('j.digested_at IS NULL');
  }

  const where = conditions.join(' AND ');
  const limit =
    params.mode === 'rolling'
      ? params.limit ?? DEFAULTS.rollingDefault
      : params.limit;

  let sql = `SELECT j.id, j.entry_id, j.content, j.sub_section, j.created_at, j.digested_at
             FROM journal_entries j
             JOIN entries e ON j.entry_id = e.id
             WHERE ${where}
             ORDER BY j.created_at DESC`;
  if (limit !== undefined) {
    sql += ` LIMIT ?`;
    bindings.push(limit);
  }

  const rows = db.prepare(sql).all(...bindings) as Array<{
    id: string;
    entry_id: string;
    content: string;
    sub_section: string | null;
    created_at: string;
    digested_at: string | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    entryId: r.entry_id,
    content: r.content,
    subSection: r.sub_section,
    createdAt: r.created_at,
    digestedAt: r.digested_at,
  }));
}

export function searchJournal(
  db: Database.Database,
  params: { entryId?: string; query?: string; tags?: string[] }
): Array<{
  id: string;
  entryId: string;
  content: string;
  subSection: string | null;
  createdAt: string;
  digestedAt: string | null;
}> {
  const conditions: string[] = [];
  const bindings: unknown[] = [];

  if (params.entryId) {
    conditions.push('j.entry_id = ?');
    bindings.push(params.entryId);
  }

  if (params.query) {
    conditions.push('j.content LIKE ?');
    bindings.push(`%${params.query}%`);
  }

  let joinClause = '';
  let groupByClause = '';
  let havingClause = '';
  if (params.tags && params.tags.length > 0) {
    joinClause = `
      JOIN entry_tags et ON j.entry_id = et.entry_id
      JOIN tags t ON et.tag_id = t.id`;
    const placeholders = params.tags.map(() => '?').join(', ');
    conditions.push(`t.name IN (${placeholders})`);
    bindings.push(...params.tags);
    groupByClause = 'GROUP BY j.id';
    havingClause = 'HAVING COUNT(DISTINCT t.id) = ?';
    bindings.push(params.tags.length);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const sql = `SELECT j.id, j.entry_id, j.content, j.sub_section, j.created_at, j.digested_at
               FROM journal_entries j
               ${joinClause}
               ${where}
               ${groupByClause}
               ${havingClause}
               ORDER BY j.created_at DESC`;

  const rows = db.prepare(sql).all(...bindings) as Array<{
    id: string;
    entry_id: string;
    content: string;
    sub_section: string | null;
    created_at: string;
    digested_at: string | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    entryId: r.entry_id,
    content: r.content,
    subSection: r.sub_section,
    createdAt: r.created_at,
    digestedAt: r.digested_at,
  }));
}

export function markDigested(
  db: Database.Database,
  params: { ids: string[] }
): void {
  db.transaction(() => {
    const stmt = db.prepare(
      `UPDATE journal_entries SET digested_at = datetime('now') WHERE id = ?`
    );
    for (const id of params.ids) {
      stmt.run(id);
    }
  }).immediate();
}
