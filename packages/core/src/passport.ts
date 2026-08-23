import { join } from 'node:path';
import { SecretRegistry } from '@agentpassport/secrets';
import { catalogEntry } from './catalog.js';
import { agentpassHome, deviceId as resolveDeviceId, deviceName } from './paths.js';
import { loadPlugins, type PluginLoadResult, type AdapterRegistry, type AdapterLike } from './plugins.js';
import { VaultStore, type SyncTarget } from './store.js';
import { FolderRemoteStore, GitRemoteStore } from './sync-backends.js';
import { HttpRemoteStore, NullRemoteStore, type RemoteStore } from './remote.js';

export interface PassportOptions {
  home?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  device?: string;
  deviceId?: string;
  agentHome?: string;
  plugins?: string[];
  disableAutoDiscovery?: boolean;
}

/**
 * Wires the pieces together. Adapters are plugins resolved at runtime; the vault
 * unlocks from this machine's credential store rather than a password.
 */
export class Passport {
  readonly store: VaultStore;
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
    this.store = new VaultStore({
      home: this.home,
      device: this.device,
      deviceId: this.deviceId,
    });
    this.secrets = SecretRegistry.default(this.env);
  }

  static async open(options: PassportOptions = {}): Promise<Passport> {
    const env = options.env ?? process.env;
    const home = options.home ?? agentpassHome(env);
    const id = options.deviceId ?? (await resolveDeviceId(home, env));
    return new Passport(options, id);
  }

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

  async adapter(id: string): Promise<AdapterLike> {
    const registry = await this.registry();
    if (registry.has(id)) return registry.get(id);

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
}
