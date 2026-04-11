// Backup / restore / verify framework for the Aletheia SQLite database.
//
// v0.2.0 item #24 — upgrade data preservation. The goal is that an
// operator (or the SysAdmin install pipeline) can take a snapshot of
// the live database before a version bump, run the upgrade, and
// restore from the snapshot if anything goes wrong. Prior to v0.2.0
// the procedure was an undocumented `cp ~/.aletheia/data/aletheia.db
// /tmp/foo.db`, which is incorrect because it skips uncommitted WAL
// pages of a live db.
//
// All three operations are exposed both as importable functions (used
// by `src/cli/cli.ts` and by tests) and as CLI subcommands.

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

import { ALETHEIA_HOME, DB_PATH } from '../lib/constants.js';
import { getSchemaVersion, CURRENT_SCHEMA_VERSION } from '../db/schema.js';

export const BACKUPS_DIR = path.join(ALETHEIA_HOME, 'backups');

export interface BackupResult {
  path: string;
  bytes: number;
}

export interface VerifyResult {
  ok: boolean;
  schemaVersion?: number;
  /**
   * The schema version this build targets. Compared against
   * `schemaVersion` to derive `needsMigration` / `fromFuture`.
   */
  expectedSchemaVersion?: number;
  /**
   * True when the database is behind this build — a backup made by
   * an older release. The server will auto-migrate on startup, but
   * operators should be aware before they commit to a restore.
   */
  needsMigration?: boolean;
  /**
   * True when the database reports a schema version higher than
   * this build knows about. This is a serious signal: a newer
   * Aletheia installed the db and this older binary should NOT
   * restore or open it.
   */
  fromFuture?: boolean;
  integrity?: string;
  entryCounts?: Record<string, number>;
  error?: string;
}

export interface RestoreResult {
  path: string;
  safetyBackupPath?: string;
  restoredFromSchema: number;
}

function timestampSlug(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/**
 * Online backup of a SQLite database. Uses better-sqlite3's native
 * `db.backup()` API which copies pages while writers continue, so a
 * live Aletheia server doesn't need to stop. The destination is
 * either an explicit path or `~/.aletheia/backups/aletheia-<ts>.db`.
 */
export async function backupDatabase(
  opts: { sourcePath?: string; targetPath?: string } = {},
): Promise<BackupResult> {
  const sourcePath = opts.sourcePath ?? DB_PATH;

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`source database not found: ${sourcePath}`);
  }

  let targetPath = opts.targetPath;
  if (!targetPath) {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    targetPath = path.join(BACKUPS_DIR, `aletheia-${timestampSlug()}.db`);
  } else {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  }

  const db = new Database(sourcePath, { readonly: true });
  try {
    await db.backup(targetPath);
  } finally {
    db.close();
  }

  const stat = fs.statSync(targetPath);
  return { path: targetPath, bytes: stat.size };
}

/**
 * Validate a SQLite file: integrity_check, schema_version readable,
 * count entries by class. Used both as a standalone command and as
 * a pre-restore safety check inside `restoreDatabase`.
 *
 * Returns `{ ok: false }` rather than throwing for any failure mode
 * the operator might recover from (file missing, not a sqlite db,
 * corrupted, schema_version table absent). Throws only for genuine
 * programmer errors.
 */
