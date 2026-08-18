import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { classify } from './policy.js';
import { appliesToAgent } from './sharing.js';
import type { MemoryProvider, MemoryQuery } from './provider.js';
import { MemoryRecordSchema, type MemoryDraft, type MemoryRecord } from './schema.js';

/** Content-addressed id, so importing the same config twice does not duplicate memories. */
export function memoryId(userId: string, content: string): string {
  const normalized = content.trim().toLowerCase().replace(/\s+/g, ' ');
  return `mem_${createHash('sha256').update(`${userId}:${normalized}`).digest('hex').slice(0, 24)}`;
}

interface MemoryFile {
  version: 1;
  records: Record<string, MemoryRecord[]>;
}

/**
 * File-backed memory provider.
 *
 * This is the default so that `agentpass` is useful with zero third-party accounts. Mem0
 * is an upgrade, not a prerequisite.
 */
export class LocalMemoryProvider implements MemoryProvider {
  readonly name = 'local';

  constructor(private readonly filePath: string) {}

  private async read(): Promise<MemoryFile> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as MemoryFile;
      return { version: 1, records: parsed.records ?? {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, records: {} };
      throw error;
    }
  }

  private async write(file: MemoryFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  }

  async add(userId: string, drafts: MemoryDraft[]): Promise<MemoryRecord[]> {
    const file = await this.read();
    const existing = file.records[userId] ?? [];
    const byId = new Map(existing.map((record) => [record.id, record]));
    const now = new Date().toISOString();
    const saved: MemoryRecord[] = [];

    for (const draft of drafts) {
      const id = draft.id ?? memoryId(userId, draft.content);
      const decision = classify(draft);
      const previous = byId.get(id);
      const record = MemoryRecordSchema.parse({
        ...draft,
        id,
        status: draft.status ?? decision.status,
        createdAt: previous?.createdAt ?? draft.createdAt ?? now,
        updatedAt: now,
      });
      byId.set(id, record);
      saved.push(record);
    }

    file.records[userId] = [...byId.values()];
    await this.write(file);
    return saved;
  }

  async list(userId: string, query: MemoryQuery = {}): Promise<MemoryRecord[]> {
    const file = await this.read();
    let records = file.records[userId] ?? [];
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
        const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
        return { record, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => entry.record);
  }

  async update(userId: string, id: string, patch: Partial<MemoryRecord>): Promise<MemoryRecord> {
    const file = await this.read();
    const records = file.records[userId] ?? [];
    const index = records.findIndex((record) => record.id === id);
    if (index === -1) throw new Error(`memory ${id} not found`);
    const current = records[index] as MemoryRecord;
    const updated = MemoryRecordSchema.parse({
      ...current,
      ...patch,
      id,
      updatedAt: new Date().toISOString(),
    });
    records[index] = updated;
    file.records[userId] = records;
    await this.write(file);
    return updated;
  }

  async delete(userId: string, id: string): Promise<void> {
    const file = await this.read();
    file.records[userId] = (file.records[userId] ?? []).filter((record) => record.id !== id);
    await this.write(file);
  }
}
