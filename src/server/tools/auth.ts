import type Database from 'better-sqlite3';
import type { AletheiaSettings } from '../../lib/settings.js';
import {
  validateKey,
  createKey,
  modifyKey,
  listKeys,
  canDelegatePermission,
  canDelegateScope,
  getKeyChain,
} from '../../db/queries/keys.js';
import { xmlEscape } from '../../lib/errors.js';
import { toolError, toolSuccess } from './response-format.js';
import type { ToolErrorResponse, ToolSuccessResponse } from './response-format.js';
import { KEYS_DIR } from '../../lib/constants.js';
import fs from 'fs';
import path from 'path';

export type ToolHandler = (args: Record<string, unknown>) => {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

/**
 * Re-validate the cached claim against the keys table. Without
 * this, a key revoked or modified mid-session had no effect on
 * the session — the handler kept exercising the stale cached
 * permission level (fail-open). After this call:
 *   - Key deleted from the db → clear cache, return null
 *     (caller treats as unclaimed and NO_CLAIM-fails).
 *   - Key permissions / entry_scope modified in the db → refresh
 *     the cache so subsequent checks see the authoritative
 *     (potentially downgraded) value.
 *   - Key unchanged → passthrough the cached object.
 *
 * Cost: one indexed SELECT per call. The keys table is tiny so
 * this is cheap. Broader coverage for non-auth write handlers
 * (write_journal, write_memory, etc.) is a follow-up — they
 * don't currently call requireClaim at all.
 */
export function refreshClaim(
  db: Database.Database,
  sessionState: Map<string, unknown>,
): { id: string; permissions: string; entryScope: string | null } | null {
  const cached = sessionState.get('claimedKey') as
    | { id: string; permissions: string; entryScope: string | null }
    | undefined;
  if (!cached) return null;

  const row = db.prepare(
    `SELECT id, permissions, entry_scope, revoked FROM keys WHERE id = ?`,
  ).get(cached.id) as
    | { id: string; permissions: string; entry_scope: string | null; revoked: number }
    | undefined;

  if (!row || row.revoked) {
    sessionState.delete('claimedKey');
    return null;
  }

  if (row.permissions !== cached.permissions || row.entry_scope !== cached.entryScope) {
    const refreshed = {
      id: row.id,
      permissions: row.permissions,
      entryScope: row.entry_scope,
    };
    sessionState.set('claimedKey', refreshed);
    return refreshed;
  }

  return cached;
}

function requireClaim(
  db: Database.Database,
  sessionState: Map<string, unknown>,
  settings: AletheiaSettings,
): { id: string; permissions: string; entryScope: string | null } | null {
  if (!settings.permissions.enforce) return null;
  return refreshClaim(db, sessionState);
}

/**
 * Guard helper for non-auth tool handlers (write_journal,
 * write_memory, replace_status, etc.) that previously trusted
 * whatever was in sessionState.claimedKey without ever
 * re-validating against the db. Returns a `ToolErrorResponse` to
 * return directly when the refreshed claim fails, or `null` when
 * the call may proceed.
 *
 * In dev mode (enforce=false) this is a no-op — write handlers
 * continue to accept unclaimed callers because enforce mode is
 * the opt-in for authorization. The fix here targets the
 * enforce-mode fail-open: a key revoked mid-session used to
 * keep writing because no handler re-checked the keys table
 * between the original claim() call and any subsequent write.
 *
 * Coverage extends the round-1 `refreshClaim` fix in auth.ts to
 * the full write surface. Any handler that mutates the db while
 * respecting an authenticated claim should call this first.
 */
export function claimGuard(
  db: Database.Database,
  sessionState: Map<string, unknown>,
  settings: AletheiaSettings,
): ToolErrorResponse | null {
  if (!settings.permissions.enforce) return null;
  const claimed = refreshClaim(db, sessionState);
  if (!claimed) return toolError('NO_CLAIM', 'Use claim(key) to authenticate');
  return null;
}

function claimError(): ToolErrorResponse {
  return toolError('NO_CLAIM', 'Use claim(key) to authenticate');
}

export function registerAuthTools(
  handlers: Record<string, ToolHandler>,
  db: Database.Database,
  settings: AletheiaSettings,
  sessionState: Map<string, unknown>,
): void {
  handlers['claim'] = (args): ToolErrorResponse | ToolSuccessResponse => {
    const keyValue = args.key as string | undefined;
    if (!keyValue) return toolError('INVALID_INPUT', 'key is required');

    const result = validateKey(db, { keyValue });
    if (!result) return toolError('INVALID_KEY', 'Key not found or invalid');
    if ('revoked' in result) return toolError('INVALID_KEY', 'Key has been revoked');

    sessionState.set('claimedKey', result);

    // Item #32 smallest slice: precompute the key ancestry chain
    // at claim time and stash it on sessionState. Readers can
    // pick it up later via sessionState.get('keyChain') once the
    // owner_chain column + readMemoriesByChain ship. Today it's
    // populated but unused — having it now means the claim path
    // doesn't need to change when the read side lands.
    sessionState.set('keyChain', getKeyChain(db, result.id));

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

    return toolSuccess(
      `<result><id>${result.id}</id><permissions>${result.permissions}</permissions><entry_scope>${xmlEscape(result.entryScope ?? '')}</entry_scope></result>`,
    );
  };

  handlers['whoami'] = (): ToolSuccessResponse => {
    const claimed = sessionState.get('claimedKey') as
      | { id: string; permissions: string; entryScope: string | null }
      | undefined;

    if (!claimed) {
      return toolSuccess('<result><status>unclaimed</status></result>');
    }

    return toolSuccess(
      `<result><status>claimed</status><id>${claimed.id}</id><permissions>${claimed.permissions}</permissions><entry_scope>${xmlEscape(claimed.entryScope ?? '')}</entry_scope></result>`,
    );
  };

  handlers['bootstrap'] = (args): ToolErrorResponse | ToolSuccessResponse => {
    const name = args.name as string | undefined;
    const enforcePermissions = args.enforce_permissions as boolean | undefined;

    if (!name) return toolError('INVALID_INPUT', 'name is required');

    // Validate project name to prevent path traversal
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      return toolError(
        'INVALID_INPUT',
        'name must contain only letters, numbers, hyphens, and underscores',
      );
    }

    // Check if master key file already exists for this project name
    const keyFilePath = path.join(KEYS_DIR, `${name}.key`);

    // Verify resolved path is under KEYS_DIR (defense in depth)
    if (!path.resolve(keyFilePath).startsWith(path.resolve(KEYS_DIR))) {
      return toolError('INVALID_INPUT', 'Invalid project name');
    }
    if (fs.existsSync(keyFilePath)) {
      return toolError('ALREADY_BOOTSTRAPPED', `Project "${name}" has already been bootstrapped`);
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
    // Item #32 smallest slice: precompute key chain for the
    // bootstrapped root key too. This is a single-entry chain
    // (bootstrap keys have no parent), so the stored value is
    // just the key's own id — but populating it keeps the claim
    // and bootstrap paths symmetric.
    sessionState.set('keyChain', getKeyChain(db, keyResult.id));
    sessionState.set('claimedEntry', name);

    return toolSuccess(
      `<result><key>${keyResult.keyValue}</key><key_id>${keyResult.id}</key_id><permissions>${keyResult.permissions}</permissions><key_file>${xmlEscape(keyFilePath)}</key_file><project>${xmlEscape(name)}</project></result>`,
    );
  };

  handlers['create_key'] = (args): ToolErrorResponse | ToolSuccessResponse => {
    const permissions = args.permissions as string | undefined;
    const entryScope = args.entry_scope as string | undefined;
    const name = args.name as string | undefined;

    if (!permissions) return toolError('INVALID_INPUT', 'permissions is required');

    // refreshClaim re-validates the cached claim against the db so
    // a key revoked or downgraded mid-session is reflected here
    // (fail-closed on delete, fail-smaller on downgrade). In dev
    // mode (enforce=false) the caller may still be unclaimed — we
    // pass the result through and let the subset-check block below
    // handle the null-claim case.
    const claimed = refreshClaim(db, sessionState);

    if (settings.permissions.enforce) {
      if (!claimed) return claimError();

      if (claimed.permissions !== 'maintenance' && claimed.permissions !== 'create-sub-entries') {
        return toolError(
          'INSUFFICIENT_PERMISSIONS',
          'Requires create-sub-entries or maintenance permission',
        );
      }
    }

    // Item #16 — cascading delegation. Enforced whenever a claim
    // exists, including dev mode. A claimed parent cannot mint a
    // child with strictly higher permission level or a scope it
    // doesn't itself hold. Unclaimed dev-mode callers (no parent to
    // compare against) still bypass entirely.
    if (claimed) {
      if (!canDelegatePermission(claimed.permissions, permissions)) {
        return toolError(
          'INSUFFICIENT_PERMISSIONS',
          `Cannot delegate "${permissions}" permission from parent "${claimed.permissions}": child permissions must be a subset of parent`,
        );
      }

      if (!canDelegateScope(claimed.entryScope, entryScope)) {
        const childLabel = entryScope ?? 'global';
        const parentLabel = claimed.entryScope ?? 'global';
        return toolError(
          'INSUFFICIENT_PERMISSIONS',
          `Cannot delegate scope "${childLabel}" from parent scope "${parentLabel}": scoped parents can only delegate their own scope`,
        );
      }
    }

    const result = createKey(db, {
      permissions,
      entryScope,
      createdBy: claimed?.id,
      name,
    });

    return toolSuccess(
      `<result><id>${result.id}</id><key>${result.keyValue}</key><permissions>${result.permissions}</permissions></result>`,
    );
  };

  handlers['modify_key'] = (args): ToolErrorResponse | ToolSuccessResponse => {
    const keyId = args.key_id as string | undefined;
    const permissions = args.permissions as string | undefined;
    const revoked = args.revoked as boolean | undefined;

    if (!keyId) {
      return toolError('INVALID_INPUT', 'key_id is required');
    }

    if (permissions === undefined && revoked === undefined) {
      return toolError('INVALID_INPUT', 'At least one of permissions or revoked is required');
    }

    if (permissions !== undefined) {
      const validPermissions = ['read-only', 'read-write', 'create-sub-entries', 'maintenance'];
      if (!validPermissions.includes(permissions)) {
        return toolError(
          'INVALID_INPUT',
          `permissions must be one of: ${validPermissions.join(', ')}`,
        );
      }
    }

    // refreshClaim re-validates the cached key against the db —
    // prevents a revoked key from continuing to modify other keys.
    const claimed = refreshClaim(db, sessionState);

    if (settings.permissions.enforce) {
      if (!claimed) return claimError();
    }

    const callerPermissions = claimed?.permissions ?? 'read-only';

    const result = modifyKey(db, { keyId, permissions, revoked, callerPermissions });

    if ('error' in result) {
      return toolError('MODIFY_FAILED', result.error);
    }

    return toolSuccess(
      `<result><id>${result.id}</id><permissions>${result.permissions}</permissions><revoked>${result.revoked}</revoked></result>`,
    );
  };

  handlers['list_keys'] = (): ToolErrorResponse | ToolSuccessResponse => {
    // refreshClaim catches a revoked key mid-session — don't let
    // a deleted key continue to enumerate descendants.
    const claimed = refreshClaim(db, sessionState);

    if (settings.permissions.enforce) {
      if (!claimed) return claimError();
    }

    const keys = listKeys(db, { callerKeyId: claimed?.id });

    const keyXml = keys
      .map(
        (k) =>
          `<key><id>${k.id}</id><permissions>${k.permissions}</permissions><entry_scope>${xmlEscape(k.entryScope ?? '')}</entry_scope><created_at>${k.createdAt}</created_at><name>${xmlEscape(k.name ?? '')}</name><revoked>${k.revoked}</revoked></key>`,
      )
      .join('');

    return toolSuccess(`<result><keys>${keyXml}</keys></result>`);
  };
}
