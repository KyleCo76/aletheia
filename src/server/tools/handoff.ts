import type Database from 'better-sqlite3';
import type { AletheiaSettings } from '../../lib/settings.js';
import type { ToolHandler } from './auth.js';
import { claimGuard } from './auth.js';
import { createHandoff, readHandoff } from '../../db/queries/handoff.js';
import { xmlEscape } from '../../lib/errors.js';
import { toolError, toolSuccess } from './response-format.js';

export function registerHandoffTools(
  handlers: Record<string, ToolHandler>,
  db: Database.Database,
  settings: AletheiaSettings,
  sessionState: Map<string, unknown>,
): void {
  handlers['create_handoff'] = (args) => {
    // Fail-closed on revoked-mid-session key (round-2 fix).
    const authErr = claimGuard(db, sessionState, settings);
    if (authErr) return authErr;

    const targetKey = args.target_key as string | undefined;
    const content = args.content as string | undefined;
    const tags = args.tags as string | undefined;

    if (!targetKey || !content) {
      return toolError('INVALID_INPUT', 'target_key and content are required');
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

    return toolSuccess(
      `<result><handoff target_key="${xmlEscape(targetKey)}">created</handoff></result>`,
    );
  };

  handlers['read_handoff'] = (args) => {
    const claimed = sessionState.get('claimedKey') as
      | { id: string }
      | undefined;

    const targetKey = claimed?.id ?? (args.target_key as string | undefined) ?? 'default';
    const content = readHandoff(db, { targetKey });

    if (!content) {
      return toolSuccess('<result><handoff>none</handoff></result>');
    }

    return toolSuccess(`<result><handoff>${xmlEscape(content)}</handoff></result>`);
  };
}
