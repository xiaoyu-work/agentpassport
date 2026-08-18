import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { AGENT_CATALOG, type CatalogEntry, type HintKind } from './catalog.js';
import type { Passport } from './passport.js';

export interface DiscoveredFile {
  path: string;
  kind: HintKind;
  bytes: number;
}

export interface DiscoveredAgent {
  id: string;
  displayName: string;
  /** Config for this agent exists on disk. */
  installed: boolean;
  /** An adapter plugin is loaded and can read and write it. */
  pluginInstalled: boolean;
  /** npm package to install when `installed` is true but `pluginInstalled` is false. */
  package?: string;
  files: DiscoveredFile[];
}

/**
 * Scan the machine for agents, whether or not their plugin is present.
 *
 * Detection is split deliberately. A loaded plugin decides authoritatively whether its
 * agent is configured, because only it knows the environment overrides and file formats
 * involved. For agents with no plugin, core falls back to the catalog's path hints — just
 * enough to say "you have Cursor here, install this to include it" without pulling in an
 * adapter the user never asked for.
 */
export async function discoverAgents(passport: Passport): Promise<DiscoveredAgent[]> {
  const context = passport.context();
  const registry = await passport.registry();
  const discovered: DiscoveredAgent[] = [];
  const seen = new Set<string>();

  for (const entry of AGENT_CATALOG) {
    seen.add(entry.id);
    const files = await measureHints(entry, passport);
    const hasPlugin = registry.has(entry.id);
    const installed = hasPlugin ? await registry.get(entry.id).detect(context) : files.length > 0;

    discovered.push({
      id: entry.id,
      displayName: entry.displayName,
      installed,
      pluginInstalled: hasPlugin,
      ...(hasPlugin ? {} : { package: entry.package }),
      files,
    });
  }

  // Third-party plugins have no catalog entry, so they are reported from the registry.
  for (const adapter of registry.all()) {
    if (seen.has(adapter.id)) continue;
    discovered.push({
      id: adapter.id,
      displayName: adapter.displayName,
      installed: await adapter.detect(context),
      pluginInstalled: true,
      files: [],
    });
  }

  return discovered;
}

/** Agents that are configured here but whose plugin is missing. */
export function missingPlugins(discovered: DiscoveredAgent[]): DiscoveredAgent[] {
  return discovered.filter((agent) => agent.installed && !agent.pluginInstalled);
}

/** Agents that can actually be imported or restored right now. */
export function usableAgents(discovered: DiscoveredAgent[]): DiscoveredAgent[] {
  return discovered.filter((agent) => agent.installed && agent.pluginInstalled);
}

async function measureHints(entry: CatalogEntry, passport: Passport): Promise<DiscoveredFile[]> {
  const files: DiscoveredFile[] = [];
  for (const hint of entry.hints) {
    const path = resolveHint(hint.path, passport);
    const size = await measure(path);
    if (size === undefined) continue;
    files.push({ path, kind: hint.kind, bytes: size });
  }
  return files;
}

function resolveHint(path: string, passport: Passport): string {
  if (path.startsWith('~/')) return join(passport.agentHome, path.slice(2));
  if (path.startsWith('./')) return join(passport.cwd, path.slice(2));
  return isAbsolute(path) ? path : resolve(passport.cwd, path);
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
        total += (await stat(join(path, entry.name))).size;
      } catch {
        // A file that vanished between listing and stat is simply not counted.
      }
    }
    return total;
  } catch {
    return undefined;
  }
}
