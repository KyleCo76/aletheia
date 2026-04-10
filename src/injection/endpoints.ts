import type Database from 'better-sqlite3';
import type http from 'http';
import type { AletheiaSettings } from '../lib/settings.js';
import type { FrequencyManager } from './frequency.js';
import { buildL1Payload } from './l1-builder.js';
import { buildL2Payload } from './l2-builder.js';

export function createEndpointHandlers(
  db: Database.Database,
  settings: AletheiaSettings,
  sessionState: Map<string, unknown>,
  frequencyManager: FrequencyManager
): Record<string, (req: http.IncomingMessage, res: http.ServerResponse) => void> {
  return {
    'GET /state': (_req, res) => {
      const { injectL1 } = frequencyManager.tick();
      if (!injectL1) {
        res.writeHead(200);
        res.end(JSON.stringify({}));
        return;
      }

      const payload = buildL1Payload(db, settings, sessionState);
      frequencyManager.updateHash('l1', payload);

      res.writeHead(200);
      res.end(JSON.stringify(payload ?? {}));
    },

    'GET /context': (_req, res) => {
      const { injectL2 } = frequencyManager.tick();
      if (!injectL2) {
        res.writeHead(200);
        res.end(JSON.stringify({}));
        return;
      }

      const payload = buildL2Payload(db, settings, sessionState);
      frequencyManager.updateHash('l2', payload);

      res.writeHead(200);
      res.end(JSON.stringify(payload ?? {}));
    },

    'GET /session-info': (_req, res) => {
      const claimedEntry = sessionState.get('claimedEntry') as string | undefined;
      const claimedKey = sessionState.get('claimedKey') as { id: string; permissions: string; entryScope: string | null } | undefined;
      const entryCount = sessionState.get('entryCount') as number | undefined;

      res.writeHead(200);
      res.end(JSON.stringify({
        claimed: !!claimedKey,
        hasEntry: !!claimedEntry,
        claimedEntry: claimedEntry ?? null,
        permissions: claimedKey?.permissions ?? null,
        entryCount: entryCount ?? 0,
        disableSystemMemory: settings.memory.disableSystemMemory,
      }));
    },

    'GET /handoff': (_req, res) => {
      const claimedEntry = sessionState.get('claimedEntry') as string | undefined;
      if (!claimedEntry) {
        res.writeHead(200);
        res.end(JSON.stringify({ handoff: null }));
        return;
      }

      // Peek without consuming — direct SELECT, not readHandoff
      const row = db.prepare(
        `SELECT content, tags, created_by, created_at FROM handoffs WHERE target_key = ?`
      ).get(claimedEntry) as { content: string; tags: string | null; created_by: string | null; created_at: string } | undefined;

      res.writeHead(200);
      res.end(JSON.stringify({
        handoff: row ? {
          content: row.content,
          tags: row.tags,
          createdBy: row.created_by,
          createdAt: row.created_at,
        } : null,
      }));
    },
  };
}
