import { contentHash, type UniversalProfile } from '@agentpass/profile';

export interface Revision {
  revision: number;
  hash: string;
  updatedAt: string;
  sourceDevice: string;
  sourceAgent: string;
  /** One-line description of what changed, for `agentpass status`. */
  summary: string;
}

export const MAX_REVISIONS = 50;

/**
 * Append-only revision log.
 *
 * The log is what makes destructive sync recoverable: a bad merge or an over-eager import
 * can be identified after the fact, which is the difference between "sync is safe to run"
 * and "sync is a gamble the user only takes once".
 */
export function appendRevision(
  history: Revision[],
  profile: UniversalProfile,
  details: { sourceDevice: string; sourceAgent: string; summary: string },
): Revision[] {
  const record: Revision = {
    revision: profile.revision,
    hash: contentHash(profile),
    updatedAt: profile.updatedAt,
    sourceDevice: details.sourceDevice,
    sourceAgent: details.sourceAgent,
    summary: details.summary,
  };
  const last = history.at(-1);
  if (last && last.hash === record.hash) return history;
  return [...history, record].slice(-MAX_REVISIONS);
}
