import { stat } from 'node:fs/promises';
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
  installed: boolean;
  pluginInstalled: boolean;
  package?: string;
  files: DiscoveredFile[];
}

/**
 * Scan the machine for agents by walking the catalog's path hints.
 *
 * With cross-agent sharing gone we no longer ask each adapter to detect itself —
 * a config file being on disk is the whole signal.
 */
export async function discoverAgents(passport: Passport): Promise<DiscoveredAgent[]> {
  const registry = await passport.registry();
  const discovered: DiscoveredAgent[] = [];
  const seen = new Set<string>();

  for (const entry of AGENT_CATALOG) {
    seen.add(entry.id);
    const files = await measureHints(entry, passport);
    const hasPlugin = registry.has(entry.id);
    discovered.push({
      id: entry.id,
      displayName: entry.displayName,
      installed: files.length > 0,
      pluginInstalled: hasPlugin,
      ...(hasPlugin ? {} : { package: entry.package }),
      files,
    });
  }

  for (const adapter of registry.all()) {
    if (seen.has(adapter.id)) continue;
    discovered.push({
      id: adapter.id,
      displayName: adapter.displayName,
      installed: false,
      pluginInstalled: true,
      files: [],
    });
  }

  return discovered;
}

async function measureHints(entry: CatalogEntry, passport: Passport): Promise<DiscoveredFile[]> {
  const found: DiscoveredFile[] = [];
  for (const hint of entry.hints ?? []) {
    const raw = hint.path.replace('~', passport.agentHome).replace('$CWD', passport.cwd);
    const resolved = isAbsolute(raw) ? raw : resolve(passport.cwd, raw);
    try {
      const s = await stat(resolved);
      if (s.isFile()) found.push({ path: resolved, kind: hint.kind, bytes: s.size });
    } catch {
      /* absent hints are the common case */
    }
  }
  return found;
}
