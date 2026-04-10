import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createConnection } from '../db/connection.js';
import { runMigrations } from '../db/schema.js';
import { startSocketServer, getSocketServerPath } from './socket.js';
import { loadSettings } from '../lib/settings.js';
import { DATA_DIR } from '../lib/constants.js';
import { formatError } from '../lib/errors.js';
import { registerAuthTools } from './tools/auth.js';
import type { ToolHandler } from './tools/auth.js';
import { registerEntryTools } from './tools/entries.js';
import { registerJournalTools } from './tools/journal.js';
import { registerMemoryTools } from './tools/memory.js';
import { registerDiscoveryTools } from './tools/discovery.js';
import { registerStatusTools } from './tools/status.js';
import { registerHandoffTools } from './tools/handoff.js';
import { registerSystemTools } from './tools/system.js';
import { FrequencyManager } from '../injection/frequency.js';
import fs from 'fs';

const TOOL_DEFINITIONS = [
  {
    name: 'claim',
    description: 'Claim or register this session with an API key',
    inputSchema: {
      type: 'object' as const,
      properties: { key: { type: 'string', description: 'The API key to claim' } },
      required: ['key'],
    },
  },
  {
    name: 'whoami',
    description: 'Show current session identity',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'bootstrap',
    description: 'Bootstrap a new project (one-time init)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Project name' },
        enforce_permissions: { type: 'boolean', description: 'Whether to enforce permissions' },
      },
      required: ['name'],
    },
  },
  {
    name: 'create_key',
    description: 'Create a new API key',
    inputSchema: {
      type: 'object' as const,
      properties: {
        permissions: { type: 'string', description: 'Permission level: read-only, read-write, create-sub-entries, or maintenance' },
        entry_scope: { type: 'string', description: 'Optional entry scope for the key' },
      },
      required: ['permissions'],
    },
  },
  {
    name: 'modify_key',
    description: 'Modify an existing API key',
    inputSchema: {
      type: 'object' as const,
      properties: {
        key_id: { type: 'string', description: 'The key ID to modify' },
        permissions: { type: 'string', description: 'New permission level' },
      },
      required: ['key_id', 'permissions'],
    },
  },
  {
    name: 'list_keys',
    description: 'List all API keys beneath caller scope',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'create_entry',
    description: 'Create a new entry',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entry_class: { type: 'string', description: 'Entry class: journal, memory, or handoff' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for the entry' },
        template: { type: 'string', description: 'Optional template name' },
      },
      required: ['entry_class'],
    },
  },
  {
    name: 'list_entries',
    description: 'List entries with optional filters',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entry_class: { type: 'string', description: 'Filter by entry class' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags (all must match)' },
      },
    },
  },
  {
    name: 'write_journal',
    description: 'Write a journal entry. Use critical:true for urgent knowledge (requires memory_summary).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entry_id: { type: 'string' }, content: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        critical: { type: 'boolean' }, memory_summary: { type: 'string' },
        skip_related: { type: 'boolean' },
      },
      required: ['entry_id', 'content'],
    },
  },
  {
    name: 'write_memory',
    description: 'Write a memory entry (key-value with OCC versioning)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entry_id: { type: 'string' }, key: { type: 'string' }, value: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        version_id: { type: 'string' }, supersedes: { type: 'string' },
      },
      required: ['entry_id', 'key', 'value'],
    },
  },
  {
    name: 'retire_memory',
    description: 'Retire (archive) a memory entry',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entry_id: { type: 'string' }, memory_entry_id: { type: 'string' }, reason: { type: 'string' },
      },
      required: ['entry_id', 'memory_entry_id'],
    },
  },
  {
    name: 'promote_to_memory',
    description: 'Promote a journal entry to memory (explicit path)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        journal_id: { type: 'string' }, synthesized_knowledge: { type: 'string' },
        key: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['journal_id', 'synthesized_knowledge', 'key'],
    },
  },
  {
    name: 'read_memory_history',
    description: 'Query previous versions of a memory entry (full snapshots)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entry_id: { type: 'string' }, key: { type: 'string' }, limit: { type: 'number' },
      },
      required: ['entry_id', 'key'],
    },
  },
  {
    name: 'search',
    description: 'Search entries across all types',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entry_class: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } },
        query: { type: 'string' }, include_archived: { type: 'boolean' },
      },
    },
  },
  {
    name: 'read',
    description: 'Read an entry by ID (auto-detects type). Related entries shown by default; set show_related: false to hide.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entry_id: { type: 'string' }, mode: { type: 'string' },
        limit: { type: 'number' }, show_related: { type: 'boolean' },
      },
      required: ['entry_id'],
    },
  },
  {
    name: 'list_tags',
    description: 'List all active tags with entry counts',
    inputSchema: { type: 'object' as const, properties: { entry_class: { type: 'string' } } },
  },
  {
    name: 'read_status',
    description: 'Read the status document or a specific section',
    inputSchema: {
      type: 'object' as const,
      properties: { entry_id: { type: 'string' }, section_id: { type: 'string' } },
      required: ['entry_id'],
    },
  },
  {
    name: 'replace_status',
    description: 'Replace the entire status document (OCC required)',
    inputSchema: {
      type: 'object' as const,
      properties: { entry_id: { type: 'string' }, content: { type: 'string' }, version_id: { type: 'string' } },
      required: ['entry_id', 'content', 'version_id'],
    },
  },
  {
    name: 'update_status',
    description: 'Update a status section atomically. Set continue:true to get next section.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entry_id: { type: 'string' }, section_id: { type: 'string' },
        state: { type: 'string' }, continue: { type: 'boolean' },
      },
      required: ['entry_id', 'section_id'],
    },
  },
  {
    name: 'add_section',
    description: 'Add a section to the status document',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entry_id: { type: 'string' }, section_id: { type: 'string' },
        content: { type: 'string' }, position: { type: 'number' },
      },
      required: ['entry_id', 'section_id', 'content'],
    },
  },
  {
    name: 'remove_section',
    description: 'Remove a section from the status document',
    inputSchema: {
      type: 'object' as const,
      properties: { entry_id: { type: 'string' }, section_id: { type: 'string' } },
      required: ['entry_id', 'section_id'],
    },
  },
  {
    name: 'create_handoff',
    description: 'Create a handoff (mailbox overwrite)',
    inputSchema: {
      type: 'object' as const,
      properties: { target_key: { type: 'string' }, content: { type: 'string' }, tags: { type: 'string' } },
      required: ['target_key', 'content'],
    },
  },
  {
    name: 'read_handoff',
    description: 'Read and consume your handoff slot',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'help',
    description: 'Show contextual help about Aletheia',
    inputSchema: { type: 'object' as const, properties: { topic: { type: 'string' } } },
  },
  {
    name: 'health',
    description: 'Check server health and show entry statistics',
    inputSchema: { type: 'object' as const, properties: {} },
  },
];

