import type Database from 'better-sqlite3';

export function linkProvenance(
  db: Database.Database,
  params: { memoryEntryId: string; journalEntryId: string }
): void {
  db.prepare(
    `INSERT INTO memory_journal_provenance (memory_entry_id, journal_entry_id)
     VALUES (?, ?)`
  ).run(params.memoryEntryId, params.journalEntryId);
}

export function getProvenance(
  db: Database.Database,
  params: { memoryEntryId: string }
): Array<{ journalEntryId: string; content: string; createdAt: string }> {
  const rows = db.prepare(
    `SELECT j.id, j.content, j.created_at
     FROM memory_journal_provenance mjp
     JOIN journal_entries j ON mjp.journal_entry_id = j.id
     WHERE mjp.memory_entry_id = ?
     ORDER BY j.created_at DESC`
  ).all(params.memoryEntryId) as Array<{
    id: string;
    content: string;
    created_at: string;
  }>;

  return rows.map((r) => ({
    journalEntryId: r.id,
    content: r.content,
    createdAt: r.created_at,
  }));
}
