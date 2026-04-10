import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
  ALETHEIA_HOME,
  SOCKETS_DIR,
  KEYS_DIR,
  DATA_DIR,
  TEMPLATES_DIR,
  LOGS_DIR,
  SETTINGS_PATH,
  DEFAULTS,
} from '../lib/constants.js';
import { isWindows } from '../lib/platform.js';
import { readClaudeSettings, writeClaudeSettings } from './utils.js';
import { createConnection } from '../db/connection.js';
import { runMigrations } from '../db/schema.js';
import { createKey } from '../db/queries/keys.js';

function getDistDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  // thisFile is dist/cli/setup.js — go up two levels to dist/
  return path.resolve(path.dirname(thisFile), '..');
}

function getHooksDir(): string {
  const distDir = getDistDir();
  // hooks/ is at package root (copied from src/hooks/ during build)
  const packageRoot = path.resolve(distDir, '..');
  return path.join(packageRoot, 'hooks');
}

function createDirectoryStructure(): void {
  const dirs = [ALETHEIA_HOME, SOCKETS_DIR, KEYS_DIR, DATA_DIR, TEMPLATES_DIR, LOGS_DIR];
  const mode = isWindows() ? undefined : 0o700;
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true, mode });
  }
  console.error(`[aletheia] Created directory structure at ${ALETHEIA_HOME}`);
}

function generateSettingsToml(): void {
  if (fs.existsSync(SETTINGS_PATH)) {
    console.error(`[aletheia] Settings file already exists: ${SETTINGS_PATH}`);
    return;
  }

  const content = `# Aletheia Memory System Configuration

[permissions]
# Enable permission enforcement for multi-agent scenarios
enforce = false

[injection]
# Hook trigger (currently only PreToolUse is supported)
trigger = "PreToolUse"
# L1 injection interval (every N tool calls)
l1_interval = ${DEFAULTS.l1Interval}
# L2 injection interval (every N tool calls)
l2_interval = ${DEFAULTS.l2Interval}
# Include history reminder markers in injection
history_reminders = true
# Maximum tokens per injection payload
token_budget = ${DEFAULTS.tokenBudget}

[memory]
# Disable built-in MEMORY.md system
disable_system_memory = false
# Default number of rolling journal entries
rolling_default = ${DEFAULTS.rollingDefault}

[hooks]
startup = true
l1_injection = true
l2_injection = true
memory_interception = true
overlap_detection = true

[digest]
# Journal entries before triggering digest
entry_threshold = ${DEFAULTS.digestEntryThreshold}
# Hours of active use before triggering digest
time_threshold_hours = ${DEFAULTS.digestTimeThresholdHours}
# Maximum critical writes per session
critical_write_cap = ${DEFAULTS.criticalWriteCap}

# Enable debug logging to ~/.aletheia/logs/
debug = false
`;

  fs.writeFileSync(SETTINGS_PATH, content, 'utf-8');
  console.error(`[aletheia] Generated settings: ${SETTINGS_PATH}`);
}

/**
 * Register the Aletheia MCP server with Claude Code by invoking its
 * own CLI (`claude mcp add`). Earlier versions of this setup wrote an
 * `mcpServers` entry into ~/.claude/settings.json, but current Claude
 * Code reads MCP registrations from ~/.claude.json (top-level, managed
 * by the `claude mcp` subcommand), and silently ignores the legacy
 * settings.json location. Using the CLI is future-proof — whatever
 * storage format Claude Code uses today (or in the future), `claude
 * mcp add` writes to the right place.
 */
function registerMcpServer(): void {
  const distDir = getDistDir();
  const serverEntry = path.join(distDir, 'server', 'index.js');

  // Check whether aletheia is already registered so we don't error out
  // on re-run. `claude mcp list` prints one line per server, starting
  // with "<name>:".
  const listResult = spawnSync('claude', ['mcp', 'list'], { encoding: 'utf-8' });
  if (listResult.error) {
    console.error('[aletheia] Warning: `claude` CLI not found on PATH. Install Claude Code and re-run setup, or register manually with:');
    console.error(`[aletheia]   claude mcp add -s user aletheia node ${serverEntry}`);
    return;
  }
  if (listResult.status === 0 && typeof listResult.stdout === 'string' && /(^|\n)aletheia:/.test(listResult.stdout)) {
    console.error('[aletheia] MCP server already registered with Claude Code.');
    return;
  }

  const addResult = spawnSync(
    'claude',
    ['mcp', 'add', '-s', 'user', 'aletheia', 'node', serverEntry],
    { encoding: 'utf-8' },
  );
  if (addResult.status !== 0) {
    console.error('[aletheia] Warning: `claude mcp add` failed. Register manually with:');
    console.error(`[aletheia]   claude mcp add -s user aletheia node ${serverEntry}`);
    if (addResult.stderr) console.error(`[aletheia] stderr: ${addResult.stderr.trim()}`);
    return;
  }
  console.error(`[aletheia] Registered MCP server via 'claude mcp add': ${serverEntry}`);
}

