#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { Passport } from '@agentpassport/core';
import { setUp, signOut } from './commands/auth.js';
import { scan, status } from './commands/status.js';
import { syncCommand } from './commands/sync.js';
import { snapshotCommand, hydrateCommand } from './commands/snapshot.js';
import { pluginsCommand } from './commands/plugins.js';
import { bold, cyan, dim, fail, line, warn } from './ui.js';

const HELP = `${bold('agentpass')} — encrypted per-agent backup for your AI tools.

${bold('Getting started')}
  agentpass setup                First computer: creates your passport
  agentpass snapshot             Encrypted backup of every known agent

${bold('Using a second computer')}
  agentpass setup --user-id <id> --git <url> --code <recovery>
  agentpass hydrate              Restore snapshots back to disk

${bold('Commands')}
  setup [--name <n>] [--email <e>] [--code <recovery>] [sync flags]
  status                         What is stored on this machine
  scan                           AI tools detected on this machine
  plugins                        Which tool adapters are installed
  snapshot [agent] [--diff] [--dry-run] [--push]
  hydrate  [agent] [--prune] [--dry-run]
  sync [--dry-run]               Reconcile with your other computers
  sync --git <url>               Sync through a private git repo
  sync --folder <path>           Sync through Dropbox, iCloud, OneDrive
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
    case 'sync':
      return syncCommand(passport, args);
    case 'snapshot':
      return snapshotCommand(passport, rest[0], args);
    case 'hydrate':
      return hydrateCommand(passport, rest[0], args);
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
