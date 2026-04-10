#!/usr/bin/env node
// Intentionally CommonJS — this file runs as a standalone script via `node`,
// not as an ESM module, even though the parent package uses "type": "module".
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
let pipePath = process.env.ALETHEIA_SOCK || '';
if (!pipePath) {
  const currentFile = path.join(os.homedir(), '.aletheia', 'sockets', 'current');
  try { pipePath = fs.readFileSync(currentFile, 'utf-8').trim(); } catch { /* ignore */ }
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

  // If first run (no entry), show operational guide
  if (!info.hasEntry) {
    process.stdout.write(
      'Aletheia memory system active. Capture decisions and feedback\n' +
      'with write_journal("content", tags: ["topic"]). For critical\n' +
      'knowledge that must be remembered immediately, add critical: true.\n' +
      'Use search(tags: ["topic"]) to find existing knowledge.\n' +
      'Example: write_journal("User prefers explicit error handling\n' +
      'over try-catch", tags: ["conventions"])\n'
    );
    process.exit(0);
  }

  // Overlap detection
  if (fs.existsSync('MEMORY.md')) {
    process.stdout.write('Note: MEMORY.md detected. Consider migrating its contents to Aletheia with write_journal().\n');
  }

  // Has entry — inject L1 state
  const state = await fetch('/state');
  if (!state) process.exit(0);
  process.stdout.write(state + '\n');
})();
