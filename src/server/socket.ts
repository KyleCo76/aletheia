import http from 'http';
import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { SOCKETS_DIR, LOCKFILE_PATH } from '../lib/constants.js';
import { getSocketPath, isWindows } from '../lib/platform.js';
import { lock, unlock } from 'proper-lockfile';
import type { AletheiaSettings } from '../lib/settings.js';
import type { FrequencyManager } from '../injection/frequency.js';
import { createEndpointHandlers } from '../injection/endpoints.js';

let boundSocketPath: string = '';

export function getSocketServerPath(): string {
  return boundSocketPath;
}

function createRequestHandler(
  db: Database.Database,
  settings: AletheiaSettings,
  sessionState: Map<string, unknown>,
  frequencyManager: FrequencyManager
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  const handlers = createEndpointHandlers(db, settings, sessionState, frequencyManager);

  return (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost`);
    const method = req.method ?? 'GET';
    const routeKey = `${method} ${url.pathname}`;

    res.setHeader('Content-Type', 'application/json');

    if (method === 'GET' && url.pathname === '/health') {
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'ok', pid: process.pid }));
      return;
    }

    const handler = handlers[routeKey];
    if (handler) {
      handler(req, res);
      return;
    }

    if (method === 'POST' && url.pathname === '/claim') {
      res.writeHead(200);
      res.end(JSON.stringify({ stub: true }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not found' }));
  };
}

function garbageCollectSockets(): void {
  let files: string[];
  try {
    files = fs.readdirSync(SOCKETS_DIR).filter(f => f.startsWith('aletheia-') && f.endsWith('.sock'));
  } catch {
    return;
  }

  for (const file of files) {
    const match = file.match(/^aletheia-(\d+)\.sock$/);
    if (!match) continue;

    const pid = parseInt(match[1], 10);
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true; // process exists (EPERM also means alive)
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM') {
        alive = true;
      }
      // ESRCH means dead
    }

    if (!alive) {
      try {
        fs.unlinkSync(path.join(SOCKETS_DIR, file));
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

// Well-known fallback pointer file used by v0.1.0. Still written for
// backward compatibility with existing hooks that don't know about the
// per-session pointer yet.
const CURRENT_SOCKET_FILE = path.join(SOCKETS_DIR, 'current');

/**
 * Per-session pointer file keyed by Claude Code's PID (i.e. the MCP
 * server's parent process). Because Claude Code spawns both the MCP
 * server and the hook commands as direct children, both share the same
 * ppid at runtime. Hooks can therefore locate "their own" session's
 * socket unambiguously by reading `claude-<PPID>.sock.path`, avoiding
 * the race where a shared `current` file gets overwritten by whichever
 * MCP server started most recently.
 */
function perSessionPointerPath(parentPid: number): string {
  return path.join(SOCKETS_DIR, `claude-${parentPid}.sock.path`);
}

function registerCleanup(socketPath: string, sessionPointerPath: string): void {
  const cleanup = () => {
    try { fs.unlinkSync(socketPath); } catch { /* ignore */ }
    try { fs.unlinkSync(sessionPointerPath); } catch { /* ignore */ }
    // Only clear the shared `current` file if it still points at our
    // socket — otherwise we'd stomp on a concurrent session that has
    // since taken ownership of it.
    try {
      const current = fs.readFileSync(CURRENT_SOCKET_FILE, 'utf-8').trim();
      if (current === socketPath) {
        fs.unlinkSync(CURRENT_SOCKET_FILE);
      }
    } catch { /* ignore */ }
  };

  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });
  process.on('exit', cleanup);
}

export async function startSocketServer(
  db: Database.Database,
  settings: AletheiaSettings,
  sessionState: Map<string, unknown>,
  frequencyManager: FrequencyManager
): Promise<void> {
  // Ensure sockets directory exists
  fs.mkdirSync(SOCKETS_DIR, { recursive: true });

  // Ensure lockfile target exists (proper-lockfile locks files, not creates them)
  const lockfileDir = path.dirname(LOCKFILE_PATH);
  fs.mkdirSync(lockfileDir, { recursive: true });
  if (!fs.existsSync(LOCKFILE_PATH)) {
    fs.writeFileSync(LOCKFILE_PATH, '');
  }

  // Acquire exclusive lock
  await lock(LOCKFILE_PATH, { retries: { retries: 3, minTimeout: 100, maxTimeout: 1000 } });

  try {
    // Garbage collect stale sockets
    garbageCollectSockets();

    const socketPath = getSocketPath(process.pid);

    // Defensive: remove own socket if it exists after GC
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }

    // Bind HTTP server to socket
    const handleRequest = createRequestHandler(db, settings, sessionState, frequencyManager);
    const server = http.createServer(handleRequest);
    await new Promise<void>((resolve, reject) => {
      server.on('error', reject);
      server.listen(socketPath, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    // Set permissions (Unix only)
    if (!isWindows()) {
      fs.chmodSync(socketPath, 0o600);
    }

    boundSocketPath = socketPath;

    // Write a per-session pointer file keyed by our parent PID (Claude
    // Code's PID). Sibling hooks share the same ppid and read from this
    // path first, so each session's hooks only ever hit their own MCP
    // server's socket — fixing the shared-current-file race.
    const sessionPointerPath = perSessionPointerPath(process.ppid);
    fs.writeFileSync(sessionPointerPath, socketPath, { mode: 0o600 });

    // Also write the legacy `current` file for backward compatibility
    // with older hooks and first-session discovery when per-session
    // pointers aren't available (e.g., if the ppid lookup fails).
    fs.writeFileSync(CURRENT_SOCKET_FILE, socketPath, { mode: 0o600 });

    registerCleanup(socketPath, sessionPointerPath);
  } finally {
    // Release lockfile
    await unlock(LOCKFILE_PATH);
  }
}
