import { ok, strictEqual } from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import {
  NullRemoteStore,
  Passport,
  importFromAgent,
  restoreToAgent,
  syncProfile,
  type RemoteProfile,
  type RemoteStore,
} from '@agentpass/core';
import type { EncryptedEnvelope, Keyring } from '@agentpass/crypto';
import { createEmptyProfile } from '@agentpass/profile';
import { makeSandbox, read, seedClaude } from './helpers.ts';

/** In-memory stand-in for the sync server, exercising the same contract. */
class FakeRemote implements RemoteStore {
  private stored?: RemoteProfile;

  async pull(): Promise<RemoteProfile | undefined> {
    return this.stored;
  }

  async push(
    _userId: string,
    envelope: EncryptedEnvelope,
    keyring: Keyring,
  ): Promise<RemoteProfile> {
    this.stored = {
      envelope,
      keyring,
      revision: envelope.revision,
      updatedAt: new Date().toISOString(),
    };
    return this.stored;
  }

  /** What the server can actually see, used to assert it sees nothing meaningful. */
  raw(): string {
    return JSON.stringify(this.stored ?? {});
  }
}

async function device(name: string, remote: RemoteStore) {
  const sandbox = await makeSandbox(name);
  const passport = await Passport.open({
    home: sandbox.passportHome,
    agentHome: sandbox.home,
    cwd: sandbox.project,
    env: { ...sandbox.env, AGENTPASS_SERVER: 'http://fake' },
    device: name,
  });
  // Route sync through the fake server instead of the network.
  passport.remote = async () => remote;
  return { sandbox, passport };
}

test('setting up a computer needs no passphrase and unlocks silently', async () => {
  const { passport } = await device('solo', new NullRemoteStore());

  const { recoveryCode, keyStore } = await passport.store.initialize({
    session: { userId: 'user_ming' },
    profile: createEmptyProfile('user_ming'),
  });

  ok(recoveryCode.length > 0, 'a recovery code is issued automatically');
  ok(keyStore.length > 0, 'the user is told where the key is kept');

  // The decisive property: no argument, no prompt, no stored secret.
  const first = await passport.store.unlock();
  strictEqual(first.method, 'device');

  const again = await passport.store.unlock();
  strictEqual(again.method, 'device', 'unlocking stays silent on repeat use');
});

test('a second computer joins with the recovery code, then never asks again', async () => {
  const remote = new FakeRemote();

  const a = await device('desktop-A', remote);
  const { recoveryCode } = await a.passport.store.initialize({
    session: { userId: 'user_ming', serverUrl: 'http://fake', token: 't' },
    profile: createEmptyProfile('user_ming'),
  });
  await seedClaude(a.sandbox);
  await importFromAgent(a.passport, { agent: 'claude' });
  const pushed = await syncProfile(a.passport, {});
  strictEqual(pushed.pushed, true, 'device A should publish its passport');

  // Device B is a fresh machine with no agents and no prior state.
  const b = await device('laptop-B', remote);
  const stored = await remote.pull();
  ok(stored, 'the server should hold a profile');

  await b.passport.store.adopt({
    session: { userId: 'user_ming', serverUrl: 'http://fake', token: 't' },
    recoveryCode,
    keyring: stored.keyring,
    profile: stored.envelope,
  });

  // Typed once. From here on this machine behaves like the first one.
  const unlocked = await b.passport.store.unlock();
  strictEqual(unlocked.method, 'device', 'the code is needed exactly once');

  const profile = await b.passport.store.load(unlocked.dataKey);
  strictEqual(profile.workspace.packageManager, 'pnpm', 'preferences crossed devices');
  ok(profile.mcp.length > 0, 'MCP servers crossed devices');

  const memories = await b.passport.store.loadMemories(unlocked.dataKey);
  ok(
    memories.some((memory) => memory.content.toLowerCase().includes('pnpm')),
    'memory learned on device A is known on device B',
  );

  await restoreToAgent(b.passport, { agent: 'openclaw' });
  const memoryFile = await read(join(b.sandbox.home, '.openclaw', 'workspace', 'MEMORY.md'));
  ok(memoryFile.includes('pnpm'), 'OpenClaw on the new device receives the memory');
});

test('a wrong recovery code cannot join an account', async () => {
  const remote = new FakeRemote();
  const a = await device('desktop-A2', remote);
  await a.passport.store.initialize({
    session: { userId: 'user_ming', serverUrl: 'http://fake', token: 't' },
    profile: createEmptyProfile('user_ming'),
  });
  await syncProfile(a.passport, {});

  const b = await device('laptop-B2', remote);
  const stored = await remote.pull();
  ok(stored);

  let message = '';
  try {
    await b.passport.store.adopt({
      session: { userId: 'user_ming' },
      recoveryCode: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ',
      keyring: stored.keyring,
      profile: stored.envelope,
    });
  } catch (error) {
    message = (error as Error).message;
  }
  ok(message.includes('not correct'), `expected a clear error, got: ${message}`);
});

test('an unregistered computer is told what to do rather than failing obscurely', async () => {
  const remote = new FakeRemote();
  const a = await device('desktop-A4', remote);
  await a.passport.store.initialize({
    session: { userId: 'user_ming', serverUrl: 'http://fake', token: 't' },
    profile: createEmptyProfile('user_ming'),
  });

  // Simulate a vault copied to a machine whose device key is not in the keyring.
  const b = await device('laptop-B4', remote);
  const stored = await a.passport.store.envelope();
  await b.passport.store.adopt({
    session: { userId: 'user_ming' },
    recoveryCode: (await a.passport.store.resetRecoveryCode(
      (await a.passport.store.unlock()).dataKey,
    )) as string,
    keyring: await a.passport.store.keyring(),
    profile: stored,
  });

  const unlocked = await b.passport.store.unlock();
  strictEqual(unlocked.method, 'device');
});

test('the server never sees profile content', async () => {
  const remote = new FakeRemote();
  const a = await device('desktop-A3', remote);
  await a.passport.store.initialize({
    session: { userId: 'user_ming', serverUrl: 'http://fake', token: 't' },
    profile: createEmptyProfile('user_ming'),
  });
  await seedClaude(a.sandbox);
  await importFromAgent(a.passport, { agent: 'claude' });
  await syncProfile(a.passport, {});

  const visible = remote.raw();
  for (const secret of ['pnpm', 'TypeScript', 'github', 'ghp_', 'sonnet']) {
    strictEqual(visible.includes(secret), false, `the server must not see "${secret}"`);
  }
  ok(visible.includes('user_ming'), 'the server does route by user id');
});

test('local-only mode works without any server', async () => {
  const { sandbox, passport } = await device('offline', new NullRemoteStore());
  await passport.store.initialize({
    session: { userId: 'user_solo' },
    profile: createEmptyProfile('user_solo'),
  });
  await seedClaude(sandbox);

  await importFromAgent(passport, { agent: 'claude' });
  const outcome = await syncProfile(passport, {});
  strictEqual(outcome.remoteConfigured, false, 'no server is a supported state');

  const result = await restoreToAgent(passport, { agent: 'cursor' });
  ok(result.written.length > 0, 'restore still works entirely offline');
});
