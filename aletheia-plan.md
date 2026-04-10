---
title: "Aletheia Implementation Plan"
date: 2026-04-09
type: implementation-plan
feature: "aletheia"
design-doc: "docs/plans/designs/2026-04-08-aletheia-design.md"
tier: 2
---

# Implementation Plan: Aletheia

<!-- plan-index:start -->
<!-- verified:2026-04-09T23:30:00 -->
<!-- overview lines:43-100 -->
<!-- phase-summary lines:102-131 -->
<!-- phase:1 lines:133-445 title:"Foundation" -->
<!-- conductor-review:1 lines:447-480 -->
<!-- phase:2 lines:482-670 title:"Server Infrastructure + Data Layer" -->
<!-- conductor-review:2 lines:672-711 -->
<!-- phase:3 lines:713-854 title:"MCP Tools + Injection System" -->
<!-- conductor-review:3 lines:856-893 -->
<!-- phase:4 lines:895-1015 title:"Hooks + CLI + Setup" -->
<!-- conductor-review:4 lines:1017-1052 -->
<!-- phase:5 lines:1054-1155 title:"Content + Packaging + Integration" -->
<!-- conductor-review:5 lines:1157-1185 -->
<!-- plan-index:end -->

<sections>
- overview
- phase-summary
- phase-1
- conductor-review-1
- phase-2
- conductor-review-2
- phase-3
- conductor-review-3
- phase-4
- conductor-review-4
- phase-5
- conductor-review-5
</sections>

<!-- overview -->
<section id="overview">
## Overview

<core>
Aletheia is a complete, self-contained memory system for Claude Code distributed as a global npm package. It replaces the built-in MEMORY.md with a structured, searchable, permission-aware, multi-session knowledge base backed by SQLite. The name comes from the Greek a-lethe-ia ("un-forgetting") — the etymological opposite of the user's existing Lethe session compaction skill. Together they form a memory lifecycle: Lethe forgets from the conversation window, Aletheia un-forgets into persistent storage.

The package comprises: an MCP server with dual-interface (stdio for Claude Code + Unix domain socket HTTP server for hooks), a SQLite database in WAL mode, 5 hook scripts for context injection and enforcement, a CLI tool for setup/teardown, and configurable entry templates including a digest teammate prompt.

**End goals:**
- Solo developers get zero-config persistent memory with structured entries (journal, memory, status, handoff) that survives across sessions
- Multi-agent teams get permission-controlled shared memory with key-based authentication, scoped read/write access, and cross-session knowledge sharing
- Claude captures knowledge into journals with minimal cognitive overhead; a dedicated digest teammate synthesizes journals into condensed memories asynchronously
- Adaptive injection (L1/L2) keeps Claude's context populated with relevant memory without burning tokens on unchanged content
- The system works on a fresh OS install with no assumptions about existing tools — Linux, macOS, and Windows supported

**Key decisions from planning:**
- **Dual-interface MCP server** (not separate sidecar): the MCP server serves stdio for Claude + Unix socket HTTP for hooks in the same Node.js process. Multiple sessions share SQLite via WAL. No daemon, no background processes.
- **Hybrid OCC**: Solo mode disables concurrency control entirely. Multi-agent mode uses state-forwarding errors (failed writes return current state for immediate retry). Status section operations are server-side atomic.
- **"Dumb Capture, Smart Digest"**: Working Claude writes to journal only (no promotion decisions). An autonomous digest teammate is spawned at configurable thresholds to synthesize journal entries into condensed memories and retire stale ones. Critical escape hatch available for urgent knowledge.
- **Minimum Viable Lifecycle**: retire_memory (soft delete), digest-driven cleanup, handoff overwrite model (mailbox slot, not queue), supersedes auto-retire, journal tiering (digested entries excluded from injection).
- **~21 MCP tools** with targeted consolidations: unified search(entry_class?, tags?, query?), unified read(entry_id), simplified handoff (overwrite + consume, no IDs). Tool schemas use deferred loading.
- **POSIX sh hooks** (primary, Linux/macOS) + **Node.js hooks** (Windows fallback). Platform detected at setup time.
- **TypeScript ESM** project with better-sqlite3 (synchronous WAL), smol-toml (settings), proper-lockfile (socket startup coordination).
- **Container + per-class content tables** in SQLite: unified entries table for cross-type search, separate journal_entries/memory_entries/handoffs/status_documents tables for class-specific operations.

**Constraints (inviolable, from design):**
- Fresh system design: no assumptions about existing tools, OS, or MCP servers
- Hooks are the primary enforcement layer, not Claude's instruction-following
- Higher-tier memories are read-only to non-creators; changes controlled by entry creator
- Key-based permission model with downward-only scoping and no self-promotion
- Simple default mode must require zero setup, zero keys, zero configuration
- Journal entries are immutable after creation (append-only)
- Status is for information that won't matter tomorrow; Memory is for information that will matter next week

**Feasibility verification (normal mode — Gemini available throughout):**
- Dual-interface pattern (stdio + socket in same process): VERIFIED — no event loop conflicts. Critical constraint: no console.log() anywhere (stdout is MCP JSON-RPC channel).
- better-sqlite3 multi-process WAL: VERIFIED — concurrent read/write safe with busy_timeout. Requires BEGIN IMMEDIATE for write transactions to prevent deadlock.
- Socket startup requires lockfile coordination: VERIFIED — race condition on simultaneous starts confirmed. proper-lockfile handles stale lock recovery.
- npm global packaging with hooks + CLI + MCP server: VERIFIED — standard pattern.
- Windows support: VERIFIED — all components have cross-platform paths (Named Pipes, Node.js hooks, libuv PID checking).

**User overrides:** None.
</core>

<context>
This plan was produced from a Dramaturg design session (2026-04-08) followed by a multi-perspective design review. The review session used a Claude teammate (behavioral/usage perspective) and Gemini (technical architecture) to identify 3 critical design flaws, all resolved before planning:

