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
import { PASSPHRASE, makeSandbox, read, seedClaude } from './helpers.ts';

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
  const passport = new Passport({
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

test('a second device joins with the same passphrase and inherits everything', async () => {
  const remote = new FakeRemote();

  const a = await device('desktop-A', remote);
  await a.passport.store.initialize({
    session: { userId: 'user_ming', serverUrl: 'http://fake', token: 't' },
    passphrase: PASSPHRASE,
    profile: createEmptyProfile('user_ming'),
  });
  await seedClaude(a.sandbox);
  await importFromAgent(a.passport, { agent: 'claude', passphrase: PASSPHRASE });
  const pushed = await syncProfile(a.passport, { passphrase: PASSPHRASE });
  strictEqual(pushed.pushed, true, 'device A should publish its passport');

  // Device B is a fresh machine with no agents and no prior state.
  const b = await device('laptop-B', remote);
  const remoteProfile = await remote.pull();
  ok(remoteProfile, 'the server should hold a profile');

  await b.passport.store.adopt({
    session: { userId: 'user_ming', serverUrl: 'http://fake', token: 't' },
    passphrase: PASSPHRASE,
    keyring: remoteProfile.keyring,
    profile: remoteProfile.envelope,
  });

  const dataKey = await b.passport.store.unlock(PASSPHRASE);
  const profile = await b.passport.store.load(dataKey);
  strictEqual(profile.workspace.packageManager, 'pnpm', 'preferences crossed devices');
  strictEqual(profile.mcp.length > 0, true, 'MCP servers crossed devices');

  // The decisive assertion: memory, not just configuration, reaches the new machine.
  const memories = await b.passport.store.loadMemories(dataKey);
  ok(memories.length > 0, 'memories must travel with the passport');
  ok(
    memories.some((memory) => memory.content.toLowerCase().includes('pnpm')),
    'the pnpm preference learned on device A is known on device B',
  );

  await restoreToAgent(b.passport, { agent: 'openclaw', passphrase: PASSPHRASE });
  const memoryFile = await read(join(b.sandbox.home, '.openclaw', 'workspace', 'MEMORY.md'));
  ok(memoryFile.includes('pnpm'), 'OpenClaw on the new device receives the memory');
});

test('a wrong passphrase cannot join an account', async () => {
  const remote = new FakeRemote();
  const a = await device('desktop-A2', remote);
  await a.passport.store.initialize({
    session: { userId: 'user_ming', serverUrl: 'http://fake', token: 't' },
    passphrase: PASSPHRASE,
    profile: createEmptyProfile('user_ming'),
  });
  await syncProfile(a.passport, { passphrase: PASSPHRASE });

  const b = await device('laptop-B2', remote);
  const stored = await remote.pull();
  ok(stored);

  let message = '';
  try {
    await b.passport.store.adopt({
      session: { userId: 'user_ming' },
      passphrase: 'the wrong passphrase entirely',
      keyring: stored.keyring,
      profile: stored.envelope,
    });
  } catch (error) {
    message = (error as Error).message;
  }
  ok(message.includes('does not match'), `expected a clear error, got: ${message}`);
});

test('the server never sees profile content', async () => {
  const remote = new FakeRemote();
  const a = await device('desktop-A3', remote);
  await a.passport.store.initialize({
    session: { userId: 'user_ming', serverUrl: 'http://fake', token: 't' },
    passphrase: PASSPHRASE,
    profile: createEmptyProfile('user_ming'),
  });
  await seedClaude(a.sandbox);
  await importFromAgent(a.passport, { agent: 'claude', passphrase: PASSPHRASE });
  await syncProfile(a.passport, { passphrase: PASSPHRASE });

  const visible = remote.raw();
  for (const secret of ['pnpm', 'TypeScript', 'github', 'ghp_', 'sonnet']) {
    strictEqual(visible.includes(secret), false, `the server must not be able to see "${secret}"`);
  }
  ok(visible.includes('user_ming'), 'the server does route by user id');
});

test('local-only mode works without any server', async () => {
  const { sandbox, passport } = await device('offline', new NullRemoteStore());
  await passport.store.initialize({
    session: { userId: 'user_solo' },
    passphrase: PASSPHRASE,
    profile: createEmptyProfile('user_solo'),
  });
  await seedClaude(sandbox);

  await importFromAgent(passport, { agent: 'claude', passphrase: PASSPHRASE });
  const outcome = await syncProfile(passport, { passphrase: PASSPHRASE });
  strictEqual(outcome.remoteConfigured, false, 'no server is a supported state');

  const result = await restoreToAgent(passport, { agent: 'cursor', passphrase: PASSPHRASE });
  ok(result.written.length > 0, 'restore still works entirely offline');
});
