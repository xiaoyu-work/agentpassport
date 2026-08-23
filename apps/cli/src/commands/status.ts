import { discoverAgents, type Passport } from '@agentpassport/core';
import { bullet, cyan, dim, heading, line, warn } from '../ui.js';

/** Show discovered agents on this machine. */
export async function scan(passport: Passport): Promise<number> {
  const agents = await discoverAgents(passport);
  heading('Agents on this computer');
  for (const a of agents) {
    const files = a.files.length > 0 ? dim(` (${a.files.length} file${a.files.length === 1 ? '' : 's'})`) : '';
    if (a.installed) bullet(`${a.displayName}${files}`);
    else bullet(dim(`${a.displayName}${files}`));
    if (!a.pluginInstalled && a.package) {
      bullet(dim(`  plugin missing — install ${cyan(a.package)}`));
    }
  }
  return 0;
}

/** Terse status card for the vault itself. */
export async function status(passport: Passport): Promise<number> {
  if (!(await passport.store.exists())) {
    warn('This computer is not set up yet.');
    line(`Run ${cyan('agentpass setup')} to begin.`);
    return 1;
  }
  const session = await passport.store.session();
  heading('Passport');
  bullet(`user id      ${session.userId}`);
  if (session.email) bullet(`email        ${session.email}`);
  bullet(`device       ${session.device}`);
  bullet(`created      ${session.createdAt}`);
  const target = session.sync;
  bullet(`sync         ${target && target.kind !== 'none' ? describeSync(target) : dim('this computer only')}`);
  line('');
  line(dim(`Vault: ${passport.store.path}`));
  return 0;
}

function describeSync(t: { kind: string; [k: string]: unknown }): string {
  switch (t.kind) {
    case 'git':
      return `git ${t['remote'] as string}`;
    case 'folder':
      return `folder ${t['path'] as string}`;
    case 'server':
      return t['url'] as string;
    default:
      return 'this computer only';
  }
}
