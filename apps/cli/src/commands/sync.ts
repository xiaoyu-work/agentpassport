import { syncProfile, type Passport } from '@agentpass/core';
import { renderDiffLines, type Side } from '@agentpass/sync';
import { ask, bullet, dim, heading, line, ok, warn } from '../ui.js';

/**
 * Reconcile this machine with the cloud.
 *
 * Conflicts are surfaced and resolved by the user rather than settled by timestamp: the
 * data in question is a description of a person, and quietly discarding the losing side is
 * a change they would have no way to notice.
 */
export async function syncCommand(passport: Passport, args: Map<string, string>): Promise<number> {
  const dryRun = args.has('dry-run');

  let outcome = await syncProfile(passport, { dryRun, strategy: 'ask' });

  if (outcome.conflicts.length > 0) {
    heading('Conflicts');
    line(dim('The same field changed on this device and in the cloud.'));
    line('');

    const resolutions: Record<string, Side> = {};
    for (const conflict of outcome.conflicts) {
      line(`  ${conflict.kind}: ${conflict.label}`);
      bullet(`  local  ${conflict.local ?? dim('(removed)')}`);
      bullet(`  cloud  ${conflict.remote ?? dim('(removed)')}`);
      const answer = await ask('  keep [l]ocal / [c]loud? ', 'l');
      resolutions[conflict.path] = /^c/i.test(answer) ? 'remote' : 'local';
      line('');
    }

    outcome = await syncProfile(passport, { dryRun, resolutions, strategy: 'ask' });
  }

  if (!outcome.remoteConfigured) {
    heading('Sync');
    warn('No cloud profile configured.');
    line(
      dim('Your passport is stored locally and encrypted. Set AGENTPASS_SERVER to enable sync.'),
    );
    return 0;
  }

  heading('Sync');
  if (!outcome.remoteHadProfile) {
    line(dim('  First sync: published this device as the starting point.'));
  } else if (outcome.pulled.entries.length === 0) {
    line(dim('  Nothing changed in the cloud.'));
  } else {
    for (const change of renderDiffLines(outcome.pulled)) bullet(change);
  }

  line('');
  if (dryRun) {
    line(dim('Dry run: nothing was written.'));
    return 0;
  }
  if (outcome.pushed) {
    ok(`Synced at revision ${outcome.revision}.`);
  } else if (outcome.conflicts.length > 0) {
    warn('Unresolved conflicts remain; nothing was pushed.');
    return 1;
  } else {
    warn('The cloud profile moved on. Run "agentpass sync" again.');
    return 1;
  }
  return 0;
}
