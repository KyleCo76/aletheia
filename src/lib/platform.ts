import os from 'os';
import path from 'path';
import { SOCKETS_DIR } from './constants.js';

export function getSocketPath(pid: number = process.pid): string {
  if (os.platform() === 'win32') {
    return `\\\\.\\pipe\\aletheia-${pid}`;
  }
  return path.join(SOCKETS_DIR, `aletheia-${pid}.sock`);
}

export function isWindows(): boolean {
  return os.platform() === 'win32';
}
