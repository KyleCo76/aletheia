import type Database from 'better-sqlite3';
import crypto from 'crypto';

type StatusResult = {
  id: string;
  content: string;
  versionId: string;
  updatedAt: string;
  sections: Array<{ id: string; sectionId: string; content: string; state: string | null; position: number }>;
};

function loadSections(
  db: Database.Database,
  statusId: string,
  sectionId?: string,
): Array<{ id: string; sectionId: string; content: string; state: string | null; position: number }> {
  let sectionSql = `SELECT id, section_id, content, state, position
                     FROM status_sections
                     WHERE status_id = ?`;
  const bindings: unknown[] = [statusId];

  if (sectionId) {
    sectionSql += ' AND section_id = ?';
    bindings.push(sectionId);
  }

  sectionSql += ' ORDER BY position ASC';

  const sections = db.prepare(sectionSql).all(...bindings) as Array<{
    id: string;
    section_id: string;
    content: string;
    state: string | null;
    position: number;
  }>;

  return sections.map((s) => ({
    id: s.id,
    sectionId: s.section_id,
    content: s.content,
    state: s.state,
    position: s.position,
  }));
}

export function readStatus(
  db: Database.Database,
  params: { entryId: string; sectionId?: string }
): StatusResult | null {
  const doc = db.prepare(
    `SELECT id, content, version_id, updated_at FROM status_documents WHERE entry_id = ?`
  ).get(params.entryId) as
    | { id: string; content: string; version_id: string; updated_at: string }
    | undefined;

  if (!doc) {
    return null;
  }

  return {
    id: doc.id,
    content: doc.content,
    versionId: doc.version_id,
    updatedAt: doc.updated_at,
    sections: loadSections(db, doc.id, params.sectionId),
  };
}

/**
 * Read the most-recently-updated status document within a project namespace.
 * Used by the injection builders which know the session's project scope
 * (from claim/bootstrap) but not a specific entry UUID.
 */
export function readStatusByProject(
  db: Database.Database,
  params: { projectNamespace: string; sectionId?: string }
): StatusResult | null {
  const doc = db.prepare(
    `SELECT s.id, s.content, s.version_id, s.updated_at
     FROM status_documents s
     JOIN entries e ON s.entry_id = e.id
     WHERE e.project_namespace = ?
     ORDER BY s.updated_at DESC
     LIMIT 1`
  ).get(params.projectNamespace) as
    | { id: string; content: string; version_id: string; updated_at: string }
    | undefined;

  if (!doc) {
    return null;
  }

  return {
    id: doc.id,
    content: doc.content,
    versionId: doc.version_id,
    updatedAt: doc.updated_at,
    sections: loadSections(db, doc.id, params.sectionId),
  };
}

export function replaceStatus(
  db: Database.Database,
  params: { entryId: string; content: string; versionId: string }
): { id: string; versionId: string } | { conflict: true; currentVersionId: string; currentContent: string } {
  return db.transaction(() => {
    const doc = db.prepare(
      `SELECT id, content, version_id FROM status_documents WHERE entry_id = ?`
    ).get(params.entryId) as
      | { id: string; content: string; version_id: string }
      | undefined;

    if (!doc) {
      // Create new document
      const id = crypto.randomUUID();
      const versionId = crypto.randomBytes(8).toString('hex');
      db.prepare(
        `INSERT INTO status_documents (id, entry_id, content, version_id)
         VALUES (?, ?, ?, ?)`
      ).run(id, params.entryId, params.content, versionId);
      return { id, versionId };
    }

    if (params.versionId !== doc.version_id) {
      return {
        conflict: true as const,
        currentVersionId: doc.version_id,
        currentContent: doc.content,
      };
    }

    const newVersionId = crypto.randomBytes(8).toString('hex');
    db.prepare(
      `UPDATE status_documents
       SET content = ?, undo_content = ?, version_id = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(params.content, doc.content, newVersionId, doc.id);

    return { id: doc.id, versionId: newVersionId };
  }).immediate();
}

export function updateStatusSection(
  db: Database.Database,
  params: { statusId: string; sectionId: string; state?: string; content?: string }
): { found: boolean } {
  const sets: string[] = [];
  const bindings: unknown[] = [];

  if (params.state !== undefined) {
    sets.push('state = ?');
    bindings.push(params.state);
  }

  if (params.content !== undefined) {
    sets.push('content = ?');
    bindings.push(params.content);
  }

  // Existence check and UPDATE share a single immediate transaction so
  // the {found} return reflects the same row state the UPDATE saw — no
  // racing INSERT can sneak between the SELECT and the UPDATE. Bug #27
  // (silent no-op on missing section) was caused by callers having no
  // way to distinguish "row updated" from "row absent"; the {found}
  // return value is the signal handlers check.
  return db.transaction(() => {
    const exists = db.prepare(
      `SELECT 1 FROM status_sections WHERE status_id = ? AND section_id = ?`
    ).get(params.statusId, params.sectionId);

    if (!exists) {
      return { found: false };
    }

    if (sets.length > 0) {
      bindings.push(params.statusId, params.sectionId);
      db.prepare(
        `UPDATE status_sections SET ${sets.join(', ')} WHERE status_id = ? AND section_id = ?`
      ).run(...bindings);
    }

    return { found: true };
  }).immediate();
}

export function addSection(
  db: Database.Database,
  params: { statusId: string; sectionId: string; content: string; position?: number }
): void {
  db.transaction(() => {
    let position = params.position;

    if (position !== undefined) {
      // Shift existing sections at or above this position
      db.prepare(
        `UPDATE status_sections SET position = position + 1
         WHERE status_id = ? AND position >= ?`
      ).run(params.statusId, position);
    } else {
      // Place at end
      const max = db.prepare(
        `SELECT MAX(position) as max_pos FROM status_sections WHERE status_id = ?`
      ).get(params.statusId) as { max_pos: number | null };
      position = (max.max_pos ?? -1) + 1;
    }

    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO status_sections (id, status_id, section_id, content, position)
       VALUES (?, ?, ?, ?, ?)`
    ).run(id, params.statusId, params.sectionId, params.content, position);
  }).immediate();
}

export function removeSection(
  db: Database.Database,
  params: { statusId: string; sectionId: string }
): void {
  db.transaction(() => {
    const section = db.prepare(
      `SELECT position FROM status_sections WHERE status_id = ? AND section_id = ?`
    ).get(params.statusId, params.sectionId) as { position: number } | undefined;

    if (!section) return;

    db.prepare(
      `DELETE FROM status_sections WHERE status_id = ? AND section_id = ?`
    ).run(params.statusId, params.sectionId);

    // Shift remaining sections down
    db.prepare(
      `UPDATE status_sections SET position = position - 1
       WHERE status_id = ? AND position > ?`
    ).run(params.statusId, section.position);
  }).immediate();
}
