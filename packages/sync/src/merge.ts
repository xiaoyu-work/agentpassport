import { sectionOf, type FieldMeta, type UniversalProfile } from '@agentpassport/profile';
import type { DiffEntry } from './diff.js';
import { flattenProfile, type FlatEntry } from './flatten.js';

export type Side = 'local' | 'remote';

export interface Conflict {
  path: string;
  section: string;
  kind: string;
  label: string;
  local: string | undefined;
  remote: string | undefined;
  localMeta?: FieldMeta;
  remoteMeta?: FieldMeta;
}

export interface MergeOptions {
  /**
   * The profile as it stood at the last successful sync. With it, a field missing on one
   * side is a deletion; without it, the same absence is indistinguishable from a field
   * that side never had, so merging can only ever union.
   */
  ancestor?: UniversalProfile;
  /** Explicit per-path decisions, normally collected by prompting the user. */
  resolutions?: Record<string, Side>;
  /** Fallback when a path conflicts and has no resolution. `ask` leaves it unresolved. */
  strategy?: Side | 'ask';
}

export interface MergeResult {
  profile: UniversalProfile;
  conflicts: Conflict[];
  /** Changes applied to the local profile, for display after a sync. */
  applied: DiffEntry[];
}

/**
 * Three-way merge of two profiles.
 *
 * Non-conflicting fields merge silently; genuinely divergent fields are surfaced rather
 * than resolved by timestamp. Last-write-wins on identity data quietly discards a change
 * the user made deliberately, and they only find out when an agent starts behaving wrongly.
 */
export function mergeProfiles(
  local: UniversalProfile,
  remote: UniversalProfile,
  options: MergeOptions = {},
): MergeResult {
  const merged = structuredClone(local);
  const leftEntries = flattenProfile(local);
  const rightEntries = flattenProfile(remote);
  const ancestorEntries = options.ancestor ? flattenProfile(options.ancestor) : undefined;
  const resolutions = options.resolutions ?? {};
  const strategy = options.strategy ?? 'ask';

  const conflicts: Conflict[] = [];
  const applied: DiffEntry[] = [];
  const paths = new Set([...leftEntries.keys(), ...rightEntries.keys()]);

  for (const path of [...paths].sort()) {
    const left = leftEntries.get(path);
    const right = rightEntries.get(path);
    if (left?.canonical === right?.canonical) continue;

    const decision = decide(path, left, right, ancestorEntries?.get(path), local, remote);
    const chosen = resolutions[path] ?? (decision === 'conflict' ? strategy : decision);

    if (chosen === 'ask') {
      conflicts.push({
        path,
        section: sectionOf(path),
        kind: (left ?? right)?.kind ?? 'field',
        label: (left ?? right)?.label ?? path,
        local: left?.summary,
        remote: right?.summary,
        ...(local.meta[path] ? { localMeta: local.meta[path] } : {}),
        ...(remote.meta[path] ? { remoteMeta: remote.meta[path] } : {}),
      });
      continue;
    }

    if (chosen === 'local') continue;

    if (right) {
      right.apply(merged);
      const remoteMeta = remote.meta[path];
      if (remoteMeta) merged.meta[path] = remoteMeta;
      applied.push(entry(left ? 'updated' : 'added', path, right, left?.summary, right.summary));
    } else if (left) {
      left.remove(merged);
      delete merged.meta[path];
      applied.push(entry('removed', path, left, left.summary, undefined));
    }
  }

  merged.revision = Math.max(local.revision, remote.revision) + (applied.length > 0 ? 1 : 0);
  if (applied.length > 0) merged.updatedAt = new Date().toISOString();

  return { profile: merged, conflicts, applied };
}

function decide(
  path: string,
  left: FlatEntry | undefined,
  right: FlatEntry | undefined,
  ancestor: FlatEntry | undefined,
  local: UniversalProfile,
  remote: UniversalProfile,
): Side | 'conflict' {
  if (!left) return 'remote';

  if (ancestor) {
    const unchangedLocally = left.canonical === ancestor.canonical;
    const unchangedRemotely = right?.canonical === ancestor.canonical;
    if (unchangedLocally && !unchangedRemotely) return 'remote';
    if (unchangedRemotely && !unchangedLocally) return 'local';
    return 'conflict';
  }

  // Without an ancestor a missing remote field cannot be proven to be a deletion.
  if (!right) return 'local';

  const localVersion = local.meta[path]?.version;
  const remoteVersion = remote.meta[path]?.version;
  if (typeof localVersion === 'number' && typeof remoteVersion === 'number') {
    if (localVersion > remoteVersion) return 'local';
    if (remoteVersion > localVersion) return 'remote';
  }
  return 'conflict';
}

function entry(
  op: DiffEntry['op'],
  path: string,
  source: FlatEntry,
  before: string | undefined,
  after: string | undefined,
): DiffEntry {
  return {
    op,
    path,
    section: sectionOf(path),
    kind: source.kind,
    label: source.label,
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
  };
}
