#!/usr/bin/env node
// Intentionally CommonJS — this file runs as a standalone script via `node`,
// not as an ESM module, even though the parent package uses "type": "module".
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
let pipePath = process.env.ALETHEIA_SOCK || '';
if (!pipePath) {
  // Prefer per-session pointer keyed by Claude Code's PID.
  const sockDir = path.join(os.homedir(), '.aletheia', 'sockets');
  try { pipePath = fs.readFileSync(path.join(sockDir, `claude-${process.ppid}.sock.path`), 'utf-8').trim(); } catch { /* ignore */ }
  if (!pipePath) {
    try { pipePath = fs.readFileSync(path.join(sockDir, 'current'), 'utf-8').trim(); } catch { /* ignore */ }
  }
}
if (!pipePath) process.exit(0);

function fetch(endpoint) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost${endpoint}`, { socketPath: pipePath, timeout: 2000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200 && data) resolve(data);
        else resolve(null);
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

(async () => {
  const response = await fetch('/context');
  if (!response) process.exit(0);

  if (response === '{}' || response === 'null') process.exit(0);

  process.stdout.write(response + '\n');
})();
