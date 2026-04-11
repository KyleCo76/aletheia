#!/usr/bin/env node

import { setup } from './setup.js';
import { teardown } from './teardown.js';
import {
  backupDatabase,
  restoreDatabase,
  verifyDatabase,
} from './backup.js';

const command = process.argv[2];
const args = process.argv.slice(3);

function printUsage(): void {
  console.error('Usage: aletheia <subcommand>');
  console.error('  setup                    Install Aletheia memory system');
  console.error('  teardown                 Remove Aletheia registrations');
  console.error('  backup [path]            Online backup of live database');
  console.error('  restore <path>           Restore live database from backup');
  console.error('  verify [path]            Verify integrity of database file');
}

async function main(): Promise<void> {
  switch (command) {
    case 'setup':
      await setup();
      return;

    case 'teardown':
      await teardown();
      return;

    case 'backup': {
      const targetPath = args[0]; // optional positional override
      const result = await backupDatabase({ targetPath });
      console.log(`Backup written: ${result.path}`);
      console.log(`  size: ${result.bytes} bytes`);
      return;
    }

    case 'restore': {
      const sourcePath = args[0];
      if (!sourcePath) {
        console.error('Usage: aletheia restore <path-to-backup>');
        process.exit(1);
      }
      const result = await restoreDatabase({ sourcePath });
      console.log(`Restored from ${sourcePath}`);
      console.log(`  target:         ${result.path}`);
      console.log(`  schema version: ${result.restoredFromSchema}`);
      if (result.safetyBackupPath) {
        console.log(`  safety backup:  ${result.safetyBackupPath}`);
        console.log('  (use `aletheia restore <safety backup>` to roll back)');
      }
      return;
    }

    case 'verify': {
      const target = args[0]; // optional path; defaults to live db
      const result = await verifyDatabase({ path: target });
      const label = target ?? 'live database';
      if (result.ok) {
        console.log(`OK: ${label}`);
        console.log(`  schema version: ${result.schemaVersion} (this build expects ${result.expectedSchemaVersion})`);
        if (result.needsMigration) {
          console.log(
            '  NOTE: database is behind this build and will be auto-migrated on next server startup',
          );
        }
        console.log(`  integrity:      ${result.integrity}`);
        if (result.entryCounts) {
          for (const [cls, n] of Object.entries(result.entryCounts)) {
            console.log(`  ${cls}: ${n}`);
          }
        }
      } else {
        console.error(`FAIL: ${label}`);
        console.error(`  ${result.error}`);
        if (result.fromFuture) {
          console.error(
            '  This database was written by a newer Aletheia. Do NOT restore it with this binary.',
          );
        }
        process.exit(1);
      }
      return;
    }

    default:
      printUsage();
      process.exit(1);
  }
}

main().catch((err: Error) => {
  console.error(`aletheia: ${err.message}`);
  process.exit(1);
});
