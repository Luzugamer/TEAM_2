import * as crypto from 'crypto';

/**
 * Serializes a JavaScript value to canonical JSON as defined in RFC 8785 (JSON Canonicalization Scheme - JCS).
 * - Object keys sorted by UTF-16 code unit order.
 * - No whitespace outside strings.
 * - Standard JSON representation for primitives and arrays.
 */
export function canonicalizeJson(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalizeJson).join(',') + ']';
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  const pairs = keys.map((key) => {
    const val = (obj as Record<string, unknown>)[key];
    if (val === undefined) {
      return '';
    }
    return `${JSON.stringify(key)}:${canonicalizeJson(val)}`;
  }).filter(Boolean);
  return '{' + pairs.join(',') + '}';
}

/**
 * Computes SHA-256 hash in hex format over the canonical UTF-8 JSON representation.
 */
export function computeSha256(content: string | object): string {
  const canonical = typeof content === 'string' ? content : canonicalizeJson(content);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

