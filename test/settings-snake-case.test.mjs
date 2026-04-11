// Round-4 regression test for the latent snake_case override
// bug in loadSettings, documented in src/lib/settings.ts since
// v0.1.1 and deferred until now.
//
// Pre-fix behavior: loadSettings only normalized snake_case →
// camelCase for the [limits] section. Snake-case keys in any
// other section (e.g. `l1_interval = 5` under [injection])
// silently failed to override the camelCase TypeScript defaults
// because deepMerge copied the snake_case key verbatim, leaving
// the camelCase default untouched. Operators who copied the
// natural TOML form from documentation never realized their
// override wasn't taking effect.
//
// Post-fix: snake_case is normalized for every object section
// (injection, memory, hooks, digest, limits) so any of the
// natural TOML key forms work as expected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// loadSettings reads from a fixed SETTINGS_PATH derived from
// constants. To test it without touching the user's real
// settings.toml we have to override HOME (which the constants
// resolver uses) BEFORE we import the modules. We'll spawn a
// helper subprocess that imports loadSettings with HOME set to
// a temp dir we control.
import { spawn } from 'node:child_process';

function withTmpHome(fn) {
  return async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aletheia-settings-test-'));
    try {
      await fn(tmp);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
}

function writeSettings(home, content) {
  const dir = path.join(home, '.aletheia');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.toml'), content);
}

// Run loadSettings in a child process with the given HOME and
// return the parsed JSON it prints to stdout.
function runLoadSettings(home) {
  return new Promise((resolve, reject) => {
    const inlineScript = `
      import { loadSettings } from '${path.resolve('dist/lib/settings.js')}';
      process.stdout.write(JSON.stringify(loadSettings()));
    `;
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', inlineScript],
      {
        env: { ...process.env, HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`loadSettings child exited ${code}: ${stderr}`));
        return;
      }
      try {
        resolve({ settings: JSON.parse(stdout), stderr });
      } catch (e) {
        reject(new Error(`failed to parse stdout: ${stdout}\n${stderr}`));
      }
    });
  });
}

test(
  'snake_case keys in [injection] override camelCase defaults (latent fix)',
  withTmpHome(async (home) => {
    writeSettings(home, `
[injection]
l1_interval = 99
l2_interval = 77
token_budget = 4242
`);
    const { settings } = await runLoadSettings(home);
    assert.equal(settings.injection.l1Interval, 99, 'l1_interval should land on l1Interval');
    assert.equal(settings.injection.l2Interval, 77);
    assert.equal(settings.injection.tokenBudget, 4242);
  }),
);

test(
  'snake_case keys in [memory] override camelCase defaults',
  withTmpHome(async (home) => {
    writeSettings(home, `
[memory]
disable_system_memory = true
rolling_default = 25
`);
    const { settings } = await runLoadSettings(home);
    assert.equal(settings.memory.disableSystemMemory, true);
    assert.equal(settings.memory.rollingDefault, 25);
  }),
);

test(
  'snake_case keys in [digest] override camelCase defaults',
  withTmpHome(async (home) => {
    writeSettings(home, `
[digest]
entry_threshold = 11
time_threshold_hours = 6
critical_write_cap = 9
`);
    const { settings } = await runLoadSettings(home);
    assert.equal(settings.digest.entryThreshold, 11);
    assert.equal(settings.digest.timeThresholdHours, 6);
    assert.equal(settings.digest.criticalWriteCap, 9);
  }),
);

test(
  'snake_case keys in [limits] still work (no regression on the v0.1.1 fix)',
  withTmpHome(async (home) => {
    writeSettings(home, `
[limits]
circuit_breaker_writes_per_interval = 7
circuit_breaker_interval_minutes = 3
critical_write_cap = 4
`);
    const { settings } = await runLoadSettings(home);
    assert.equal(settings.limits.circuitBreakerWritesPerInterval, 7);
    assert.equal(settings.limits.circuitBreakerIntervalMinutes, 3);
    assert.equal(settings.limits.criticalWriteCap, 4);
  }),
);

test(
  'camelCase keys still work (no regression on the existing path)',
  withTmpHome(async (home) => {
    writeSettings(home, `
[injection]
l1Interval = 50
tokenBudget = 1000
`);
    const { settings } = await runLoadSettings(home);
    assert.equal(settings.injection.l1Interval, 50);
    assert.equal(settings.injection.tokenBudget, 1000);
  }),
);

test(
  'malformed TOML falls back to defaults instead of crashing',
  withTmpHome(async (home) => {
    // This is the safety-net behavior the round-4 task asked
    // about. loadSettings already handles this — pin it as a
    // regression guard.
    writeSettings(home, `[injection
this is not valid toml at all === broken
`);
    const { settings, stderr } = await runLoadSettings(home);
    assert.ok(settings, 'should still return a settings object');
    assert.equal(settings.injection.l1Interval, 10, 'should fall back to default l1Interval');
    assert.match(stderr, /Malformed settings.toml/, 'should log a warning to stderr');
  }),
);
