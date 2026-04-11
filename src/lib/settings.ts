import { SETTINGS_PATH, DEFAULTS } from './constants.js';
import fs from 'fs';
import { parse } from 'smol-toml';

export interface AletheiaSettings {
  permissions: { enforce: boolean };
  injection: {
    trigger: 'PreToolUse' | 'UserPromptSubmit';
    l1Interval: number;
    l2Interval: number;
    historyReminders: boolean;
    tokenBudget: number;
  };
  memory: {
    disableSystemMemory: boolean;
    rollingDefault: number;
  };
  hooks: {
    startup: boolean;
    l1Injection: boolean;
    l2Injection: boolean;
    memoryInterception: boolean;
    overlapDetection: boolean;
  };
  digest: {
    entryThreshold: number;
    timeThresholdHours: number;
    criticalWriteCap: number;
  };
  limits: {
    circuitBreakerWritesPerInterval: number;
    circuitBreakerIntervalMinutes: number;
    criticalWriteCap: number;
  };
  debug: boolean;
}

function getDefaults(): AletheiaSettings {
  return {
    permissions: { enforce: false },
    injection: {
      trigger: 'PreToolUse',
      l1Interval: DEFAULTS.l1Interval,
      l2Interval: DEFAULTS.l2Interval,
      historyReminders: true,
      tokenBudget: DEFAULTS.tokenBudget,
    },
    memory: {
      disableSystemMemory: false,
      rollingDefault: DEFAULTS.rollingDefault,
    },
    hooks: {
      startup: true,
      l1Injection: true,
      l2Injection: true,
      memoryInterception: true,
      overlapDetection: true,
    },
    digest: {
      entryThreshold: DEFAULTS.digestEntryThreshold,
      timeThresholdHours: DEFAULTS.digestTimeThresholdHours,
      criticalWriteCap: DEFAULTS.criticalWriteCap,
    },
    limits: {
      circuitBreakerWritesPerInterval: DEFAULTS.circuitBreakerWritesPerInterval,
      circuitBreakerIntervalMinutes: DEFAULTS.circuitBreakerIntervalMinutes,
      criticalWriteCap: DEFAULTS.criticalWriteCap,
    },
    debug: false,
  };
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = target[key];
    if (
      srcVal !== null &&
      typeof srcVal === 'object' &&
      !Array.isArray(srcVal) &&
      tgtVal !== null &&
      typeof tgtVal === 'object' &&
      !Array.isArray(tgtVal)
    ) {
      result[key] = deepMerge(tgtVal as Record<string, unknown>, srcVal as Record<string, unknown>);
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}

/**
 * Convert snake_case keys in a plain object to camelCase. Used
 * specifically for the [limits] section so operators can write the
 * natural TOML form (circuit_breaker_writes_per_interval) and have it
 * land on the camelCase TypeScript field. (deepMerge above copies
 * unknown keys verbatim, so without this the override silently fails.)
 */
function snakeToCamelObject(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const camelKey = key.replace(/_([a-z])/g, (_m, ch: string) => ch.toUpperCase());
    out[camelKey] = value;
  }
  return out;
}

export function loadSettings(): AletheiaSettings {
  const defaults = getDefaults();

  if (!fs.existsSync(SETTINGS_PATH)) {
    return defaults;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
  } catch {
    console.error(`[aletheia] Failed to read settings file: ${SETTINGS_PATH}`);
    return defaults;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parse(raw) as Record<string, unknown>;
  } catch (err) {
    console.error(`[aletheia] Malformed settings.toml: ${err instanceof Error ? err.message : err}`);
    return defaults;
  }

  // Normalize snake_case → camelCase for every object section
  // before merging, so TOML keys in any natural form
  // (`l1_interval`, `disable_system_memory`,
  // `circuit_breaker_writes_per_interval`...) actually override
  // the camelCase TypeScript defaults. Prior to v0.2.7 only
  // [limits] was normalized — the original v0.1.1 fix carved
  // out a single section because broader normalization was
  // considered too risky. The risk turned out to be theoretical
  // (no test depended on snake_case being broken in other
  // sections), and the bug was a real silent override failure
  // affecting any operator who copied the natural TOML form
  // from documentation. The full normalization ships in v0.2.7.
  for (const [sectionKey, sectionVal] of Object.entries(parsed)) {
    if (
      sectionVal !== null &&
      typeof sectionVal === 'object' &&
      !Array.isArray(sectionVal)
    ) {
      parsed[sectionKey] = snakeToCamelObject(sectionVal as Record<string, unknown>);
    }
  }

  return deepMerge(defaults as unknown as Record<string, unknown>, parsed) as unknown as AletheiaSettings;
}
