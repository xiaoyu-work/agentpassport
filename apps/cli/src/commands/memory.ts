import type { Passport } from '@agentpass/core';
import {
  appliesToAgent,
  restrictToAgents,
  share,
  summarizeSharing,
  type MemoryRecord,
} from '@agentpass/memory';
import { bullet, cyan, dim, heading, line, ok, readPassphrase, warn, yellow } from '../ui.js';

/**
 * Inspect and control the shared memory store.
 *
 * Memory the user cannot see is memory they cannot correct, so listing, editing, and
 * deleting are part of the product rather than a maintenance afterthought.
 */
export async function memoryCommand(
  passport: Passport,
  subcommand: string | undefined,
  rest: string[],
  args: Map<string, string>,
): Promise<number> {
  const passphrase = await readPassphrase();
  const dataKey = await passport.store.unlock(passphrase);
  const profile = await passport.store.load(dataKey);
  const provider = passport.memory(profile, dataKey);
  const userId = profile.identity.userId;

  switch (subcommand ?? 'list') {
    case 'list': {
      const agent = args.get('agent');
      const all = await provider.list(userId);
      const records = agent ? all.filter((record) => appliesToAgent(record, agent)) : all;

      if (records.length === 0) {
        line(dim('No memories yet. Run "agentpass import" to capture some.'));
        return 0;
      }

      const summary = summarizeSharing(all);
      heading(`Memory — one store, ${summary.total} active`);
      line(
        dim(`${summary.shared} shared with every agent, ${summary.agentSpecific} agent-specific`),
      );
      line('');

      for (const record of records) render(record);
      return 0;
    }

    case 'share': {
      const id = rest[0];
      if (!id) return usage('agentpass memory share <id>');
      const record = await find(provider, userId, id);
      if (!record) return notFound(id);
      await provider.update(userId, record.id, share(record));
      ok(`"${truncate(record.content)}" is now shared with every agent.`);
      return 0;
    }

    case 'pin': {
      const id = rest[0];
      const agents = rest.slice(1);
      if (!id || agents.length === 0) return usage('agentpass memory pin <id> <agent> [agent...]');
      for (const agent of agents) {
        if (!(await passport.registry()).has(agent)) {
          warn(`unknown agent "${agent}". Known: ${(await passport.registry()).ids().join(', ')}`);
          return 1;
        }
      }
      const record = await find(provider, userId, id);
      if (!record) return notFound(id);
      await provider.update(userId, record.id, restrictToAgents(record, agents));
      ok(`"${truncate(record.content)}" is now limited to ${agents.join(', ')}.`);
      return 0;
    }

    case 'approve': {
      const id = rest[0];
      if (!id) return usage('agentpass memory approve <id>');
      const record = await find(provider, userId, id);
      if (!record) return notFound(id);
      await provider.update(userId, record.id, { status: 'active' });
      ok(`Approved: ${truncate(record.content)}`);
      return 0;
    }

    case 'forget':
    case 'delete': {
      const id = rest[0];
      if (!id) return usage('agentpass memory forget <id>');
      const record = await find(provider, userId, id);
      if (!record) return notFound(id);
      await provider.delete(userId, record.id);
      ok(`Forgotten everywhere: ${truncate(record.content)}`);
      line(dim('One store means one deletion; no agent keeps a copy.'));
      return 0;
    }

    case 'search': {
      const query = rest.join(' ');
      if (!query) return usage('agentpass memory search <query>');
      const records = await provider.search(userId, query);
      if (records.length === 0) {
        line(dim('No matches.'));
        return 0;
      }
      heading(`${records.length} match(es)`);
      for (const record of records) render(record);
      return 0;
    }

    default:
      warn(`unknown subcommand "${subcommand}"`);
      line(dim('Try: list, search, share, pin, approve, forget'));
      return 1;
  }
}

function render(record: MemoryRecord): void {
  const audience =
    record.sharing === 'shared' || record.agents.length === 0
      ? cyan('all agents')
      : yellow(record.agents.join(', '));
  const status = record.status === 'active' ? '' : ` ${yellow(`[${record.status}]`)}`;

  line(`  ${dim(record.id.slice(0, 12))}  ${record.content}${status}`);
  bullet(
    dim(
      `  ${record.category} · ${audience} · from ${record.sourceAgent} · ${record.provenance} · confidence ${record.confidence}`,
    ),
  );
}

async function find(
  provider: ReturnType<Passport['memory']>,
  userId: string,
  id: string,
): Promise<MemoryRecord | undefined> {
  const records = await provider.list(userId);
  return records.find((record) => record.id === id || record.id.startsWith(id));
}

function usage(text: string): number {
  line(`Usage: ${text}`);
  return 1;
}

function notFound(id: string): number {
  warn(`no memory matching "${id}"`);
  return 1;
}

function truncate(text: string, max = 56): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}
