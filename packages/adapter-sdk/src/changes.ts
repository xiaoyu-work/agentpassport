import type { ChangeOperation, ConfigChange } from './types.js';

/** Classify a proposed write by comparing it with what is already on disk. */
export function describeChange(
  file: string,
  before: string | undefined,
  after: string | undefined,
  description: string,
): ConfigChange {
  let op: ChangeOperation;
  if (before === undefined && after !== undefined) op = 'create';
  else if (before !== undefined && after === undefined) op = 'delete';
  else if (before === after) op = 'unchanged';
  else op = 'update';

  return {
    op,
    file,
    description,
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
  };
}

export function hasEffect(changes: ConfigChange[]): boolean {
  return changes.some((change) => change.op !== 'unchanged');
}

/**
 * Execute a plan produced by `previewExport`.
 *
 * Every adapter computes its changes once and either renders them or writes them, so a
 * preview can never disagree with the export it previews. A user who confirms a diff gets
 * exactly that diff.
 */
export async function applyPlan(
  changes: ConfigChange[],
  options: { dryRun: boolean; write: (file: string, contents: string) => Promise<void> },
): Promise<{ written: string[]; skipped: string[] }> {
  const written: string[] = [];
  const skipped: string[] = [];

  for (const change of changes) {
    if (change.op === 'unchanged' || change.after === undefined) {
      skipped.push(change.file);
      continue;
    }
    if (options.dryRun) {
      skipped.push(change.file);
      continue;
    }
    await options.write(change.file, change.after);
    written.push(change.file);
  }

  return { written, skipped };
}

/**
 * Merge our keys into an existing config object without disturbing keys we do not model.
 *
 * An agent's config file contains far more than Agent Passport understands. Replacing the
 * document would silently delete settings the user depends on, so unknown keys survive
 * untouched and only owned paths are rewritten.
 */
export function mergePreserving<T extends Record<string, unknown>>(
  existing: T | undefined,
  owned: Record<string, unknown>,
): T {
  const base: Record<string, unknown> = { ...(existing ?? {}) };
  for (const [key, value] of Object.entries(owned)) {
    if (value === undefined) continue;
    const current = base[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      base[key] = mergePreserving(current, value);
    } else {
      base[key] = value;
    }
  }
  return base as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
