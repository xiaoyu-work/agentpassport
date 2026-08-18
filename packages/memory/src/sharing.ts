import type { MemoryRecord } from './schema.js';
import { isRestorable } from './policy.js';

/**
 * There is exactly one memory store per user.
 *
 * Not one per agent. A per-agent store is the thing Agent Passport exists to abolish: it
 * makes "delete this about me" mean "delete it in four places, and hope you remember the
 * fifth agent you installed last month". With a single store, sharing is a *view* over the
 * same records, so deletion, correction, and revocation are global by construction.
 *
 *      one store, keyed by user_id
 *      ├── shared            agents: []            -> every agent
 *      ├── agent_specific    agents: ['claude']    -> Claude Code only
 *      └── project           scope: 'project'      -> only inside that project
 *                    │
 *              selectForAgent(agentId, project)
 *                    │
 *      ┌─────────┬───┴─────┬─────────┐
 *   Claude    OpenClaw   Codex    Cursor
 *   shared +  shared +   shared + shared +
 *   its own   its own    its own  its own
 */

export interface SelectOptions {
  /** Restrict project-scoped memories to this project. */
  project?: string;
  /** Include project-scoped memories from other projects. Off by default. */
  includeOtherProjects?: boolean;
  limit?: number;
}

/** Whether a memory is visible to `agentId`. */
export function appliesToAgent(record: MemoryRecord, agentId: string): boolean {
  if (record.sharing === 'shared') return true;
  // A record narrowed to nobody would be invisible everywhere; treat it as shared rather
  // than silently losing it.
  if (record.agents.length === 0) return true;
  return record.agents.includes(agentId);
}

function appliesToProject(record: MemoryRecord, options: SelectOptions): boolean {
  if (record.scope !== 'project') return true;
  if (options.includeOtherProjects) return true;
  if (!record.project) return true;
  return record.project === options.project;
}

/**
 * Resolve the memory set a given agent should be restored with.
 *
 * Session-scoped memories are excluded: they were never meant to outlive the conversation
 * that produced them, and carrying them across agents would be indistinguishable from a
 * leak.
 */
export function selectForAgent(
  records: MemoryRecord[],
  agentId: string,
  options: SelectOptions = {},
): MemoryRecord[] {
  const selected = records.filter(
    (record) =>
      isRestorable(record) &&
      record.scope !== 'session' &&
      appliesToAgent(record, agentId) &&
      appliesToProject(record, options),
  );
  return typeof options.limit === 'number' ? selected.slice(0, options.limit) : selected;
}

export interface SharingSummary {
  total: number;
  shared: number;
  agentSpecific: number;
  /** Agent id -> number of memories narrowed to it. */
  byAgent: Record<string, number>;
}

/** Counts behind `agentpass status`, showing how much of the store every agent sees. */
export function summarizeSharing(records: MemoryRecord[]): SharingSummary {
  const summary: SharingSummary = { total: 0, shared: 0, agentSpecific: 0, byAgent: {} };
  for (const record of records) {
    if (!isRestorable(record)) continue;
    summary.total += 1;
    if (record.sharing === 'shared' || record.agents.length === 0) {
      summary.shared += 1;
      continue;
    }
    summary.agentSpecific += 1;
    for (const agent of record.agents) {
      summary.byAgent[agent] = (summary.byAgent[agent] ?? 0) + 1;
    }
  }
  return summary;
}

/** Widen a memory to every agent. */
export function share(record: MemoryRecord): MemoryRecord {
  return { ...record, sharing: 'shared', agents: [] };
}

/** Narrow a memory to specific agents. */
export function restrictToAgents(record: MemoryRecord, agents: string[]): MemoryRecord {
  const unique = [...new Set(agents.filter(Boolean))].sort();
  if (unique.length === 0) return share(record);
  return { ...record, sharing: 'agent_specific', agents: unique };
}
