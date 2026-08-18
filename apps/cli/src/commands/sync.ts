import { syncProfile, type Passport, type SyncTarget } from '@agentpassport/core';
import { renderDiffLines, type Side } from '@agentpassport/sync';
import { ask, bullet, cyan, dim, heading, line, ok, warn } from '../ui.js';

/**
 * Reconcile this machine with wherever the user keeps their passport.
 *
 * Conflicts are surfaced and resolved by the user rather than settled by timestamp: the
 * data in question describes a person, and quietly discarding the losing side is a change
 * they would have no way to notice.
 */
export async function syncCommand(passport: Passport, args: Map<string, string>): Promise<number> {
  const dryRun = args.has('dry-run');

  const chosen = targetFromArgs(args);
  if (chosen) {
    await passport.store.setSyncTarget(chosen);
    ok(`Sync set up: ${describe(chosen)}`);
    line(dim('Future syncs need no flags.'));
    line('');
  }

  const session = await passport.store.session();
  const target = session.sync;
  if (!target || target.kind === 'none') {
    heading('Sync');
    warn('This passport only exists on this computer.');
    line('');
    line('Point it somewhere your other computers can reach:');
    bullet(cyan('agentpass sync --git git@github.com:you/ai-passport.git'));
    bullet(cyan('agentpass sync --folder ~/Dropbox/agentpass'));
    line('');
    line(dim('Whatever you choose only ever receives encrypted data.'));
    return 1;
  }

  let outcome = await syncProfile(passport, { dryRun, strategy: 'ask' });

  if (outcome.conflicts.length > 0) {
    heading('Conflicts');
    line(dim('The same field changed here and on another computer.'));
    line('');

    const resolutions: Record<string, Side> = {};
    for (const conflict of outcome.conflicts) {
      line(`  ${conflict.kind}: ${conflict.label}`);
      bullet(`  this computer  ${conflict.local ?? dim('(removed)')}`);
      bullet(`  other          ${conflict.remote ?? dim('(removed)')}`);
      const answer = await ask('  keep [t]his / [o]ther? ', 't');
      resolutions[conflict.path] = /^o/i.test(answer) ? 'remote' : 'local';
      line('');
    }

    outcome = await syncProfile(passport, { dryRun, resolutions, strategy: 'ask' });
  }

  heading(`Sync — ${describe(target)}`);
  if (!outcome.remoteHadProfile) {
    line(dim('  First sync: published this computer as the starting point.'));
  } else if (outcome.pulled.entries.length === 0) {
    line(dim('  Nothing changed elsewhere.'));
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
    if (!outcome.remoteHadProfile) {
      line('');
      line('On your other computer:');
      bullet(
        cyan(`agentpass setup --user-id ${session.userId} ${flagFor(target)} --code <your code>`),
      );
    }
    return 0;
  }
  if (outcome.conflicts.length > 0) {
    warn('Unresolved conflicts remain; nothing was sent.');
    return 1;
  }
  warn('Another computer got there first. Run "agentpass sync" again.');
  return 1;
}

export function targetFromArgs(args: Map<string, string>): SyncTarget | undefined {
  const git = args.get('git');
  if (git) {
    const branch = args.get('branch');
    return { kind: 'git', remote: git, ...(branch ? { branch } : {}) };
  }

  const folder = args.get('folder');
  if (folder) return { kind: 'folder', path: folder };

  const server = args.get('server');
  if (server) {
    return { kind: 'server', url: server, token: args.get('token') ?? 'local-dev-token' };
  }
  return undefined;
}

export function describe(target: SyncTarget): string {
  switch (target.kind) {
    case 'git':
      return `git ${target.remote}`;
    case 'folder':
      return `folder ${target.path}`;
    case 'server':
      return target.url;
    default:
      return 'this computer only';
  }
}

function flagFor(target: SyncTarget): string {
  switch (target.kind) {
    case 'git':
      return `--git ${target.remote}`;
    case 'folder':
      return `--folder ${target.path}`;
    case 'server':
      return `--server ${target.url}`;
    default:
      return '';
  }
}
