#!/usr/bin/env node
// Intentionally CommonJS — this file runs as a standalone script via `node`,
// not as an ESM module, even though the parent package uses "type": "module".
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
let pipePath = process.env.ALETHEIA_SOCK || '';
if (!pipePath) {
  try { pipePath = fs.readFileSync(path.join(os.homedir(), '.aletheia', 'sockets', 'current'), 'utf-8').trim(); } catch { /* ignore */ }
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
  const response = await fetch('/session-info');
  if (!response) process.exit(0);

  let info;
  try { info = JSON.parse(response); } catch { process.exit(0); }

  if (info.disableSystemMemory) {
    process.stdout.write('MEMORY.md writes are disabled — use Aletheia instead.\n');
    process.stdout.write('Use write_journal() or write_memory() to persist knowledge.\n');
    process.exit(0);
  }

  process.stdout.write('Consider using Aletheia\'s write_journal() for persistent memory.\n');
  process.stdout.write('MEMORY.md changes may be lost across sessions.\n');
})();
