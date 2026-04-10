import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { ALETHEIA_HOME } from '../lib/constants.js';
import { readClaudeSettings, writeClaudeSettings } from './utils.js';

const CLAUDE_SETTINGS_PATH = path.join(
  process.env.HOME ?? process.env.USERPROFILE ?? '',
  '.claude',
  'settings.json',
);

/**
 * Unregister the Aletheia MCP server by invoking `claude mcp remove`.
 * Also cleans up any stale `mcpServers.aletheia` entry left behind in
 * the legacy ~/.claude/settings.json location by v0.1.0's setup.
 */
function removeMcpServer(settings: Record<string, unknown>): void {
  // Remove from Claude Code's current MCP registry (~/.claude.json).
  const result = spawnSync('claude', ['mcp', 'remove', 'aletheia'], { encoding: 'utf-8' });
  if (result.error) {
    console.error('[aletheia] Warning: `claude` CLI not found on PATH. Remove manually with: claude mcp remove aletheia');
  } else if (result.status === 0) {
    console.error('[aletheia] Removed MCP server registration via `claude mcp remove`.');
  } else if (result.stderr && /not found|no such/i.test(result.stderr)) {
    // Already absent — that's fine.
  } else if (result.stderr) {
    console.error(`[aletheia] Warning: 'claude mcp remove' reported: ${result.stderr.trim()}`);
  }

  // Also scrub the legacy settings.json location, in case this teardown
  // is cleaning up an install that was set up with v0.1.0.
  if (settings.mcpServers && typeof settings.mcpServers === 'object') {
    const mcpServers = settings.mcpServers as Record<string, unknown>;
    if ('aletheia' in mcpServers) {
      delete mcpServers.aletheia;
      console.error('[aletheia] Also removed stale v0.1.0 mcpServers entry from settings.json.');
    }
  }
}

function removeHooks(settings: Record<string, unknown>): void {
  if (!settings.hooks || typeof settings.hooks !== 'object') {
    return;
  }
  const hooks = settings.hooks as Record<string, unknown>;

  if (Array.isArray(hooks.PreToolUse)) {
    const before = hooks.PreToolUse.length;
    hooks.PreToolUse = (hooks.PreToolUse as Array<Record<string, unknown>>).filter(h => {
      const innerHooks = h.hooks as Array<{ command?: string }> | undefined;
      if (!innerHooks) return true;
      return !innerHooks.some(ih => ih.command && ih.command.includes('aletheia'));
    });
    const removed = before - (hooks.PreToolUse as unknown[]).length;
    if (removed > 0) {
      console.error(`[aletheia] Removed ${removed} hook registration(s).`);
    }
    // Clean up empty array
    if ((hooks.PreToolUse as unknown[]).length === 0) {
      delete hooks.PreToolUse;
    }
  }

  // Clean up empty hooks object
  if (Object.keys(hooks).length === 0) {
    delete settings.hooks;
  }
}

export async function teardown(): Promise<void> {
  console.error('[aletheia] Starting teardown...');

  if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
    const settings = readClaudeSettings();
    removeMcpServer(settings);
    removeHooks(settings);
    writeClaudeSettings(settings);
  } else {
    console.error('[aletheia] No Claude settings found, nothing to remove.');
  }

  console.error('');
  console.error('Aletheia registrations removed.');
  console.error(`Data directory at ${ALETHEIA_HOME} was NOT removed.`);
  console.error(`To remove all data: rm -rf ${ALETHEIA_HOME}`);
}
