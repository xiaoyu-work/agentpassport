import { importAll, importFromAgent, type ImportOutcome, type Passport } from '@agentpass/core';
import { renderDiffLines } from '@agentpass/sync';
import {
  bullet,
  confirm,
  cyan,
  dim,
  heading,
  line,
  ok,
  readPassphrase,
  warn,
  yellow,
} from '../ui.js';

/**
 * Bring existing agent configuration into the passport.
 *
 * With no agent named, every agent on the machine is imported in one pass. Naming one is
 * the exception, not the rule.
 */
export async function importCommand(
  passport: Passport,
  agent: string | undefined,
  args: Map<string, string>,
): Promise<number> {
  const dryRun = args.has('dry-run');
  const passphrase = await readPassphrase();

  const outcomes: ImportOutcome[] = [];
  const failures: Array<{ agent: string; error: string }> = [];

  if (agent) {
    try {
      outcomes.push(await importFromAgent(passport, { agent, passphrase, dryRun }));
    } catch (error) {
      failures.push({ agent, error: (error as Error).message });
    }
  } else {
    const bulk = await importAll(passport, { passphrase, dryRun });
    outcomes.push(...bulk.results);
    failures.push(...bulk.failures);
  }

  if (outcomes.length === 0 && failures.length === 0) {
    warn('No supported agents found on this machine.');
    line(dim('Run "agentpass scan" to see where Agent Passport looked.'));
    return 1;
  }

  for (const outcome of outcomes) {
    const adapter = await passport.adapter(outcome.agent);
    heading(`${adapter.displayName}`);

    if (outcome.sources.length > 0) {
      for (const source of outcome.sources) bullet(dim(`read ${source}`));
    }

    if (outcome.diff.entries.length === 0) {
      line(dim('  Profile already up to date.'));
    } else {
      line('');
      for (const change of renderDiffLines(outcome.diff)) bullet(change);
    }

    if (outcome.accepted.length > 0) {
      line('');
      const shared = outcome.accepted.filter((memory) => memory.sharing === 'shared').length;
      const pinned = outcome.accepted.length - shared;
      ok(`${outcome.accepted.length} memor${outcome.accepted.length === 1 ? 'y' : 'ies'} captured`);
      bullet(cyan(`${shared} shared with every agent`));
      if (pinned > 0) bullet(dim(`${pinned} kept specific to ${adapter.displayName}`));
    }

    for (const held of outcome.held) {
      warn(`held for review: ${truncate(held.draft.content)} ${dim(`(${held.reason})`)}`);
    }

    for (const warning of outcome.warnings) {
      if (warning.severity === 'security') warn(yellow(warning.message));
      else if (warning.severity === 'warn') warn(warning.message);
      else bullet(dim(warning.message));
    }
  }

  for (const failure of failures) {
    warn(`${failure.agent}: ${failure.error}`);
  }

  line('');
  if (dryRun) {
    line(dim('Dry run: nothing was written.'));
    return 0;
  }

  const total = outcomes.reduce((sum, outcome) => sum + outcome.diff.entries.length, 0);
  ok(`Imported ${outcomes.length} agent(s), ${total} profile change(s).`);

  const remote = await passport.store.session();
  if (remote.serverUrl && (await confirm('Sync to the cloud now?', true))) {
    const { syncCommand } = await import('./sync.js');
    return syncCommand(passport, new Map([['passphrase-cached', passphrase]]));
  }
  line(`Next: ${dim('agentpass restore')}   (writes your identity into every agent)`);
  return 0;
}

function truncate(text: string, max = 60): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}
