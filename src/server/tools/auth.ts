import type Database from 'better-sqlite3';
import type { AletheiaSettings } from '../../lib/settings.js';
import {
  validateKey,
  createKey,
  modifyKey,
  listKeys,
  canDelegatePermission,
  canDelegateScope,
} from '../../db/queries/keys.js';
import { formatError, xmlEscape } from '../../lib/errors.js';
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
      // The key's entry_scope IS the project namespace in the multi-agent
      // model. Set both: claimedEntry for legacy callers (handoff target,
      // session-info), and projectNamespace so create_entry tags new
      // entries with the correct scope and the injection builders query
      // the right project's data. Prior to this fix, only bootstrap set
      // projectNamespace, so claim-only sessions wrote into 'default'.
      sessionState.set('claimedEntry', result.entryScope);
      sessionState.set('projectNamespace', result.entryScope);
    }

    return {
      content: [{
        type: 'text',
        text: `<result><id>${result.id}</id><permissions>${result.permissions}</permissions><entry_scope>${xmlEscape(result.entryScope ?? '')}</entry_scope></result>`,
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
        text: `<result><status>claimed</status><id>${claimed.id}</id><permissions>${claimed.permissions}</permissions><entry_scope>${xmlEscape(claimed.entryScope ?? '')}</entry_scope></result>`,
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

    // Validate project name to prevent path traversal
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      return {
        content: [{ type: 'text', text: formatError('INVALID_INPUT', 'name must contain only letters, numbers, hyphens, and underscores') }],
        isError: true,
      };
    }

    // Check if master key file already exists for this project name
    const keyFilePath = path.join(KEYS_DIR, `${name}.key`);

    // Verify resolved path is under KEYS_DIR (defense in depth)
    if (!path.resolve(keyFilePath).startsWith(path.resolve(KEYS_DIR))) {
      return {
        content: [{ type: 'text', text: formatError('INVALID_INPUT', 'Invalid project name') }],
        isError: true,
      };
    }
    if (fs.existsSync(keyFilePath)) {
      return {
        content: [{ type: 'text', text: formatError('ALREADY_BOOTSTRAPPED', `Project "${name}" has already been bootstrapped`) }],
        isError: true,
      };
    }

    // Create master key in DB first, then write to filesystem.
    // Note: if writeFileSync fails after DB insert, the key exists in DB but
    // has no file. Recovery: manually delete the key from DB and retry bootstrap.
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
        text: `<result><key>${keyResult.keyValue}</key><key_id>${keyResult.id}</key_id><permissions>${keyResult.permissions}</permissions><key_file>${xmlEscape(keyFilePath)}</key_file><project>${xmlEscape(name)}</project></result>`,
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

    // Look up the caller's claim once up front. The "do you have a
    // claim at all" check is still gated on settings.permissions.enforce
    // because dev mode (enforce=false) intentionally allows callers
    // with no claim to exercise the API. But the subset-delegation
    // invariant below is a SECURITY property, not a permission check:
    // if a claim DOES exist, it must not be able to mint a child that
    // exceeds its own authority, regardless of enforce mode.
    const claimed = sessionState.get('claimedKey') as
      | { id: string; permissions: string; entryScope: string | null }
      | undefined;

    if (settings.permissions.enforce) {
      if (!claimed) return claimError();

      if (claimed.permissions !== 'maintenance' && claimed.permissions !== 'create-sub-entries') {
        return {
          content: [{ type: 'text', text: formatError('INSUFFICIENT_PERMISSIONS', 'Requires create-sub-entries or maintenance permission') }],
          isError: true,
        };
      }
    }

    // Item #16 — cascading delegation. Enforced whenever a claim
    // exists, including dev mode. A claimed parent cannot mint a
    // child with strictly higher permission level or a scope it
    // doesn't itself hold. Unclaimed dev-mode callers (no parent to
    // compare against) still bypass entirely.
    if (claimed) {
      if (!canDelegatePermission(claimed.permissions, permissions)) {
        return {
          content: [{
            type: 'text',
            text: formatError(
              'INSUFFICIENT_PERMISSIONS',
              `Cannot delegate "${permissions}" permission from parent "${claimed.permissions}": child permissions must be a subset of parent`,
            ),
          }],
          isError: true,
        };
      }

      if (!canDelegateScope(claimed.entryScope, entryScope)) {
        const childLabel = entryScope ?? 'global';
        const parentLabel = claimed.entryScope ?? 'global';
        return {
          content: [{
            type: 'text',
            text: formatError(
              'INSUFFICIENT_PERMISSIONS',
              `Cannot delegate scope "${childLabel}" from parent scope "${parentLabel}": scoped parents can only delegate their own scope`,
            ),
          }],
          isError: true,
        };
      }
    }

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

    const validPermissions = ['read-only', 'read-write', 'create-sub-entries', 'maintenance'];
    if (!validPermissions.includes(permissions)) {
      return {
        content: [{ type: 'text', text: formatError('INVALID_INPUT', `permissions must be one of: ${validPermissions.join(', ')}`) }],
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

    const callerPermissions = claimed?.permissions ?? 'read-only';

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
          `<key><id>${k.id}</id><permissions>${k.permissions}</permissions><entry_scope>${xmlEscape(k.entryScope ?? '')}</entry_scope><created_at>${k.createdAt}</created_at></key>`,
      )
      .join('');

    return {
      content: [{ type: 'text', text: `<result><keys>${keyXml}</keys></result>` }],
    };
  };
}
