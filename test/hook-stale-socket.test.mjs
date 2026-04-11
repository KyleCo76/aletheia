// Round-3 P1 regression test for stale-socket short-circuit
// in the unix hook scripts.
//
// Pre-fix behavior: every hook invocation against a stale
// `~/.aletheia/sockets/claude-$PPID.sock.path` pointer waited
// the full curl timeout (2 seconds) before exiting 0. On dev
// workstations where the MCP server may have died between
// sessions, this added 2s of latency to every Claude Code hook
// invocation. The hooks are invoked on PreToolUse and similar
// fast-path events, so the wait was visible.
//
// Post-fix behavior: hooks check `[ -S "$SOCK" ]` after socket
// discovery and exit 0 immediately when the path doesn't point
// at a live unix domain socket. Fail-open semantics preserved.
//
// Test setup: spawn each hook script with HOME pointed at a
// temp directory containing a `claude-$PPID.sock.path` file
// that names a non-existent socket. Time the execution and
// assert it's well under the 2s timeout — proving the
// short-circuit fired.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Hooks live at hooks/unix in the package layout. Tests run
// after `npm run build && npm run copy-hooks`, so the hooks
// directory is populated with the up-to-date scripts.
const HOOKS_DIR = path.resolve('hooks/unix');

const HOOK_SCRIPTS = [
  'l1-inject.sh',
  'l2-inject.sh',
  'memory-intercept.sh',
  'startup.sh',
];

function withTmp(fn) {
  return async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aletheia-hook-test-'));
    try {
      await fn(tmp);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
}

function runHook(scriptPath, env) {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn('/bin/sh', [scriptPath], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr, durationMs: Date.now() - start });
    });
  });
}

for (const script of HOOK_SCRIPTS) {
  test(
    `${script} short-circuits when the discovered socket pointer is stale`,
    withTmp(async (tmp) => {
      // Build a fake HOME with a sockets dir + a stale per-PPID
      // pointer file. The pointer names a path that does not
      // exist — pre-fix, curl would still try to connect and
      // wait the full 2s timeout. Post-fix, the script's
      // `[ -S "$SOCK" ]` test fails first and exit 0 fires
      // immediately.
      const sockDir = path.join(tmp, '.aletheia', 'sockets');
      fs.mkdirSync(sockDir, { recursive: true });
      const stalePath = path.join(tmp, 'definitely-not-a-real.sock');
      // Note: we use the parent's PPID which is the test runner.
      // The hook reads $PPID which is the parent shell of the
      // hook script — when we spawn `/bin/sh script.sh`, $PPID
      // inside the script equals the spawning Node process's pid.
      const ppid = process.pid;
      fs.writeFileSync(
        path.join(sockDir, `claude-${ppid}.sock.path`),
        stalePath,
      );

      const env = {
        ...process.env,
        HOME: tmp,
        // Unset ALETHEIA_SOCK so the discovery falls through
        // to the per-PPID pointer file.
        ALETHEIA_SOCK: '',
      };

      const { code, durationMs } = await runHook(
        path.join(HOOKS_DIR, script),
        env,
      );

      assert.equal(code, 0, `${script} should exit 0 (fail-open)`);
      // Pre-fix: ~2000ms (curl timeout). Post-fix: << 100ms (no
      // network at all). 500ms is a generous ceiling that proves
      // the short-circuit ran without being flaky on slow CI.
      assert.ok(
        durationMs < 500,
        `${script} should short-circuit fast (got ${durationMs}ms, expected < 500ms; pre-fix was ~2000ms)`,
      );
    }),
  );
}

test(
  'l1-inject.sh exits 0 instantly when no socket pointer file exists',
  withTmp(async (tmp) => {
    // No pointer file at all. The original code already exited
    // 0 fast in this case (the `if [ -z "$SOCK" ]` check), so
    // this is a regression guard against the new short-circuit
    // accidentally breaking the no-discovery path.
    const env = {
      ...process.env,
      HOME: tmp,
      ALETHEIA_SOCK: '',
    };
    const { code, durationMs } = await runHook(
      path.join(HOOKS_DIR, 'l1-inject.sh'),
      env,
    );
    assert.equal(code, 0);
    assert.ok(durationMs < 500, `expected < 500ms, got ${durationMs}ms`);
  }),
);

test(
  'l1-inject.sh short-circuits when ALETHEIA_SOCK env points to a stale path',
  withTmp(async (tmp) => {
    // Coverage for the ALETHEIA_SOCK env-var path which bypasses
    // pointer-file discovery entirely. The new `[ -S "$SOCK" ]`
    // check still applies.
    const env = {
      ...process.env,
      HOME: tmp,
      ALETHEIA_SOCK: path.join(tmp, 'definitely-not-a-real.sock'),
    };
    const { code, durationMs } = await runHook(
      path.join(HOOKS_DIR, 'l1-inject.sh'),
      env,
    );
    assert.equal(code, 0);
    assert.ok(
      durationMs < 500,
      `env-var stale path should also short-circuit (got ${durationMs}ms)`,
    );
  }),
);
