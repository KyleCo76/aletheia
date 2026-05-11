import type { AletheiaSettings } from './settings.js';
import { DEFAULTS } from './constants.js';
import { formatError } from './errors.js';

interface WriteRecord {
  timestamp: number;
}

const SESSION_KEY = 'generalWriteLog';

/**
 * Permission levels permitted to bypass the circuit breaker
 * on a per-call basis via the `bypass_circuit_breaker` flag on
 * write_journal / write_memory / replace_status. The bypass is
 * silently ignored for any other permission level (no error,
 * no warning — throttle proceeds as normal). This preserves
 * read-only / read-write callers' inability to escalate while
 * giving PM-tier sessions a documented escape hatch for bulk
 * ingest workflows.
 */
export const BYPASS_PERMITTED_PERMISSIONS = new Set([
  'create-sub-entries',
  'maintenance',
]);

/**
 * Resolve the effective bypass for a single mutating call.
 * Returns `true` only when BOTH the caller passed
 * `bypass_circuit_breaker: true` AND the claim's permission
 * level is in the trusted set. Unclaimed sessions (dev mode)
 * never bypass — there's no claim to gate against.
 */
export function resolveBypass(
  sessionState: Map<string, unknown>,
  requested: boolean | undefined,
): boolean {
  if (!requested) return false;
  const claimed = sessionState.get('claimedKey') as
    | { permissions: string }
    | undefined;
  if (!claimed) return false;
  return BYPASS_PERMITTED_PERMISSIONS.has(claimed.permissions);
}

export function checkGeneralCircuitBreaker(
  sessionState: Map<string, unknown>,
  settings: AletheiaSettings,
  bypass: boolean = false,
): { blocked: true; response: { content: Array<{ type: string; text: string }>; isError: boolean } } | { blocked: false } {
  if (bypass) return { blocked: false };
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
