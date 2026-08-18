import { readdir, stat } from 'node:fs/promises';
import { claudePaths } from '@agentpass/adapter-claude';
import { codexPaths } from '@agentpass/adapter-codex';
import { cursorPaths } from '@agentpass/adapter-cursor';
import { openclawPaths } from '@agentpass/adapter-openclaw';
import type { AdapterContext } from '@agentpass/adapter-sdk';
import type { Passport } from './passport.js';

export interface DiscoveredFile {
  path: string;
  kind: 'instructions' | 'settings' | 'mcp' | 'memory' | 'skills';
  bytes: number;
}

export interface DiscoveredAgent {
  id: string;
  displayName: string;
  installed: boolean;
  files: DiscoveredFile[];
}

/**
 * Where each agent keeps its state.
 *
 * These paths are stable across installs, which is the entire reason zero-configuration
 * discovery is possible: the user should never have to tell Agent Passport where their
 * agents live, because there is nothing to tell.
 */
function knownLocations(context: AdapterContext): Record<string, DiscoveredFile[]> {
  const claude = claudePaths(context);
  const openclaw = openclawPaths(context);
  const codex = codexPaths(context);
  const cursor = cursorPaths(context);

  const file = (path: string, kind: DiscoveredFile['kind']): DiscoveredFile => ({
    path,
    kind,
    bytes: 0,
  });

  return {
    claude: [
      file(claude.userMemory, 'instructions'),
      file(claude.projectMemory, 'instructions'),
      file(claude.userSettings, 'settings'),
      file(claude.globalJson, 'mcp'),
      file(claude.projectMcp, 'mcp'),
      file(claude.skillsDir, 'skills'),
    ],
    openclaw: [
      file(openclaw.agentsFile, 'instructions'),
      file(openclaw.userFile, 'instructions'),
      file(openclaw.memoryFile, 'memory'),
      file(openclaw.configFile, 'settings'),
      file(openclaw.skillsDir, 'skills'),
    ],
    codex: [
      file(codex.globalAgents, 'instructions'),
      file(codex.projectAgents, 'instructions'),
      file(codex.configFile, 'settings'),
      file(codex.skillsDir, 'skills'),
    ],
    cursor: [
      file(cursor.passportRule, 'instructions'),
      file(cursor.agentsFile, 'instructions'),
      file(cursor.rulesDir, 'instructions'),
      file(cursor.projectMcp, 'mcp'),
      file(cursor.globalMcp, 'mcp'),
    ],
  };
}

/**
 * Scan the machine for every agent Agent Passport understands.
 *
 * This runs before the user has said anything about their setup. Asking someone to
 * enumerate their own agents defeats the purpose: the tool exists because keeping track of
 * that by hand is the chore being removed.
 */
export async function discoverAgents(passport: Passport): Promise<DiscoveredAgent[]> {
  const context = passport.context();
  const locations = knownLocations(context);
  const discovered: DiscoveredAgent[] = [];

  for (const adapter of passport.registry.all()) {
    const candidates = locations[adapter.id] ?? [];
    const files: DiscoveredFile[] = [];

    for (const candidate of candidates) {
      const size = await measure(candidate.path);
      if (size === undefined) continue;
      files.push({ ...candidate, bytes: size });
    }

    discovered.push({
      id: adapter.id,
      displayName: adapter.displayName,
      installed: await adapter.detect(context),
      files,
    });
  }

  return discovered;
}

/** Size of a file, or the total size of a directory's immediate contents. */
async function measure(path: string): Promise<number | undefined> {
  try {
    const info = await stat(path);
    if (info.isFile()) return info.size;
    if (!info.isDirectory()) return undefined;

    const entries = await readdir(path, { withFileTypes: true });
    if (entries.length === 0) return undefined;

    let total = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      try {
        total += (await stat(`${path}/${entry.name}`)).size;
      } catch {
        // A file that vanished between listing and stat is simply not counted.
      }
    }
    return total;
  } catch {
    return undefined;
  }
}
