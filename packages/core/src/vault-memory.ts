import {
  MemoryRecordSchema,
  appliesToAgent,
  classify,
  memoryId,
  type MemoryDraft,
  type MemoryProvider,
  type MemoryQuery,
  type MemoryRecord,
} from '@agentpass/memory';
import type { ProfileStore } from './store.js';

/**
 * The default memory store: one encrypted set per user, living inside the vault.
 *
 * Keeping memories in the vault rather than a side file is what makes them portable
 * without a third-party account. They are encrypted by the same data key, versioned by the
 * same revision, and carried by the same sync, so a new device that joins an account
 * receives the user's history along with their configuration. A device-local file would
 * leave every new machine starting from nothing, which is the problem, not the product.
 */
export class VaultMemoryProvider implements MemoryProvider {
  readonly name = 'vault';

  constructor(
    private readonly store: ProfileStore,
    private readonly dataKey: Buffer,
  ) {}

  async add(userId: string, drafts: MemoryDraft[]): Promise<MemoryRecord[]> {
    const existing = await this.store.loadMemories(this.dataKey);
    const byId = new Map(existing.map((record) => [record.id, record]));
    const now = new Date().toISOString();
    const saved: MemoryRecord[] = [];

    for (const draft of drafts) {
      const id = draft.id ?? memoryId(userId, draft.content);
      const previous = byId.get(id);
      const record = MemoryRecordSchema.parse({
        ...draft,
        id,
        status: draft.status ?? previous?.status ?? classify(draft).status,
        // A re-import must not silently widen a memory the user deliberately narrowed.
        sharing: previous?.sharing ?? draft.sharing ?? 'shared',
        agents: previous?.agents ?? draft.agents ?? [],
        createdAt: previous?.createdAt ?? draft.createdAt ?? now,
        updatedAt: now,
      });
      byId.set(id, record);
      saved.push(record);
    }

    await this.store.saveMemories(this.dataKey, [...byId.values()]);
    return saved;
  }

  async list(_userId: string, query: MemoryQuery = {}): Promise<MemoryRecord[]> {
    let records = await this.store.loadMemories(this.dataKey);
    if (query.scope) records = records.filter((record) => record.scope === query.scope);
    if (query.category) records = records.filter((record) => record.category === query.category);
    if (query.agent) {
      const agent = query.agent;
      records = records.filter((record) => appliesToAgent(record, agent));
    }
    return typeof query.limit === 'number' ? records.slice(0, query.limit) : records;
  }

  async search(userId: string, query: string, limit = 20): Promise<MemoryRecord[]> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const records = await this.list(userId);
    return records
      .map((record) => {
        const haystack = record.content.toLowerCase();
        return { record, score: terms.filter((term) => haystack.includes(term)).length };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => entry.record);
  }

  async update(_userId: string, id: string, patch: Partial<MemoryRecord>): Promise<MemoryRecord> {
    const records = await this.store.loadMemories(this.dataKey);
    const index = records.findIndex((record) => record.id === id);
    if (index === -1) throw new Error(`memory ${id} not found`);
    const updated = MemoryRecordSchema.parse({
      ...(records[index] as MemoryRecord),
      ...patch,
      id,
      updatedAt: new Date().toISOString(),
    });
    records[index] = updated;
    await this.store.saveMemories(this.dataKey, records);
    return updated;
  }

  async delete(_userId: string, id: string): Promise<void> {
    const records = await this.store.loadMemories(this.dataKey);
    await this.store.saveMemories(
      this.dataKey,
      records.filter((record) => record.id !== id),
    );
  }
}

/**
 * Union two memory sets, preferring the more recently updated copy of each record.
 *
 * Memories are append-mostly and identified by content hash, so a union loses nothing.
 * A deletion is represented by a `revoked` status rather than an absence, which is what
 * keeps "forget this" from being undone by the next sync from an older device.
 */
export function mergeMemories(local: MemoryRecord[], remote: MemoryRecord[]): MemoryRecord[] {
  const merged = new Map<string, MemoryRecord>();
  for (const record of [...local, ...remote]) {
    const existing = merged.get(record.id);
    if (!existing || record.updatedAt > existing.updatedAt) merged.set(record.id, record);
  }
  return [...merged.values()];
}
