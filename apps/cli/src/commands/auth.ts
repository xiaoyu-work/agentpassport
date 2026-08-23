import { randomUUID } from 'node:crypto';
import { formatRecoveryCode, isRecoveryCodeShaped } from '@agentpassport/crypto';
import type { Passport } from '@agentpassport/core';
import { ask, bold, cyan, dim, heading, line, ok, warn } from '../ui.js';

/**
 * Set up this computer. Creates a vault + keyring; per-agent snapshots come later.
 */
export async function setUp(passport: Passport, args: Map<string, string>): Promise<number> {
  if (await passport.store.exists()) {
    const session = await passport.store.session();
    line(`This computer is already set up as ${bold(session.userId)}.`);
    line(dim('Run "agentpass" to see what is stored.'));
    return 0;
  }

  const code = args.get('code');
  if (code) {
    const userId = args.get('user-id');
    if (!userId) {
      warn('Tell me which account to join with --user-id.');
      return 1;
    }
    warn('Joining an existing passport from another machine is not implemented in this build.');
    line(dim('Copy ~/.agentpass/vault.json manually, then rerun setup with --code.'));
    return 1;
  }

  const email = args.get('email');
  const displayName = args.get('name');
  const userId =
    args.get('user-id') ?? (email ? emailToUserId(email) : `user_${randomUUID().slice(0, 12)}`);

  const result = await passport.store.initialize({
    session: {
      userId,
      ...(email ? { email } : {}),
    },
  });

  heading('You are set up.');
  ok(`This computer unlocks automatically using your ${result.keyStore}.`);
  line(dim('You do not need a password.'));
  if (displayName) line(dim(`Display name: ${displayName}`));

  showRecoveryCode(result.recoveryCode);

  line('');
  line(`Next: ${cyan('agentpass snapshot')} to back up every known agent.`);
  return 0;
}

export async function signOut(passport: Passport): Promise<number> {
  if (!(await passport.store.exists())) {
    warn('No passport on this computer.');
    return 0;
  }
  const answer = await ask('This wipes the local vault. Continue? [y/N] ', 'n');
  if (!/^y/i.test(answer)) return 0;
  await passport.store.destroy();
  ok('Signed out.');
  return 0;
}

function emailToUserId(email: string): string {
  const [name] = email.split('@');
  return `user_${(name ?? 'anon').toLowerCase().replace(/[^a-z0-9]+/g, '')}`;
}

function showRecoveryCode(code: string): void {
  const boxed = formatRecoveryCode(code);
  line('');
  line(bold('Save this recovery code'));
  line('');
  line(`  ${dim('────────────────────────────────')}`);
  line(`     ${bold(boxed)}`);
  line(`  ${dim('────────────────────────────────')}`);
  line('');
  line('  This is the only way to get your identity onto another computer,');
  line('  or back if this one is lost. Write it down or save it somewhere safe.');
  line('');
  line(dim('  It is never uploaded, and nobody can recover it for you.'));
  line('');
}

// Kept for API consistency but unused in the pared-down build.
export { isRecoveryCodeShaped };
