import type { AgentAdapter } from './types.js';

/**
 * Plugin API version.
 *
 * Bumped whenever `AgentAdapter` changes in a way an existing plugin cannot satisfy. A
 * third-party adapter compiled against an older interface is refused at load time with a
 * clear message, rather than half-working and corrupting someone's agent configuration on
 * the first `restore`.
 */
export const ADAPTER_API_VERSION = 1;

export interface AdapterPlugin {
  /** Must equal `ADAPTER_API_VERSION` for the plugin to load. */
  apiVersion: number;
  id: string;
  displayName: string;
  /** Plugin package version, shown by `agentpass plugins`. */
  version?: string;
  /**
   * Construct the adapter.
   *
   * A factory rather than a bare instance so a plugin can do setup work only when it is
   * actually used, and so loading a plugin never has side effects.
   */
  create(): AgentAdapter;
}

export function definePlugin(plugin: AdapterPlugin): AdapterPlugin {
  return plugin;
}

export interface PluginValidation {
  ok: boolean;
  reason?: string;
}

/**
 * Check an untrusted module export before trusting it with a user's config.
 *
 * Plugins come from npm and from a user's plugin directory, so a malformed one is an
 * expected condition, not an exceptional one.
 */
export function validatePlugin(value: unknown): PluginValidation {
  if (!value || typeof value !== 'object') {
    return { ok: false, reason: 'plugin export is not an object' };
  }
  const candidate = value as Partial<AdapterPlugin>;

  if (typeof candidate.apiVersion !== 'number') {
    return { ok: false, reason: 'plugin does not declare an apiVersion' };
  }
  if (candidate.apiVersion !== ADAPTER_API_VERSION) {
    return {
      ok: false,
      reason: `plugin targets adapter API v${candidate.apiVersion}, this build supports v${ADAPTER_API_VERSION}`,
    };
  }
  if (typeof candidate.id !== 'string' || !candidate.id) {
    return { ok: false, reason: 'plugin has no id' };
  }
  if (typeof candidate.create !== 'function') {
    return { ok: false, reason: 'plugin has no create() factory' };
  }
  return { ok: true };
}

const REQUIRED_METHODS = ['detect', 'import', 'previewExport', 'export', 'validate'] as const;

/** Confirm a constructed adapter actually implements the interface it claims. */
export function validateAdapter(value: unknown): PluginValidation {
  if (!value || typeof value !== 'object') {
    return { ok: false, reason: 'create() did not return an object' };
  }
  const candidate = value as Record<string, unknown>;
  for (const method of REQUIRED_METHODS) {
    if (typeof candidate[method] !== 'function') {
      return { ok: false, reason: `adapter is missing ${method}()` };
    }
  }
  return { ok: true };
}