export async function main(): Promise<void> {
  // 1. Ensure data directory exists and create SQLite connection
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = createConnection();

  // 2. Run migrations
  runMigrations(db);

  // 3. Load settings
  const settings = loadSettings();

  // 4. Create MCP Server instance
  const server = new Server(
    { name: 'aletheia', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  // 5. Set up tool handler registry
  const sessionState = new Map<string, unknown>();
  const handlers: Record<string, ToolHandler> = {};

  registerAuthTools(handlers, db, settings, sessionState);
  registerEntryTools(handlers, db, settings, sessionState);
  registerJournalTools(handlers, db, settings, sessionState);
  registerMemoryTools(handlers, db, settings, sessionState);
  registerDiscoveryTools(handlers, db, settings, sessionState);
  registerStatusTools(handlers, db, settings, sessionState);
  registerHandoffTools(handlers, db, settings, sessionState);
  registerSystemTools(handlers, db, settings, sessionState);

  // 6. Register tool list and dispatch handlers
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOL_DEFINITIONS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const handler = handlers[request.params.name];
    if (handler) {
      return handler((request.params.arguments ?? {}) as Record<string, unknown>);
    }

    return {
      content: [{ type: 'text', text: formatError('UNKNOWN_TOOL', `Unknown tool: ${request.params.name}`) }],
      isError: true,
    };
  });

  // 7. Start socket HTTP server
  const frequencyManager = new FrequencyManager(settings);
  await startSocketServer(db, settings, sessionState, frequencyManager);

  // Set ALETHEIA_SOCK so hooks can discover the socket path
  process.env.ALETHEIA_SOCK = getSocketServerPath();

  // 8. Connect StdioServerTransport (this blocks — must be last)
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[aletheia] MCP server running on stdio');
}

main().catch((err) => {
  console.error('[aletheia] Fatal error:', err);
  process.exit(1);
});
