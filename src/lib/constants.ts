import os from 'os';
import path from 'path';

export const ALETHEIA_HOME = path.join(os.homedir(), '.aletheia');
export const SOCKETS_DIR = path.join(ALETHEIA_HOME, 'sockets');
export const KEYS_DIR = path.join(ALETHEIA_HOME, 'keys');
export const DATA_DIR = path.join(ALETHEIA_HOME, 'data');
export const TEMPLATES_DIR = path.join(ALETHEIA_HOME, 'templates');
export const LOGS_DIR = path.join(ALETHEIA_HOME, 'logs');
export const SETTINGS_PATH = path.join(ALETHEIA_HOME, 'settings.toml');
export const DB_PATH = path.join(DATA_DIR, 'aletheia.db');
export const LOCKFILE_PATH = path.join(SOCKETS_DIR, 'startup.lock');

export const DEFAULTS = {
  l1Interval: 10,
  l2Interval: 20,
  tokenBudget: 1500,
  digestEntryThreshold: 15,
  digestTimeThresholdHours: 4,
  hookTimeoutSeconds: 2,
  showRelatedDefaultThreshold: 1,
  circuitBreakerWritesPerInterval: 20,
  circuitBreakerIntervalMinutes: 5,
  criticalWriteCap: 3,
  adaptiveNoChangeBumpMultiplier: 2,
  rollingDefault: 50,
} as const;
