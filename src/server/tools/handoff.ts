import type Database from 'better-sqlite3';
import type { AletheiaSettings } from '../../lib/settings.js';
import type { ToolHandler } from './auth.js';
import { createHandoff, readHandoff } from '../../db/queries/handoff.js';
import { formatError, xmlEscape } from '../../lib/errors.js';

export function registerHandoffTools(
  handlers: Record<string, ToolHandler>,
  db: Database.Database,
  _settings: AletheiaSettings,
  sessionState: Map<string, unknown>,
): void {
  handlers['create_handoff'] = (args) => {
    const targetKey = args.target_key as string | undefined;
    const content = args.content as string | undefined;
    const tags = args.tags as string | undefined;

    if (!targetKey || !content) {
      return {
        content: [{ type: 'text', text: formatError('INVALID_INPUT', 'target_key and content are required') }],
        isError: true,
      };
    }

    const claimed = sessionState.get('claimedKey') as
      | { id: string }
      | undefined;

    createHandoff(db, {
      targetKey,
      content,
      tags,
      createdBy: claimed?.id,
    });

    return {
      content: [{
        type: 'text',
        text: `<result><handoff target_key="${xmlEscape(targetKey)}">created</handoff></result>`,
      }],
    };
  };

  handlers['read_handoff'] = (args) => {
    const claimed = sessionState.get('claimedKey') as
      | { id: string }
      | undefined;

    const targetKey = claimed?.id ?? (args.target_key as string | undefined) ?? 'default';
    const content = readHandoff(db, { targetKey });

    if (!content) {
      return {
        content: [{ type: 'text', text: '<result><handoff>none</handoff></result>' }],
      };
    }

    return {
      content: [{
        type: 'text',
        text: `<result><handoff>${xmlEscape(content)}</handoff></result>`,
      }],
    };
  };
}
