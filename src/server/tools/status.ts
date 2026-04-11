import type Database from 'better-sqlite3';
import type { AletheiaSettings } from '../../lib/settings.js';
import type { ToolHandler } from './auth.js';
import {
  readStatus,
  replaceStatus,
  updateStatusSection,
  addSection,
  removeSection,
} from '../../db/queries/status.js';
import { xmlEscape, validateContentSize } from '../../lib/errors.js';
import { toolError } from './response-format.js';
import { checkGeneralCircuitBreaker, recordWrite } from '../../lib/circuit-breaker.js';

export function registerStatusTools(
  handlers: Record<string, ToolHandler>,
  db: Database.Database,
  settings: AletheiaSettings,
  sessionState: Map<string, unknown>,
): void {
  handlers['read_status'] = (args) => {
    const entryId = args.entry_id as string | undefined;
    if (!entryId) {
      return toolError('INVALID_INPUT', 'entry_id is required');
    }

    const sectionId = args.section_id as string | undefined;
    const result = readStatus(db, { entryId, sectionId });

    if (!result) {
      return toolError('NOT_FOUND', 'Status document not found');
    }

    const sectionsXml = result.sections
      .map(
        (s) =>
          `<section id="${xmlEscape(s.sectionId)}" state="${xmlEscape(s.state ?? '')}" position="${s.position}">${xmlEscape(s.content)}</section>`,
      )
      .join('');

    return {
      content: [{
        type: 'text',
        text: `<result><status version_id="${result.versionId}" updated_at="${result.updatedAt}">${xmlEscape(result.content)}${sectionsXml}</status></result>`,
      }],
    };
  };

  handlers['replace_status'] = (args) => {
    // General circuit breaker check
    const cbCheck = checkGeneralCircuitBreaker(sessionState, settings);
    if (cbCheck.blocked) return cbCheck.response;

    const entryId = args.entry_id as string | undefined;
    const content = args.content as string | undefined;
    // version_id may be an empty string on first write to a newly
    // created status entry — the caller has no prior version to quote.
    // The replaceStatus query already handles missing documents by
    // creating a fresh one and minting a new version_id, ignoring the
    // passed value; the handler was just over-strict in its truthiness
    // check. Callers with an existing version_id must still pass it for
    // OCC to engage.
    const versionId = (args.version_id as string | undefined) ?? '';

    if (!entryId || !content) {
      return toolError('INVALID_INPUT', 'entry_id and content are required');
    }

    const sizeError = validateContentSize(content);
    if (sizeError) {
      return { content: [{ type: 'text', text: sizeError }], isError: true };
    }

    const result = replaceStatus(db, { entryId, content, versionId });

    if ('conflict' in result) {
      return toolError(
        'VERSION_CONFLICT',
        `Version conflict. Current version: ${result.currentVersionId}. Current content: ${result.currentContent}`,
      );
    }

    recordWrite(sessionState);

    return {
      content: [{
        type: 'text',
        text: `<result><status id="${result.id}" version_id="${result.versionId}">replaced</status></result>`,
      }],
    };
  };

  handlers['update_status'] = (args) => {
    const entryId = args.entry_id as string | undefined;
    const sectionId = args.section_id as string | undefined;
    const state = args.state as string | undefined;
    const continueFlag = args.continue as boolean | undefined;

    if (!entryId || !sectionId) {
      return toolError('INVALID_INPUT', 'entry_id and section_id are required');
    }

    // Look up the status document
    const doc = db.prepare(
      `SELECT id FROM status_documents WHERE entry_id = ?`,
    ).get(entryId) as { id: string } | undefined;

    if (!doc) {
      return toolError('NOT_FOUND', 'Status document not found');
    }

    const updateResult = updateStatusSection(db, { statusId: doc.id, sectionId, state });

    // Bug #27: prior to v0.1.2 this call's return was discarded, so a
    // section_id that didn't match any row produced a silent success.
    // Surface the miss as NOT_FOUND so callers can react instead of
    // assuming their state machine moved.
    if (!updateResult.found) {
      return toolError(
        'NOT_FOUND',
        `Section "${sectionId}" not found in status document for entry "${entryId}"`,
      );
    }

    let nextSectionXml = '';

    if (continueFlag) {
      // Get updated section's position
      const currentSection = db.prepare(
        `SELECT position FROM status_sections WHERE status_id = ? AND section_id = ?`,
      ).get(doc.id, sectionId) as { position: number } | undefined;

      if (currentSection) {
        // Find the next section by position
        const nextSection = db.prepare(
          `SELECT section_id, content, state, position
           FROM status_sections
           WHERE status_id = ? AND position > ?
           ORDER BY position ASC
           LIMIT 1`,
        ).get(doc.id, currentSection.position) as
          | { section_id: string; content: string; state: string | null; position: number }
          | undefined;

        if (nextSection) {
          nextSectionXml = `<next_section id="${xmlEscape(nextSection.section_id)}" state="${xmlEscape(nextSection.state ?? '')}" position="${nextSection.position}">${xmlEscape(nextSection.content)}</next_section>`;
        } else {
          nextSectionXml = '<next_section>none</next_section>';
        }
      }
    }

    return {
      content: [{
        type: 'text',
        text: `<result><updated section_id="${xmlEscape(sectionId)}" state="${xmlEscape(state ?? '')}"/>${nextSectionXml}</result>`,
      }],
    };
  };

  handlers['add_section'] = (args) => {
    const entryId = args.entry_id as string | undefined;
    const sectionId = args.section_id as string | undefined;
    const content = args.content as string | undefined;
    const position = args.position as number | undefined;

    if (!entryId || !sectionId || !content) {
      return toolError('INVALID_INPUT', 'entry_id, section_id, and content are required');
    }

    const doc = db.prepare(
      `SELECT id FROM status_documents WHERE entry_id = ?`,
    ).get(entryId) as { id: string } | undefined;

    if (!doc) {
      return toolError('NOT_FOUND', 'Status document not found');
    }

    addSection(db, { statusId: doc.id, sectionId, content, position });

    return {
      content: [{
        type: 'text',
        text: `<result><added section_id="${xmlEscape(sectionId)}"/></result>`,
      }],
    };
  };

  handlers['remove_section'] = (args) => {
    const entryId = args.entry_id as string | undefined;
    const sectionId = args.section_id as string | undefined;

    if (!entryId || !sectionId) {
      return toolError('INVALID_INPUT', 'entry_id and section_id are required');
    }

    const doc = db.prepare(
      `SELECT id FROM status_documents WHERE entry_id = ?`,
    ).get(entryId) as { id: string } | undefined;

    if (!doc) {
      return toolError('NOT_FOUND', 'Status document not found');
    }

    removeSection(db, { statusId: doc.id, sectionId });

    return {
      content: [{
        type: 'text',
        text: `<result><removed section_id="${xmlEscape(sectionId)}"/></result>`,
      }],
    };
  };
}
