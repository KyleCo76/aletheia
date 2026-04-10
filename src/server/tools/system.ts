import type Database from 'better-sqlite3';
import type { AletheiaSettings } from '../../lib/settings.js';

type ToolHandler = (args: Record<string, unknown>) => {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

const HELP_TOPICS: Record<string, string> = {
  general:
    'Aletheia is a structured memory system for Claude Code that persists knowledge across sessions. ' +
    'Core concepts:\n' +
    '- Journal: timestamped observations captured during a session (write_journal)\n' +
    '- Memory: distilled, long-lived knowledge synthesized from journals (write_memory)\n' +
    '- Status: living documents that track multi-step workflow state (read_status, update_status)\n' +
    '- Handoff: structured session summaries for teammate continuity (write_handoff)\n\n' +
    'Aletheia uses temporal framing: journals are "what happened," memories are "what we know," ' +
    'and status is "where things stand." Use search(tags: ["topic"]) to discover existing knowledge. ' +
    'Use help(topic) for details on: journal, memory, status, tags, permissions.',

  journal:
    'Journals capture observations, decisions, and context during a session.\n\n' +
    'Usage: write_journal(content, tags: ["topic1", "topic2"])\n' +
    '- content: free-text observation or decision\n' +
    '- tags: categorize for later discovery\n' +
    '- critical: true — flags the entry for immediate promotion to memory ' +
    '(use for decisions, constraints, or corrections that must survive session boundaries)\n\n' +
    'Digest process: a digest teammate periodically scans undigested journals, identifies patterns ' +
    '(3+ mentions = pattern, not noise), and synthesizes them into memories via promote_to_memory(). ' +
    'Raw journals are preserved for provenance — memories link back to their source entries.\n\n' +
    'Search journals: search(entry_class: "journal", tags: ["topic"])',

  memory:
    'Memories are persistent, distilled knowledge — the "things we know" layer.\n\n' +
    'Usage: write_memory(key, value, tags: ["topic"])\n' +
    '- key: unique identifier (e.g., "auth-strategy", "deploy-process")\n' +
    '- value: the synthesized knowledge\n' +
    '- Writing to an existing key updates it (requires version_id for OCC)\n\n' +
    'OCC (Optimistic Concurrency Control): every memory has a version_id. To update, pass the ' +
    'current version_id — if another agent updated it first, you get a conflict error. ' +
    'Re-read, merge, and retry.\n\n' +
    'retire_memory(entry_id, reason): archives a memory that is outdated or contradicted. ' +
    'Retired memories remain searchable for historical context but are excluded from active recall.',

  status:
    'Status documents are living state-machines for tracking multi-step workflows.\n\n' +
    'Lifecycle: read_status() -> replace_status(doc) or update_status(section, content)\n' +
    '- Sections have a name, content, state (e.g., "pending", "in-progress", "done"), and position\n' +
    '- add_section(name, content, state) / remove_section(name) to modify structure\n' +
    '- update_status(section, content, continue: true) appends to a section without replacing it\n\n' +
    'Status docs are ephemeral by design — they track "where things stand right now" and are ' +
    'typically replaced each session. For persistent knowledge, promote insights to memory.',

  tags:
    'Tags are the primary discovery mechanism in Aletheia.\n\n' +
    '- Assigned at creation: write_journal(content, tags: ["api", "auth"])\n' +
    '- Normalized for comparison: lowercased with hyphens, underscores, and spaces removed ' +
    '(e.g., "API Auth", "api-auth", "api_auth" all match). The original tag form is preserved.\n' +
    '- list_tags() shows all tags with usage counts\n' +
    '- search(tags: ["topic"]) finds entries across all classes (journal, memory, handoff)\n' +
    '- Entries can have multiple tags; search matches any tag in the list\n\n' +
    'Best practices: reuse existing tags from list_tags() for consistency. ' +
    'Use specific tags ("error-handling") over generic ones ("code"). ' +
    'Related entries sharing tags form an implicit knowledge graph.',

  permissions:
    'Aletheia uses a key hierarchy for multi-agent access control.\n\n' +
    'Key types (ascending privilege):\n' +
    '- read-only: search and read operations only\n' +
    '- read-write: can create journals and update status\n' +
    '- create-sub-entries: can create child entries and sub-keys\n' +
    '- maintenance: full access including memory writes, retirements, and key management\n\n' +
    'Setup flow:\n' +
    '1. bootstrap(project_name) — initializes the project and returns a root maintenance key\n' +
    '2. create_key(permission_level) — generates keys for teammates\n' +
    '3. claim(key) — authenticates a session with a key\n' +
    '4. whoami() — confirms current identity and permissions\n\n' +
    'Single-agent mode skips key management entirely — all operations are permitted.',
};

export function registerSystemTools(
  handlers: Record<string, ToolHandler>,
  db: Database.Database,
  _settings: AletheiaSettings,
  _sessionState: Map<string, unknown>,
): void {
  handlers['help'] = (args) => {
    const topic = (args.topic as string | undefined) ?? 'general';
    const text = HELP_TOPICS[topic];

    if (!text) {
      const available = Object.keys(HELP_TOPICS).join(', ');
      return {
        content: [{
          type: 'text',
          text: `<result><help>Unknown topic "${topic}". Available: ${available}</help></result>`,
        }],
      };
    }

    return {
      content: [{
        type: 'text',
        text: `<result><help topic="${topic}">${text}</help></result>`,
      }],
    };
  };

  handlers['health'] = () => {
    const entryCounts = db.prepare(
      `SELECT entry_class, COUNT(*) as count FROM entries GROUP BY entry_class`,
    ).all() as Array<{ entry_class: string; count: number }>;

    const tagCount = db.prepare(
      `SELECT COUNT(*) as count FROM tags`,
    ).get() as { count: number };

    const memoryStats = db.prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN archived_at IS NULL THEN 1 ELSE 0 END) as active,
         SUM(CASE WHEN archived_at IS NOT NULL THEN 1 ELSE 0 END) as archived,
         MIN(updated_at) as oldest_update,
         MAX(updated_at) as newest_update
       FROM memory_entries`,
    ).get() as {
      total: number;
      active: number;
      archived: number;
      oldest_update: string | null;
      newest_update: string | null;
    };

    const countsXml = entryCounts
      .map((e) => `<class name="${e.entry_class}">${e.count}</class>`)
      .join('');

    return {
      content: [{
        type: 'text',
        text: `<result><health><entries>${countsXml}</entries><tags>${tagCount.count}</tags><memory total="${memoryStats.total}" active="${memoryStats.active}" archived="${memoryStats.archived}" oldest_update="${memoryStats.oldest_update ?? ''}" newest_update="${memoryStats.newest_update ?? ''}"/></health></result>`,
      }],
    };
  };
}
