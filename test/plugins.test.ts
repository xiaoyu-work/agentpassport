import { ok, strictEqual } from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Passport, discoverAgents, missingPlugins, usableAgents } from '@agentpass/core';
import { createEmptyProfile } from '@agentpass/profile';
import { ADAPTER_API_VERSION, validateAdapter, validatePlugin } from '@agentpass/adapter-sdk';
import { makeSandbox, seedClaude } from './helpers.ts';

async function passportFor(
  name: string,
  overrides: { disableAutoDiscovery?: boolean; plugins?: string[] } = {},
) {
  const sandbox = await makeSandbox(name);
  const passport = await Passport.open({
    home: sandbox.passportHome,
    agentHome: sandbox.home,
    cwd: sandbox.project,
    env: sandbox.env,
    device: 'test-device',
    ...overrides,
  });
  return { sandbox, passport };
}

test('bundled adapters load as plugins', async () => {
  const { passport } = await passportFor('plugins-bundled');
  const { loaded, failed } = await passport.loadPlugins();

  const ids = loaded.map((plugin) => plugin.id).sort();
  for (const expected of ['claude', 'codex', 'cursor', 'openclaw']) {
    ok(ids.includes(expected), `${expected} should load as a plugin`);
  }
  strictEqual(failed.length, 0, `no plugin should fail: ${JSON.stringify(failed)}`);
});

test('Agent Passport works with no adapter plugins at all', async () => {
  const { sandbox, passport } = await passportFor('plugins-none', {
    disableAutoDiscovery: true,
    plugins: [],
  });
  await seedClaude(sandbox);

  const registry = await passport.registry();
  strictEqual(registry.ids().length, 0, 'no plugins should be registered');

  // The core promise still holds: a passport can be created and unlocked.
  await passport.store.initialize({
    session: { userId: 'user_test' },
    profile: createEmptyProfile('user_test'),
  });
  const dataKey = (await passport.store.unlock()).dataKey;
  ok((await passport.store.load(dataKey)).identity.userId === 'user_test');
});

test('a detected agent with no plugin is reported with an install hint', async () => {
  const { sandbox, passport } = await passportFor('plugins-missing', {
    disableAutoDiscovery: true,
    plugins: [],
  });
  await seedClaude(sandbox);

  const discovered = await discoverAgents(passport);
  const claude = discovered.find((agent) => agent.id === 'claude');

  ok(claude, 'claude should still be discovered from path hints alone');
  strictEqual(claude.installed, true, 'core notices the config without the plugin');
  strictEqual(claude.pluginInstalled, false);
  strictEqual(claude.package, '@agentpass/adapter-claude');
  ok(claude.files.length > 0, 'hint paths should be reported');

  const missing = missingPlugins(discovered);
  strictEqual(missing.length, 1);
  strictEqual(usableAgents(discovered).length, 0, 'nothing is actionable without a plugin');
});

test('asking for an agent whose plugin is missing explains how to fix it', async () => {
  const { passport } = await passportFor('plugins-hint', {
    disableAutoDiscovery: true,
    plugins: [],
  });

  let message = '';
  try {
    await passport.adapter('cursor');
  } catch (error) {
    message = (error as Error).message;
  }
  ok(message.includes('@agentpass/adapter-cursor'), `expected an install hint, got: ${message}`);

  let unknown = '';
  try {
    await passport.adapter('not-a-real-agent');
  } catch (error) {
    unknown = (error as Error).message;
  }
  ok(/unknown app/i.test(unknown), `expected an unknown-app error, got: ${unknown}`);
});

test('a third-party plugin is loaded from a file path', async () => {
  const { sandbox, passport } = await passportFor('plugins-third-party', {
    disableAutoDiscovery: true,
  });

  const dir = join(sandbox.root, 'my-plugin');
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'index.js');
  await writeFile(
    file,
    `export const plugin = {
       apiVersion: ${ADAPTER_API_VERSION},
       id: 'demo',
       displayName: 'Demo Agent',
       version: '9.9.9',
       create: () => ({
         id: 'demo',
         displayName: 'Demo Agent',
         detect: async () => true,
         import: async () => ({ profile: null, memories: [], warnings: [], sources: [] }),
         previewExport: async () => ({ agent: 'demo', changes: [], warnings: [] }),
         export: async () => ({ agent: 'demo', written: [], skipped: [], warnings: [] }),
         validate: async () => ({ ok: true, issues: [] }),
       }),
     };`,
    'utf8',
  );

  const scoped = await Passport.open({
    home: sandbox.passportHome,
    agentHome: sandbox.home,
    cwd: sandbox.project,
    env: sandbox.env,
    device: 'test-device',
    disableAutoDiscovery: true,
    plugins: [pathToFileURL(file).href],
  });

  const registry = await scoped.registry();
  ok(registry.has('demo'), 'a third-party plugin should register');
  strictEqual(registry.get('demo').displayName, 'Demo Agent');

  // A plugin with no catalog entry is still surfaced by discovery.
  const discovered = await discoverAgents(scoped);
  ok(discovered.some((agent) => agent.id === 'demo'));
  void passport;
});

test('a plugin built against a different API version is refused', async () => {
  const { sandbox } = await passportFor('plugins-version');
  const dir = join(sandbox.root, 'stale-plugin');
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'index.js');
  await writeFile(
    file,
    `export const plugin = {
       apiVersion: ${ADAPTER_API_VERSION + 99},
       id: 'stale',
       displayName: 'Stale',
       create: () => ({}),
     };`,
    'utf8',
  );

  const passport = await Passport.open({
    home: sandbox.passportHome,
    agentHome: sandbox.home,
    cwd: sandbox.project,
    env: sandbox.env,
    disableAutoDiscovery: true,
    plugins: [pathToFileURL(file).href],
  });

  const { loaded, failed } = await passport.loadPlugins();
  strictEqual(loaded.length, 0, 'a version-mismatched plugin must not load');
  strictEqual(failed.length, 1);
  ok(failed[0]?.reason.includes('adapter API'), `unclear reason: ${failed[0]?.reason}`);
});

test('a broken plugin does not break the others', async () => {
  const { sandbox } = await passportFor('plugins-broken');
  const dir = join(sandbox.root, 'broken-plugin');
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'index.js');
  await writeFile(file, 'this is not valid javascript {{{', 'utf8');

  const passport = await Passport.open({
    home: sandbox.passportHome,
    agentHome: sandbox.home,
    cwd: sandbox.project,
    env: sandbox.env,
    plugins: [pathToFileURL(file).href],
  });

  const { loaded, failed } = await passport.loadPlugins();
  ok(loaded.length >= 4, 'the bundled adapters should still load');
  strictEqual(failed.length, 1, 'the broken plugin is reported, not thrown');
});

test('plugin and adapter shapes are validated before use', () => {
  strictEqual(validatePlugin(undefined).ok, false);
  strictEqual(validatePlugin({ id: 'x', create: () => ({}) }).ok, false, 'apiVersion required');
  strictEqual(
    validatePlugin({ apiVersion: ADAPTER_API_VERSION, id: 'x' }).ok,
    false,
    'create() required',
  );
  strictEqual(
    validatePlugin({ apiVersion: ADAPTER_API_VERSION, id: 'x', create: () => ({}) }).ok,
    true,
  );

  strictEqual(validateAdapter({}).ok, false);
  strictEqual(
    validateAdapter({
      detect: () => {},
      import: () => {},
      previewExport: () => {},
      export: () => {},
      validate: () => {},
    }).ok,
    true,
  );
});
