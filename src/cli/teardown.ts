import fs from 'fs';
import path from 'path';
import { ALETHEIA_HOME } from '../lib/constants.js';
import { readClaudeSettings, writeClaudeSettings } from './utils.js';

const CLAUDE_SETTINGS_PATH = path.join(
  process.env.HOME ?? process.env.USERPROFILE ?? '',
  '.claude',
  'settings.json',
);

function removeMcpServer(settings: Record<string, unknown>): void {
  if (settings.mcpServers && typeof settings.mcpServers === 'object') {
    const mcpServers = settings.mcpServers as Record<string, unknown>;
    if ('aletheia' in mcpServers) {
      delete mcpServers.aletheia;
      console.error('[aletheia] Removed MCP server registration.');
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
    hooks.PreToolUse = (hooks.PreToolUse as Array<{ command?: string }>).filter(
      h => !h.command || !h.command.includes('aletheia'),
    );
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
