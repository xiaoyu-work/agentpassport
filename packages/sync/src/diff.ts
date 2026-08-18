import { sectionOf, type UniversalProfile } from '@agentpass/profile';
import { flattenProfile, type FlatEntry } from './flatten.js';

export type DiffOperation = 'added' | 'removed' | 'updated';

export interface DiffEntry {
  op: DiffOperation;
  path: string;
  section: string;
  kind: string;
  label: string;
  before?: string;
  after?: string;
}

export interface ProfileDiff {
  entries: DiffEntry[];
  added: number;
  removed: number;
  updated: number;
}

/**
 * Compare two profiles field by field.
 *
 * `base` is what the user already has and `target` is what they would get. The direction
 * matters for the words the CLI prints: "added" always means "new to `base`".
 */
export function diffProfiles(base: UniversalProfile, target: UniversalProfile): ProfileDiff {
  const left = flattenProfile(base);
  const right = flattenProfile(target);
  const entries: DiffEntry[] = [];

  for (const [path, entry] of right) {
    const previous = left.get(path);
    if (!previous) {
      entries.push(toDiff('added', entry, undefined, entry.summary));
    } else if (previous.canonical !== entry.canonical) {
      entries.push(toDiff('updated', entry, previous.summary, entry.summary));
    }
  }

  for (const [path, entry] of left) {
    if (!right.has(path)) entries.push(toDiff('removed', entry, entry.summary, undefined));
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));
  return {
    entries,
    added: entries.filter((entry) => entry.op === 'added').length,
    removed: entries.filter((entry) => entry.op === 'removed').length,
    updated: entries.filter((entry) => entry.op === 'updated').length,
  };
}

export function isEmptyDiff(diff: ProfileDiff): boolean {
  return diff.entries.length === 0;
}

const SIGILS: Record<DiffOperation, string> = { added: '+', removed: '-', updated: '~' };

const VERBS: Record<DiffOperation, string> = {
  added: 'Added',
  removed: 'Removed',
  updated: 'Updated',
};

/** Render a diff in the form the CLI shows before asking for confirmation. */
export function renderDiffLines(diff: ProfileDiff): string[] {
  return diff.entries.map((entry) => {
    const head = `${SIGILS[entry.op]} ${VERBS[entry.op]} ${entry.kind}: ${entry.label}`;
    if (entry.op === 'updated' && entry.before && entry.after && entry.before !== entry.label) {
      return `${head}  (${entry.before} -> ${entry.after})`;
    }
    return head;
  });
}

function toDiff(
  op: DiffOperation,
  entry: FlatEntry,
  before: string | undefined,
  after: string | undefined,
): DiffEntry {
  return {
    op,
    path: entry.path,
    section: sectionOf(entry.path),
    kind: entry.kind,
    label: entry.label,
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
  };
}