function registerHooks(settings: Record<string, unknown>): void {
  const hooksDir = getHooksDir();
  const win = isWindows();
  const subdir = win ? 'windows' : 'unix';
  const ext = win ? '.js' : '.sh';
  const runner = win ? 'node' : 'bash';

  function hookCommand(name: string): string {
    return `${runner} ${path.join(hooksDir, subdir, name + ext)}`;
  }

  // Build Aletheia hook entries in Claude Code's required format:
  // { matcher, hooks: [{ type: "command", command: "..." }] }
  const aletheiaHooks = [
    { matcher: '', hooks: [{ type: 'command', command: hookCommand('startup') }] },
    { matcher: '', hooks: [{ type: 'command', command: hookCommand('l1-inject') }] },
    { matcher: '', hooks: [{ type: 'command', command: hookCommand('l2-inject') }] },
    { matcher: 'Write|Edit', hooks: [{ type: 'command', command: hookCommand('memory-intercept') }] },
  ];

  if (!settings.hooks || typeof settings.hooks !== 'object') {
    settings.hooks = {};
  }
  const hooks = settings.hooks as Record<string, unknown>;

  if (!Array.isArray(hooks.PreToolUse)) {
    hooks.PreToolUse = [];
  }
  const existing = hooks.PreToolUse as Array<Record<string, unknown>>;

  // Remove any previously registered Aletheia hooks
  const filtered = existing.filter(h => {
    const innerHooks = h.hooks as Array<{ command?: string }> | undefined;
    if (!innerHooks) return true;
    return !innerHooks.some(ih => ih.command && ih.command.includes('aletheia'));
  });

  // Append new Aletheia hooks
  filtered.push(...aletheiaHooks);
  hooks.PreToolUse = filtered;

  // Note: Stop hook (5th hook for session cleanup) deferred to v0.2.0
  console.error(`[aletheia] Registered ${aletheiaHooks.length} hooks (${subdir})`);
}

function installTemplates(): void {
  const distDir = getDistDir();
  const packageRoot = path.resolve(distDir, '..');
  const srcTemplates = path.join(packageRoot, 'src', 'templates');

  if (!fs.existsSync(srcTemplates)) {
    console.error('[aletheia] Template source not found, skipping template install.');
    return;
  }

  const files = fs.readdirSync(srcTemplates).filter(f => f.endsWith('.md'));
  let copied = 0;
  for (const file of files) {
    const dest = path.join(TEMPLATES_DIR, file);
    if (!fs.existsSync(dest)) {
      fs.copyFileSync(path.join(srcTemplates, file), dest);
      copied++;
    }
  }
  console.error(`[aletheia] Installed ${copied} templates to ${TEMPLATES_DIR}`);
}

function generateMaintenanceKey(): void {
  const keyPath = path.join(KEYS_DIR, 'maintenance.key');
  if (fs.existsSync(keyPath)) {
    console.error(`[aletheia] Maintenance key already exists: ${keyPath}`);
    return;
  }

  // Initialize DB and insert the key so it can be claimed
  const db = createConnection();
  runMigrations(db);

  const result = createKey(db, { permissions: 'maintenance' });
  db.close();

  fs.writeFileSync(keyPath, result.keyValue + '\n', { encoding: 'utf-8', mode: 0o600 });
  console.error(`[aletheia] Generated maintenance key: ${keyPath}`);
}

export async function setup(): Promise<void> {
  console.error('[aletheia] Starting setup...');

  // 1. Create directory structure
  createDirectoryStructure();

  // 2. Generate settings.toml
  generateSettingsToml();

  // 3. Register the MCP server via the `claude mcp add` CLI (writes to
  //    ~/.claude.json, which is where current Claude Code reads from).
  registerMcpServer();

  // 4. Register hooks in ~/.claude/settings.json (still the correct
  //    location for hooks, verified against Claude Code's behavior).
  const settings = readClaudeSettings();
  registerHooks(settings);
  writeClaudeSettings(settings);

  // 5. Copy templates to user directory
  installTemplates();

  // 6. Generate maintenance key if permissions enforcement is on
  //    Default is off, but generate it anyway for future use
  generateMaintenanceKey();

  console.error('[aletheia] Setup complete.');
}
