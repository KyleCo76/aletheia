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

const CURRENT_SOCKET_FILE = path.join(SOCKETS_DIR, 'current');

function registerCleanup(socketPath: string): void {
  const cleanup = () => {
    try { fs.unlinkSync(socketPath); } catch { /* ignore */ }
    try { fs.unlinkSync(CURRENT_SOCKET_FILE); } catch { /* ignore */ }
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

    // Write socket path to well-known file for hook discovery
    fs.writeFileSync(CURRENT_SOCKET_FILE, socketPath, { mode: 0o600 });

    registerCleanup(socketPath);
  } finally {
    // Release lockfile
    await unlock(LOCKFILE_PATH);
  }
}
