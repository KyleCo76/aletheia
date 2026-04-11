export function xmlEscape(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export const MAX_CONTENT_SIZE = 256 * 1024; // 256KB

/**
 * Hard cap on the number of tags accepted by a single
 * write/create call. Exists to close one of the circuit-breaker
 * bypass paths discovered in v0.2.5: write_journal / write_memory
 * / create_entry all accept arbitrary `tags: string[]`, and
 * `addTags` inserts 2 rows per tag (one in `tags` if new, one in
 * `entry_tags`). Without a cap, a single tool call counts as one
 * write against the breaker but can mutate 200+ rows by stuffing
 * 100 tags. The cap is intentionally generous — 32 is more than
 * any sensible workflow needs but tight enough to prevent
 * pathological multipliers.
 */
export const MAX_TAGS_PER_CALL = 32;

/**
 * Structured content-size validation result. A returned value
 * represents a rejection (caller should wrap with `toolError`);
 * `null` means the input is acceptable.
 *
 * Prior to v0.2.4 this helper returned a pre-formatted XML error
 * string which callers had to splice into an inline
 * `{content:[...], isError:true}` envelope — the one remaining
 * legacy caller of `formatError` outside the lib layer. Returning
 * a typed `{code, message}` object instead lets write handlers
 * use the same `toolError` path as every other error.
 */
export interface ContentSizeError {
  code: 'CONTENT_TOO_LARGE';
  message: string;
}

export function validateContentSize(
  content: string,
  fieldName: string = 'content',
): ContentSizeError | null {
  if (content.length > MAX_CONTENT_SIZE) {
    return {
      code: 'CONTENT_TOO_LARGE',
      message: `${fieldName} exceeds maximum size of 256KB`,
    };
  }
  return null;
}

/**
 * Same shape as ContentSizeError but for the tag-count cap.
 * Returned by `validateTagCount` and wrapped at call sites with
 * `toolError(code, message)`. Uses the existing INVALID_INPUT
 * code (already in ERROR_CODES) so the wire format does not gain
 * a new value — clients pattern-matching on codes are unaffected.
 */
export interface TagCountError {
  code: 'INVALID_INPUT';
  message: string;
}

export function validateTagCount(
  tags: string[] | undefined,
): TagCountError | null {
  if (!tags) return null;
  if (tags.length > MAX_TAGS_PER_CALL) {
    return {
      code: 'INVALID_INPUT',
      message: `tags array exceeds maximum of ${MAX_TAGS_PER_CALL} per call (received ${tags.length})`,
    };
  }
  return null;
}

export function formatError(code: string, message: string): string {
  return `<error code="${xmlEscape(code)}">${xmlEscape(message)}</error>`;
}
