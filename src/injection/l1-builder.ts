import type Database from 'better-sqlite3';
import type { AletheiaSettings } from '../lib/settings.js';
import { readStatus } from '../db/queries/status.js';
import { readMemory } from '../db/queries/memory.js';

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function getAccessCounts(sessionState: Map<string, unknown>): Map<string, number> {
  let counts = sessionState.get('accessCounts') as Map<string, number> | undefined;
  if (!counts) {
    counts = new Map<string, number>();
    sessionState.set('accessCounts', counts);
  }
  return counts;
}

export function buildL1Payload(
  db: Database.Database,
  settings: AletheiaSettings,
  sessionState: Map<string, unknown>
): object | null {
  const claimedEntry = sessionState.get('claimedEntry') as string | undefined;
  if (!claimedEntry) return null;

  const budget = settings.injection.tokenBudget;
  let usedTokens = 0;

  const payload: Record<string, unknown> = {};

  // 1. Current status document
  const status = readStatus(db, { entryId: claimedEntry });
  if (status) {
    const statusObj = {
      content: status.content,
      versionId: status.versionId,
      sections: status.sections,
    };
    const statusTokens = estimateTokens(JSON.stringify(statusObj));
    if (usedTokens + statusTokens <= budget) {
      payload.status = statusObj;
      usedTokens += statusTokens;
    }
  }

  // 2. Active memory entries for the claimed entry
  const memories = readMemory(db, { entryId: claimedEntry });
  if (memories.length > 0) {
    const accessCounts = getAccessCounts(sessionState);

    // Sort by recency first, then access frequency
    const sorted = [...memories].sort((a, b) => {
      const timeDiff = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      if (timeDiff !== 0) return timeDiff;
      return (accessCounts.get(b.id) ?? 0) - (accessCounts.get(a.id) ?? 0);
    });

    const includedMemories: typeof memories = [];
    for (const mem of sorted) {
      const memTokens = estimateTokens(JSON.stringify(mem));
      if (usedTokens + memTokens > budget) break;
      includedMemories.push(mem);
      usedTokens += memTokens;
    }

    if (includedMemories.length > 0) {
      payload.memories = includedMemories;
    }
  }

  // 3. Pending handoff (peek without consuming)
  const handoff = db.prepare(
    `SELECT content, tags, created_by, created_at FROM handoffs WHERE target_key = ?`
  ).get(claimedEntry) as { content: string; tags: string | null; created_by: string | null; created_at: string } | undefined;

  if (handoff) {
    const handoffObj = {
      content: handoff.content,
      tags: handoff.tags,
      createdBy: handoff.created_by,
      createdAt: handoff.created_at,
    };
    const handoffTokens = estimateTokens(JSON.stringify(handoffObj));
    if (usedTokens + handoffTokens <= budget) {
      payload.handoff = handoffObj;
    }
  }

  // Note: settings.injection.historyReminders is reserved for future use.
  // When enabled, injection payloads would include a brief "memory unchanged"
  // marker when the content hash doesn't change, instead of skipping entirely.

  return Object.keys(payload).length > 0 ? payload : null;
}
