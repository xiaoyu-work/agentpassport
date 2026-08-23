#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { Passport } from '@agentpassport/core';
import { setUp, signOut } from './commands/auth.js';
import { scan, status } from './commands/status.js';
import { snapshotCommand, restoreCommand } from './commands/snapshot.js';
import { pluginsCommand } from './commands/plugins.js';
import { remoteCommand } from './commands/remote.js';
import { bold, cyan, dim, fail, line, warn } from './ui.js';

const HELP = `${bold('agentpass')} — per-agent backup for your AI tools, synced to a git repo you own.

${bold('Getting started')}
  agentpass setup                First computer: creates your passport
  agentpass remote <git-url>     Bind this passport to your private repo
  agentpass snapshot --push      Back up every known agent and push

${bold('Using a second computer')}
  git clone <git-url> ~/.agentpass
  agentpass restore              Restore snapshots back to disk

${bold('Commands')}
  setup [--name <n>] [--email <e>] [--code <recovery>]
  status                         What is stored on this machine
  scan                           AI tools detected on this machine
  plugins                        Which tool adapters are installed
  snapshot [agent] [--diff] [--dry-run] [--push]
  restore  [agent] [--prune] [--dry-run]
  remote   [<git-url>] [--branch main]  Bind passport home to a git repo
  logout                         Remove the passport from this computer

${bold('Unlocking')}
  No passphrase. Your key lives in this machine's credential store. A recovery
  code, shown once at setup, is what adds another computer.

${bold('Tool support is optional')}
  npm install @agentpassport/adapter-claude     # or -openclaw, -codex, -cursor

${bold('Environment')}
  AGENTPASS_HOME                 Passport directory (default ~/.agentpass)
  AGENTPASS_AGENT_HOME           Home directory tools are read from
  AGENTPASS_SERVER               Sync server URL
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      code: { type: 'string' },
      git: { type: 'string' },
      folder: { type: 'string' },
      branch: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      'dry-run': { type: 'boolean' },
      email: { type: 'string' },
      name: { type: 'string' },
      'user-id': { type: 'string' },
      server: { type: 'string' },
      token: { type: 'string' },
      agent: { type: 'string' },
      cwd: { type: 'string' },
    },
  });

  const [command, ...rest] = positionals;

  if (values['version']) {
    line('0.1.0');
    return 0;
  }
  if (values['help'] || command === 'help') {
    line(HELP);
    return 0;
  }

  const args = new Map<string, string>();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === false) continue;
    args.set(key, value === true ? '' : String(value));
  }

  const passport = await Passport.open({
    ...(args.get('cwd') ? { cwd: args.get('cwd') as string } : {}),
  });

  // Bare `agentpass` should advance the user, not lecture them. Before setup the next step
  // is setup; after it, the useful thing is knowing what is out of sync.
  if (!command) {
    if (!(await passport.store.exists())) {
      line(HELP);
      line('');
      warn('This computer is not set up yet.');
      line(`Run ${cyan('agentpass setup')} to begin.`);
      return 1;
    }
    return status(passport);
  }

  switch (command) {
    case 'setup':
    case 'login':
    case 'signup':
    case 'init':
      return setUp(passport, args);
    case 'join':
      return setUp(passport, args);
    case 'logout':
    case 'signout':
      return signOut(passport);
    case 'status':
      return status(passport);
    case 'scan':
    case 'detect':
      return scan(passport);
    case 'plugins':
      return pluginsCommand(passport);
    case 'snapshot':
      return snapshotCommand(passport, rest[0], args);
    case 'restore':
      return restoreCommand(passport, rest[0], args);
    case 'remote':
      return remoteCommand(passport, rest[0], args);
    default:
      fail(`unknown command "${command}"`);
      line(dim('Run "agentpass help" to see available commands.'));
      return 1;
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    fail((error as Error).message);
    process.exitCode = 1;
  });
