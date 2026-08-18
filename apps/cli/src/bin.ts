#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { Passport } from '@agentpass/core';
import { login, logout } from './commands/auth.js';
import { scan, status } from './commands/status.js';
import { importCommand } from './commands/import.js';
import { restoreCommand } from './commands/restore.js';
import { diffCommand } from './commands/diff.js';
import { syncCommand } from './commands/sync.js';
import { memoryCommand } from './commands/memory.js';
import { pluginsCommand } from './commands/plugins.js';
import { bold, dim, fail, line } from './ui.js';

const HELP = `${bold('agentpass')} — Sign in to your AI.

Your identity, memory, and configuration follow you across every AI agent.

${bold('Getting started')}
  agentpass scan                 See which agents are installed on this machine
  agentpass login                Create an encrypted passport
  agentpass import               Import from every agent found (no arguments needed)
  agentpass restore              Write your identity into every agent

${bold('Commands')}
  login [--email <e>] [--name <n>] [--server <url>]
  logout
  status                         Passport, memory, and agent overview
  scan                           List detected agents and their config files
  plugins                        Which agent adapters are installed
  import [agent] [--dry-run]     Agent config -> passport
  restore [agent] [--dry-run]    Passport -> agent config
  diff [agent]                   Show both directions without changing anything
  sync [--dry-run]               Reconcile this machine with the cloud
  memory list [--agent <id>]     One shared store; see who sees what
  memory search <query>
  memory share <id>              Make a memory visible to every agent
  memory pin <id> <agent>...     Limit a memory to specific agents
  memory approve <id>            Accept a memory held for review
  memory forget <id>             Delete everywhere, from every agent

${bold('Agent plugins')}
  Adapters are optional. Install only the agents you use:
    npm install @agentpass/adapter-claude
    npm install @agentpass/adapter-openclaw
    npm install @agentpass/adapter-codex
    npm install @agentpass/adapter-cursor
  Anything named agentpass-adapter-* is discovered automatically.

${bold('Environment')}
  AGENTPASS_HOME                 Passport directory (default ~/.agentpass)
  AGENTPASS_PASSPHRASE           Non-interactive passphrase
  AGENTPASS_SERVER               Sync server URL
  MEM0_API_KEY                   Use Mem0 instead of local memory storage
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
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
  if (!command || values['help'] || command === 'help') {
    line(HELP);
    return command && command !== 'help' ? 1 : 0;
  }

  const args = new Map<string, string>();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === false) continue;
    args.set(key, value === true ? '' : String(value));
  }

  const passport = new Passport({
    ...(args.get('cwd') ? { cwd: args.get('cwd') as string } : {}),
  });

  switch (command) {
    case 'login':
    case 'signup':
      return login(passport, args);
    case 'logout':
      return logout(passport);
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
