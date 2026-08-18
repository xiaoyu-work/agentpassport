import { ok, strictEqual } from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  FolderRemoteStore,
  GitRemoteStore,
  Passport,
  importFromAgent,
  restoreToAgent,
  syncProfile,
} from '@agentpassport/core';
import { createEmptyProfile } from '@agentpassport/profile';
import { makeSandbox, read, seedClaude } from './helpers.ts';

const run = promisify(execFile);

async function machine(name: string, sandboxName: string) {
  const sandbox = await makeSandbox(sandboxName);
  const passport = await Passport.open({
    home: sandbox.passportHome,
    agentHome: sandbox.home,
    cwd: sandbox.project,
    env: sandbox.env,
    device: name,
  });
  return { sandbox, passport };
}

/**
 * The cross-device promise has to work without anyone running a server, so both
 * zero-infrastructure transports are exercised end to end rather than mocked.
 */
test('two computers sync through a shared folder', async () => {
  const shared = await makeSandbox('folder-sync');
  const drive = join(shared.root, 'Dropbox', 'agentpass');

  const a = await machine('desktop', 'folder-a');
  const { recoveryCode } = await a.passport.store.initialize({
    session: { userId: 'user_ming', sync: { kind: 'folder', path: drive } },
    profile: createEmptyProfile('user_ming'),
  });
  await seedClaude(a.sandbox);
  await importFromAgent(a.passport, { agent: 'claude' });

  const pushed = await syncProfile(a.passport, {});
  strictEqual(pushed.pushed, true, 'the first computer publishes');

  // The folder provider only ever holds ciphertext.
  const files = await readdir(join(drive, 'user_ming'));
  const contents = await readFile(join(drive, 'user_ming', files[0] as string), 'utf8');
  for (const secret of ['pnpm', 'github', 'ghp_', 'sonnet']) {
    strictEqual(contents.includes(secret), false, `the folder must not expose "${secret}"`);
  }

  const b = await machine('laptop', 'folder-b');
  const stored = await new FolderRemoteStore(drive).pull('user_ming');
  ok(stored, 'the second computer finds the published passport');

  await b.passport.store.adopt({
    session: { userId: 'user_ming', sync: { kind: 'folder', path: drive } },
    recoveryCode,
    keyring: stored.keyring,
    profile: stored.envelope,
  });

  const { dataKey } = await b.passport.store.unlock();
  const profile = await b.passport.store.load(dataKey);
  strictEqual(profile.workspace.packageManager, 'pnpm', 'preferences crossed machines');

  const memories = await b.passport.store.loadMemories(dataKey);
  ok(
    memories.some((memory) => memory.content.toLowerCase().includes('pnpm')),
    'memory crossed machines',
  );

  await restoreToAgent(b.passport, { agent: 'openclaw' });
  const memoryFile = await read(join(b.sandbox.home, '.openclaw', 'workspace', 'MEMORY.md'));
  ok(memoryFile.includes('pnpm'), 'the new machine sets up OpenClaw with the memory');
});

test('two computers sync through a git repository', async () => {
  const shared = await makeSandbox('git-sync');
  const origin = join(shared.root, 'origin.git');
  await mkdir(origin, { recursive: true });
  await run('git', ['init', '--bare', '--initial-branch', 'main', origin]);

  const a = await machine('desktop', 'git-a');
  const { recoveryCode } = await a.passport.store.initialize({
    session: { userId: 'user_ming', sync: { kind: 'git', remote: origin } },
    profile: createEmptyProfile('user_ming'),
  });
  await seedClaude(a.sandbox);
  await importFromAgent(a.passport, { agent: 'claude' });

  const pushed = await syncProfile(a.passport, {});
  strictEqual(pushed.pushed, true, 'the first computer pushes to the repo');

  // Whoever hosts the repo sees only ciphertext. Inspect via --git-dir so the check works
  // regardless of the machine's safe.bareRepository setting.
  const { stdout } = await run('git', ['--git-dir', origin, 'log', '--oneline']);
  ok(stdout.includes('passport: revision'), `expected a commit, got: ${stdout}`);
  const { stdout: blob } = await run('git', [
    '--git-dir',
    origin,
    'show',
    'HEAD:user_ming/passport.json',
  ]);
  for (const secret of ['pnpm', 'github', 'ghp_', 'sonnet']) {
    strictEqual(blob.includes(secret), false, `the repo must not expose "${secret}"`);
  }

  const b = await machine('laptop', 'git-b');
  const stored = await new GitRemoteStore(origin, join(b.sandbox.root, 'checkout')).pull(
    'user_ming',
  );
  ok(stored, 'the second computer clones and finds the passport');

  await b.passport.store.adopt({
    session: { userId: 'user_ming', sync: { kind: 'git', remote: origin } },
    recoveryCode,
    keyring: stored.keyring,
    profile: stored.envelope,
  });

  const { dataKey } = await b.passport.store.unlock();
  const profile = await b.passport.store.load(dataKey);
  strictEqual(profile.workspace.packageManager, 'pnpm', 'preferences crossed machines');
  ok(profile.mcp.length > 0, 'MCP servers crossed machines');
});

test('a stale computer is told to merge instead of overwriting', async () => {
  const shared = await makeSandbox('folder-stale');
  const drive = join(shared.root, 'drive');
  const store = new FolderRemoteStore(drive);

  const a = await machine('desktop', 'stale-a');
  await a.passport.store.initialize({
    session: { userId: 'user_ming', sync: { kind: 'folder', path: drive } },
    profile: createEmptyProfile('user_ming'),
  });
  const { dataKey } = await a.passport.store.unlock();
  const profile = await a.passport.store.load(dataKey);

  profile.revision = 5;
  await a.passport.store.save(dataKey, profile);
  await store.push(
    'user_ming',
    await a.passport.store.envelope(),
    await a.passport.store.keyring(),
  );

  profile.revision = 2;
  await a.passport.store.save(dataKey, profile);

  let message = '';
  try {
    await store.push(
      'user_ming',
      await a.passport.store.envelope(),
      await a.passport.store.keyring(),
    );
  } catch (error) {
    message = (error as Error).message;
  }
  ok(message.includes('newer changes'), `expected a merge prompt, got: ${message}`);
});
