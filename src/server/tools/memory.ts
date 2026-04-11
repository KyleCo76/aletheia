import type Database from 'better-sqlite3';
import type { AletheiaSettings } from '../../lib/settings.js';
import type { ToolHandler } from './auth.js';
import { writeMemory, retireMemory, readMemoryHistory } from '../../db/queries/memory.js';
import { addTags, getEntryTags } from '../../db/queries/tags.js';
import { xmlEscape, validateContentSize } from '../../lib/errors.js';
import { toolError, toolSuccess } from './response-format.js';
import { checkGeneralCircuitBreaker, recordWrite } from '../../lib/circuit-breaker.js';

export function registerMemoryTools(
  handlers: Record<string, ToolHandler>,
  db: Database.Database,
  settings: AletheiaSettings,
  sessionState: Map<string, unknown>,
): void {
  handlers['write_memory'] = (args) => {
    // General circuit breaker check
    const cbCheck = checkGeneralCircuitBreaker(sessionState, settings);
    if (cbCheck.blocked) return cbCheck.response;
    const entryId = args.entry_id as string | undefined;
    const key = args.key as string | undefined;
    const value = args.value as string | undefined;
    const tags = args.tags as string[] | undefined;
    const versionId = args.version_id as string | undefined;
    const supersedes = args.supersedes as string | undefined;

    if (!entryId) return toolError('MISSING_FIELD', 'entry_id is required');
    if (!key) return toolError('MISSING_FIELD', 'key is required');
    if (!value) return toolError('MISSING_FIELD', 'value is required');

    const sizeError = validateContentSize(value, 'value');
    if (sizeError) {
      // validateContentSize already formats the error text including
      // the CONTENT_TOO_LARGE code. Wrap it with the same {isError}
      // envelope the rest of the module uses.
      return { content: [{ type: 'text', text: sizeError }], isError: true };
    }

    const result = writeMemory(db, {
      entryId,
      key,
      value,
      versionId,
      enforcePermissions: settings.permissions.enforce,
      supersedes,
    });

    if ('conflict' in result) {
      return toolError(
        'OCC_CONFLICT',
        `Version conflict on key "${key}". Current version_id: ${result.currentVersionId}, current value: ${result.currentValue}`,
      );
    }

    recordWrite(sessionState);

    // Process tags
    let tagXml = '';
    if (tags && tags.length > 0) {
      const tagResult = addTags(db, { entryId, tags });
      // Bug A: echo the full current tag set on the entry after the
      // write, not just the "newly added" subset that flipped a 0→1
      // junction row. A caller submitting an overlap with pre-existing
      // tags must see the union so they can trust the response as a
      // ground truth for the entry's state.
      const currentTags = getEntryTags(db, entryId);
      if (currentTags.length > 0) {
        tagXml = `<tags>${currentTags.map((t) => `<tag>${xmlEscape(t)}</tag>`).join('')}</tags>`;
      }
      if (tagResult.similar.length > 0) {
        tagXml += `<tags_similar>${tagResult.similar.map((s) => `${xmlEscape(s.existing)} (similar to ${xmlEscape(s.submitted)})`).join(', ')}</tags_similar>`;
      }
    }

    return toolSuccess(
      `<result><memory_entry id="${result.id}" version_id="${result.versionId}" key="${xmlEscape(key)}" created="${result.created}"/>${tagXml}</result>`,
    );
  };

  handlers['retire_memory'] = (args) => {
    const entryId = args.entry_id as string | undefined;
    const memoryEntryId = args.memory_entry_id as string | undefined;
    const reason = args.reason as string | undefined;

    if (!entryId) return toolError('MISSING_FIELD', 'entry_id is required');
    if (!memoryEntryId) return toolError('MISSING_FIELD', 'memory_entry_id is required');

    retireMemory(db, { entryId, memoryEntryId, reason });

    return toolSuccess(
      `<result><retired id="${xmlEscape(memoryEntryId)}" entry_id="${xmlEscape(entryId)}"/></result>`,
    );
  };

  handlers['read_memory_history'] = (args) => {
    const entryId = args.entry_id as string | undefined;
    const key = args.key as string | undefined;
    const limit = args.limit as number | undefined;

    if (!entryId) return toolError('MISSING_FIELD', 'entry_id is required');
    if (!key) return toolError('MISSING_FIELD', 'key is required');

    const history = readMemoryHistory(db, { entryId, key, limit });

    if (history.length === 0) {
      return toolSuccess(`<result><history key="${xmlEscape(key)}" count="0"/></result>`);
    }

    const versionsXml = history
      .map(
        (v) => `<version version_id="${v.versionId}" changed_at="${v.changedAt}"><value>${xmlEscape(v.value)}</value></version>`,
      )
      .join('');

    return toolSuccess(
      `<result><history key="${xmlEscape(key)}" count="${history.length}">${versionsXml}</history></result>`,
    );
  };
}
