// Single source of truth for the shape and error-code vocabulary of
// MCP tool responses (v0.2.0, item #31).
//
// Why this exists:
//   - Prior to v0.2.0, every tool synthesized its own
//     `{ content: [...], isError: true }` response with a free-string
//     error code passed to `formatError`. There was no machine-readable
//     contract — readers had to grep `formatError(` call sites to
//     learn which codes existed, and a typo (`NOT_FOUUND`) would ship
//     undetected because TypeScript treats the code parameter as a
//     plain string.
//   - This module exports `ERROR_CODES` (a runtime-readable list),
//     `ErrorCode` (a TypeScript union of those codes), and the
//     `toolError` / `toolSuccess` constructors that handlers should
//     use instead of inlining response objects. Misspelled codes
//     become compile-time errors.
//   - The on-the-wire format is unchanged: `toolError` reduces to
//     exactly the same `{ content: [{type: 'text', text: '<error
//     code="X">...</error>'}], isError: true }` shape v0.1.x emitted,
//     so existing consumers do not need to change.
//
// Migration approach:
//   - Pilot module: `src/server/tools/status.ts` (all error paths
//     migrated). Other tool modules continue to import `formatError`
//     directly until a follow-up commit migrates them. Both styles
//     coexist while the migration is in progress.

import { formatError } from '../../lib/errors.js';

// Listed alphabetically for diff stability. New codes MUST be added
// here before any handler emits them — that's the whole point of the
// embedded contract.
//
// Backward-compat notes:
//   * `MISSING_FIELD` is treated as a synonym for `INVALID_INPUT`.
//     Both are kept in v0.2.0 because v0.1.x handlers picked one or
//     the other inconsistently, and changing the wire code is
//     observable. A follow-up release can canonicalize.
//   * `OCC_CONFLICT` (memory) and `VERSION_CONFLICT` (status) both
//     describe optimistic-concurrency failures. Same reasoning —
//     both are preserved here for compat.
export const ERROR_CODES = [
  'ALREADY_BOOTSTRAPPED',
  'CIRCUIT_BREAKER',
  'CONTENT_TOO_LARGE',
  'INSUFFICIENT_PERMISSIONS',
  'INVALID_INPUT',
  'INVALID_KEY',
  'MISSING_FIELD',
  'MODIFY_FAILED',
  'NO_CLAIM',
  'NOT_FOUND',
  'OCC_CONFLICT',
  'UNKNOWN_TOOL',
  'VERSION_CONFLICT',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ToolResponseContent {
  type: 'text';
  text: string;
}

export interface ToolErrorResponse {
  content: [ToolResponseContent];
  isError: true;
}

export interface ToolSuccessResponse {
  content: [ToolResponseContent];
  isError?: false;
}

export type ToolResponse = ToolErrorResponse | ToolSuccessResponse;

/**
 * Construct a typed error response for an MCP tool handler.
 *
 * The `code` parameter is constrained to `ErrorCode`, so misspellings
 * and ad-hoc codes become TypeScript errors at the call site instead
 * of slipping into the wire format and confusing client code that
 * pattern-matches on known codes.
 */
export function toolError(code: ErrorCode, message: string): ToolErrorResponse {
  return {
    content: [{ type: 'text', text: formatError(code, message) }],
    isError: true,
  };
}

/**
 * Construct a typed success response for an MCP tool handler.
 *
 * The body is the already-formatted XML payload (the conventional
 * micro-XML the handlers build with template literals). This wrapper
 * exists so call sites for success and error look symmetric and a
 * future migration can intercept both.
 */
export function toolSuccess(xmlBody: string): ToolSuccessResponse {
  return {
    content: [{ type: 'text', text: xmlBody }],
  };
}

/**
 * Runtime guard for tests and any out-of-band validators that need to
 * check whether a string is a known `ErrorCode` without TypeScript
 * narrowing in scope. Used by the v0.2.0 regression test that walks
 * every error path of the migrated tools and asserts the embedded
 * code is in `ERROR_CODES`.
 */
export function isKnownErrorCode(s: string): s is ErrorCode {
  return (ERROR_CODES as readonly string[]).includes(s);
}
