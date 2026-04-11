// Round-4 regression test for `aletheia --version`.
//
// The CEO's pre-install sandbox test of the v0.2.x tarball
// surfaced that `aletheia --version` returned exit 1 because
// no flag handler existed in the CLI dispatcher. Standard
// CLI hygiene says --version should print the version and
// exit 0; the lack of it broke automated install scripts and
// version-pinning tooling.
//
// Post-fix:
//   - `aletheia --version`, `-v`, and `version` all print the
//     bare version string to stdout and exit 0.
//   - `aletheia --help`, `-h`, and `help` print usage to
//     stderr and exit 0.
//   - Unknown subcommands still print usage and exit 1.
//
// Tests spawn the compiled dist/cli/cli.js as a child node
// process so the binary path matches what installed users
// would invoke. Stdout / stderr / exit code are all asserted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';

// Import VERSION from the dedicated lib/version module rather than
// cli.js — cli.js has an unguarded main() at module bottom that
// would call process.exit(1) when imported with a test file path
// in argv[2], killing the test process before the assertions run.
import { VERSION } from '../dist/lib/version.js';

const CLI_PATH = path.resolve('dist/cli/cli.js');

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => {
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

test('VERSION constant matches the package version', async () => {
  // Static guard against drift between cli.ts's hardcoded
  // VERSION and package.json. Also validates that the import
  // works.
  const { readFile } = await import('node:fs/promises');
  const pkg = JSON.parse(await readFile('package.json', 'utf-8'));
  assert.equal(VERSION, pkg.version, 'cli.ts VERSION must track package.json');
});

test('aletheia --version prints version to stdout and exits 0', async () => {
  const { code, stdout } = await runCli(['--version']);
  assert.equal(code, 0, '--version should exit 0');
  assert.equal(stdout, VERSION, 'stdout should be the bare version string');
});

test('aletheia -v is an alias for --version', async () => {
  const { code, stdout } = await runCli(['-v']);
  assert.equal(code, 0);
  assert.equal(stdout, VERSION);
});

test('aletheia version is also an alias for --version (subcommand form)', async () => {
  const { code, stdout } = await runCli(['version']);
  assert.equal(code, 0);
  assert.equal(stdout, VERSION);
});

test('aletheia --help prints usage and exits 0', async () => {
  const { code, stderr } = await runCli(['--help']);
  assert.equal(code, 0, '--help should exit 0');
  assert.match(stderr, /Usage: aletheia/);
  assert.match(stderr, /setup/);
  assert.match(stderr, /backup/);
  assert.match(stderr, /verify/);
  // Usage banner should also include the version.
  assert.match(stderr, new RegExp(`aletheia ${VERSION.replace(/\./g, '\\.')}`));
});

test('aletheia -h is an alias for --help', async () => {
  const { code, stderr } = await runCli(['-h']);
  assert.equal(code, 0);
  assert.match(stderr, /Usage: aletheia/);
});

test('unknown subcommand still exits 1 with usage (regression guard)', async () => {
  const { code, stderr } = await runCli(['definitely-not-a-real-subcommand']);
  assert.equal(code, 1, 'unknown subcommand must keep exiting 1');
  assert.match(stderr, /Usage: aletheia/);
});

test('no subcommand at all also exits 1 with usage', async () => {
  const { code, stderr } = await runCli([]);
  assert.equal(code, 1);
  assert.match(stderr, /Usage: aletheia/);
});
