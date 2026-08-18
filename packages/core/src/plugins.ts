import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  AdapterRegistry,
  validateAdapter,
  validatePlugin,
  type AdapterPlugin,
  type AgentAdapter,
} from '@agentpassport/adapter-sdk';
import { bundledPackages } from './catalog.js';

export type PluginOrigin = 'bundled' | 'installed' | 'user';

export interface LoadedPlugin {
  id: string;
  displayName: string;
  version?: string;
  specifier: string;
  origin: PluginOrigin;
}

export interface FailedPlugin {
  specifier: string;
  origin: PluginOrigin;
  reason: string;
}

export interface PluginLoadResult {
  registry: AdapterRegistry;
  loaded: LoadedPlugin[];
  failed: FailedPlugin[];
}

export interface LoadOptions {
  /** Agent Passport's own directory, searched for user-installed plugins. */
  home: string;
  /** Extra specifiers to load, mainly for tests. */
  extra?: string[];
  /**
   * Turn off automatic discovery entirely, leaving only `extra`.
   *
   * Exists so tests can exercise a genuinely plugin-free install; in normal use discovery
   * is the whole point and should stay on.
   */
  disableAutoDiscovery?: boolean;
}

interface Candidate {
  specifier: string;
  origin: PluginOrigin;
}

/**
 * Load every available adapter plugin.
 *
 * Nothing here is required. A user who only runs Claude Code should not have to install a
 * Cursor adapter, and Agent Passport must stay useful with zero plugins present — so a
 * missing or broken plugin is reported, never thrown. One bad third-party package cannot
 * take down the CLI for the agents that do work.
 */
export async function loadPlugins(options: LoadOptions): Promise<PluginLoadResult> {
  const registry = new AdapterRegistry();
  const loaded: LoadedPlugin[] = [];
  const failed: FailedPlugin[] = [];
  const seen = new Set<string>();

  for (const candidate of await candidates(options)) {
    if (seen.has(candidate.specifier)) continue;
    seen.add(candidate.specifier);

    let plugin: AdapterPlugin;
    try {
      const module = (await import(candidate.specifier)) as Record<string, unknown>;
      const exported = module['plugin'] ?? module['default'];
      const check = validatePlugin(exported);
      if (!check.ok) {
        failed.push({ ...candidate, reason: check.reason ?? 'invalid plugin' });
        continue;
      }
      plugin = exported as AdapterPlugin;
    } catch (error) {
      // A bundled adapter that was never installed is the normal case, not a failure.
      if (candidate.origin === 'bundled' && isModuleNotFound(error)) continue;
      failed.push({ ...candidate, reason: (error as Error).message });
      continue;
    }

    if (registry.has(plugin.id)) {
      failed.push({
        ...candidate,
        reason: `another plugin already provides "${plugin.id}"`,
      });
      continue;
    }

    let adapter: AgentAdapter;
    try {
      adapter = plugin.create();
    } catch (error) {
      failed.push({ ...candidate, reason: `create() threw: ${(error as Error).message}` });
      continue;
    }

    const adapterCheck = validateAdapter(adapter);
    if (!adapterCheck.ok) {
      failed.push({ ...candidate, reason: adapterCheck.reason ?? 'invalid adapter' });
      continue;
    }

    registry.register(adapter);
    loaded.push({
      id: plugin.id,
      displayName: plugin.displayName || adapter.displayName,
      ...(plugin.version ? { version: plugin.version } : {}),
      specifier: candidate.specifier,
      origin: candidate.origin,
    });
  }

  loaded.sort((a, b) => a.id.localeCompare(b.id));
  return { registry, loaded, failed };
}

async function candidates(options: LoadOptions): Promise<Candidate[]> {
  const found: Candidate[] = [];

  if (!options.disableAutoDiscovery) {
    for (const specifier of bundledPackages()) found.push({ specifier, origin: 'bundled' });
    for (const specifier of await installedPlugins()) {
      found.push({ specifier, origin: 'installed' });
    }
    for (const specifier of await userPlugins(options.home)) {
      found.push({ specifier, origin: 'user' });
    }
  }

  for (const specifier of options.extra ?? []) {
    found.push({ specifier, origin: 'user' });
  }

  return found;
}

/**
 * Packages under the `@agentpassport/adapter-` prefix that are not adapters.
 *
 * The naming convention that makes discovery work also catches the SDK every adapter
 * depends on, which would otherwise be reported as a broken plugin on every run.
 */
const NOT_ADAPTERS = new Set(['@agentpassport/adapter-sdk']);

/**
 * Third-party plugins published to npm.
 *
 * The naming convention is the discovery mechanism: anything called
 * `agentpass-adapter-*` or `@agentpassport/adapter-*` is picked up without configuration, so
 * publishing a new agent's support requires no change here.
 */
async function installedPlugins(): Promise<string[]> {
  const roots = modulePaths();
  const specifiers = new Set<string>();

  for (const root of roots) {
    for (const name of await safeReaddir(root)) {
      if (name.startsWith('agentpass-adapter-') || name.startsWith('agentpassport-adapter-')) {
        specifiers.add(name);
        continue;
      }
      if (name !== '@agentpass') continue;
      for (const scoped of await safeReaddir(join(root, name))) {
        if (!scoped.startsWith('adapter-')) continue;
        const specifier = `@agentpassport/${scoped}`;
        if (NOT_ADAPTERS.has(specifier)) continue;
        specifiers.add(specifier);
      }
    }
  }

  return [...specifiers];
}

function modulePaths(): string[] {
  // Walk up from the working directory. This finds both a project-local install and a
  // global one, without depending on `require.main`, which is unavailable under pure ESM.
  const paths: string[] = [];
  let current = process.cwd();

  while (true) {
    paths.push(join(current, 'node_modules'));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return paths;
}

/** Plugins a user dropped into `~/.agentpass/plugins`, or listed in `plugins.json`. */
async function userPlugins(home: string): Promise<string[]> {
  const specifiers: string[] = [];

  try {
    const raw = await readFile(join(home, 'plugins.json'), 'utf8');
    const parsed = JSON.parse(raw) as { plugins?: string[] };
    for (const entry of parsed.plugins ?? []) {
      specifiers.push(
        entry.startsWith('.') || entry.includes('/') || entry.includes('\\')
          ? toUrl(entry, home)
          : entry,
      );
    }
  } catch {
    // No plugins.json is the common case.
  }

  const dir = join(home, 'plugins');
  for (const name of await safeReaddir(dir)) {
    if (name.startsWith('.')) continue;
    specifiers.push(pathToFileURL(join(dir, name, 'index.js')).href);
  }

  return specifiers;
}

function toUrl(entry: string, home: string): string {
  const resolved = entry.startsWith('.') ? join(home, entry) : entry;
  return pathToFileURL(resolved).href;
}

async function safeReaddir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

function isModuleNotFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND';
}
