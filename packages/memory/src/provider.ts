import type { MemoryDraft, MemoryRecord } from './schema.js';

export interface MemoryQuery {
  scope?: MemoryRecord['scope'];
  category?: MemoryRecord['category'];
  /** Return only memories visible to this agent: shared plus those narrowed to it. */
  agent?: string;
  limit?: number;
}

/**
 * The seam between Agent Passport and whatever actually stores memories.
 *
 * Agent Passport deliberately does not implement retrieval, embedding, or ranking. This
 * interface exists so Mem0 can be swapped for a local file, or later for another vendor,
 * without any adapter or CLI command changing.
 */
export interface MemoryProvider {
  readonly name: string;

  add(userId: string, drafts: MemoryDraft[]): Promise<MemoryRecord[]>;

  list(userId: string, query?: MemoryQuery): Promise<MemoryRecord[]>;

  search(userId: string, query: string, limit?: number): Promise<MemoryRecord[]>;

  update(userId: string, id: string, patch: Partial<MemoryRecord>): Promise<MemoryRecord>;

  delete(userId: string, id: string): Promise<void>;
}
