import { restoreAll, restoreToAgent, type Passport, type RestoreOutcome } from '@agentpass/core';
import { bullet, confirm, cyan, dim, heading, line, ok, readPassphrase, warn } from '../ui.js';

/**
 * Write the passport into an agent's native configuration.
 *
 * This is the moment the product either works or does not: a freshly installed agent
 * should come up already knowing who the user is.
 */
export async function restoreCommand(
  passport: Passport,
  agent: string | undefined,
  args: Map<string, string>,
): Promise<number> {
  const passphrase = await readPassphrase();
  const dryRun = args.has('dry-run');

  // Always preview first. Overwriting a user's agent configuration without showing them
  // what changes is exactly the kind of surprise that makes a tool untrustworthy.
  const previews: RestoreOutcome[] = [];
  const failures: Array<{ agent: string; error: string }> = [];

  if (agent) {
    try {
      previews.push(await restoreToAgent(passport, { agent, passphrase, dryRun: true }));
    } catch (error) {
      failures.push({ agent, error: (error as Error).message });
    }
  } else {
    const bulk = await restoreAll(passport, { passphrase, dryRun: true });
    previews.push(...bulk.results);
    failures.push(...bulk.failures);
  }

  if (previews.length === 0) {
    for (const failure of failures) warn(`${failure.agent}: ${failure.error}`);
    if (failures.length === 0) warn('No supported agents found on this machine.');
    return 1;
  }

  let effective = 0;
  for (const preview of previews) {
    const adapter = passport.adapter(preview.agent);
    const changes = preview.plan.changes.filter((change) => change.op !== 'unchanged');
    effective += changes.length;

    heading(adapter.displayName);
    if (changes.length === 0) {
      line(dim('  Already up to date.'));
    }
    for (const change of changes) {
      const sigil = change.op === 'create' ? '+' : change.op === 'delete' ? '-' : '~';
      bullet(`${sigil} ${change.file}`);
      bullet(dim(`    ${change.description}`));
    }
    if (preview.memories.length > 0) {
      const shared = preview.memories.filter((memory) => memory.sharing === 'shared').length;
      bullet(
        cyan(
          `  ${preview.memories.length} memor${preview.memories.length === 1 ? 'y' : 'ies'} ` +
            `(${shared} shared, ${preview.memories.length - shared} specific to this agent)`,
        ),
      );
    }
    for (const warning of preview.plan.warnings) bullet(dim(`    ${warning.message}`));
  }

  for (const failure of failures) warn(`${failure.agent}: ${failure.error}`);

  if (effective === 0) {
    line('');
    ok('Every agent already matches your passport.');
    return 0;
  }

  line('');
  if (dryRun) {
    line(dim('Dry run: nothing was written.'));
    return 0;
  }

  if (!(await confirm(`Apply these changes to ${previews.length} agent(s)?`, true))) {
    line('Cancelled.');
    return 1;
  }

  const applied: RestoreOutcome[] = [];
  if (agent) {
    applied.push(await restoreToAgent(passport, { agent, passphrase, dryRun: false }));
  } else {
    const bulk = await restoreAll(passport, {
      passphrase,
      dryRun: false,
      agents: previews.map((preview) => preview.agent),
    });
    applied.push(...bulk.results);
  }

  line('');
  heading('Found your AI identity.');
  const totals = summarize(applied);
  for (const [label, count] of totals) {
    if (count > 0) ok(`${label}`);
  }
  line('');
  for (const result of applied) {
    const adapter = passport.adapter(result.agent);
    ok(`Restored to ${adapter.displayName} ${dim(`(${result.written.length} file(s))`)}`);
  }
  return 0;
}

function summarize(results: RestoreOutcome[]): Array<[string, number]> {
  const memories = new Set(results.flatMap((r) => r.memories.map((m) => m.id)));
  const files = results.reduce((sum, r) => sum + r.written.length, 0);
  return [
    ['Identity', 1],
    ['Preferences', 1],
    [`Long-term memory (${memories.size})`, memories.size],
    ['Skills', 1],
    ['MCP servers', 1],
    ['Workspace rules', 1],
    ['Model preferences', 1],
    [`${files} file(s) written`, files],
  ];
}
