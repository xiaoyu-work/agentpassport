import type { Passport } from './passport.js';
import { discoverAgents } from './discover.js';
import {
  importFromAgent,
  restoreToAgent,
  type ImportOutcome,
  type RestoreOutcome,
} from './operations.js';

export interface BulkOptions {
  passphrase: string;
  dryRun?: boolean;
  /** Restrict to these agents. Defaults to every agent detected on the machine. */
  agents?: string[];
}

export interface BulkResult<T> {
  results: T[];
  failures: Array<{ agent: string; error: string }>;
  /** Agents that are installed but were skipped, with the reason. */
  skipped: Array<{ agent: string; reason: string }>;
}

async function targets(passport: Passport, requested?: string[]): Promise<string[]> {
  if (requested && requested.length > 0) return requested;
  const discovered = await discoverAgents(passport);
  return discovered.filter((agent) => agent.installed).map((agent) => agent.id);
}

/**
 * Import from every agent found on this machine, in one pass.
 *
 * A user with four agents installed has their identity smeared across four formats, and
 * asking them to run four commands is asking them to already know what Agent Passport is
 * for. Running the sweep by default is what turns setup into a single step.
 *
 * Imports run in sequence, not in parallel: each one merges into the profile the previous
 * one produced, so a later agent updating a field the user recently changed wins over an
 * older one, and no two writers race for the same vault file.
 */
export async function importAll(
  passport: Passport,
  options: BulkOptions,
): Promise<BulkResult<ImportOutcome>> {
  const ids = await targets(passport, options.agents);
  const results: ImportOutcome[] = [];
  const failures: Array<{ agent: string; error: string }> = [];

  for (const agent of ids) {
    try {
      results.push(
        await importFromAgent(passport, {
          agent,
          passphrase: options.passphrase,
          dryRun: options.dryRun ?? false,
        }),
      );
    } catch (error) {
      failures.push({ agent, error: (error as Error).message });
    }
  }

  return { results, failures, skipped: [] };
}

/**
 * Write the passport into every agent found on this machine.
 *
 * Each agent receives the shared memory set plus whatever is pinned to it, so the same
 * identity lands everywhere without one agent inheriting another's tool-specific notes.
 */
export async function restoreAll(
  passport: Passport,
  options: BulkOptions,
): Promise<BulkResult<RestoreOutcome>> {
  const ids = await targets(passport, options.agents);
  const results: RestoreOutcome[] = [];
  const failures: Array<{ agent: string; error: string }> = [];

  for (const agent of ids) {
    try {
      results.push(
        await restoreToAgent(passport, {
          agent,
          passphrase: options.passphrase,
          dryRun: options.dryRun ?? false,
        }),
      );
    } catch (error) {
      failures.push({ agent, error: (error as Error).message });
    }
  }

  return { results, failures, skipped: [] };
}
