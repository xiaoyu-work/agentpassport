import type { AgentAdapter } from './types.js';

/**
 * Adapter registry.
 *
 * Adding an agent must be exactly one new adapter plus one registration — never a change
 * to the profile schema, the sync engine, or the CLI. That property is the whole reason
 * the translation layer is worth building.
 */
export class AdapterRegistry {
  private readonly adapters = new Map<string, AgentAdapter>();

  register(adapter: AgentAdapter): this {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`adapter ${adapter.id} is already registered`);
    }
    this.adapters.set(adapter.id, adapter);
    return this;
  }

  get(id: string): AgentAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) {
      throw new Error(`unknown agent "${id}". Known agents: ${this.ids().join(', ')}`);
    }
    return adapter;
  }

  has(id: string): boolean {
    return this.adapters.has(id);
  }

  ids(): string[] {
    return [...this.adapters.keys()].sort();
  }

  all(): AgentAdapter[] {
    return [...this.adapters.values()];
  }
}
