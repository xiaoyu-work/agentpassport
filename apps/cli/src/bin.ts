#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { Passport } from '@agentpassport/core';
import { setUp, signOut } from './commands/auth.js';
import { scan, status } from './commands/status.js';
import { importCommand } from './commands/import.js';
import { restoreCommand } from './commands/restore.js';
import { diffCommand } from './commands/diff.js';
import { syncCommand } from './commands/sync.js';
import { memoryCommand } from './commands/memory.js';
import { snapshotCommand, hydrateCommand } from './commands/snapshot.js';
import { pluginsCommand } from './commands/plugins.js';
import { bold, cyan, dim, fail, line, warn } from './ui.js';

const HELP = `${bold('agentpass')} — your AI identity, on every machine and every agent.

${bold('Getting started')}
  agentpass setup                First computer: creates your passport
  agentpass import               Read every AI tool found here
  agentpass restore              Write your identity into every AI tool

${bold('Using a second computer')}
  agentpass sync --git <url>     Publish, through a repo only you can read
  agentpass setup --user-id <id> --git <url> --code <recovery>
  agentpass import               Read every AI tool found here
  agentpass restore              Write your identity into every AI tool

${bold('Commands')}
  setup [--name <n>] [--email <e>] [--code <recovery>] [sync flags]
  status                         What is stored, and which tools see it
  scan                           AI tools detected on this machine
  plugins                        Which tool adapters are installed
  import [tool] [--dry-run]      Tool config -> passport
  restore [tool] [--dry-run]     Passport -> tool config
  diff [tool]                    Show both directions, change nothing
  sync [--dry-run]               Reconcile with your other computers
  sync --git <url>               Sync through a private git repo
  sync --folder <path>           Sync through Dropbox, iCloud, OneDrive
  memory list [--agent <id>]     One shared store; see who sees what
  memory search <query>
  memory share <id>              Make a memory visible to every tool
  memory pin <id> <tool>...      Limit a memory to specific tools
  memory forget <id>             Delete everywhere, from every tool
  logout                         Remove the passport from this computer

${bold('Unlocking')}
  No passphrase. Your key lives in this machine's credential store, so
  every command just works. A recovery code, shown once at setup, is what
  adds another computer.

${bold('Tool support is optional')}
  npm install @agentpassport/adapter-claude     # or -openclaw, -codex, -cursor
  Anything named agentpass-adapter-* is discovered automatically.

${bold('Environment')}
  AGENTPASS_HOME                 Passport directory (default ~/.agentpass)
  AGENTPASS_AGENT_HOME           Home directory tools are read from
  AGENTPASS_SERVER               Sync server URL
  MEM0_API_KEY                   Use Mem0 instead of the built-in memory store
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
    case 'import':
      return importCommand(passport, rest[0], args);
    case 'restore':
      return restoreCommand(passport, rest[0], args);
    case 'diff':
      return diffCommand(passport, rest[0]);
    case 'sync':
      return syncCommand(passport, args);
    case 'memory':
      return memoryCommand(passport, rest[0], rest.slice(1), args);
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
