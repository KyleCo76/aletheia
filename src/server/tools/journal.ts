import type Database from 'better-sqlite3';
import type { AletheiaSettings } from '../../lib/settings.js';
import type { ToolHandler } from './auth.js';
import { appendJournalEntry } from '../../db/queries/journal.js';
import { addTags, getRelatedEntries } from '../../db/queries/tags.js';
import { formatError, xmlEscape, validateContentSize } from '../../lib/errors.js';
import { checkGeneralCircuitBreaker, recordWrite } from '../../lib/circuit-breaker.js';
import crypto from 'crypto';

export function registerJournalTools(
  handlers: Record<string, ToolHandler>,
  db: Database.Database,
  settings: AletheiaSettings,
  sessionState: Map<string, unknown>,
): void {
  handlers['write_journal'] = (args) => {
    // General circuit breaker check
    const cbCheck = checkGeneralCircuitBreaker(sessionState, settings);
    if (cbCheck.blocked) return cbCheck.response;

    const entryId = args.entry_id as string | undefined;
    const content = args.content as string | undefined;
    const tags = args.tags as string[] | undefined;
    const critical = args.critical as boolean | undefined;
    const memorySummary = args.memory_summary as string | undefined;
    const skipRelated = args.skip_related as boolean | undefined;

    if (!entryId) {
      return {
        content: [{ type: 'text', text: formatError('MISSING_FIELD', 'entry_id is required') }],
        isError: true,
      };
    }
    if (!content) {
      return {
        content: [{ type: 'text', text: formatError('MISSING_FIELD', 'content is required') }],
        isError: true,
      };
    }

    const sizeError = validateContentSize(content);
    if (sizeError) {
      return { content: [{ type: 'text', text: sizeError }], isError: true };
    }

    if (critical) {
      if (!memorySummary) {
        return {
          content: [{ type: 'text', text: formatError('MISSING_FIELD', 'memory_summary required when critical: true') }],
          isError: true,
        };
      }

      // Circuit breaker check
      const count = (sessionState.get('criticalWriteCount') as number) ?? 0;
      if (count >= settings.digest.criticalWriteCap) {
        return {
          content: [{
            type: 'text',
            text: formatError('CIRCUIT_BREAKER', `Critical write cap (${settings.digest.criticalWriteCap}) exceeded. Use standard write_journal instead.`),
          }],
          isError: true,
        };
      }

      // Critical write: single immediate transaction combining all operations
      const result = db.transaction(() => {
        // 1. Append journal entry
        const journalId = crypto.randomUUID();
        db.prepare(
          `INSERT INTO journal_entries (id, entry_id, content) VALUES (?, ?, ?)`,
        ).run(journalId, entryId, content);

        const journalRow = db.prepare(
          `SELECT created_at FROM journal_entries WHERE id = ?`,
        ).get(journalId) as { created_at: string };

        // 2. Create memory entry
        const memoryId = crypto.randomUUID();
        const versionId = crypto.randomBytes(8).toString('hex');
        db.prepare(
          `INSERT INTO memory_entries (id, entry_id, key, value, version_id) VALUES (?, ?, ?, ?, ?)`,
        ).run(memoryId, entryId, `critical_${journalId}`, memorySummary, versionId);

        // 3. Link provenance
        db.prepare(
          `INSERT INTO memory_journal_provenance (memory_entry_id, journal_entry_id) VALUES (?, ?)`,
        ).run(memoryId, journalId);

        // 4. Set digested_at
        db.prepare(
          `UPDATE journal_entries SET digested_at = datetime('now') WHERE id = ?`,
        ).run(journalId);

        // Process tags inline (already in a transaction)
        if (tags && tags.length > 0) {
          for (const tag of tags) {
            db.prepare(`INSERT OR IGNORE INTO tags (name) VALUES (?)`).run(tag);
            const tagRow = db.prepare(`SELECT id FROM tags WHERE name = ?`).get(tag) as { id: number };
            db.prepare(`INSERT OR IGNORE INTO entry_tags (entry_id, tag_id) VALUES (?, ?)`).run(entryId, tagRow.id);
          }
        }

        return { journalId, memoryId, versionId, createdAt: journalRow.created_at };
      }).immediate();

      // Increment circuit breakers after successful write
      sessionState.set('criticalWriteCount', ((sessionState.get('criticalWriteCount') as number) ?? 0) + 1);
      recordWrite(sessionState);

      let xml = `<result><journal_entry id="${result.journalId}" created_at="${result.createdAt}" critical="true"/>`;
      xml += `<memory_entry id="${result.memoryId}" version_id="${result.versionId}"/>`;

      if (tags && tags.length > 0) {
        xml += `<tags>${tags.map((t) => `<tag>${xmlEscape(t)}</tag>`).join('')}</tags>`;
      }

      // Related entries
      if (!skipRelated) {
        const related = getRelatedEntries(db, { entryId });
        if (related.length > 0) {
          xml += `<related>${related.map((r) => `<entry id="${xmlEscape(r.entryId)}" shared_tags="${r.sharedTags}"/>`).join('')}</related>`;
        }
      }

      xml += '</result>';

      return { content: [{ type: 'text', text: xml }] };
    }

    // Standard (non-critical) write
    const journalResult = appendJournalEntry(db, { entryId, content });
    recordWrite(sessionState);

    let tagResult: { addedTags: string[]; similar: Array<{ submitted: string; existing: string }> } | undefined;
    if (tags && tags.length > 0) {
      tagResult = addTags(db, { entryId, tags });
    }

    let xml = `<result><journal_entry id="${journalResult.id}" created_at="${journalResult.createdAt}"/>`;

    if (tagResult) {
      if (tagResult.addedTags.length > 0) {
        xml += `<tags>${tagResult.addedTags.map((t) => `<tag>${xmlEscape(t)}</tag>`).join('')}</tags>`;
      }
      if (tagResult.similar.length > 0) {
        xml += `<tags_similar>${tagResult.similar.map((s) => `${xmlEscape(s.existing)} (similar to ${xmlEscape(s.submitted)})`).join(', ')}</tags_similar>`;
      }
    }

    // Related entries (default on)
    if (!skipRelated) {
      const related = getRelatedEntries(db, { entryId });
      if (related.length > 0) {
        xml += `<related>${related.map((r) => `<entry id="${xmlEscape(r.entryId)}" shared_tags="${r.sharedTags}"/>`).join('')}</related>`;
      }
    }

    xml += '</result>';

    return { content: [{ type: 'text', text: xml }] };
  };

  handlers['promote_to_memory'] = (args) => {
    const journalId = args.journal_id as string | undefined;
    const synthesizedKnowledge = args.synthesized_knowledge as string | undefined;
    const key = args.key as string | undefined;
    const tags = args.tags as string[] | undefined;

    if (!journalId) {
      return {
        content: [{ type: 'text', text: formatError('MISSING_FIELD', 'journal_id is required') }],
        isError: true,
      };
    }
    if (!synthesizedKnowledge) {
      return {
        content: [{ type: 'text', text: formatError('MISSING_FIELD', 'synthesized_knowledge is required') }],
        isError: true,
      };
    }
    if (!key) {
      return {
        content: [{ type: 'text', text: formatError('MISSING_FIELD', 'key is required') }],
        isError: true,
      };
    }

    // Wrap entire promote operation in a single immediate transaction
    const promoteResult = db.transaction(() => {
      // Look up the journal entry to get its entry_id
      const journalRow = db.prepare(
        `SELECT entry_id FROM journal_entries WHERE id = ?`,
      ).get(journalId) as { entry_id: string } | undefined;

      if (!journalRow) {
        return { error: 'NOT_FOUND' as const, message: `Journal entry ${journalId} not found` };
      }

      const entryId = journalRow.entry_id;

      // Check for existing memory with this key
      const existing = db.prepare(
        `SELECT id, value, version_id FROM memory_entries
         WHERE entry_id = ? AND key = ? AND archived_at IS NULL`,
      ).get(entryId, key) as { id: string; value: string; version_id: string } | undefined;

      let memoryId: string;
      let versionId: string;
      let created: boolean;

      if (existing) {
        // Save previous value to memory_versions
        const versionRecordId = crypto.randomUUID();
        db.prepare(
          `INSERT INTO memory_versions (id, memory_entry_id, previous_value, previous_version_id)
           VALUES (?, ?, ?, ?)`,
        ).run(versionRecordId, existing.id, existing.value, existing.version_id);

        versionId = crypto.randomBytes(8).toString('hex');
        db.prepare(
          `UPDATE memory_entries SET value = ?, version_id = ?, updated_at = datetime('now')
           WHERE id = ?`,
        ).run(synthesizedKnowledge, versionId, existing.id);

        memoryId = existing.id;
        created = false;
      } else {
        memoryId = crypto.randomUUID();
        versionId = crypto.randomBytes(8).toString('hex');
        db.prepare(
          `INSERT INTO memory_entries (id, entry_id, key, value, version_id)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(memoryId, entryId, key, synthesizedKnowledge, versionId);
        created = true;
      }

      // Link provenance
      db.prepare(
        `INSERT INTO memory_journal_provenance (memory_entry_id, journal_entry_id) VALUES (?, ?)`,
      ).run(memoryId, journalId);

      // Mark journal entry as digested
      db.prepare(
        `UPDATE journal_entries SET digested_at = datetime('now') WHERE id = ?`,
      ).run(journalId);

      // Process tags inline
      if (tags && tags.length > 0) {
        for (const tag of tags) {
          db.prepare(`INSERT OR IGNORE INTO tags (name) VALUES (?)`).run(tag);
          const tagRow = db.prepare(`SELECT id FROM tags WHERE name = ?`).get(tag) as { id: number };
          db.prepare(`INSERT OR IGNORE INTO entry_tags (entry_id, tag_id) VALUES (?, ?)`).run(entryId, tagRow.id);
        }
      }

      return { memoryId, versionId, created, entryId };
    }).immediate();

    if ('error' in promoteResult) {
      return {
        content: [{ type: 'text', text: formatError(promoteResult.error as string, promoteResult.message as string) }],
        isError: true,
      };
    }

    return {
      content: [{
        type: 'text',
        text: `<result><memory_entry id="${promoteResult.memoryId}" version_id="${promoteResult.versionId}" key="${xmlEscape(key)}" created="${promoteResult.created}"/><journal_entry id="${xmlEscape(journalId)}" digested="true"/></result>`,
      }],
    };
  };
}
