#!/usr/bin/env node
// Build wrapper for the npm `prepare` lifecycle.
//
// Why this exists:
//   `npm install -g git+https://github.com/KyleCo76/aletheia.git#vX.Y.Z`
//   has historically failed because npm's global install path doesn't
//   reliably install devDependencies before running `prepare`, so `tsc`
//   isn't on PATH when `npm run build` tries to invoke it. The install
//   then crashes with an opaque error.
//
// What this does:
//   - If tsc is available locally (devDependencies installed), run the
//     normal build pipeline. This is the path used for local dev,
//     `npm pack` in CI, and any consumer that ran `npm install` with
//     devDependencies enabled.
//   - If tsc is NOT available, skip the build and exit with code 0,
//     printing a clear stderr message that explains why and points
//     users at the supported install path (the prebuilt release
//     tarball published by .github/workflows/release.yml).
//
// Net effect: `npm install -g git+...` no longer aborts with a
// confusing tsc error. Users still need to install via the release
// tarball URL to get a working binary, but at least they're told so
// instead of seeing an opaque module-not-found.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// Look for the local tsc binary that `npm install` would have placed
// in node_modules/.bin. We check the file directly rather than relying
// on $PATH because npm doesn't always add node_modules/.bin to PATH
// under every install context.
const tscCandidates = [
  path.join(projectRoot, 'node_modules', '.bin', 'tsc'),
  path.join(projectRoot, 'node_modules', '.bin', 'tsc.cmd'),
];
const tscPresent = tscCandidates.some((p) => existsSync(p));

if (!tscPresent) {
  console.error('[aletheia] prepare: typescript is not installed; skipping build.');
  console.error('[aletheia] this is expected for global installs from a git URL.');
  console.error('[aletheia] the supported install path is the prebuilt release tarball:');
  console.error('[aletheia]   npm install -g \\');
  console.error('[aletheia]     https://github.com/KyleCo76/aletheia/releases/download/<tag>/aletheia-<version>.tgz');
  console.error('[aletheia] see CHANGELOG.md or the GitHub releases page for the current URL.');
  process.exit(0);
}

// Hardcoded command + arg array, no shell interpolation, no user
// input — execFileSync is safe here. The Windows .cmd shim is needed
// because npm on Windows installs as npm.cmd; Node will not auto-
// resolve the extension when invoked via execFile.
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
execFileSync(npmCmd, ['run', 'build'], { stdio: 'inherit', cwd: projectRoot });
