import type Database from 'better-sqlite3';
import type { AletheiaSettings } from '../../lib/settings.js';
import type { ToolHandler } from './auth.js';
import { claimGuard } from './auth.js';
import { appendJournalEntry } from '../../db/queries/journal.js';
import { addTags, getEntryTags, getRelatedEntries } from '../../db/queries/tags.js';
import { xmlEscape, validateContentSize } from '../../lib/errors.js';
import { toolError, toolSuccess } from './response-format.js';
import { checkGeneralCircuitBreaker, recordWrite } from '../../lib/circuit-breaker.js';
import crypto from 'crypto';

export function registerJournalTools(
  handlers: Record<string, ToolHandler>,
  db: Database.Database,
  settings: AletheiaSettings,
  sessionState: Map<string, unknown>,
): void {
  handlers['write_journal'] = (args) => {
    // Fail-closed on revoked-mid-session key (round-2 fix).
    const authErr = claimGuard(db, sessionState, settings);
    if (authErr) return authErr;

    // General circuit breaker check
    const cbCheck = checkGeneralCircuitBreaker(sessionState, settings);
    if (cbCheck.blocked) return cbCheck.response;

    const entryId = args.entry_id as string | undefined;
    const content = args.content as string | undefined;
    const tags = args.tags as string[] | undefined;
    const critical = args.critical as boolean | undefined;
    const memorySummary = args.memory_summary as string | undefined;
    const skipRelated = args.skip_related as boolean | undefined;

    if (!entryId) return toolError('MISSING_FIELD', 'entry_id is required');
    if (!content) return toolError('MISSING_FIELD', 'content is required');

    const sizeError = validateContentSize(content);
    if (sizeError) {
      // validateContentSize already formats the error text including
      // the CONTENT_TOO_LARGE code; wrap it in the expected shape.
      return { content: [{ type: 'text', text: sizeError }], isError: true };
    }

    if (critical) {
      if (!memorySummary) {
        return toolError('MISSING_FIELD', 'memory_summary required when critical: true');
      }

      // Circuit breaker check. Prefer the new [limits].critical_write_cap
      // setting, fall back to the legacy [digest].critical_write_cap
      // location for backward compatibility with v0.1.0 settings.toml.
      const count = (sessionState.get('criticalWriteCount') as number) ?? 0;
      const criticalWriteCap =
        settings.limits?.criticalWriteCap ?? settings.digest.criticalWriteCap;
      if (count >= criticalWriteCap) {
        return toolError(
          'CIRCUIT_BREAKER',
          `Critical write cap (${criticalWriteCap}) exceeded. Use standard write_journal instead.`,
        );
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

      // Bug A: echo the COMPLETE current tag set on the entry after
      // the write, not just the submitted ones. A tag the caller
      // submitted that was already attached to the entry would
      // otherwise appear to have "dropped" even though it is in fact
      // persisted.
      if (tags && tags.length > 0) {
        const currentTags = getEntryTags(db, entryId);
        if (currentTags.length > 0) {
          xml += `<tags>${currentTags.map((t) => `<tag>${xmlEscape(t)}</tag>`).join('')}</tags>`;
        }
      }

      // Related entries
      if (!skipRelated) {
        const related = getRelatedEntries(db, { entryId });
        if (related.length > 0) {
          xml += `<related>${related.map((r) => `<entry id="${xmlEscape(r.entryId)}" shared_tags="${r.sharedTags}"/>`).join('')}</related>`;
        }
      }

      xml += '</result>';

      return toolSuccess(xml);
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
      // Bug A: report the full current tag set on the entry rather
      // than the subset whose junction row was newly inserted. See
      // the critical-write block above for the full rationale.
      const currentTags = getEntryTags(db, entryId);
      if (currentTags.length > 0) {
        xml += `<tags>${currentTags.map((t) => `<tag>${xmlEscape(t)}</tag>`).join('')}</tags>`;
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

    return toolSuccess(xml);
  };

  handlers['promote_to_memory'] = (args) => {
    // Fail-closed on revoked-mid-session key (round-2 fix).
    const authErr = claimGuard(db, sessionState, settings);
    if (authErr) return authErr;

    const journalId = args.journal_id as string | undefined;
    const synthesizedKnowledge = args.synthesized_knowledge as string | undefined;
    const key = args.key as string | undefined;
    const tags = args.tags as string[] | undefined;

    if (!journalId) return toolError('MISSING_FIELD', 'journal_id is required');
    if (!synthesizedKnowledge) return toolError('MISSING_FIELD', 'synthesized_knowledge is required');
    if (!key) return toolError('MISSING_FIELD', 'key is required');

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
      // promoteResult.error is narrowed to the literal 'NOT_FOUND'
      // from the query layer, but TypeScript's inference through a
      // db.transaction() callback union loses that narrowing, so
      // explicitly cast to the known ErrorCode here. Any new error
      // variants added to the transaction callback must also be
      // added to ERROR_CODES or this cast breaks at runtime.
      return toolError(
        promoteResult.error as 'NOT_FOUND',
        promoteResult.message as string,
      );
    }

    return toolSuccess(
      `<result><memory_entry id="${promoteResult.memoryId}" version_id="${promoteResult.versionId}" key="${xmlEscape(key)}" created="${promoteResult.created}"/><journal_entry id="${xmlEscape(journalId)}" digested="true"/></result>`,
    );
  };
}
