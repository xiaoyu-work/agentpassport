import type { AdapterContext, AdapterRegistry, AgentAdapter } from '@agentpass/adapter-sdk';
import type { MemoryProvider } from '@agentpass/memory';
import { Mem0Provider } from '@agentpass/mem0';
import type { UniversalProfile } from '@agentpass/profile';
import { SecretRegistry } from '@agentpass/secrets';
import { catalogEntry } from './catalog.js';
import { agentpassHome, deviceName } from './paths.js';
import { loadPlugins, type PluginLoadResult } from './plugins.js';
import { ProfileStore } from './store.js';
import { VaultMemoryProvider } from './vault-memory.js';
import { HttpRemoteStore, NullRemoteStore, type RemoteStore } from './remote.js';

export interface PassportOptions {
  home?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  device?: string;
  /** Home directory agents are read from. Separated from `home` so tests can redirect it. */
  agentHome?: string;
  /** Additional plugin specifiers, mainly for tests. */
  plugins?: string[];
  /** Turn off automatic plugin discovery, to exercise a plugin-free install. */
  disableAutoDiscovery?: boolean;
}

/**
 * Wires the pieces together and owns the choices a user should not have to make.
 *
 * Adapters are plugins resolved at runtime rather than compiled in. Someone who only uses
 * Claude Code should not have to carry a Cursor adapter, and supporting a new agent should
 * not require a new release of this package — so nothing here imports a specific agent.
 */
export class Passport {
  readonly store: ProfileStore;
  readonly secrets: SecretRegistry;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly device: string;
  readonly agentHome: string;
  readonly home: string;

  private plugins?: Promise<PluginLoadResult>;
  private readonly extraPlugins: string[];
  private readonly noDiscovery: boolean;

  constructor(options: PassportOptions = {}) {
    this.env = options.env ?? process.env;
    this.cwd = options.cwd ?? process.cwd();
    this.device = options.device ?? deviceName(this.env);
    this.home = options.home ?? agentpassHome(this.env);
    this.agentHome =
      options.agentHome ??
      this.env['AGENTPASS_AGENT_HOME'] ??
      this.env['HOME'] ??
      this.env['USERPROFILE'] ??
      '';
    this.extraPlugins = options.plugins ?? [];
    this.noDiscovery = options.disableAutoDiscovery ?? false;
    this.store = new ProfileStore({ home: this.home, device: this.device });
    this.secrets = SecretRegistry.default(this.env);
  }

  /** Load plugins once per process; every caller shares the same result. */
  async loadPlugins(): Promise<PluginLoadResult> {
    this.plugins ??= loadPlugins({
      home: this.home,
      extra: this.extraPlugins,
      disableAutoDiscovery: this.noDiscovery,
    });
    return this.plugins;
  }

  async registry(): Promise<AdapterRegistry> {
    return (await this.loadPlugins()).registry;
  }

  context(overrides: Partial<AdapterContext> = {}): AdapterContext {
    return {
      home: this.agentHome,
      cwd: this.cwd,
      env: this.env,
      device: this.device,
      dryRun: false,
      ...overrides,
    };
  }

  async adapter(id: string): Promise<AgentAdapter> {
    const registry = await this.registry();
    if (registry.has(id)) return registry.get(id);

    // Distinguish "we know this agent but its plugin is absent" from "never heard of it".
    // The first is a one-command fix; the second is a typo.
    const known = catalogEntry(id);
    if (known) {
      throw new Error(
        `the ${known.displayName} plugin is not installed. Run: npm install ${known.package}`,
      );
    }

    const available = registry.ids();
    throw new Error(
      available.length > 0
        ? `unknown agent "${id}". Installed plugins: ${available.join(', ')}`
        : `unknown agent "${id}". No adapter plugins are installed.`,
    );
  }

  /**
   * One memory provider for the whole passport, shared by every agent.
   *
   * There is deliberately no per-agent provider: a single store is what makes "delete this
   * about me" mean deleted everywhere, rather than deleted in the one agent that happened
   * to be open at the time.
   *
   * Mem0 takes over when the user has an account, because it adds retrieval and dedup that
   * are not worth rebuilding. Without one, memories live in the encrypted vault and sync
   * with the profile, so portability never depends on a third-party signup.
   */
  memory(profile: UniversalProfile | undefined, dataKey: Buffer): MemoryProvider {
    const apiKey = this.env['MEM0_API_KEY'];
    if (apiKey && profile?.memory.provider === 'mem0') {
      return new Mem0Provider({
        apiKey,
        namespace: profile.memory.namespace,
        ...(this.env['MEM0_BASE_URL'] ? { baseUrl: this.env['MEM0_BASE_URL'] } : {}),
      });
    }
    return new VaultMemoryProvider(this.store, dataKey);
  }

  async remote(): Promise<RemoteStore> {
    if (!(await this.store.exists())) return new NullRemoteStore();
    const session = await this.store.session();
    if (!session.serverUrl || !session.token) return new NullRemoteStore();
    return new HttpRemoteStore(session.serverUrl, session.token);
  }

  /** Agents with a plugin installed that also appear to be configured on this machine. */
  async detectAgents(): Promise<AgentAdapter[]> {
    const context = this.context();
    const registry = await this.registry();
    const found: AgentAdapter[] = [];
    for (const adapter of registry.all()) {
      if (await adapter.detect(context)) found.push(adapter);
    }
    return found;
  }
}
