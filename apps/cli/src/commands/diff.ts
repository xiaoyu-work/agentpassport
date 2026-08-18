import { diffAgent, discoverAgents, usableAgents, type Passport } from '@agentpass/core';
import { renderDiffLines } from '@agentpass/sync';
import { bullet, dim, heading, line, ok, warn } from '../ui.js';

/**
 * Show what differs between the local agents and the passport, in both directions.
 *
 * Sync is only trustworthy if a user can see what it would do first, so `diff` is a
 * first-class command rather than a flag on `sync`.
 */
export async function diffCommand(passport: Passport, agent: string | undefined): Promise<number> {
  const agents = agent ? [agent] : usableAgents(await discoverAgents(passport)).map((a) => a.id);

  if (agents.length === 0) {
    warn('No supported agents found on this machine.');
    return 1;
  }

  let changes = 0;
  for (const id of agents) {
    const adapter = await passport.adapter(id);
    let result: Awaited<ReturnType<typeof diffAgent>>;
    try {
      result = await diffAgent(passport, { agent: id });
    } catch (error) {
      warn(`${id}: ${(error as Error).message}`);
      continue;
    }

    heading(`${adapter.displayName}`);

    const incoming = renderDiffLines(result.incoming);
    line(`  ${dim('Local agent -> Cloud identity')}`);
    if (incoming.length === 0) {
      bullet(dim('  nothing new on this machine'));
    } else {
      for (const change of incoming) bullet(`  ${change}`);
      changes += incoming.length;
    }

    const outgoing = result.outgoing.changes.filter((change) => change.op !== 'unchanged');
    line('');
    line(`  ${dim('Cloud identity -> Local agent')}`);
    if (outgoing.length === 0) {
      bullet(dim('  agent already matches your passport'));
    } else {
      for (const change of outgoing) {
        const sigil = change.op === 'create' ? '+' : change.op === 'delete' ? '-' : '~';
        bullet(`  ${sigil} ${change.file} ${dim(`— ${change.description}`)}`);
      }
      changes += outgoing.length;
    }
  }

  line('');
  if (changes === 0) {
    ok('Everything is in sync.');
    return 0;
  }
  line(
    `${changes} pending change(s). Run ${dim('agentpass sync')} or ${dim('agentpass restore')}.`,
  );
  return 0;
}
