import type Database from 'better-sqlite3';
import type { AletheiaSettings } from '../../lib/settings.js';
import { validateKey, createKey, modifyKey, listKeys } from '../../db/queries/keys.js';
import { formatError } from '../../lib/errors.js';
import { KEYS_DIR } from '../../lib/constants.js';
import fs from 'fs';
import path from 'path';

export type ToolHandler = (args: Record<string, unknown>) => {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

function requireClaim(
  sessionState: Map<string, unknown>,
  settings: AletheiaSettings,
): { id: string; permissions: string; entryScope: string | null } | null {
  if (!settings.permissions.enforce) return null;
  const claimed = sessionState.get('claimedKey') as
    | { id: string; permissions: string; entryScope: string | null }
    | undefined;
  return claimed ?? null;
}

function claimError(): { content: Array<{ type: string; text: string }>; isError: boolean } {
  return {
    content: [{ type: 'text', text: formatError('NO_CLAIM', 'Use claim(key) to authenticate') }],
    isError: true,
  };
}

export function registerAuthTools(
  handlers: Record<string, ToolHandler>,
  db: Database.Database,
  settings: AletheiaSettings,
  sessionState: Map<string, unknown>,
): void {
  handlers['claim'] = (args) => {
    const keyValue = args.key as string | undefined;
    if (!keyValue) {
      return {
        content: [{ type: 'text', text: formatError('INVALID_INPUT', 'key is required') }],
        isError: true,
      };
    }

    const result = validateKey(db, { keyValue });
    if (!result) {
      return {
        content: [{ type: 'text', text: formatError('INVALID_KEY', 'Key not found or invalid') }],
        isError: true,
      };
    }

    sessionState.set('claimedKey', result);
    if (result.entryScope) {
      sessionState.set('claimedEntry', result.entryScope);
    }

    return {
      content: [{
        type: 'text',
        text: `<result><id>${result.id}</id><permissions>${result.permissions}</permissions><entry_scope>${result.entryScope ?? ''}</entry_scope></result>`,
      }],
    };
  };

  handlers['whoami'] = () => {
    const claimed = sessionState.get('claimedKey') as
      | { id: string; permissions: string; entryScope: string | null }
      | undefined;

    if (!claimed) {
      return {
        content: [{ type: 'text', text: '<result><status>unclaimed</status></result>' }],
      };
    }

    return {
      content: [{
        type: 'text',
        text: `<result><status>claimed</status><id>${claimed.id}</id><permissions>${claimed.permissions}</permissions><entry_scope>${claimed.entryScope ?? ''}</entry_scope></result>`,
      }],
    };
  };

  handlers['bootstrap'] = (args) => {
    const name = args.name as string | undefined;
    const enforcePermissions = args.enforce_permissions as boolean | undefined;

    if (!name) {
      return {
        content: [{ type: 'text', text: formatError('INVALID_INPUT', 'name is required') }],
        isError: true,
      };
    }

    // Check if master key file already exists for this project name
    const keyFilePath = path.join(KEYS_DIR, `${name}.key`);
    if (fs.existsSync(keyFilePath)) {
      return {
        content: [{ type: 'text', text: formatError('ALREADY_BOOTSTRAPPED', `Project "${name}" has already been bootstrapped`) }],
        isError: true,
      };
    }

    // Create master key
    const keyResult = createKey(db, {
      permissions: 'maintenance',
      entryScope: name,
    });

    // Ensure keys directory exists and write key file with 0600 permissions
    fs.mkdirSync(KEYS_DIR, { recursive: true });
    fs.writeFileSync(keyFilePath, keyResult.keyValue, { mode: 0o600 });

    // Store the project namespace in session state
    sessionState.set('projectNamespace', name);

    // Update enforce setting if specified
    if (enforcePermissions !== undefined) {
      settings.permissions.enforce = enforcePermissions;
    }

    // Auto-claim the new key
    sessionState.set('claimedKey', {
      id: keyResult.id,
      permissions: keyResult.permissions,
      entryScope: name,
    });
    sessionState.set('claimedEntry', name);

    return {
      content: [{
        type: 'text',
        text: `<result><key>${keyResult.keyValue}</key><key_id>${keyResult.id}</key_id><permissions>${keyResult.permissions}</permissions><key_file>${keyFilePath}</key_file><project>${name}</project></result>`,
      }],
    };
  };

  handlers['create_key'] = (args) => {
    const permissions = args.permissions as string | undefined;
    const entryScope = args.entry_scope as string | undefined;

    if (!permissions) {
      return {
        content: [{ type: 'text', text: formatError('INVALID_INPUT', 'permissions is required') }],
        isError: true,
      };
    }

    if (settings.permissions.enforce) {
      const claimed = requireClaim(sessionState, settings);
      if (!claimed) return claimError();

      if (claimed.permissions !== 'maintenance' && claimed.permissions !== 'create-sub-entries') {
        return {
          content: [{ type: 'text', text: formatError('INSUFFICIENT_PERMISSIONS', 'Requires create-sub-entries or maintenance permission') }],
          isError: true,
        };
      }
    }

    const claimed = sessionState.get('claimedKey') as
      | { id: string; permissions: string; entryScope: string | null }
      | undefined;

    const result = createKey(db, {
      permissions,
      entryScope,
      createdBy: claimed?.id,
    });

    return {
      content: [{
        type: 'text',
        text: `<result><id>${result.id}</id><key>${result.keyValue}</key><permissions>${result.permissions}</permissions></result>`,
      }],
    };
  };

  handlers['modify_key'] = (args) => {
    const keyId = args.key_id as string | undefined;
    const permissions = args.permissions as string | undefined;

    if (!keyId || !permissions) {
      return {
        content: [{ type: 'text', text: formatError('INVALID_INPUT', 'key_id and permissions are required') }],
        isError: true,
      };
    }

    if (settings.permissions.enforce) {
      const claimed = requireClaim(sessionState, settings);
      if (!claimed) return claimError();
    }

    const claimed = sessionState.get('claimedKey') as
      | { id: string; permissions: string; entryScope: string | null }
      | undefined;

    const callerPermissions = claimed?.permissions ?? 'maintenance';

    const result = modifyKey(db, { keyId, permissions, callerPermissions });

    if ('error' in result) {
      return {
        content: [{ type: 'text', text: formatError('MODIFY_FAILED', result.error) }],
        isError: true,
      };
    }

    return {
      content: [{
        type: 'text',
        text: `<result><id>${result.id}</id><permissions>${result.permissions}</permissions></result>`,
      }],
    };
  };

  handlers['list_keys'] = () => {
    if (settings.permissions.enforce) {
      const claimed = requireClaim(sessionState, settings);
      if (!claimed) return claimError();
    }

    const claimed = sessionState.get('claimedKey') as
      | { id: string; permissions: string; entryScope: string | null }
      | undefined;

    const keys = listKeys(db, { callerKeyId: claimed?.id });

    const keyXml = keys
      .map(
        (k) =>
          `<key><id>${k.id}</id><permissions>${k.permissions}</permissions><entry_scope>${k.entryScope ?? ''}</entry_scope><created_at>${k.createdAt}</created_at></key>`,
      )
      .join('');

    return {
      content: [{ type: 'text', text: `<result><keys>${keyXml}</keys></result>` }],
    };
  };
}
