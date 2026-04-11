import type Database from 'better-sqlite3';

function normalizeTag(tag: string): string {
  return tag.toLowerCase().replace(/[-_\s]/g, '');
}

export function addTags(
  db: Database.Database,
  params: { entryId: string; tags: string[] }
): { addedTags: string[]; similar: Array<{ submitted: string; existing: string }> } {
  return db.transaction(() => {
    const addedTags: string[] = [];
    const similar: Array<{ submitted: string; existing: string }> = [];

    // Get all existing tags for normalization comparison
    const existingTags = db.prepare(`SELECT name FROM tags`).all() as Array<{ name: string }>;
    const existingNormMap = new Map<string, string>();
    for (const t of existingTags) {
      existingNormMap.set(normalizeTag(t.name), t.name);
    }

    for (const tag of params.tags) {
      const normalized = normalizeTag(tag);
      const existingMatch = existingNormMap.get(normalized);

      if (existingMatch && existingMatch !== tag) {
        similar.push({ submitted: tag, existing: existingMatch });
      }

      // Insert or ignore the tag
      db.prepare(`INSERT OR IGNORE INTO tags (name) VALUES (?)`).run(tag);

      const tagRow = db.prepare(`SELECT id FROM tags WHERE name = ?`).get(tag) as { id: number };

      // Insert the junction entry (ignore if already exists)
      const result = db.prepare(
        `INSERT OR IGNORE INTO entry_tags (entry_id, tag_id) VALUES (?, ?)`
      ).run(params.entryId, tagRow.id);

      if (result.changes > 0) {
        addedTags.push(tag);
      }
    }

    return { addedTags, similar };
  }).immediate();
}

export function getEntryTags(
  db: Database.Database,
  entryId: string,
): string[] {
  // Return all tag names currently attached to this entry, in
  // insertion (tags.id) order for deterministic output. Used by the
  // write_journal / write_memory response builders to echo the
  // complete post-write tag set — a caller that submits overlapping
  // or already-attached tags should see the full union rather than a
  // subset filtered to "newly inserted junction rows".
  const rows = db.prepare(
    `SELECT t.name
     FROM entry_tags et
     JOIN tags t ON et.tag_id = t.id
     WHERE et.entry_id = ?
     ORDER BY t.id`,
  ).all(entryId) as Array<{ name: string }>;

  return rows.map((r) => r.name);
}

export function listTags(
  db: Database.Database
): Array<{ name: string; count: number }> {
  const rows = db.prepare(
    `SELECT t.name, COUNT(et.entry_id) as count
     FROM active_tags t
     JOIN entry_tags et ON t.id = et.tag_id
     GROUP BY t.id, t.name
     ORDER BY t.name`
  ).all() as Array<{ name: string; count: number }>;

  return rows;
}

export function searchByTags(
  db: Database.Database,
  params: { tags: string[] }
): Array<{ entryId: string }> {
  const placeholders = params.tags.map(() => '?').join(', ');

  const rows = db.prepare(
    `SELECT et.entry_id
     FROM entry_tags et
     JOIN tags t ON et.tag_id = t.id
     WHERE t.name IN (${placeholders})
     GROUP BY et.entry_id
     HAVING COUNT(DISTINCT t.id) = ?`
  ).all(...params.tags, params.tags.length) as Array<{ entry_id: string }>;

  return rows.map((r) => ({ entryId: r.entry_id }));
}

export function getRelatedEntries(
  db: Database.Database,
  params: { entryId: string; threshold?: number }
): Array<{ entryId: string; sharedTags: number }> {
  // Get entry's tags
  const entryTags = db.prepare(
    `SELECT tag_id FROM entry_tags WHERE entry_id = ?`
  ).all(params.entryId) as Array<{ tag_id: number }>;

  if (entryTags.length === 0) return [];

  const threshold = Math.min(params.threshold ?? 1, entryTags.length);
  const tagIds = entryTags.map((t) => t.tag_id);
  const placeholders = tagIds.map(() => '?').join(', ');

  const rows = db.prepare(
    `SELECT entry_id, COUNT(*) as shared_tags
     FROM entry_tags
     WHERE tag_id IN (${placeholders}) AND entry_id != ?
     GROUP BY entry_id
     HAVING COUNT(*) >= ?`
  ).all(...tagIds, params.entryId, threshold) as Array<{
    entry_id: string;
    shared_tags: number;
  }>;

  return rows.map((r) => ({
    entryId: r.entry_id,
    sharedTags: r.shared_tags,
  }));
}
