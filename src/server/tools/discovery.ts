import type Database from 'better-sqlite3';
import type { AletheiaSettings } from '../../lib/settings.js';
import type { ToolHandler } from './auth.js';
import { searchJournal, readJournalEntries } from '../../db/queries/journal.js';
import { searchMemory, readMemory } from '../../db/queries/memory.js';
import { listTags, getRelatedEntries } from '../../db/queries/tags.js';
import { readHandoff } from '../../db/queries/handoff.js';
import { readStatus } from '../../db/queries/status.js';
import { formatError, xmlEscape } from '../../lib/errors.js';

export function registerDiscoveryTools(
  handlers: Record<string, ToolHandler>,
  db: Database.Database,
  _settings: AletheiaSettings,
  _sessionState: Map<string, unknown>,
): void {
  handlers['search'] = (args) => {
    const entryClass = args.entry_class as string | undefined;
    const tags = args.tags as string[] | undefined;
    const query = args.query as string | undefined;
    const includeArchived = args.include_archived as boolean | undefined;

    let xml = '<result>';

    if (!entryClass || entryClass === 'journal') {
      const journalResults = searchJournal(db, { query, tags });
      if (journalResults.length > 0) {
        xml += '<journal_entries>';
        for (const j of journalResults) {
          xml += `<entry id="${j.id}" entry_id="${j.entryId}" created_at="${j.createdAt}" digested="${j.digestedAt !== null}"><content>${xmlEscape(j.content)}</content></entry>`;
        }
        xml += '</journal_entries>';
      }
    }

    if (!entryClass || entryClass === 'memory') {
      const memoryResults = searchMemory(db, { query, tags, includeArchived });
      if (memoryResults.length > 0) {
        xml += '<memory_entries>';
        for (const m of memoryResults) {
          xml += `<entry id="${m.id}" key="${xmlEscape(m.key)}" version_id="${m.versionId}" updated_at="${m.updatedAt}"><value>${xmlEscape(m.value)}</value></entry>`;
        }
        xml += '</memory_entries>';
      }
    }

    xml += '</result>';

    return { content: [{ type: 'text', text: xml }] };
  };

  handlers['read'] = (args) => {
    const entryId = args.entry_id as string | undefined;
    const mode = args.mode as string | undefined;
    const limit = args.limit as number | undefined;
    const showRelated = args.show_related as boolean | undefined;

    if (!entryId) {
      return {
        content: [{ type: 'text', text: formatError('MISSING_FIELD', 'entry_id is required') }],
        isError: true,
      };
    }

    // Detect entry class from entries table
    const entryRow = db.prepare(
      `SELECT entry_class FROM entries WHERE id = ?`,
    ).get(entryId) as { entry_class: string } | undefined;

    if (!entryRow) {
      // Check if it's a handoff key
      const handoffContent = readHandoff(db, { targetKey: entryId });
      if (handoffContent !== null) {
        return {
          content: [{
            type: 'text',
            text: `<result><handoff target_key="${xmlEscape(entryId)}" consumed="true"><content>${xmlEscape(handoffContent)}</content></handoff></result>`,
          }],
        };
      }

      return {
        content: [{ type: 'text', text: formatError('NOT_FOUND', `Entry ${entryId} not found`) }],
        isError: true,
      };
    }

    let xml = '<result>';

    if (entryRow.entry_class === 'journal') {
      const entries = readJournalEntries(db, {
        entryId,
        mode: mode as 'open' | 'rolling' | undefined,
        limit,
      });

      xml += `<journal entry_id="${xmlEscape(entryId)}" count="${entries.length}">`;
      for (const e of entries) {
        xml += `<entry id="${e.id}" created_at="${e.createdAt}" digested="${e.digestedAt !== null}">`;
        if (e.subSection) {
          xml += `<sub_section>${xmlEscape(e.subSection)}</sub_section>`;
        }
        xml += `<content>${xmlEscape(e.content)}</content></entry>`;
      }
      xml += '</journal>';
    } else if (entryRow.entry_class === 'memory') {
      const memories = readMemory(db, { entryId });

      xml += `<memory entry_id="${xmlEscape(entryId)}" count="${memories.length}">`;
      for (const m of memories) {
        xml += `<entry id="${m.id}" key="${xmlEscape(m.key)}" version_id="${m.versionId}" updated_at="${m.updatedAt}"><value>${xmlEscape(m.value)}</value></entry>`;
      }
      xml += '</memory>';
    } else if (entryRow.entry_class === 'handoff') {
      const handoffContent = readHandoff(db, { targetKey: entryId });
      if (handoffContent !== null) {
        xml += `<handoff target_key="${xmlEscape(entryId)}" consumed="true"><content>${xmlEscape(handoffContent)}</content></handoff>`;
      } else {
        xml += `<handoff target_key="${xmlEscape(entryId)}" consumed="false"/>`;
      }
    } else if (entryRow.entry_class === 'status') {
      // Bug B: the generic `read` tool used to fall through its
      // if-chain for entry_class='status', emitting only <related>
      // with no document body. We now dispatch to the same query
      // helper as `read_status` and format the XML in the same shape
      // so callers can treat `read` as a uniform entry-type fetcher.
      const statusResult = readStatus(db, { entryId });
      if (!statusResult) {
        return {
          content: [{ type: 'text', text: formatError('NOT_FOUND', `Status document for entry ${entryId} not found`) }],
          isError: true,
        };
      }
      const sectionsXml = statusResult.sections
        .map(
          (s) =>
            `<section id="${xmlEscape(s.sectionId)}" state="${xmlEscape(s.state ?? '')}" position="${s.position}">${xmlEscape(s.content)}</section>`,
        )
        .join('');
      xml += `<status version_id="${statusResult.versionId}" updated_at="${statusResult.updatedAt}">${xmlEscape(statusResult.content)}${sectionsXml}</status>`;
    }

    // Related entries
    if (showRelated !== false) {
      const related = getRelatedEntries(db, { entryId });
      if (related.length > 0) {
        xml += `<related>${related.map((r) => `<entry id="${xmlEscape(r.entryId)}" shared_tags="${r.sharedTags}"/>`).join('')}</related>`;
      }
    }

    xml += '</result>';

    return { content: [{ type: 'text', text: xml }] };
  };

  handlers['list_tags'] = (args) => {
    const entryClass = args.entry_class as string | undefined;

    const allTags = listTags(db);

    // If entry_class filter is specified, filter tags to only those used by entries of that class
    let filteredTags = allTags;
    if (entryClass) {
      const entryIdsForClass = db.prepare(
        `SELECT id FROM entries WHERE entry_class = ?`,
      ).all(entryClass) as Array<{ id: string }>;

      const entryIdSet = new Set(entryIdsForClass.map((r) => r.id));

      // Get tag IDs associated with those entries
      if (entryIdSet.size > 0) {
        const placeholders = Array.from(entryIdSet).map(() => '?').join(', ');
        const tagIdsForClass = db.prepare(
          `SELECT DISTINCT t.name FROM tags t
           JOIN entry_tags et ON t.id = et.tag_id
           WHERE et.entry_id IN (${placeholders})
           ORDER BY t.name`,
        ).all(...entryIdSet) as Array<{ name: string }>;

        const classTagNames = new Set(tagIdsForClass.map((r) => r.name));
        filteredTags = allTags.filter((t) => classTagNames.has(t.name));
      } else {
        filteredTags = [];
      }
    }

    const tagsXml = filteredTags
      .map((t) => `<tag name="${xmlEscape(t.name)}" count="${t.count}"/>`)
      .join('');

    return {
      content: [{
        type: 'text',
        text: `<result><tags count="${filteredTags.length}">${tagsXml}</tags></result>`,
      }],
    };
  };
}