1. Process topology collision (separate sidecar can't handle multi-session) → resolved via dual-interface MCP
2. OCC incompatible with LLM context compaction → resolved via hybrid OCC strategy
3. promote_to_memory behaviorally unreliable → resolved via Dumb Capture, Smart Digest

The Dramaturg journal at docs/plans/designs/decisions/custom-memory-server/dramaturg-journal.md contains the full decision trail including Phase 9 revisions. The Arranger journal at docs/plans/designs/decisions/aletheia/arranger-journal.md contains feasibility findings and implementation decisions.

Note: The design document itself (2026-04-08-aletheia-design.md) has NOT been updated to reflect Phase 9 revisions. Five revisions in the Dramaturg journal supersede sections of the design doc. This plan is built from the revised decisions.
</context>
</section>
<!-- /overview -->

<!-- phase-summary -->
<section id="phase-summary">
## Phase Summary

<core>
| Phase | Title | Depends On | Parallelization |
|-------|-------|-----------|-----------------|
| 1 | Foundation | None | 3 parallel tasks: scaffolding, SQLite schema + migrations, platform abstraction |
| 2 | Server Infrastructure + Data Layer | Phase 1 | 2 parallel tracks: server (MCP skeleton, socket server, settings) ‖ data (query modules, data behaviors) |
| 3 | MCP Tools + Injection System | Phase 2 | 4 parallel tasks: auth+entry tools, journal+memory+discovery tools, status+handoff tools, injection system |
| 4 | Hooks + CLI + Setup | Phase 3 | 3 parallel tasks: Unix hooks ‖ Windows hooks ‖ CLI+setup |
| 5 | Content + Packaging + Integration | Phase 4 | 3 tasks: templates+content ‖ npm packaging, then integration testing |

**Total phases:** 5
**Critical path:** Phase 1 → Phase 2 (data track) → Phase 3 (tools) → Phase 4 (hooks) → Phase 5 (packaging)
**Maximum parallelization:** Phase 2 runs 2 independent tracks (5 tasks). Phase 3 runs 4 independent tool groups. Phase 4 runs 3 independent tasks.

**Danger files:**
- `src/server/socket.ts` — Phase 2 (bind/lifecycle) + Phase 3 (injection endpoints)
- `package.json` — Phase 1 (initial) + Phase 5 (packaging finalization)

**Integration surfaces (Conductor verification points):**
1. Schema → Query modules (Phase 1→2): table/column names, index names
2. Query modules → Tools (Phase 2→3): function signatures, return types
3. Socket endpoints → Hooks (Phase 3→4): endpoint paths, JSON response format
4. Tool surface → CLI setup (Phase 3→4): tool names for MCP server registration
5. All → Packaging (Phase 1-4→5): file paths, entry points, hook script locations
</core>
</section>
<!-- /phase-summary -->

<!-- phase:1 -->
<section id="phase-1">
## Phase 1: Foundation

<core>
### Objective
Establish the project skeleton, SQLite database schema with all tables, connection management, and the platform abstraction layer. This phase creates the foundation that all subsequent phases build upon. All three tasks are independent and parallelizable.

### Prerequisites
None — this is the first phase. Requires Node.js 18+ and npm installed.

### Implementation

<mandatory>All source files use TypeScript with ESM (type: "module" in package.json). No CommonJS. All imports use explicit .js extensions in import paths (TypeScript ESM requirement). No console.log() anywhere in the codebase — stdout is reserved for MCP JSON-RPC. Use console.error() for all diagnostic output.</mandatory>

**Project Scaffolding**

Initialize the npm package at the project root:

```json
{
  "name": "aletheia",
  "version": "0.1.0",
  "type": "module",
  "bin": { "aletheia": "./dist/cli/cli.js" },
  "files": ["dist", "hooks"],
  "engines": { "node": ">=18.0.0" },
  "dependencies": {
    "@modelcontextprotocol/sdk": "latest",
    "better-sqlite3": "latest",
    "smol-toml": "latest",
    "proper-lockfile": "latest"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "@types/better-sqlite3": "latest",
    "@types/node": "^18.0.0"
  },
  "scripts": {
    "build": "tsc",
    "prepare": "npm run build"
  }
}
```

tsconfig.json — strict TypeScript, ESM output:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "declaration": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"]
}
```

Directory structure to create:
```
src/
  server/
    index.ts          # MCP server entry point (skeleton in this phase)
    socket.ts          # Unix socket HTTP server (skeleton in this phase)
    tools/             # Tool implementations (Phase 3)
  db/
    connection.ts      # SQLite connection setup
    schema.ts          # Table definitions + migration runner
    queries/           # Per-table query modules (Phase 2)
  hooks/
    unix/              # POSIX sh hooks (Phase 4)
    windows/           # Node.js hooks (Phase 4)
  cli/
    cli.ts             # CLI entry point (Phase 4)
    setup.ts           # Setup logic (Phase 4)
    teardown.ts        # Teardown logic (Phase 4)
  injection/           # L1/L2 builders (Phase 3)
  permissions/         # Key management (Phase 2/3)
  templates/           # Default templates (Phase 5)
  lib/
    platform.ts        # Platform abstraction
    constants.ts       # Shared constants (paths, defaults)
    errors.ts          # Error types and XML formatting
```

`src/lib/constants.ts` — central path and default definitions:
```typescript
import os from 'os';
import path from 'path';

export const ALETHEIA_HOME = path.join(os.homedir(), '.aletheia');
export const SOCKETS_DIR = path.join(ALETHEIA_HOME, 'sockets');
export const KEYS_DIR = path.join(ALETHEIA_HOME, 'keys');
export const DATA_DIR = path.join(ALETHEIA_HOME, 'data');
export const TEMPLATES_DIR = path.join(ALETHEIA_HOME, 'templates');
export const LOGS_DIR = path.join(ALETHEIA_HOME, 'logs');
export const SETTINGS_PATH = path.join(ALETHEIA_HOME, 'settings.toml');
export const DB_PATH = path.join(DATA_DIR, 'aletheia.db');
export const LOCKFILE_PATH = path.join(SOCKETS_DIR, 'startup.lock');

export const DEFAULTS = {
  l1Interval: 10,
  l2Interval: 20,
  tokenBudget: 1500,
  digestEntryThreshold: 15,
  digestTimeThresholdHours: 4,
  hookTimeoutSeconds: 2,
  showRelatedDefaultThreshold: 1,
  circuitBreakerWritesPerInterval: 20,
  circuitBreakerIntervalMinutes: 5,
  criticalWriteCap: 3,
  adaptiveNoChangeBumpMultiplier: 2,
} as const;
```

`src/lib/errors.ts` — concise XML error formatting per design:
```typescript
export function formatError(code: string, message: string): string {
  return `<error code="${code}">${message}</error>`;
}
```

**SQLite Database**

`src/db/connection.ts` — connection factory with WAL + PRAGMAs:
```typescript
import Database from 'better-sqlite3';
import { DB_PATH } from '../lib/constants.js';

export function createConnection(dbPath: string = DB_PATH): Database.Database {
  const db = new Database(dbPath, { timeout: 5000 });
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -20000');
  db.pragma('wal_autocheckpoint = 1000');
  db.pragma('foreign_keys = ON');
  return db;
}
```

<mandatory>All write transactions must use better-sqlite3's .immediate() mode to prevent deadlock in multi-process scenarios. Never use default DEFERRED transactions for writes.</mandatory>

`src/db/schema.ts` — full schema definition + migration runner:

```sql
-- schema version 1

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  entry_class TEXT NOT NULL CHECK(entry_class IN ('journal', 'memory', 'handoff')),
  project_namespace TEXT,
  created_by_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES entries(id),
  content TEXT NOT NULL,
  sub_section TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  digested_at TEXT
);
CREATE INDEX idx_journal_undigested ON journal_entries(entry_id) WHERE digested_at IS NULL;

CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES entries(id),
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  version_id TEXT NOT NULL,
  archived_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_memory_active ON memory_entries(entry_id) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX idx_memory_entry_key ON memory_entries(entry_id, key) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS memory_versions (
  id TEXT PRIMARY KEY,
  memory_entry_id TEXT NOT NULL REFERENCES memory_entries(id),
  previous_value TEXT NOT NULL,
  previous_version_id TEXT NOT NULL,
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS handoffs (
  target_key TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  tags TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS status_documents (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES entries(id),
  content TEXT NOT NULL,
  undo_content TEXT,
  version_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS status_sections (
  id TEXT PRIMARY KEY,
  status_id TEXT NOT NULL REFERENCES status_documents(id),
  section_id TEXT NOT NULL,
  content TEXT NOT NULL,
  state TEXT,
  position INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_status_section ON status_sections(status_id, section_id);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS entry_tags (
  entry_id TEXT NOT NULL REFERENCES entries(id),
  tag_id INTEGER NOT NULL REFERENCES tags(id),
  PRIMARY KEY (entry_id, tag_id)
);
CREATE INDEX idx_entry_tags_tag ON entry_tags(tag_id);

CREATE TABLE IF NOT EXISTS memory_journal_provenance (
  memory_entry_id TEXT NOT NULL REFERENCES memory_entries(id),
  journal_entry_id TEXT NOT NULL REFERENCES journal_entries(id),
  PRIMARY KEY (memory_entry_id, journal_entry_id)
);

CREATE TABLE IF NOT EXISTS keys (
  id TEXT PRIMARY KEY,
  key_value TEXT NOT NULL UNIQUE,
  permissions TEXT NOT NULL CHECK(permissions IN ('read-only', 'read-write', 'create-sub-entries', 'maintenance')),
  created_by TEXT,
  entry_scope TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE VIEW active_tags AS
  SELECT DISTINCT t.id, t.name
  FROM tags t
  JOIN entry_tags et ON t.id = et.tag_id
  JOIN entries e ON et.entry_id = e.id
  LEFT JOIN memory_entries me ON e.id = me.entry_id
  WHERE e.entry_class != 'memory' OR me.archived_at IS NULL;
```

The migration runner pattern:
```typescript
export function runMigrations(db: Database.Database): void {
  const currentVersion = getSchemaVersion(db);
  if (currentVersion < 1) { runMigration1(db); setSchemaVersion(db, 1); }
}
```

**Platform Abstraction**

`src/lib/platform.ts`:
```typescript
import os from 'os';
import path from 'path';
import { SOCKETS_DIR } from './constants.js';

export function getSocketPath(pid: number = process.pid): string {
  if (os.platform() === 'win32') {
    return `\\\\.\\pipe\\aletheia-${pid}`;
  }
  return path.join(SOCKETS_DIR, `aletheia-${pid}.sock`);
}

export function isWindows(): boolean {
  return os.platform() === 'win32';
}
```

<guidance>
Generate unique IDs for entries using crypto.randomUUID() (available in Node.js 18+). No external UUID library needed. For version_ids, use a shorter format: crypto.randomBytes(8).toString('hex') produces a 16-character hex string sufficient for OCC versioning.
</guidance>

### Integration Points
- **Schema → Phase 2 query modules:** Table names, column names, column types, and index names defined here are consumed by all query modules in Phase 2. The schema is the contract.
- **Connection module → everything:** All database access goes through createConnection(). PRAGMAs set here apply to every consumer.
- **Platform abstraction → Phase 2 socket server:** getSocketPath() is called by the socket server to determine where to bind.
- **Constants → everything:** ALETHEIA_HOME, DB_PATH, DEFAULTS are referenced throughout all subsequent phases.
- **Error formatting → Phase 3 tools:** formatError() produces the `<error code="CODE">message</error>` format used by all tool error responses.

### Expected Outcomes
After Phase 1 completes:
- `npm run build` succeeds with zero errors
- `src/db/schema.ts` creates all tables when run against a fresh SQLite database
- `src/lib/platform.ts` returns correct socket path for the current OS
- All constants are importable from `src/lib/constants.js`
- Directory structure exists with placeholder files for Phase 2+ modules

### Testing Recommendations
- Schema creation: run migration against in-memory SQLite (`:memory:`), verify all tables exist with correct columns
- Platform abstraction: verify Unix socket path on Linux/macOS, Named Pipe path on Windows (or mock os.platform())
- Connection module: verify PRAGMAs are set correctly after createConnection()
</core>
</section>
<!-- /phase:1 -->

<!-- conductor-review:1 -->
<section id="conductor-review-1">
## Conductor Review: Post-Phase 1

<core>
<mandatory>All checklist items must be verified before proceeding to Phase 2.</mandatory>

### Verification Checklist

- [ ] `npm run build` completes with zero TypeScript errors
- [ ] SQLite schema creates all 10 tables + 1 view when run against fresh database: entries, journal_entries, memory_entries, memory_versions, handoffs, status_documents, status_sections, tags, entry_tags, memory_journal_provenance, keys, active_tags (view)
- [ ] All indexes created: idx_journal_undigested, idx_memory_active, idx_memory_entry_key, idx_entry_tags_tag, idx_status_section
- [ ] schema_version table exists and returns version 1 after migration
- [ ] `createConnection()` returns a database with WAL mode enabled (verify: `PRAGMA journal_mode` returns 'wal')
- [ ] `getSocketPath()` returns a path under `~/.aletheia/sockets/` on Unix or `\\.\pipe\` on Windows
- [ ] No `console.log()` calls exist anywhere in `src/` (grep verification)
- [ ] All imports use explicit `.js` extensions

### Known Risks
- Schema changes after Phase 1 require migration version bump — if Phase 2 query development reveals a missing column or index, a migration 2 must be added, not an edit to migration 1.
- The `active_tags` view joins across entries and memory_entries — verify it returns correct results when memory entries with both active and archived states exist.

### Guidance for Phase 2

<guidance>
Phase 2 has two parallel tracks: server infrastructure (Tasks A-C) and data layer (Tasks D-E). These touch completely different files and can run concurrently.

Recommended task decomposition:
- Track 1: MCP server skeleton (src/server/index.ts), socket HTTP server (src/server/socket.ts), settings parsing (src/lib/settings.ts)
- Track 2: Query modules — one per table group. Suggested grouping: journal queries, memory queries (including OCC + versioning), status queries (including section CRUD + undo buffer), handoff queries, tag queries (including normalization), key/permission queries, provenance queries
</guidance>
</core>
</section>
<!-- /conductor-review:1 -->

<!-- phase:2 -->
<section id="phase-2">
## Phase 2: Server Infrastructure + Data Layer

<core>
### Objective
Build both the server infrastructure (MCP skeleton, socket HTTP server, settings parsing) and the complete data access layer (query modules for all tables, OCC logic, version history, tag similarity, journal tiering). These two tracks are independent and parallelizable — they touch completely different files.

### Prerequisites
- Phase 1 complete: all tables exist, `createConnection()` works, platform abstraction available, constants defined
- `better-sqlite3`, `smol-toml`, `proper-lockfile`, `@modelcontextprotocol/sdk` installed

### Implementation

**Track 1: Server Infrastructure**

**MCP Server Skeleton** (`src/server/index.ts`):

<mandatory>The MCP server entry point must initialize BOTH the stdio transport AND the socket HTTP server. It must never write to stdout except through the MCP SDK's StdioServerTransport. All child processes spawned must have explicit stdio configuration: { stdio: ['ignore', 'pipe', 'pipe'] } or equivalent to prevent stdout inheritance.</mandatory>

Initialization sequence:
1. Create SQLite connection via createConnection()
2. Create MCP Server instance
3. Register all tool handlers (stubs in this phase, implemented in Phase 3)
4. Start socket HTTP server (bind, lockfile, GC)
5. Connect stdio transport (this blocks — must be last)

The MCP server uses `@modelcontextprotocol/sdk`'s `Server` class and `StdioServerTransport`. Tool registration uses `server.setRequestHandler(ListToolsRequestSchema, ...)` and `server.setRequestHandler(CallToolRequestSchema, ...)`. In this phase, register the tool listing with names and schemas but stub the implementations to return placeholder responses.

**Socket HTTP Server** (`src/server/socket.ts`):

Startup sequence with lockfile coordination:
1. Acquire exclusive lock via `proper-lockfile` on `~/.aletheia/sockets/startup.lock`
2. Run garbage collection: glob `~/.aletheia/sockets/aletheia-*.sock`, parse PID from filename, `process.kill(pid, 0)` to check liveness (catch ESRCH = dead, EPERM = alive). For dead PIDs, also attempt socket connection as secondary check. Delete confirmed-stale socket files.
3. Check if own socket path already exists (shouldn't after GC, but defensive)
4. Bind `http.createServer()` to `getSocketPath(process.pid)`
5. `fs.chmodSync(socketPath, '0600')` immediately after bind (Unix only)
6. Release lockfile
7. Register cleanup handlers: `process.on('SIGINT')`, `process.on('SIGTERM')`, `process.on('exit')` → `fs.unlinkSync(socketPath)`

Socket HTTP endpoints (stubs in this phase, populated in Phase 3):
- `GET /health` — returns `{ status: 'ok', pid: process.pid }`
- `GET /state` — returns injection payload (L1 data) — stub
- `GET /context` — returns broader context (L2 data) — stub
- `GET /handoff` — returns pending handoff — stub
- `POST /claim` — claims session — stub

<!-- danger-file: src/server/socket.ts shared-with="phase:3" -->

<guidance>
Use Node.js native `http` module — no Express/Fastify needed. The endpoints are simple JSON request/response. Parse URL paths manually or with a minimal router pattern. Keep the socket server lightweight — it serves hooks, not browsers.
</guidance>

**Settings Module** (`src/lib/settings.ts`):

Parse `~/.aletheia/settings.toml` using `smol-toml`. Return merged defaults + user overrides:

```typescript
export interface AletheiaSettings {
  permissions: { enforce: boolean };
  injection: {
    trigger: 'PreToolUse' | 'UserPromptSubmit';
    l1Interval: number;
    l2Interval: number;
    historyReminders: boolean;
    tokenBudget: number;
  };
  memory: {
    disableSystemMemory: boolean;
    rollingDefault: number;
  };
  hooks: {
    startup: boolean;
    l1Injection: boolean;
    l2Injection: boolean;
    memoryInterception: boolean;
    overlapDetection: boolean;
  };
  digest: {
    entryThreshold: number;
    timeThresholdHours: number;
    criticalWriteCap: number;
  };
  debug: boolean;
}
```

If settings file doesn't exist, return all defaults from `DEFAULTS` constant. If file exists but is malformed, log error to stderr and return defaults.

**Track 2: Data Layer**

**Query Module Pattern** — each module in `src/db/queries/` exports functions that accept a `Database` instance:

```typescript
// Example: src/db/queries/journal.ts
import type Database from 'better-sqlite3';

export function appendJournalEntry(db: Database.Database, params: {
  entryId: string; content: string; subSection?: string;
}): { id: string; createdAt: string } { ... }

export function readJournalEntries(db: Database.Database, params: {
  entryId: string; mode?: 'open' | 'rolling'; limit?: number;
}): JournalEntry[] { ... }
```

**Journal Queries** (`src/db/queries/journal.ts`):
- `appendJournalEntry` — INSERT into journal_entries. Wraps in immediate transaction.
- `readJournalEntries` — SELECT with mode: 'open' (all entries) or 'rolling' (last N, default from settings). By default excludes digested entries from rolling reads. Explicit `includeDigested: true` parameter for archive access.
- `searchJournal` — SELECT with optional entry_id filter, tag join, and content LIKE query.
- `markDigested` — UPDATE digested_at = datetime('now') for batch of IDs.

**Memory Queries** (`src/db/queries/memory.ts`):
- `writeMemory` — UPSERT on entry_id + key. If key exists: check version_id for OCC (when enforce_permissions=true), save previous value to memory_versions, generate new version_id, update value. If key doesn't exist: INSERT new row with generated version_id. All in immediate transaction.
- `readMemory` — SELECT active (archived_at IS NULL) entries. Optional key filter. Returns version_id with each entry.
- `retireMemory` — UPDATE archived_at = datetime('now'). Accepts reason parameter, logs to journal_entries as provenance.
- `searchMemory` — SELECT active entries with optional tag join and content LIKE.

<mandatory>OCC check in writeMemory: when enforce_permissions is true and a version_id is provided, compare against current version_id. On mismatch, return state-forwarding error containing current version_id AND current value. When enforce_permissions is false, skip OCC entirely — version_id parameter is ignored.</mandatory>

**Status Queries** (`src/db/queries/status.ts`):
- `readStatus` — SELECT full document or specific section by section_id.
- `replaceStatus` — Full document replace with OCC (version_id check). Saves current content to undo_content before replacing. Immediate transaction.
- `updateStatusSection` — Atomic section state update. No OCC needed. Modifies specific section's state/content without touching other sections.
- `addSection` — INSERT new section at position. Shift existing sections' positions. Immediate transaction.
- `removeSection` — DELETE section, shift positions. Immediate transaction.

<mandatory>Status section operations (updateStatusSection, addSection, removeSection) are atomic at the server level — they do NOT require version_id or OCC. Only replaceStatus (full document rewrite) uses OCC.</mandatory>

**Handoff Queries** (`src/db/queries/handoff.ts`):
- `createHandoff` — INSERT OR REPLACE on target_key (mailbox overwrite). One row per target.
- `readHandoff` — SELECT + DELETE in immediate transaction (consume). If no target_key parameter, use current session's claimed key. Returns content or null.

**Tag Queries** (`src/db/queries/tags.ts`):
- `addTags` — INSERT OR IGNORE into tags table, then INSERT into entry_tags junction. Returns tag similarity suggestions: normalize submitted tags (lowercase, strip hyphens/underscores/spaces), compare against normalized existing tags. If a submitted tag normalizes to match an existing different-surface-form tag, include in response.
- `listTags` — SELECT from active_tags view. Returns tag names with entry counts.
- `searchByTags` — SELECT entries matching specified tags. Joins through entry_tags.
- `getRelatedEntries` — Given an entry's tags, find other entries sharing N+ tags (for show_related). Caps threshold at entry's actual tag count.

**Key/Permission Queries** (`src/db/queries/keys.ts`):
- `createKey` — INSERT with permissions, scope, created_by.
- `validateKey` — SELECT by key_value, return permissions and scope.
- `claimSession` — Associate a key with the current connection (in-memory session state, not DB).
- `modifyKey` — UPDATE permissions. Validate: caller can only modify keys beneath their own scope, cannot self-promote.
- `listKeys` — SELECT keys beneath caller's scope.

**Provenance Queries** (`src/db/queries/provenance.ts`):
- `linkProvenance` — INSERT into memory_journal_provenance.
- `getProvenance` — SELECT journal entries linked to a memory entry.

**Data Behaviors** (integrated into relevant query modules):
- Supersedes auto-retire: when a memory entry is created/updated with a supersedes field, automatically call retireMemory on the superseded entry in the same immediate transaction.
- Memory version snapshot: store diffs internally, render full snapshots when Claude queries previous versions.

<guidance>
All query functions should accept the Database instance as first parameter rather than importing a global connection. This makes testing easy (pass in-memory DB) and supports the multi-connection architecture.

For search queries, SQLite's LIKE operator is sufficient for the initial implementation. FTS5 can be added as a future migration if search performance becomes an issue.
</guidance>

### Integration Points
- **Schema contract (from Phase 1):** All query modules depend on exact table/column names from Phase 1 schema. Any schema change requires migration version bump.
- **Connection module (from Phase 1):** All queries receive a Database instance created by createConnection().
- **Socket server → Phase 3:** Socket HTTP endpoints are stubs in this phase. Phase 3 populates them with injection payload builders.
- **Query modules → Phase 3 tools:** Tool implementations in Phase 3 call these query functions. Function signatures defined here are the contract.
- **Settings → everything:** Settings values flow through to query logic (OCC bypass) and injection logic (intervals).

### Expected Outcomes
After Phase 2 completes:
- MCP server starts, connects stdio transport, and accepts tool list requests (returning stub tools)
- Socket HTTP server binds, responds to `GET /health` with `{ status: 'ok' }`
- Socket cleanup correctly identifies and removes stale socket files on startup
- Settings parsed from TOML file with defaults fallback
- All query modules functional: CRUD operations on all tables verified
- OCC correctly blocks stale writes when enforce_permissions=true, passes through when false
- State-forwarding errors return current version_id + value on OCC conflict
- Status section operations succeed without version_id
- Handoff overwrite model works (second write replaces first, read consumes)
- Tag similarity returns suggestions when normalized forms match
- Memory retirement sets archived_at, excludes from active queries

### Testing Recommendations
- **Query modules:** Test each against in-memory SQLite. Cover: basic CRUD, OCC conflict + state-forwarding, version history storage + snapshot rendering, handoff overwrite + consume, tag normalization matching, status section atomicity, supersedes auto-retire.
- **Socket server:** Test startup sequence with stale socket file present, lockfile contention, cleanup handlers.
- **Settings:** Test TOML parsing with valid file, missing file (defaults), malformed file (defaults + error log).
- **Integration:** Verify MCP server + socket server coexist — start both, query socket health endpoint while MCP tool list works.
</core>
</section>
<!-- /phase:2 -->

<!-- conductor-review:2 -->
<section id="conductor-review-2">
## Conductor Review: Post-Phase 2

<core>
<mandatory>All checklist items must be verified before proceeding to Phase 3.</mandatory>

### Verification Checklist

- [ ] MCP server starts and responds to ListTools request via stdio (returns tool names/schemas, stub implementations)
- [ ] Socket HTTP server binds to `~/.aletheia/sockets/aletheia-<pid>.sock` and responds to `GET /health`
- [ ] Socket file has 0600 permissions (Unix)
- [ ] Lockfile acquired/released correctly during socket startup
- [ ] Stale socket garbage collection works: create orphaned socket file, verify cleanup on next startup
- [ ] SIGINT/SIGTERM cleanup removes socket file
- [ ] Settings parsed correctly from TOML; missing file returns defaults; malformed file returns defaults + stderr warning
- [ ] No `console.log()` calls in any new files
- [ ] **Journal queries:** append succeeds, rolling read returns last N, digested entries excluded from rolling reads, searchable by tag and content
- [ ] **Memory queries:** write creates entry with version_id, OCC rejects stale version_id with state-forwarding error, OCC bypassed when enforce_permissions=false, retire sets archived_at, archived entries excluded from active queries
- [ ] **Status queries:** replace with OCC works, undo buffer populated, section add/remove/update succeed WITHOUT version_id
- [ ] **Handoff queries:** create overwrites existing for same target_key, read consumes (deletes) the row, read on empty slot returns null
- [ ] **Tag queries:** normalization matching works (#front-end matches existing #frontend), active_tags view excludes archived entries
- [ ] **Supersedes:** creating memory with supersedes field auto-retires the referenced entry
- [ ] **Provenance:** memory→journal links created and queryable
- [ ] **Key queries:** create, validate, modify (downward-only scope enforced), list (scoped to caller)

### Known Risks
- Socket server endpoint stubs will be replaced in Phase 3. Ensure the endpoint registration pattern is extensible.
- Query function signatures defined here are the contract for Phase 3 tools.

### Guidance for Phase 3

<guidance>
Phase 3 has 4 parallel tasks: auth+entry tools, journal+memory+discovery tools, status+handoff tools, and the injection system. Each task uses different query modules and registers different tool handlers — no file conflicts.

The injection system (Task D) needs to populate the socket HTTP endpoint stubs created in this phase. Use an import-and-register pattern rather than editing socket.ts directly to minimize danger file contention.
</guidance>
</core>
</section>
<!-- /conductor-review:2 -->

<!-- phase:3 -->
<section id="phase-3">
## Phase 3: MCP Tools + Injection System

<core>
### Objective
Implement all ~21 MCP tool handlers and the adaptive injection system (L1/L2 payload builders, frequency management, content-hash change detection). All four tasks are independent — each tool group uses different query modules and registers separate tool handlers.

### Prerequisites
- Phase 2 complete: MCP server skeleton accepts tool registrations, socket HTTP server running with stub endpoints, all query modules functional, settings loaded
- All query function signatures from Phase 2 are the contract

### Implementation

**Tool Registration Pattern**

Each tool group exports a registration function called from the MCP server's main initialization:

```typescript
// src/server/tools/journal.ts
export function registerJournalTools(server: Server, db: Database.Database, settings: AletheiaSettings): void {
  // Register write_journal, etc.
}
```

The main server index.ts calls all registration functions during startup. Tool groups never import each other.

<mandatory>All tool responses use micro-XML format with short tags as defined in the design. All error responses use formatError(code, message). Tool descriptions must include temporal framing: "Status is for information that won't matter tomorrow. Memory is for information that will matter next week."</mandatory>

**Auth + Entry Tools** (`src/server/tools/auth.ts`, `src/server/tools/entries.ts`):

`claim(key)` — Calls `validateKey()`, stores claimed key in session state (in-memory Map). Returns permissions and accessible entry scope. If enforce_permissions=true and no claim exists, all other tools return `<error code="NO_CLAIM">Use claim(key) to authenticate</error>`.

`whoami` — Returns current claimed key, permissions, accessible entries.

`bootstrap(name, enforce_permissions)` — One-time system init. Creates project namespace, generates master key, writes to `~/.aletheia/keys/<project>.key` with 0600 permissions. Response directs Claude to inform user of file path. Permanently disabled for that project name once master key exists.

`create_key(permissions, entry_id)` — Creates sub-key scoped beneath caller's entry. Requires `create-sub-entries` permission.

`modify_key(key_id, permissions)` — Promote/demote sub-key. Downward-only scope enforced.

`list_keys` — Returns all sub-keys beneath caller's scope.

`create_entry(entry_class, tags, content?, template?)` — Creates new entry. Tags processed through addTags (with similarity suggestions). If project namespace doesn't exist, triggers prompt-back for project name.

`list_entries(entry_class?, tags?)` — Lists entries filtered by class and/or tags.

**Journal + Memory + Discovery Tools** (`src/server/tools/journal.ts`, `src/server/tools/memory.ts`, `src/server/tools/discovery.ts`):

`write_journal(entry_id, content, tags, critical?, memory_summary?)`:
- Standard write: appends via `appendJournalEntry()`. Processes tags via `addTags()`. Returns confirmation with tag suggestions in `<tags_similar>` element.
- Critical write (`critical: true`): `memory_summary` REQUIRED. In single immediate transaction: (1) append journal entry, (2) create memory entry, (3) link provenance, (4) set digested_at. Circuit breaker tracks critical writes per session, rejects if cap exceeded.
- show_related: default-on at threshold from settings. `skip_related: true` to opt out.

<mandatory>When critical: true, memory_summary is required (reject if absent). Journal entry AND memory entry created in same immediate transaction. Journal entry's digested_at set in same transaction.</mandatory>

`write_memory(entry_id, key, value, tags, version_id?)` — Calls `writeMemory()` query. OCC behavior determined by settings.

`retire_memory(entry_id, reason?)` — Calls `retireMemory()`. Single tool for soft-delete. Optional reason logged to journal.

`promote_to_memory(journal_id, synthesized_knowledge, tags)` — Explicit tool (not primary path). Creates memory from journal entry, links provenance.

`search(entry_class?, tags?, query?, include_archived?)` — Consolidated search across all entry types. Routes to appropriate query based on entry_class filter. Default excludes archived.

`read(entry_id, mode?, limit?, show_related?)` — Consolidated read. Server detects entry type from entries table. Routes to appropriate read function. Handoff read consumes.

`list_tags(entry_class?)` — Returns all active tags with entry counts.

**Status + Handoff Tools** (`src/server/tools/status.ts`, `src/server/tools/handoff.ts`):

`read_status(entry_id, section_id?)` — Full document or specific section.

`replace_status(entry_id, content, version_id)` — Full replace with OCC. Saves current to undo buffer. State-forwarding error on mismatch.

`update_status(entry_id, section_id, state?, content?)` — Atomic section update. No OCC.

`add_section(entry_id, section_id, content, position?)` — Atomic add with position shifting.

`remove_section(entry_id, section_id)` — Atomic remove with position shifting.

`create_handoff(target_key, content, tags)` — Mailbox overwrite.

`read_handoff()` — Consume caller's handoff slot. Returns content or empty response.

**System Tools** (`src/server/tools/system.ts`):

`help(topic?)` — Contextual help. Stub content in this phase, populated in Phase 5.

`health` — Permission-scoped metrics: entry counts, tag distribution, memory staleness stats.

**Injection System** (`src/injection/`):

`src/injection/l1-builder.ts` — Builds L1 payload: current status document, active memory entries tagged with current task, pending handoff. Dense YAML-in-XML format. Respects token budget.

`src/injection/l2-builder.ts` — Builds L2 payload: all accessible active memories, recent undigested journal entries (rolling), tag list, undigested journal count. YAML-in-XML format. Respects token budget.

`src/injection/frequency.ts` — Adaptive frequency manager:
- Tracks PreToolUse call count per session
- L1 fires every l1Interval calls, L2 every l2Interval
- Content-hash change detection: hash payload, compare to last
- No change: single bump to 2x interval. Does NOT continue escalating.
- Change detected: reset to base, inject on next PreToolUse.

`src/injection/endpoints.ts` — Socket HTTP endpoint handlers:
- `GET /state` → L1 builder, returns JSON for hooks to format
- `GET /context` → L2 builder, returns JSON
- `GET /session-info` → session claim status, permissions, entry count
- `GET /handoff` → pending handoff for claimed key (without consuming)

<!-- danger-file: src/server/socket.ts shared-with="phase:2" -->

<guidance>
Keep hook response as structured JSON. Hooks (Phase 4) format JSON into YAML-in-XML injection payload. This separation lets hooks be updated without changing server injection logic.

The circuit breaker should track writes per rolling interval (default: 20 per 5 minutes). When tripped, return error with last N operations attached, flagging for supervisor review.
</guidance>

### Integration Points
- **Query modules (Phase 2):** Every tool calls Phase 2 query functions.
- **Socket server (Phase 2 danger file):** Injection endpoints register on existing socket HTTP server.
- **Tool schemas → Phase 4 hooks:** Hook scripts query socket endpoints defined here.
- **Tool names → Phase 4 CLI setup:** Setup registers the MCP server with these tools.

### Expected Outcomes
After Phase 3 completes:
- All ~21 MCP tools respond correctly via stdio
- Auth flow: bootstrap → claim → whoami works end-to-end
- Journal, memory, status, handoff lifecycles work
- Consolidated search/read auto-detects type and routes correctly
- Injection endpoints return valid JSON on socket HTTP
- Adaptive frequency fires correctly, bumps on no-change, resets on change
- Circuit breaker trips at configured threshold

### Testing Recommendations
- **Tool integration:** Full path per tool: MCP request → handler → query → SQLite → response. Use in-memory SQLite.
- **OCC scenarios:** Solo bypass, multi-agent conflict with state-forwarding, status section atomicity.
- **Critical write:** Transaction atomicity (journal + memory + provenance + digested_at). Circuit breaker cap.
- **Injection:** Payload size vs token budget. Adaptive frequency behavior.
- **Consolidated search/read:** Mixed entry types, tag filters, archived exclusion.
</core>
</section>
<!-- /phase:3 -->

<!-- conductor-review:3 -->
<section id="conductor-review-3">
## Conductor Review: Post-Phase 3

<core>
<mandatory>All checklist items must be verified before proceeding to Phase 4.</mandatory>

### Verification Checklist

- [ ] All ~21 MCP tools registered and responding via stdio JSON-RPC
- [ ] **Auth flow:** bootstrap → claim → whoami → list_keys end-to-end
- [ ] **Journal:** write_journal appends, returns tag similarity suggestions. Critical write atomic (journal + memory + provenance + digested_at). Critical without memory_summary errors. Circuit breaker rejects after cap.
- [ ] **Memory:** OCC conflict returns state-forwarding error. OCC bypassed in solo mode. retire_memory excludes from active queries.
- [ ] **Status:** replace_status enforces OCC. Section operations succeed without version_id. Undo buffer populated.
- [ ] **Handoff:** create overwrites, read consumes, empty slot returns empty response.
- [ ] **Consolidated search:** filters by entry_class and tags, excludes archived by default
- [ ] **Consolidated read:** auto-detects type, handoff read consumes
- [ ] **show_related:** default-on, skip_related suppresses
- [ ] **Tag similarity:** suggestions returned when normalized forms match existing tags
- [ ] **Injection endpoints:** GET /state, /context, /session-info, /handoff return valid JSON
- [ ] **Adaptive frequency:** L1 every 10, L2 every 20. Bump on no-change. Reset on change.
- [ ] **Token budget:** payloads truncated when exceeding budget
- [ ] No `console.log()` in any new files

### Known Risks
- Injection endpoint JSON structure is the contract for Phase 4 hooks. Document response schema clearly.
- Circuit breaker threshold untested against real workflows — flag as tuning point.

### Guidance for Phase 4

<guidance>
Phase 4 has 3 fully parallel tasks: Unix hooks, Windows hooks, CLI+setup. All consume Phase 3 outputs but don't interact with each other.

Unix and Windows hooks implement identical logic — coordinate on socket endpoint response parsing to ensure identical injection output format.
</guidance>
</core>
</section>
<!-- /conductor-review:3 -->

<!-- phase:4 -->
<section id="phase-4">
## Phase 4: Hooks + CLI + Setup

<core>
### Objective
Implement the 5 hook scripts (POSIX sh for Unix, Node.js for Windows), the CLI tool (`aletheia setup` / `aletheia teardown`), and the MCP server + hook registration logic. All three tasks are independent and parallelizable.

### Prerequisites
- Phase 3 complete: all MCP tools functional, socket HTTP endpoints responding with valid JSON at `/state`, `/context`, `/session-info`, `/handoff`
- Socket endpoint response schemas documented

### Implementation

**Unix Hooks — POSIX sh** (`src/hooks/unix/`)

All hooks follow the same pattern:
```sh
#!/bin/sh
SOCK="${ALETHEIA_SOCK:-}"
TIMEOUT=2

if [ -z "$SOCK" ]; then exit 0; fi

response=$(curl -s --unix-socket "$SOCK" --max-time "$TIMEOUT" "http://localhost/endpoint" 2>/dev/null)
if [ $? -ne 0 ] || [ -z "$response" ]; then exit 0; fi

# Format response as injection payload
```

<mandatory>All hooks MUST fail-open. If ALETHEIA_SOCK is unset, socket is unreachable, or curl times out, the hook exits silently with code 0. Hooks must NEVER block Claude Code operation.</mandatory>

**Hook 1: Startup** (`startup.sh`) — first PreToolUse or UserPromptSubmit:
- Queries `GET /session-info`
- Orchestrated session (key in env): outputs claim instruction
- Simple mode with existing entry: outputs L1 injection (auto-claimed)
- Simple mode, no entry: outputs brief notice with operational guide (5 lines: what Aletheia is, write_journal for capture, critical:true for urgent, search for discovery, concrete example)
- Enforce permissions with no key: outputs auth instructions
- Also checks if MEMORY.md exists and has content, notifies if so

**Hook 2: L1 Injection** (`l1-inject.sh`) — PreToolUse:
- Queries `GET /state`
- Formats JSON as YAML-in-XML injection payload
- Frequency management is SERVER-SIDE — hook always queries, server returns payload or empty response based on adaptive counter

**Hook 3: L2 Injection** (`l2-inject.sh`) — PreToolUse:
- Queries `GET /context`
- Same pattern as L1 but broader payload
- Includes undigested journal count

**Hook 4: Memory Interception** (`memory-intercept.sh`) — PreToolUse matching Write/Edit to MEMORY.md:
- If disableSystemMemory = true: outputs blocking message + mirror instruction
- If false: outputs advisory to consider Aletheia

<guidance>
Consider combining hooks 2+3 into a single injection hook querying `GET /inject` — the server decides whether to return L1, L2, both, or nothing. This reduces from 5 hooks to 4.
</guidance>

**Windows Hooks — Node.js** (`src/hooks/windows/`)

Identical logic to Unix hooks using native `http` module over Named Pipes:
```typescript
import http from 'http';
const pipePath = process.env.ALETHEIA_SOCK || '';
if (!pipePath) process.exit(0);
const req = http.get(`http://localhost/endpoint`, { socketPath: pipePath, timeout: 2000 }, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    if (res.statusCode === 200 && data) {
      process.stdout.write(formatPayload(data));
    }
  });
});
req.on('error', () => process.exit(0));
req.on('timeout', () => { req.destroy(); process.exit(0); });
```

Same fail-open semantics. Shared formatting logic extracted to common module.

**CLI + Setup** (`src/cli/`)

`aletheia setup` flow:
1. Create `~/.aletheia/` directory structure (sockets/, keys/, data/, templates/, logs/) with 0700 permissions
2. Generate `settings.toml` with inline documentation and all defaults
3. Register MCP server in Claude Code config (read-modify-write, not overwrite)
4. Register hooks — detect platform, register sh (Unix) or node (Windows) variants with appropriate matchers
5. Copy default templates to `~/.aletheia/templates/`
6. If enforce_permissions configured, auto-generate maintenance key at `~/.aletheia/keys/maintenance.key` (0600)

`aletheia teardown` flow:
1. Remove MCP server registration
2. Remove hook registrations
3. Prompt: "Remove data? (y/N)" — if yes, remove `~/.aletheia/` entirely

<mandatory>Setup must detect the current Claude Code hook configuration format at runtime. Read existing config, add Aletheia entries, write back. If config format is unrecognized, warn user and output manual registration instructions.</mandatory>

### Integration Points
- **Socket endpoints (Phase 3):** Hooks query exact endpoint paths and parse exact JSON response format.
- **Tool names (Phase 3):** Setup registers the MCP server whose tools were defined in Phase 3.
- **Templates (Phase 5):** Setup copies templates — if not yet available, create directory and skip with note.
- **Settings defaults (Phase 1):** Default values in settings.toml must match DEFAULTS constant.

### Expected Outcomes
After Phase 4 completes:
- `aletheia setup` creates full directory structure, generates settings.toml, registers MCP server and hooks
- `aletheia teardown` cleanly removes all registrations
- Unix hooks produce correctly formatted injection payloads
- Windows hooks produce identical output to Unix hooks
- All hooks fail-open when socket unavailable
- Memory interception hook correctly matches MEMORY.md operations
- Startup hook produces appropriate output for each session type

### Testing Recommendations
- **Hooks:** Test with mock socket server returning known JSON. Verify output format. Test fail-open scenarios.
- **Cross-platform:** Verify Unix and Windows hooks produce identical output for same input.
- **CLI:** Test on clean system, existing config, malformed config. Test teardown + re-setup idempotency.
- **End-to-end:** MCP server start → hook trigger → verify injection payload appears.
</core>
</section>
<!-- /phase:4 -->

<!-- conductor-review:4 -->
<section id="conductor-review-4">
## Conductor Review: Post-Phase 4

<core>
<mandatory>All checklist items must be verified before proceeding to Phase 5.</mandatory>

### Verification Checklist

- [ ] `aletheia setup` creates `~/.aletheia/` with all subdirectories (0700 permissions)
- [ ] `settings.toml` generated with all defaults + inline comments
- [ ] MCP server registered in Claude Code config — starts when Claude Code launches
- [ ] All hooks registered with correct matchers
- [ ] Platform detection: Unix → sh hooks, Windows → Node.js hooks
- [ ] `aletheia teardown` removes all registrations cleanly
- [ ] **Unix hooks:** valid injection output when socket available
- [ ] **Unix hooks:** exit 0 with no output when socket unavailable (fail-open)
- [ ] **Windows hooks:** identical output to Unix hooks for same server response
- [ ] **Memory intercept:** correctly matches Write/Edit to MEMORY.md
- [ ] **Startup hook:** correct output for all session types
- [ ] **End-to-end:** server → hook → injection payload appears in Claude context
- [ ] Default settings.toml values match DEFAULTS constant
- [ ] Maintenance key generated with 0600 permissions when enforce_permissions configured

### Known Risks
- Claude Code's hook/MCP configuration format may change between versions.
- Template directory empty until Phase 5.

### Guidance for Phase 5

<guidance>
Phase 5 has 3 tasks: templates+content (A), npm packaging (B), and integration testing (C). Tasks A and B are parallel. The digest teammate prompt template is the most critical content artifact.
</guidance>
</core>
</section>
<!-- /conductor-review:4 -->

<!-- phase:5 -->
<section id="phase-5">
## Phase 5: Content + Packaging + Integration

<core>
### Objective
Create all content artifacts (entry templates, digest teammate prompt, startup injection text, help tool content), finalize npm packaging for global distribution, and define the integration testing strategy. Tasks A and B are parallelizable.

### Prerequisites
- Phase 4 complete: CLI setup works, hooks produce valid output, all tools responding
- Template directory exists at `~/.aletheia/templates/`
- Package structure from Phase 1 with compiled output in `dist/`

### Implementation

**Entry Templates** (`src/templates/`)

Four default templates — concise starting points (10-25 lines each):

*Golden Template* (`golden.md`) — heavily commented educational reference covering: Current State, Decisions (with rationale format), Constraints, Open Questions. Comments explain tag conventions and best practices.

*Manager Template* (`manager.md`) — Team Structure, Active Workstreams, Decisions Pending Review, Cross-Team Dependencies, Risk Register.

*Backend Template* (`backend.md`) — Architecture, API Contracts, Data Model, Error Handling Conventions, Performance Constraints.

*UI Design Template* (`ui-design.md`) — User Flow, Component Hierarchy, State Management, Accessibility Requirements, Design Tokens/Styling.

<guidance>Templates are starting points, not comprehensive frameworks. The golden template has the most comments (educational). Others are minimal scaffolds.</guidance>

**Digest Teammate Prompt Template** (`src/templates/digest-prompt.md`):

<mandatory>The digest teammate prompt template is a first-class configurable artifact shipped at ~/.aletheia/templates/digest-prompt.md. NOT embedded in code. Users can modify it. Must be heavily commented.</mandatory>

The prompt instructs an autonomous Claude session to:
1. Connect: claim maintenance key, confirm permissions via whoami
2. Gather context: list_tags for vocabulary, search(entry_class: "memory") for existing memories, search(entry_class: "journal", include_digested: false) for undigested entries. Process in batches of ~15.
3. Analyze patterns: recurring themes (3+ mentions), explicit user decisions, contradictions with existing memories, duplicates among memories
4. Synthesize: write_memory with concise distilled summaries using existing tags. Link provenance.
5. Clean up: retire contradicted/duplicate memories with reason. Update existing memories when new info adds to (not contradicts) them.
6. Mark reviewed: all processed journal entries marked digested regardless of promotion outcome.

Quality guidelines: distill don't copy, include rationale, err toward promoting when uncertain, don't over-generalize from insufficient data.

**Startup Injection Content**

Embedded in startup hook output formatting (5 lines):
```
Aletheia memory system active. Capture decisions and feedback
with write_journal("content", tags: ["topic"]). For critical
knowledge that must be remembered immediately, add critical: true.
Use search(tags: ["topic"]) to find existing knowledge.
Example: write_journal("User prefers explicit error handling
over try-catch", tags: ["conventions"])
```

**Help Tool Content** — populate stub from Phase 3 with contextual help per topic (journal, memory, status, tags, permissions, general overview). Each response under 500 tokens.

**npm Packaging**

Finalize package.json:
- `files: ["dist", "hooks", "src/templates"]`
- Ensure `dist/cli/cli.ts` has shebang `#!/usr/bin/env node`
- Build script copies hook scripts and templates to dist-adjacent locations
- `npm pack` produces valid tarball
- Test: `npm install -g ./aletheia-1.0.0.tgz` → `aletheia setup` works

<guidance>Use Node.js built-in test runner (node --test) rather than adding Jest/Vitest. Keeps dependency tree minimal.</guidance>

**Integration Testing Strategy**

Key scenarios:
1. Full lifecycle: setup → server start → claim → write_journal → search → write_memory → read → retire → verify
2. Multi-session concurrency: 2 MCP servers, cross-session WAL reads, concurrent write contention
3. Hook pipeline: server → hook trigger → injection payload format verification → adaptive frequency
4. Critical write atomicity: verify all-or-nothing transaction. Kill mid-transaction → verify rollback.
5. OCC scenarios: solo bypass, multi-agent state-forwarding, status section atomicity
6. Setup idempotency: setup → teardown → setup → clean state
7. Cross-platform hooks: identical output for same input

### Integration Points
- **Templates → CLI setup (Phase 4):** Setup copies templates from dist/templates/ to ~/.aletheia/templates/.
- **Help content → system tools (Phase 3):** Content update to existing help tool stub.
- **Package.json → npm registry:** Must be valid for `npm publish`.

### Expected Outcomes
After Phase 5 completes:
- All templates + digest prompt exist in src/templates/
- Setup copies templates to ~/.aletheia/templates/
- Startup injection is concise with concrete example
- Help tool returns actionable responses for all topics
- `npm pack` produces valid package
- `npm install -g` from tarball succeeds, `aletheia setup` works from global install
- Integration test scenarios documented and key scenarios implemented

### Testing Recommendations
- **Templates:** valid markdown, under 25 lines each, no placeholder text
- **Digest prompt:** dry-run against sample journal entries
- **Package:** npm pack → npm install -g → aletheia setup → Claude Code → hooks fire
- **Help content:** each response under 500 tokens
</core>
</section>
<!-- /phase:5 -->

<!-- conductor-review:5 -->
<section id="conductor-review-5">
## Conductor Review: Post-Phase 5

<core>
<mandatory>All checklist items must be verified before final release.</mandatory>

### Verification Checklist

- [ ] All 4 entry templates present in dist/templates/ and well-formed
- [ ] Digest prompt template present, heavily commented, includes all workflow steps
- [ ] Startup injection text is 5 lines with concrete write_journal example
- [ ] Help tool returns responses for all topics: journal, memory, status, tags, permissions, general
- [ ] `npm pack` succeeds, tarball contains: dist/, hooks/, src/templates/
- [ ] Global install from tarball: `npm install -g ./` → `aletheia` command available
- [ ] Post-install: `aletheia setup` → `aletheia teardown` → `aletheia setup` (idempotent)
- [ ] **Full lifecycle integration test passes**
- [ ] **Multi-session test:** 2 concurrent servers, cross-session WAL reads confirmed
- [ ] **Hook pipeline test:** startup injection appears, L1/L2 fire at correct intervals
- [ ] All help responses under 500 tokens
- [ ] No `console.log()` anywhere in final codebase
- [ ] Shebang line present on CLI entry point

### Known Risks
- Digest prompt quality validated through real usage — ship golden default and iterate.
- npm global install behavior varies across Node version managers.
</core>
</section>
<!-- /conductor-review:5 -->
