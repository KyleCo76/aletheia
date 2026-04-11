import type Database from 'better-sqlite3';
import type { AletheiaSettings } from '../lib/settings.js';
import { searchMemory, readMemoriesByProject } from '../db/queries/memory.js';
import { readJournalEntries, readJournalEntriesByProject } from '../db/queries/journal.js';
import { listTags } from '../db/queries/tags.js';

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function buildL2Payload(
  db: Database.Database,
  settings: AletheiaSettings,
  sessionState: Map<string, unknown>
): object | null {
  // Resolve scope: prefer projectNamespace for scoped queries, fall back to
  // claimedEntry as an entry UUID in simple mode.
  const projectNamespace = sessionState.get('projectNamespace') as string | undefined;
  const claimedEntry = sessionState.get('claimedEntry') as string | undefined;
  if (!projectNamespace && !claimedEntry) return null;

  const budget = settings.injection.tokenBudget;
  let usedTokens = 0;

  const payload: Record<string, unknown> = {};

  // 1. Active memory entries within scope. In scoped (multi-agent) mode we
  //    restrict to the project namespace to avoid cross-project leakage;
  //    in simple mode we fall back to the original "all memories" behavior.
  const allMemories = projectNamespace
    ? readMemoriesByProject(db, { projectNamespace })
    : searchMemory(db, {});
  if (allMemories.length > 0) {
    const accessCounts = (sessionState.get('accessCounts') as Map<string, number>) ?? new Map<string, number>();

    const sorted = [...allMemories].sort((a, b) => {
      const timeDiff = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      if (timeDiff !== 0) return timeDiff;
      return (accessCounts.get(b.id) ?? 0) - (accessCounts.get(a.id) ?? 0);
    });

    const includedMemories: typeof allMemories = [];
    for (const mem of sorted) {
      const memTokens = estimateTokens(JSON.stringify(mem));
      // Round-3 P3 fix: see l1-builder.ts for the rationale.
      // Skip oversized items (continue) instead of halting the
      // loop (break) so smaller, older memories still get a
      // fair shot at the remaining budget.
      if (usedTokens + memTokens > budget) continue;
      includedMemories.push(mem);
      usedTokens += memTokens;
    }

    if (includedMemories.length > 0) {
      payload.memories = includedMemories;
    }
  }

  // 2. Recent undigested journal entries (rolling mode, last N)
  const rollingLimit = settings.memory.rollingDefault;
  const journalEntries = projectNamespace
    ? readJournalEntriesByProject(db, {
        projectNamespace,
        mode: 'rolling',
        limit: rollingLimit,
      })
    : readJournalEntries(db, {
        entryId: claimedEntry as string,
        mode: 'rolling',
        limit: rollingLimit,
      });

  if (journalEntries.length > 0) {
    const includedJournal: typeof journalEntries = [];
    for (const entry of journalEntries) {
      const entryTokens = estimateTokens(JSON.stringify(entry));
      // Round-3 P3 fix: skip oversized journal entries instead of
      // halting the loop. Same rationale as the memory loop above.
      if (usedTokens + entryTokens > budget) continue;
      includedJournal.push(entry);
      usedTokens += entryTokens;
    }

    if (includedJournal.length > 0) {
      payload.journal = includedJournal;
    }
  }

  // 3. Tag list with counts
  const tags = listTags(db);
  if (tags.length > 0) {
    const tagsTokens = estimateTokens(JSON.stringify(tags));
    if (usedTokens + tagsTokens <= budget) {
      payload.tags = tags;
    }
  }

  // 4. Undigested journal entry count (for digest threshold detection)
  const undigestedCount = projectNamespace
    ? (db.prepare(
        `SELECT COUNT(*) as count FROM journal_entries j
         JOIN entries e ON j.entry_id = e.id
         WHERE e.project_namespace = ? AND j.digested_at IS NULL`
      ).get(projectNamespace) as { count: number })
    : (db.prepare(
        `SELECT COUNT(*) as count FROM journal_entries WHERE entry_id = ? AND digested_at IS NULL`
      ).get(claimedEntry) as { count: number });

  payload.undigestedJournalCount = undigestedCount.count;
  payload.digestThreshold = settings.digest.entryThreshold;

  return Object.keys(payload).length > 0 ? payload : null;
}
