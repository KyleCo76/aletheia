import type Database from 'better-sqlite3';

export function createHandoff(
  db: Database.Database,
  params: { targetKey: string; content: string; tags?: string; createdBy?: string }
): void {
  db.prepare(
    `INSERT OR REPLACE INTO handoffs (target_key, content, tags, created_by)
     VALUES (?, ?, ?, ?)`
  ).run(params.targetKey, params.content, params.tags ?? null, params.createdBy ?? null);
}

export function readHandoff(
  db: Database.Database,
  params: { targetKey: string }
): string | null {
  return db.transaction(() => {
    const row = db.prepare(
      `SELECT content FROM handoffs WHERE target_key = ?`
    ).get(params.targetKey) as { content: string } | undefined;

    if (!row) return null;

    db.prepare(
      `DELETE FROM handoffs WHERE target_key = ?`
    ).run(params.targetKey);

    return row.content;
  }).immediate();
}
