import type { AdapterContext, AgentAdapter } from '@agentpass/adapter-sdk';
import type { MemoryProvider } from '@agentpass/memory';
import { Mem0Provider } from '@agentpass/mem0';
import type { UniversalProfile } from '@agentpass/profile';
import { SecretRegistry } from '@agentpass/secrets';
import { createRegistry, agentpassHome, deviceName } from './registry.js';
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
}

/**
 * Wires the pieces together and owns the choices a user should not have to make.
 *
 * Memory provider selection is the important one: Mem0 when an API key is present,
 * otherwise a local file. Both satisfy `MemoryProvider`, so no command, adapter, or test
 * has to branch on which is in use.
 */
export class Passport {
  readonly store: ProfileStore;
  readonly registry = createRegistry();
  readonly secrets: SecretRegistry;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly device: string;
  readonly agentHome: string;
  readonly home: string;

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
    this.store = new ProfileStore({ home: this.home, device: this.device });
    this.secrets = SecretRegistry.default(this.env);
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

  adapter(id: string): AgentAdapter {
    return this.registry.get(id);
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

  /** Agents that appear to be installed, used by `status` and by `sync` with no arguments. */
  async detectAgents(): Promise<AgentAdapter[]> {
    const context = this.context();
    const found: AgentAdapter[] = [];
    for (const adapter of this.registry.all()) {
      if (await adapter.detect(context)) found.push(adapter);
    }
    return found;
  }
}
