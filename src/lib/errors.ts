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

export function formatError(code: string, message: string): string {
  return `<error code="${xmlEscape(code)}">${xmlEscape(message)}</error>`;
}
