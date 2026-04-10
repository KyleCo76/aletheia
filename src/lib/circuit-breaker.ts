import type { AletheiaSettings } from './settings.js';
import { DEFAULTS } from './constants.js';
import { formatError } from './errors.js';

interface WriteRecord {
  timestamp: number;
}

const SESSION_KEY = 'generalWriteLog';

export function checkGeneralCircuitBreaker(
  sessionState: Map<string, unknown>,
  settings: AletheiaSettings,
): { blocked: true; response: { content: Array<{ type: string; text: string }>; isError: boolean } } | { blocked: false } {
  const now = Date.now();
  // Read from settings.limits (populated from the [limits] section of
  // settings.toml) so operators can raise the cap during bulk imports
  // and lower it afterwards, without editing source. Falls back to the
  // built-in defaults if settings.limits isn't present (e.g., an older
  // settings.toml from v0.1.0).
  const intervalMinutes =
    settings.limits?.circuitBreakerIntervalMinutes ?? DEFAULTS.circuitBreakerIntervalMinutes;
  const maxWrites =
    settings.limits?.circuitBreakerWritesPerInterval ?? DEFAULTS.circuitBreakerWritesPerInterval;
  const intervalMs = intervalMinutes * 60 * 1000;

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
            `General write limit (${maxWrites} per ${intervalMinutes} minutes) exceeded. Wait before writing again.`,
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
