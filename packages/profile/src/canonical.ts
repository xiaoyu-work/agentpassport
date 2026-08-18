import { createHash } from 'node:crypto';

/**
 * Deterministic JSON with sorted object keys.
 *
 * Two profiles that mean the same thing must serialize to the same bytes, otherwise
 * every sync would report spurious changes purely from key ordering.
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const entry = source[key];
    if (entry === undefined) continue;
    sorted[key] = sortValue(entry);
  }
  return sorted;
}

export function contentHash(value: unknown): string {
  return createHash('sha256').update(canonicalStringify(value)).digest('hex');
}
