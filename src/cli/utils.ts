import fs from 'fs';
import path from 'path';

const CLAUDE_SETTINGS_PATH = path.join(
  process.env.HOME ?? process.env.USERPROFILE ?? '',
  '.claude',
  'settings.json',
);

export function readClaudeSettings(): Record<string, unknown> {
  const dir = path.dirname(CLAUDE_SETTINGS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(CLAUDE_SETTINGS_PATH)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    console.error(`[aletheia] Warning: could not parse ${CLAUDE_SETTINGS_PATH}, starting fresh`);
    return {};
  }
}

export function writeClaudeSettings(settings: Record<string, unknown>): void {
  const dir = path.dirname(CLAUDE_SETTINGS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}
