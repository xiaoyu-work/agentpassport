import { randomUUID } from 'node:crypto';
import { createEmptyProfile } from '@agentpassport/profile';
import { formatRecoveryCode, isRecoveryCodeShaped } from '@agentpassport/crypto';
import type { Passport, RemoteProfile } from '@agentpassport/core';
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
    line(dim('Run "agentpass" to open Agent Passport.'));
    return 0;
  }

  const serverUrl = args.get('server') ?? process.env['AGENTPASS_SERVER'];
  const token = args.get('token') ?? process.env['AGENTPASS_TOKEN'] ?? 'local-dev-token';

  // Joining an existing account is the common case for a second computer, so check before
  // creating a new identity that could never read the first one's data.
  const code = args.get('code');
  if (code && serverUrl) {
    const userId = args.get('user-id');
    if (!userId) {
      warn('Tell me which account to join with --user-id.');
      return 1;
    }
    return joinExisting(passport, { serverUrl, token, userId, code });
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
      ...(serverUrl ? { serverUrl, token } : {}),
    },
    profile,
  });

  heading('You are set up.');
  ok(`This computer unlocks automatically using your ${result.keyStore}.`);
  line(dim('You do not need a password.'));

  showRecoveryCode(result.recoveryCode);

  line('');
  line(`Next: ${cyan('agentpass')} to open Agent Passport.`);
  return 0;
}

async function joinExisting(
  passport: Passport,
  input: { serverUrl: string; token: string; userId: string; code: string },
): Promise<number> {
  if (!isRecoveryCodeShaped(input.code)) {
    warn('That does not look like a recovery code. It looks like ABCD-EFGH-JKMN-PQRS-TVWX.');
    return 1;
  }

  const remote = await fetchExisting(input.serverUrl, input.token, input.userId);
  if (!remote) {
    warn('Could not find that account.');
    return 1;
  }

  const result = await passport.store.adopt({
    session: { userId: input.userId, serverUrl: input.serverUrl, token: input.token },
    recoveryCode: input.code,
    keyring: remote.keyring,
    profile: remote.envelope,
  });

  heading('Welcome back.');
  ok(`This computer is now part of your account.`);
  line(dim(`It will unlock automatically from now on, using your ${result.keyStore}.`));
  line('');
  line(`Next: ${cyan('agentpass')} to set up your AI apps here.`);
  return 0;
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

async function fetchExisting(
  serverUrl: string,
  token: string,
  userId: string,
): Promise<RemoteProfile | undefined> {
  try {
    const response = await fetch(
      `${serverUrl.replace(/\/+$/, '')}/v1/profiles/${encodeURIComponent(userId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.ok) return undefined;
    const remote = (await response.json()) as RemoteProfile;
    return remote.keyring ? remote : undefined;
  } catch {
    return undefined;
  }
}

function emailToUserId(email: string): string {
  const local = email.split('@')[0] ?? 'user';
  return `user_${local.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`;
}
