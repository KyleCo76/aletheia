#!/usr/bin/env node
// Cross-platform Windows equivalent: read stdin JSON, write per-PPID file
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

let buf = '';
process.stdin.on('data', c => { buf += c; });
process.stdin.on('end', () => {
  let sessionId;
  try { sessionId = JSON.parse(buf).session_id; } catch { return; }
  if (!sessionId) return;
  const dataDir = process.env.ALETHEIA_DATA_DIR || path.join(os.homedir(), '.aletheia-v2');
  const sessionsDir = path.join(dataDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const target = path.join(sessionsDir, `${process.ppid}.session_id`);
  // writeFileSync with { mode: 0o600 } is atomic-on-create — no TOCTOU window
  // (matches the unix sh's umask 077 subshell semantics). SHOULD-4 covered.
  fs.writeFileSync(target, sessionId + '\n', { mode: 0o600 });
});
