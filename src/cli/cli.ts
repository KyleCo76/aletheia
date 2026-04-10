#!/usr/bin/env node

import { setup } from './setup.js';
import { teardown } from './teardown.js';

const command = process.argv[2];

switch (command) {
  case 'setup':
    setup().catch(err => { console.error('Setup failed:', err); process.exit(1); });
    break;
  case 'teardown':
    teardown().catch(err => { console.error('Teardown failed:', err); process.exit(1); });
    break;
  default:
    console.error('Usage: aletheia <setup|teardown>');
    console.error('  setup     - Install Aletheia memory system');
    console.error('  teardown  - Remove Aletheia registrations');
    process.exit(1);
}
