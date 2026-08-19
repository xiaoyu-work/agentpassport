import { isAbsolute, join, relative, sep } from 'node:path';
import { ArtifactSchema, type Artifact, type ArtifactKind } from '@agentpassport/profile';
import { readTextIfExists, writeFileAtomic } from './fsx.js';
import type { AdapterContext, AdapterWarning } from './types.js';

/** Beyond this a file is configuration in name only, and not worth syncing. */
export const MAX_ARTIFACT_BYTES = 256 * 1024;
export const MAX_ARTIFACTS_TOTAL_BYTES = 4 * 1024 * 1024;

const SECRET_NAME_PATTERN =
  /(^|_)(API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH|PAT|ACCESS_KEY|PRIVATE_KEY|SESSION)($|_)/i;

const SECRET_VALUE_PATTERN =
  /(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/g;

const INDIRECTION_PATTERN = /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/;

export interface CaptureOptions {
  kind: ArtifactKind;
  scope?: 'global' | 'project';
  agent: string;
}

/**
 * Read a file exactly as it is, minus anything that looks like a credential.
 *
 * Capturing verbatim is the point — it is what lets a restore reproduce settings this
 * schema has never heard of — but doing it naively would copy live API keys into the
 * synced profile, which is precisely what Agent Passport promises never to hold. So the
 * bytes are preserved and the secrets within them are not.
 */
export async function captureArtifact(
  context: AdapterContext,
  absolutePath: string,
  options: CaptureOptions,
): Promise<{ artifact?: Artifact; warnings: AdapterWarning[] }> {
  const warnings: AdapterWarning[] = [];
  const raw = await readTextIfExists(absolutePath);
  if (raw === undefined) return { warnings };

  const bytes = Buffer.byteLength(raw, 'utf8');
  if (bytes > MAX_ARTIFACT_BYTES) {
    warnings.push({
      severity: 'info',
      message: `skipped a copy of this file because it is ${Math.round(bytes / 1024)}KB`,
      file: absolutePath,
    });
    return { warnings };
  }

  const { content, redacted } = scrub(raw);
  if (redacted) {
    warnings.push({
      severity: 'security',
      message: 'credential material was removed from the stored copy of this file',
      file: absolutePath,
    });
  }

  return {
    artifact: ArtifactSchema.parse({
      agent: options.agent,
      path: toPortablePath(context, absolutePath),
      kind: options.kind,
      scope: options.scope ?? 'global',
      content,
      bytes,
      redacted,
    }),
    warnings,
  };
}

/**
 * Write back originals for files that are not present.
 *
 * Existing files are never overwritten from an artifact: the machine's own copy is newer
 * by definition and may hold local changes. Artifacts exist to populate a fresh machine,
 * not to fight with a configured one.
 */
export async function restoreArtifacts(
  context: AdapterContext,
  artifacts: Artifact[],
  agent: string,
): Promise<{ written: string[]; skipped: string[] }> {
  const written: string[] = [];
  const skipped: string[] = [];

  for (const artifact of artifacts) {
    if (artifact.agent !== agent) continue;

    const target = fromPortablePath(context, artifact.path);
    if ((await readTextIfExists(target)) !== undefined) {
      skipped.push(target);
      continue;
    }
    if (context.dryRun) {
      skipped.push(target);
      continue;
    }

    await writeFileAtomic(target, artifact.content);
    written.push(target);
  }

  return { written, skipped };
}

/** Which artifacts a fresh machine would gain, for `previewExport`. */
export async function missingArtifacts(
  context: AdapterContext,
  artifacts: Artifact[],
  agent: string,
): Promise<Array<{ artifact: Artifact; target: string }>> {
  const missing: Array<{ artifact: Artifact; target: string }> = [];
  for (const artifact of artifacts) {
    if (artifact.agent !== agent) continue;
    const target = fromPortablePath(context, artifact.path);
    if ((await readTextIfExists(target)) === undefined) missing.push({ artifact, target });
  }
  return missing;
}

/**
 * Replace credential material while leaving the document otherwise intact.
 *
 * Structured files are walked key by key so a redaction becomes `${VAR}` indirection that
 * the agent can still resolve. Anything unparseable falls back to pattern replacement,
 * which is blunter but never leaves a live token behind.
 */
export function scrub(raw: string): { content: string; redacted: boolean } {
  const trimmed = raw.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      const result = scrubValue(parsed, undefined);
      if (!result.redacted) return { content: raw, redacted: false };
      return { content: `${JSON.stringify(result.value, null, 2)}\n`, redacted: true };
    } catch {
      // Not valid JSON after all; fall through to text scrubbing.
    }
  }

  const content = raw.replace(SECRET_VALUE_PATTERN, '${REDACTED}');
  return { content, redacted: content !== raw };
}

function scrubValue(
  value: unknown,
  key: string | undefined,
): { value: unknown; redacted: boolean } {
  if (Array.isArray(value)) {
    let redacted = false;
    const next = value.map((entry) => {
      const result = scrubValue(entry, key);
      redacted ||= result.redacted;
      return result.value;
    });
    return { value: next, redacted };
  }

  if (value && typeof value === 'object') {
    let redacted = false;
    const next: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      const result = scrubValue(childValue, childKey);
      redacted ||= result.redacted;
      next[childKey] = result.value;
    }
    return { value: next, redacted };
  }

  if (typeof value !== 'string' || !value) return { value, redacted: false };
  if (INDIRECTION_PATTERN.test(value)) return { value, redacted: false };

  const looksSecret =
    (key !== undefined && SECRET_NAME_PATTERN.test(key)) ||
    new RegExp(SECRET_VALUE_PATTERN.source).test(value);
  if (!looksSecret) return { value, redacted: false };

  return { value: key ? `\${${key}}` : '${REDACTED}', redacted: true };
}

/** Absolute path -> a form that means the same thing on another machine. */
export function toPortablePath(context: AdapterContext, absolutePath: string): string {
  for (const [root, prefix] of [
    [context.home, '~/'],
    [context.cwd, './'],
  ] as const) {
    if (!root) continue;
    const rel = relative(root, absolutePath);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
      return `${prefix}${rel.split(sep).join('/')}`;
    }
  }
  return absolutePath.split(sep).join('/');
}

export function fromPortablePath(context: AdapterContext, portable: string): string {
  if (portable.startsWith('~/')) return join(context.home, portable.slice(2));
  if (portable.startsWith('./')) return join(context.cwd, portable.slice(2));
  return portable;
}

/** Enforce the overall budget, newest first, so one huge agent cannot crowd out the rest. */
export function capArtifacts(artifacts: Artifact[]): {
  kept: Artifact[];
  dropped: Artifact[];
} {
  const sorted = [...artifacts].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  const kept: Artifact[] = [];
  const dropped: Artifact[] = [];
  let total = 0;

  for (const artifact of sorted) {
    const size = Buffer.byteLength(artifact.content, 'utf8');
    if (total + size > MAX_ARTIFACTS_TOTAL_BYTES) {
      dropped.push(artifact);
      continue;
    }
    total += size;
    kept.push(artifact);
  }

  return { kept, dropped };
}
