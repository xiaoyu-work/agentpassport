import { parse, stringify } from 'yaml';

export const BLOCK_BEGIN = '<!-- BEGIN AGENT PASSPORT -->';
export const BLOCK_END = '<!-- END AGENT PASSPORT -->';

const BLOCK_PATTERN = new RegExp(
  `${escapeRegExp(BLOCK_BEGIN)}[\\s\\S]*?${escapeRegExp(BLOCK_END)}`,
  'g',
);

/**
 * Replace only the region Agent Passport owns, leaving the rest of the file untouched.
 *
 * Instruction files like CLAUDE.md and AGENTS.md are hand-written documents that users
 * care about. Overwriting one wholesale on `restore` would destroy work the user never
 * asked us to manage, so managed content is fenced and everything outside is preserved
 * byte for byte.
 */
export function applyManagedBlock(existing: string | undefined, managed: string): string {
  const block = `${BLOCK_BEGIN}\n${managed.trim()}\n${BLOCK_END}`;
  if (!existing || !existing.trim()) return `${block}\n`;
  if (BLOCK_PATTERN.test(existing)) {
    BLOCK_PATTERN.lastIndex = 0;
    return existing.replace(BLOCK_PATTERN, block);
  }
  return `${existing.trimEnd()}\n\n${block}\n`;
}

/** Extract previously managed content, which is what `import` should read back. */
export function readManagedBlock(existing: string | undefined): string | undefined {
  if (!existing) return undefined;
  const match = existing.match(
    new RegExp(`${escapeRegExp(BLOCK_BEGIN)}\\n?([\\s\\S]*?)\\n?${escapeRegExp(BLOCK_END)}`),
  );
  return match?.[1]?.trim();
}

/** Content outside the managed block: authored by the user, owned by the user. */
export function stripManagedBlock(existing: string | undefined): string {
  if (!existing) return '';
  BLOCK_PATTERN.lastIndex = 0;
  return existing.replace(BLOCK_PATTERN, '').trim();
}

export interface Frontmatter {
  data: Record<string, unknown>;
  body: string;
}

export function parseFrontmatter(text: string): Frontmatter {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: text };
  try {
    const parsed = parse(match[1] ?? '') as unknown;
    const data = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    return { data, body: (match[2] ?? '').trim() };
  } catch {
    return { data: {}, body: text };
  }
}

export function renderFrontmatter(data: Record<string, unknown>, body: string): string {
  const entries = Object.entries(data).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return `${body.trim()}\n`;
  const yaml = stringify(Object.fromEntries(entries), { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n\n${body.trim()}\n`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
