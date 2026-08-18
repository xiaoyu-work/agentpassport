import type { AdapterContext, AdapterRegistry, AgentAdapter } from '@agentpassport/adapter-sdk';
import { join } from 'node:path';
import type { MemoryProvider } from '@agentpassport/memory';
import { Mem0Provider } from '@agentpassport/mem0';
import type { UniversalProfile } from '@agentpassport/profile';
import { SecretRegistry } from '@agentpassport/secrets';
import { catalogEntry } from './catalog.js';
import { agentpassHome, deviceId as resolveDeviceId, deviceName } from './paths.js';
import { loadPlugins, type PluginLoadResult } from './plugins.js';
import { ProfileStore, type SyncTarget } from './store.js';
import { FolderRemoteStore, GitRemoteStore } from './sync-backends.js';
import { VaultMemoryProvider } from './vault-memory.js';
import { HttpRemoteStore, NullRemoteStore, type RemoteStore } from './remote.js';

export interface PassportOptions {
  home?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  device?: string;
  /** Stable id for this machine; resolved and persisted automatically when omitted. */
  deviceId?: string;
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
 * Adapters are plugins resolved at runtime rather than compiled in, and the vault unlocks
 * from this machine's credential store rather than from something typed. Both are the same
 * idea: the person using this should have to know as little as possible for it to work.
 */
export class Passport {
  readonly store: ProfileStore;
  readonly secrets: SecretRegistry;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly device: string;
  readonly deviceId: string;
  readonly agentHome: string;
  readonly home: string;

  private plugins?: Promise<PluginLoadResult>;
  private readonly extraPlugins: string[];
  private readonly noDiscovery: boolean;

  private constructor(options: PassportOptions, deviceId: string) {
    this.env = options.env ?? process.env;
    this.cwd = options.cwd ?? process.cwd();
    this.device = options.device ?? deviceName(this.env);
    this.deviceId = deviceId;
    this.home = options.home ?? agentpassHome(this.env);
    this.agentHome =
      options.agentHome ??
      this.env['AGENTPASS_AGENT_HOME'] ??
      this.env['HOME'] ??
      this.env['USERPROFILE'] ??
      '';
    this.extraPlugins = options.plugins ?? [];
    this.noDiscovery = options.disableAutoDiscovery ?? false;
    this.store = new ProfileStore({
      home: this.home,
      device: this.device,
      deviceId: this.deviceId,
    });
    this.secrets = SecretRegistry.default(this.env);
  }

  /**
   * Create a passport for this machine.
   *
   * Asynchronous because the device identifier is persisted on first use; key slots are
   * addressed by it, so it has to be settled before the store exists.
   */
  static async open(options: PassportOptions = {}): Promise<Passport> {
    const env = options.env ?? process.env;
    const home = options.home ?? agentpassHome(env);
    const id = options.deviceId ?? (await resolveDeviceId(home, env));
    return new Passport(options, id);
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
      throw new Error(`Support for ${known.displayName} is not installed yet (${known.package}).`);
    }

    const available = registry.ids();
    throw new Error(
      available.length > 0
        ? `Unknown app "${id}". Available: ${available.join(', ')}`
        : `Unknown app "${id}". No app support is installed.`,
    );
  }

  /**
   * One memory provider for the whole passport, shared by every agent.
   *
   * There is deliberately no per-agent provider: a single store is what makes "delete this
   * about me" mean deleted everywhere, rather than deleted in the one app that happened to
   * be open at the time.
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

  /**
   * Build the transport this passport syncs through.
   *
   * All three backends move the same encrypted document, so the choice is the user's
   * convenience rather than a security decision. Falling back to `serverUrl` keeps
   * passports created before sync targets existed working unchanged.
   */
  async remote(): Promise<RemoteStore> {
    if (!(await this.store.exists())) return new NullRemoteStore();
    const session = await this.store.session();
    const target: SyncTarget =
      session.sync ??
      (session.serverUrl && session.token
        ? { kind: 'server', url: session.serverUrl, token: session.token }
        : { kind: 'none' });

    switch (target.kind) {
      case 'folder':
        return new FolderRemoteStore(target.path);
      case 'git':
        return new GitRemoteStore(
          target.remote,
          join(this.home, 'sync-repo'),
          target.branch ?? 'main',
        );
      case 'server':
        return new HttpRemoteStore(target.url, target.token);
      default:
        return new NullRemoteStore();
    }
  }

  /** Agents with support installed that also appear to be configured on this machine. */
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
