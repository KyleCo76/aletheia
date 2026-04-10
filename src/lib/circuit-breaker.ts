import type { AletheiaSettings } from './settings.js';
import { DEFAULTS } from './constants.js';
import { formatError } from './errors.js';

interface WriteRecord {
  timestamp: number;
}

const SESSION_KEY = 'generalWriteLog';

export function checkGeneralCircuitBreaker(
  sessionState: Map<string, unknown>,
  _settings: AletheiaSettings,
): { blocked: true; response: { content: Array<{ type: string; text: string }>; isError: boolean } } | { blocked: false } {
  const now = Date.now();
  const intervalMs = DEFAULTS.circuitBreakerIntervalMinutes * 60 * 1000;
  const maxWrites = DEFAULTS.circuitBreakerWritesPerInterval;

  let log = sessionState.get(SESSION_KEY) as WriteRecord[] | undefined;
  if (!log) {
    log = [];
    sessionState.set(SESSION_KEY, log);
  }

  // Prune entries outside the rolling window
  const cutoff = now - intervalMs;
  while (log.length > 0 && log[0].timestamp < cutoff) {
    log.shift();
  }

  if (log.length >= maxWrites) {
    return {
      blocked: true,
      response: {
        content: [{
          type: 'text',
          text: formatError(
            'CIRCUIT_BREAKER',
            `General write limit (${maxWrites} per ${DEFAULTS.circuitBreakerIntervalMinutes} minutes) exceeded. Wait before writing again.`,
          ),
        }],
        isError: true,
      },
    };
  }

  return { blocked: false };
}

export function recordWrite(sessionState: Map<string, unknown>): void {
  let log = sessionState.get(SESSION_KEY) as WriteRecord[] | undefined;
  if (!log) {
    log = [];
    sessionState.set(SESSION_KEY, log);
  }
  log.push({ timestamp: Date.now() });
}
