import { randomUUID } from 'node:crypto';
import { createEmptyProfile } from '@agentpassport/profile';
import { formatRecoveryCode, isRecoveryCodeShaped } from '@agentpassport/crypto';
import { join } from 'node:path';
import {
  FolderRemoteStore,
  GitRemoteStore,
  HttpRemoteStore,
  type Passport,
  type SyncTarget,
} from '@agentpassport/core';
import { describe, targetFromArgs } from './sync.js';
import { ask, bold, cyan, dim, heading, line, ok, warn } from '../ui.js';

/**
 * Set up this computer.
 *
 * There is deliberately nothing to invent here: no passphrase, no account, no decisions.
 * The vault is protected by this machine's credential store, and the one thing the user is
 * asked to keep — a recovery code — is generated for them and shown once.
 */
export async function setUp(passport: Passport, args: Map<string, string>): Promise<number> {
  if (await passport.store.exists()) {
    const session = await passport.store.session();
    line(`This computer is already set up as ${bold(session.userId)}.`);
    line(dim('Run "agentpass" to see what is stored.'));
    return 0;
  }

  const target = targetFromArgs(args);

  // Joining an existing account is the common case for a second computer, so check before
  // creating a new identity that could never read the first one's data.
  const code = args.get('code');
  if (code) {
    if (!target) {
      warn('Tell me where your passport is kept: --git, --folder, or --server.');
      return 1;
    }
    const userId = args.get('user-id');
    if (!userId) {
      warn('Tell me which account to join with --user-id.');
      return 1;
    }
    return joinExisting(passport, { target, userId, code });
  }

  const email = args.get('email');
  const displayName = args.get('name');
  const userId =
    args.get('user-id') ?? (email ? emailToUserId(email) : `user_${randomUUID().slice(0, 12)}`);

  const profile = createEmptyProfile(userId);
  if (displayName) profile.identity.displayName = displayName;
  if (email) profile.identity.email = email;

  const result = await passport.store.initialize({
    session: {
      userId,
      ...(email ? { email } : {}),
      ...(target ? { sync: target } : {}),
    },
    profile,
  });

  heading('You are set up.');
  ok(`This computer unlocks automatically using your ${result.keyStore}.`);
  line(dim('You do not need a password.'));

  showRecoveryCode(result.recoveryCode);

  line('');
  if (target) {
    line(`Syncing through ${cyan(describe(target))}.`);
    line(`Next: ${cyan('agentpass import')}, then ${cyan('agentpass sync')}.`);
  } else {
    line(`Next: ${cyan('agentpass import')} to read the AI tools on this computer.`);
    line(dim('To use this on another computer later, run "agentpass sync" to pick a sync method.'));
  }
  return 0;
}

async function joinExisting(
  passport: Passport,
  input: { target: SyncTarget; userId: string; code: string },
): Promise<number> {
  if (!isRecoveryCodeShaped(input.code)) {
    warn('That does not look like a recovery code. It looks like ABCD-EFGH-JKMN-PQRS-TVWX.');
    return 1;
  }

  const remote = await remoteFor(passport, input.target);
  const stored = await remote.pull(input.userId);
  if (!stored) {
    warn(`No passport for ${input.userId} at ${describe(input.target)}.`);
    line(dim('Run "agentpass sync" on your first computer to publish it.'));
    return 1;
  }

  const result = await passport.store.adopt({
    session: { userId: input.userId, sync: input.target },
    recoveryCode: input.code,
    keyring: stored.keyring,
    profile: stored.envelope,
  });

  heading('Welcome back.');
  ok('This computer is now part of your account.');
  line(dim(`It will unlock automatically from now on, using your ${result.keyStore}.`));
  line('');
  line(`Next: ${cyan('agentpass restore')} to set up the AI tools here.`);
  return 0;
}

/** Build a transport before a vault exists, which is the case when joining. */
async function remoteFor(passport: Passport, target: SyncTarget) {
  switch (target.kind) {
    case 'folder':
      return new FolderRemoteStore(target.path);
    case 'git':
      return new GitRemoteStore(
        target.remote,
        join(passport.home, 'sync-repo'),
        target.branch ?? 'main',
      );
    case 'server':
      return new HttpRemoteStore(target.url, target.token);
    default:
      throw new Error('no sync target');
  }
}

export function showRecoveryCode(code: string): void {
  const formatted = formatRecoveryCode(code);
  const width = formatted.length + 8;

  heading('Save this recovery code');
  line('');
  line(`  ${'─'.repeat(width)}`);
  line(`     ${bold(cyan(formatted))}`);
  line(`  ${'─'.repeat(width)}`);
  line('');
  line('  This is the only way to get your identity onto another computer,');
  line('  or back if this one is lost. Write it down or save it somewhere safe.');
  line('');
  line(dim('  It is never uploaded, and nobody can recover it for you.'));
}

export async function signOut(passport: Passport): Promise<number> {
  if (!(await passport.store.exists())) {
    line('Nothing to sign out of on this computer.');
    return 0;
  }

  const answer = await ask(
    'Remove Agent Passport from this computer? Your AI apps keep their settings. [y/N] ',
    'n',
  );
  if (!/^y(es)?$/i.test(answer) && process.env['AGENTPASS_YES'] !== '1') {
    line('Cancelled.');
    return 1;
  }

  await passport.store.destroy();
  ok('Removed from this computer.');
  line(dim('Your AI apps were left exactly as they are.'));
  return 0;
}

function emailToUserId(email: string): string {
  const local = email.split('@')[0] ?? 'user';
  return `user_${local.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`;
}
