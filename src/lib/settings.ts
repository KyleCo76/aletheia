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

  return deepMerge(defaults as unknown as Record<string, unknown>, parsed) as unknown as AletheiaSettings;
}
