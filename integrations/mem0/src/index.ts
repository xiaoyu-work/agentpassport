import {
  MemoryRecordSchema,
  classify,
  isSyncable,
  memoryId,
  type MemoryDraft,
  type MemoryProvider,
  type MemoryQuery,
  type MemoryRecord,
  appliesToAgent,
} from '@agentpass/memory';

export interface Mem0Options {
  apiKey: string;
  /** Shared across every agent. One namespace per user is what makes memory portable. */
  userId?: string;
  baseUrl?: string;
  /** Mem0 project namespace, mirrored from `profile.memory.namespace`. */
  namespace?: string;
  fetchImpl?: typeof fetch;
}

interface Mem0Memory {
  id: string;
  memory?: string;
  text?: string;
  metadata?: Record<string, unknown> | null;
  categories?: string[] | null;
  created_at?: string;
  updated_at?: string;
}

/**
 * Mem0-backed memory provider.
 *
 * Agent Passport stores no vectors and runs no retrieval of its own; Mem0 owns embedding,
 * dedup, and search. What Agent Passport keeps is the part Mem0 has no opinion about: the
 * provenance and sharing metadata that decides whether a memory may be trusted and which
 * agents may see it. Those ride along in `metadata` so a record survives a round trip.
 */
export class Mem0Provider implements MemoryProvider {
  readonly name = 'mem0';
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: Mem0Options) {
    if (!options.apiKey) throw new Error('Mem0 API key is required');
    this.baseUrl = (options.baseUrl ?? 'https://api.mem0.ai').replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Token ${this.options.apiKey}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Mem0 ${init.method ?? 'GET'} ${path} failed: ${response.status} ${body}`.trim(),
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async add(userId: string, drafts: MemoryDraft[]): Promise<MemoryRecord[]> {
    const records = drafts.map((draft) => toRecord(userId, draft));
    // Quarantined and secret-bearing records never leave the device, so untrusted text
    // cannot reach shared storage and become durable identity behind the user's back.
    const sendable = records.filter(isSyncable);

    for (const record of sendable) {
      await this.request('/v1/memories/', {
        method: 'POST',
        body: JSON.stringify({
          messages: [{ role: 'user', content: record.content }],
          user_id: userId,
          ...(this.options.namespace ? { app_id: this.options.namespace } : {}),
          metadata: toMetadata(record),
          infer: false,
        }),
      });
    }

    return records;
  }

  async list(userId: string, query: MemoryQuery = {}): Promise<MemoryRecord[]> {
    const params = new URLSearchParams({ user_id: userId });
    if (this.options.namespace) params.set('app_id', this.options.namespace);
    if (typeof query.limit === 'number') params.set('limit', String(query.limit));

    const payload = await this.request<Mem0Memory[] | { results?: Mem0Memory[] }>(
      `/v1/memories/?${params.toString()}`,
      { method: 'GET' },
    );
    const items = Array.isArray(payload) ? payload : (payload.results ?? []);
    return this.filter(
      items.map((item) => fromMem0(userId, item)),
      query,
    );
  }

  async search(userId: string, query: string, limit = 20): Promise<MemoryRecord[]> {
    const payload = await this.request<Mem0Memory[] | { results?: Mem0Memory[] }>(
      '/v1/memories/search/',
      {
        method: 'POST',
        body: JSON.stringify({
          query,
          user_id: userId,
          limit,
          ...(this.options.namespace ? { app_id: this.options.namespace } : {}),
        }),
      },
    );
    const items = Array.isArray(payload) ? payload : (payload.results ?? []);
    return items.map((item) => fromMem0(userId, item));
  }

  async update(userId: string, id: string, patch: Partial<MemoryRecord>): Promise<MemoryRecord> {
    const current = (await this.list(userId)).find((record) => record.id === id);
    if (!current) throw new Error(`memory ${id} not found`);
    const updated = MemoryRecordSchema.parse({
      ...current,
      ...patch,
      id,
      updatedAt: new Date().toISOString(),
    });
    await this.request(`/v1/memories/${encodeURIComponent(id)}/`, {
      method: 'PUT',
      body: JSON.stringify({ text: updated.content, metadata: toMetadata(updated) }),
    });
    return updated;
  }

  async delete(_userId: string, id: string): Promise<void> {
    await this.request(`/v1/memories/${encodeURIComponent(id)}/`, { method: 'DELETE' });
  }

  private filter(records: MemoryRecord[], query: MemoryQuery): MemoryRecord[] {
    let result = records;
    if (query.scope) result = result.filter((record) => record.scope === query.scope);
    if (query.category) result = result.filter((record) => record.category === query.category);
    if (query.agent) {
      const agent = query.agent;
      result = result.filter((record) => appliesToAgent(record, agent));
    }
    return result;
  }
}

/** Agent Passport's fields, carried through Mem0 as opaque metadata. */
function toMetadata(record: MemoryRecord): Record<string, unknown> {
  return {
    agentpass_id: record.id,
    category: record.category,
    provenance: record.provenance,
    source: record.source,
    source_agent: record.sourceAgent,
    confidence: record.confidence,
    scope: record.scope,
    project: record.project ?? null,
    sharing: record.sharing,
    agents: record.agents,
    sensitivity: record.sensitivity,
    status: record.status,
  };
}

function fromMem0(userId: string, item: Mem0Memory): MemoryRecord {
  const meta = (item.metadata ?? {}) as Record<string, unknown>;
  const content = item.memory ?? item.text ?? '';
  const draft: MemoryDraft = {
    id: str(meta['agentpass_id']) ?? item.id ?? memoryId(userId, content),
    content,
    category: (str(meta['category']) as MemoryRecord['category']) ?? 'fact',
    provenance: (str(meta['provenance']) as MemoryRecord['provenance']) ?? 'imported',
    source: str(meta['source']) ?? 'mem0',
    sourceAgent: str(meta['source_agent']) ?? 'unknown',
    confidence: typeof meta['confidence'] === 'number' ? meta['confidence'] : 0.5,
    scope: (str(meta['scope']) as MemoryRecord['scope']) ?? 'global',
    ...(str(meta['project']) ? { project: str(meta['project']) as string } : {}),
    sharing: (str(meta['sharing']) as MemoryRecord['sharing']) ?? 'shared',
    agents: Array.isArray(meta['agents']) ? (meta['agents'] as string[]) : [],
    sensitivity: (str(meta['sensitivity']) as MemoryRecord['sensitivity']) ?? 'private',
    status: (str(meta['status']) as MemoryRecord['status']) ?? 'active',
    syncEnabled: true,
    ...(item.created_at ? { createdAt: item.created_at } : {}),
    ...(item.updated_at ? { updatedAt: item.updated_at } : {}),
  };
  return MemoryRecordSchema.parse(draft);
}

function toRecord(userId: string, draft: MemoryDraft): MemoryRecord {
  const id = draft.id ?? memoryId(userId, draft.content);
  return MemoryRecordSchema.parse({
    ...draft,
    id,
    status: draft.status ?? classify(draft).status,
  });
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}
