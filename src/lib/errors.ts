export function xmlEscape(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export const MAX_CONTENT_SIZE = 256 * 1024; // 256KB

export function validateContentSize(content: string, fieldName: string = 'content'): string | null {
  if (content.length > MAX_CONTENT_SIZE) {
    return formatError('CONTENT_TOO_LARGE', `${fieldName} exceeds maximum size of 256KB`);
  }
  return null;
}

export function formatError(code: string, message: string): string {
  return `<error code="${xmlEscape(code)}">${xmlEscape(message)}</error>`;
}
