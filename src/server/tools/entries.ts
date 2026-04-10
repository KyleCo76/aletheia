import type Database from 'better-sqlite3';
import type { AletheiaSettings } from '../../lib/settings.js';
import type { ToolHandler } from './auth.js';
import { addTags } from '../../db/queries/tags.js';
import { formatError } from '../../lib/errors.js';
import crypto from 'crypto';

const VALID_ENTRY_CLASSES = ['journal', 'memory', 'handoff'] as const;

function requireClaim(
  sessionState: Map<string, unknown>,
  settings: AletheiaSettings,
): { id: string; permissions: string; entryScope: string | null } | null {
  if (!settings.permissions.enforce) return null;
  const claimed = sessionState.get('claimedKey') as
    | { id: string; permissions: string; entryScope: string | null }
    | undefined;
  return claimed ?? null;
}

function claimError(): { content: Array<{ type: string; text: string }>; isError: boolean } {
  return {
    content: [{ type: 'text', text: formatError('NO_CLAIM', 'Use claim(key) to authenticate') }],
    isError: true,
  };
}

export function registerEntryTools(
  handlers: Record<string, ToolHandler>,
  db: Database.Database,
  settings: AletheiaSettings,
  sessionState: Map<string, unknown>,
): void {
  handlers['create_entry'] = (args) => {
    const entryClass = args.entry_class as string | undefined;
    const tags = args.tags as string[] | undefined;

    if (!entryClass || !VALID_ENTRY_CLASSES.includes(entryClass as typeof VALID_ENTRY_CLASSES[number])) {
      return {
        content: [{ type: 'text', text: formatError('INVALID_INPUT', 'entry_class must be one of: journal, memory, handoff') }],
        isError: true,
      };
    }

    if (settings.permissions.enforce) {
      const claimed = requireClaim(sessionState, settings);
      if (!claimed) return claimError();
    }

    // Check for project namespace; in simple mode, default to 'default'
    let projectNamespace = sessionState.get('projectNamespace') as string | undefined;
    if (!projectNamespace) {
      if (!settings.permissions.enforce) {
        projectNamespace = 'default';
      } else {
        return {
          content: [{
            type: 'text',
            text: '<prompt_back>What is the project name? Use bootstrap(name) to initialize, or provide a project namespace.</prompt_back>',
          }],
        };
      }
    }

    const claimed = sessionState.get('claimedKey') as
      | { id: string; permissions: string; entryScope: string | null }
      | undefined;

    const entryId = crypto.randomUUID();

    db.prepare(
      `INSERT INTO entries (id, entry_class, project_namespace, created_by_key)
       VALUES (?, ?, ?, ?)`,
    ).run(entryId, entryClass, projectNamespace, claimed?.id ?? null);

    // Auto-set claimedEntry in simple mode so injection system can find entries
    if (!sessionState.has('claimedEntry')) {
      sessionState.set('claimedEntry', entryId);
    }

    // Process tags if provided
    let tagResult: { addedTags: string[]; similar: Array<{ submitted: string; existing: string }> } | undefined;
    if (tags && tags.length > 0) {
      tagResult = addTags(db, { entryId, tags });
    }

    let responseXml = `<result><entry_id>${entryId}</entry_id><entry_class>${entryClass}</entry_class><project>${projectNamespace}</project>`;

    if (tagResult) {
      const addedXml = tagResult.addedTags.map((t) => `<tag>${t}</tag>`).join('');
      responseXml += `<added_tags>${addedXml}</added_tags>`;

      if (tagResult.similar.length > 0) {
        const similarXml = tagResult.similar
          .map((s) => `<similar><submitted>${s.submitted}</submitted><existing>${s.existing}</existing></similar>`)
          .join('');
        responseXml += `<similar_tags>${similarXml}</similar_tags>`;
      }
    }

    responseXml += '</result>';

    return {
      content: [{ type: 'text', text: responseXml }],
    };
  };

  handlers['list_entries'] = (args) => {
    const entryClass = args.entry_class as string | undefined;
    const tags = args.tags as string[] | undefined;

    if (settings.permissions.enforce) {
      const claimed = requireClaim(sessionState, settings);
      if (!claimed) return claimError();
    }

    let query = 'SELECT id, entry_class, project_namespace, created_by_key, created_at FROM entries';
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (entryClass) {
      if (!VALID_ENTRY_CLASSES.includes(entryClass as typeof VALID_ENTRY_CLASSES[number])) {
        return {
          content: [{ type: 'text', text: formatError('INVALID_INPUT', 'entry_class must be one of: journal, memory, handoff') }],
          isError: true,
        };
      }
      conditions.push('entry_class = ?');
      params.push(entryClass);
    }

    // Filter by project namespace if set
    const projectNamespace = sessionState.get('projectNamespace') as string | undefined;
    if (projectNamespace) {
      conditions.push('project_namespace = ?');
      params.push(projectNamespace);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY created_at DESC';

    let rows: Array<{
      id: string;
      entry_class: string;
      project_namespace: string | null;
      created_by_key: string | null;
      created_at: string;
    }>;

    if (tags && tags.length > 0) {
      // Get entry IDs matching all tags
      const tagPlaceholders = tags.map(() => '?').join(', ');
      const tagQuery = `
        SELECT et.entry_id
        FROM entry_tags et
        JOIN tags t ON et.tag_id = t.id
        WHERE t.name IN (${tagPlaceholders})
        GROUP BY et.entry_id
        HAVING COUNT(DISTINCT t.id) = ?
      `;
      const tagEntryIds = db.prepare(tagQuery).all(...tags, tags.length) as Array<{ entry_id: string }>;

      if (tagEntryIds.length === 0) {
        return {
          content: [{ type: 'text', text: '<result><entries></entries></result>' }],
        };
      }

      const idPlaceholders = tagEntryIds.map(() => '?').join(', ');
      const idValues = tagEntryIds.map((r) => r.entry_id);

      if (conditions.length > 0) {
        query = query.replace(' ORDER BY', ` AND id IN (${idPlaceholders}) ORDER BY`);
      } else {
        query = query.replace(' ORDER BY', ` WHERE id IN (${idPlaceholders}) ORDER BY`);
      }

      rows = db.prepare(query).all(...params, ...idValues) as typeof rows;
    } else {
      rows = db.prepare(query).all(...params) as typeof rows;
    }

    const entriesXml = rows
      .map(
        (r) =>
          `<entry><id>${r.id}</id><entry_class>${r.entry_class}</entry_class><project>${r.project_namespace ?? ''}</project><created_at>${r.created_at}</created_at></entry>`,
      )
      .join('');

    return {
      content: [{ type: 'text', text: `<result><entries>${entriesXml}</entries></result>` }],
    };
  };
}
