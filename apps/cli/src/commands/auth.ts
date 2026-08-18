import { randomUUID } from 'node:crypto';
import { createEmptyProfile } from '@agentpass/profile';
import type { Passport, RemoteProfile } from '@agentpass/core';
import { ask, heading, line, ok, readPassphrase, dim } from '../ui.js';

/**
 * Create a passport on this machine.
 *
 * There is no account required to be useful: a passport works entirely locally, and a
 * server URL can be added later. Demanding a signup before the tool does anything would
 * make the first run a cost rather than a payoff.
 */
export async function login(passport: Passport, args: Map<string, string>): Promise<number> {
  if (await passport.store.exists()) {
    const session = await passport.store.session();
    line(`Already signed in as ${session.userId} on ${session.device}.`);
    line(dim('Run "agentpass logout" to sign out.'));
    return 0;
  }

  heading('Create your Agent Passport');
  const email = args.get('email') ?? (await ask('Email (optional): '));
  const displayName = args.get('name') ?? (await ask('Display name (optional): '));
  const userId =
    args.get('user-id') ?? (email ? emailToUserId(email) : `user_${randomUUID().slice(0, 12)}`);

  line('');
  line(dim('Your profile is encrypted with this passphrase before it touches disk or cloud.'));
  line(dim('It is never uploaded, and it cannot be recovered if you lose it.'));
  const passphrase = await readPassphrase('Choose a passphrase: ');
  if (passphrase.length < 8) {
    line('Passphrase must be at least 8 characters.');
    return 1;
  }
  const confirmation = await readPassphrase('Confirm passphrase: ');
  if (passphrase !== confirmation) {
    line('Passphrases did not match.');
    return 1;
  }

  const profile = createEmptyProfile(userId);
  if (displayName) profile.identity.displayName = displayName;
  if (email) profile.identity.email = email;

  const serverUrl = args.get('server') ?? process.env['AGENTPASS_SERVER'];
  const token = args.get('token') ?? process.env['AGENTPASS_TOKEN'] ?? 'local-dev-token';
  const session = {
    userId,
    ...(email ? { email } : {}),
    ...(serverUrl ? { serverUrl, token } : {}),
  };

  // Joining from a second device is the normal case, not the exception: check whether this
  // account already exists before minting a new identity that could never read the old one.
  if (serverUrl) {
    const existing = await fetchExisting(serverUrl, token, userId);
    if (existing) {
      await passport.store.adopt({
        session,
        passphrase,
        keyring: existing.keyring,
        profile: existing.envelope,
      });
      line('');
      ok(`Signed in as ${userId} on ${passport.device}`);
      line(dim(`Joined an existing passport at revision ${existing.revision}.`));
      line('');
      line(`Next: ${dim('agentpass restore')}   (writes your identity into every agent here)`);
      return 0;
    }
  }

  await passport.store.initialize({ session, passphrase, profile });

  line('');
  ok(`Signed in as ${userId}`);
  line(dim(`Passport stored at ${passport.store.path}`));
  line('');
  line(`Next: ${dim('agentpass import')}   (scans every agent on this machine)`);
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
    // An unreachable server must not block creating a local passport.
    return undefined;
  }
}

export async function logout(passport: Passport): Promise<number> {
  if (!(await passport.store.exists())) {
    line('Not signed in.');
    return 0;
  }
  await passport.store.destroy();
  ok('Signed out. The local passport was removed.');
  line(dim('Agent configuration files were left untouched.'));
  return 0;
}

function emailToUserId(email: string): string {
  const local = email.split('@')[0] ?? 'user';
  return `user_${local.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`;
}