export async function verifyDatabase(
  opts: { path?: string } = {},
): Promise<VerifyResult> {
  const target = opts.path ?? DB_PATH;

  if (!fs.existsSync(target)) {
    return { ok: false, error: `file not found: ${target}` };
  }

  let db: Database.Database;
  try {
    db = new Database(target, { readonly: true });
  } catch (e: unknown) {
    return {
      ok: false,
      error: `cannot open as sqlite: ${(e as Error).message}`,
    };
  }

  try {
    // Integrity check first — if this fails, nothing else matters and
    // we shouldn't bother reading other tables that may be corrupted.
    // Note: better-sqlite3's `new Database()` opens lazily; the first
    // pragma/query is where SQLITE_NOTADB surfaces for non-sqlite
    // files. The outer try/catch below converts that into the return
    // shape callers expect.
    const integrityRows = db.pragma('integrity_check') as Array<{
      integrity_check: string;
    }>;
    const integrity = integrityRows[0]?.integrity_check ?? 'unknown';
    if (integrity !== 'ok') {
      return {
        ok: false,
        integrity,
        error: `integrity check failed: ${integrity}`,
      };
    }

    let schemaVersion: number;
    try {
      schemaVersion = getSchemaVersion(db);
    } catch (e: unknown) {
      return {
        ok: false,
        integrity,
        error: `schema_version unreadable: ${(e as Error).message}`,
      };
    }

    // Entry counts by class — quick sanity that the basic schema is
    // intact and the operator can see what they're about to restore.
    const entryCounts: Record<string, number> = {};
    try {
      const rows = db
        .prepare(
          `SELECT entry_class, COUNT(*) as n FROM entries GROUP BY entry_class`,
        )
        .all() as Array<{ entry_class: string; n: number }>;
      for (const row of rows) {
        entryCounts[row.entry_class] = row.n;
      }
    } catch (e: unknown) {
      return {
        ok: false,
        integrity,
        schemaVersion,
        error: `entries table query failed: ${(e as Error).message}`,
      };
    }

    // Compare the observed schema version against what this build
    // expects. A newer db is a hard fail (never overwrite the live
    // db with one this binary can't understand). An older db is a
    // soft warning: the server will migrate on startup, but the
    // operator should see the delta before they commit to the action.
    const needsMigration = schemaVersion < CURRENT_SCHEMA_VERSION;
    const fromFuture = schemaVersion > CURRENT_SCHEMA_VERSION;
    if (fromFuture) {
      return {
        ok: false,
        integrity,
        schemaVersion,
        expectedSchemaVersion: CURRENT_SCHEMA_VERSION,
        fromFuture,
        error: `database schema version ${schemaVersion} is newer than this build (${CURRENT_SCHEMA_VERSION})`,
      };
    }

    return {
      ok: true,
      integrity,
      schemaVersion,
      expectedSchemaVersion: CURRENT_SCHEMA_VERSION,
      needsMigration,
      fromFuture: false,
      entryCounts,
    };
  } catch (e: unknown) {
    // Lazy SqliteError surfaces here for non-sqlite files
    // (SQLITE_NOTADB) and any other unexpected db error.
    return {
      ok: false,
      error: `not a valid sqlite database: ${(e as Error).message}`,
    };
  } finally {
    db.close();
  }
}

/**
 * Replace a target database with a backup. Verifies the source is a
 * valid SQLite db before touching anything, takes a safety backup of
 * the current target (if any) so the operation is reversible, then
 * runs the online backup from source to target.
 */
export async function restoreDatabase(
  opts: { sourcePath: string; targetPath?: string },
): Promise<RestoreResult> {
  const targetPath = opts.targetPath ?? DB_PATH;

  // Validate the source first — never overwrite the target with a
  // file we can't even open.
  const sourceCheck = await verifyDatabase({ path: opts.sourcePath });
  if (!sourceCheck.ok) {
    throw new Error(
      `cannot restore from ${opts.sourcePath}: ${sourceCheck.error ?? 'verification failed'}`,
    );
  }

  // Take a safety backup of the existing target if one exists. The
  // operator can roll back via `aletheia restore <safetyBackupPath>`
  // if the restore turns out to be wrong.
  let safetyBackupPath: string | undefined;
  if (fs.existsSync(targetPath)) {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    const candidate = path.join(BACKUPS_DIR, `pre-restore-${timestampSlug()}.db`);
    const safetyResult = await backupDatabase({
      sourcePath: targetPath,
      targetPath: candidate,
    });
    safetyBackupPath = safetyResult.path;
  }

  // Perform the actual restore via the online backup API. We do NOT
  // simply `fs.copyFile` because the source's WAL state may not be
  // checkpointed; better-sqlite3's backup handles WAL correctly.
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const sourceDb = new Database(opts.sourcePath, { readonly: true });
  try {
    await sourceDb.backup(targetPath);
  } finally {
    sourceDb.close();
  }

  return {
    path: targetPath,
    safetyBackupPath,
    // sourceCheck.ok was true, so schemaVersion is set.
    restoredFromSchema: sourceCheck.schemaVersion as number,
  };
}
