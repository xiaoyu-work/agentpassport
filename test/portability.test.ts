import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { Passport, discoverAgents, importFromAgent, restoreToAgent } from '@agentpassport/core';
import { createEmptyProfile } from '@agentpassport/profile';
import { selectForAgent } from '@agentpassport/memory';
import { makeSandbox, read, readIfExists, seedClaude } from './helpers.ts';

async function signedInPassport(name: string) {
  const sandbox = await makeSandbox(name);
  const passport = await Passport.open({
    home: sandbox.passportHome,
    agentHome: sandbox.home,
    cwd: sandbox.project,
    env: sandbox.env,
    device: 'test-device',
  });
  await passport.store.initialize({
    session: { userId: 'user_test' },
    profile: createEmptyProfile('user_test'),
  });
  return { sandbox, passport };
}

test('discovers Claude Code from its standard location without configuration', async () => {
  const { sandbox, passport } = await signedInPassport('discover');
  await seedClaude(sandbox);

  const discovered = await discoverAgents(passport);
  const claude = discovered.find((agent) => agent.id === 'claude');

  ok(claude, 'claude should be discovered');
  strictEqual(claude.installed, true);
  ok(
    claude.files.some((file) => file.path.endsWith('CLAUDE.md')),
    'should find the instructions file',
  );
  ok(
    claude.files.some((file) => file.kind === 'mcp'),
    'should find the MCP configuration',
  );

  const cursor = discovered.find((agent) => agent.id === 'cursor');
  strictEqual(cursor?.installed, false, 'uninstalled agents are reported as absent');
});

test('imports Claude configuration into the universal profile', async () => {
  const { sandbox, passport } = await signedInPassport('import');
  await seedClaude(sandbox);

  const outcome = await importFromAgent(passport, { agent: 'claude' });
  const dataKey = (await passport.store.unlock()).dataKey;
  const profile = await passport.store.load(dataKey);

  strictEqual(profile.models.coding, 'anthropic/claude-sonnet', 'bare "sonnet" is canonicalized');
  strictEqual(profile.preferences.custom['outputStyle'], 'concise');
  strictEqual(profile.workspace.packageManager, 'pnpm', 'pnpm preference inferred from prose');

  const names = profile.mcp.map((server) => server.name).sort();
  deepStrictEqual(names, ['filesystem', 'github']);
  ok(outcome.diff.entries.length > 0, 'import should report changes');
});

test('an inline API key becomes a reference and never enters the profile', async () => {
  const { sandbox, passport } = await signedInPassport('secrets');
  await seedClaude(sandbox);

  await importFromAgent(passport, { agent: 'claude' });
  const dataKey = (await passport.store.unlock()).dataKey;
  const profile = await passport.store.load(dataKey);

  const github = profile.mcp.find((server) => server.name === 'github');
  ok(github, 'github server should be imported');
  strictEqual(
    github.env['GITHUB_PERSONAL_ACCESS_TOKEN'],
    undefined,
    'the token value must not be stored',
  );
  strictEqual(
    github.secretRefs['GITHUB_PERSONAL_ACCESS_TOKEN'],
    'env://GITHUB_PERSONAL_ACCESS_TOKEN',
  );

  // The strongest guarantee: the literal secret appears nowhere in the encrypted vault.
  const vault = await read(passport.store.path);
  strictEqual(
    vault.includes('ghp_exampletokenvalue1234567890abcd'),
    false,
    'the raw token must not appear anywhere on disk',
  );
});

test('restores a Claude-derived identity into OpenClaw', async () => {
  const { sandbox, passport } = await signedInPassport('restore');
  await seedClaude(sandbox);

  await importFromAgent(passport, { agent: 'claude' });
  const outcome = await restoreToAgent(passport, { agent: 'openclaw' });

  ok(outcome.written.length > 0, 'restore should write files');

  const agentsMd = await read(join(sandbox.home, '.openclaw', 'workspace', 'AGENTS.md'));
  ok(agentsMd.includes('BEGIN AGENT PASSPORT'), 'managed block should be present');
  ok(agentsMd.includes('pnpm'), 'workspace preference should carry over');

  const config = JSON.parse(await read(join(sandbox.home, '.openclaw', 'openclaw.json')));
  strictEqual(
    config.agents.defaults.model,
    'anthropic/claude-sonnet',
    'OpenClaw takes a qualified model reference',
  );
  deepStrictEqual(Object.keys(config.mcp.servers).sort(), ['filesystem', 'github']);
  strictEqual(
    config.mcp.servers.github.env.GITHUB_PERSONAL_ACCESS_TOKEN,
    '${GITHUB_PERSONAL_ACCESS_TOKEN}',
    'secrets are exported as indirection, never as values',
  );
});

test('one memory store serves every agent', async () => {
  const { sandbox, passport } = await signedInPassport('shared-memory');
  await seedClaude(sandbox);

  await importFromAgent(passport, { agent: 'claude' });

  const dataKey = (await passport.store.unlock()).dataKey;
  const profile = await passport.store.load(dataKey);
  const provider = passport.memory(profile, dataKey);
  const all = await provider.list('user_test');

  ok(all.length > 0, 'importing prose should capture memories');

  // The point of the product: a memory learned from Claude reaches agents that were never
  // involved in learning it.
  for (const agent of ['openclaw', 'codex', 'cursor']) {
    const visible = selectForAgent(all, agent);
    ok(
      visible.some((memory) => memory.content.toLowerCase().includes('pnpm')),
      `${agent} should inherit the pnpm preference learned from Claude`,
    );
  }

  const fromClaude = all.filter((memory) => memory.sourceAgent === 'claude');
  strictEqual(fromClaude.length > 0, true, 'provenance is retained');
  ok(
    fromClaude.some((memory) => memory.sharing === 'shared'),
    'memories default to shared rather than being pinned to their source',
  );
});

test('restore is idempotent and preserves user-authored content', async () => {
  const { sandbox, passport } = await signedInPassport('idempotent');
  await seedClaude(sandbox);
  await importFromAgent(passport, { agent: 'claude' });

  await restoreToAgent(passport, { agent: 'openclaw' });
  const agentsPath = join(sandbox.home, '.openclaw', 'workspace', 'AGENTS.md');
  const first = await read(agentsPath);

  await restoreToAgent(passport, { agent: 'openclaw' });
  const second = await read(agentsPath);
  strictEqual(first, second, 'restoring twice must not change the file');

  // Content the user wrote themselves must survive a restore.
  const { writeFile } = await import('node:fs/promises');
  await writeFile(agentsPath, `# My own notes\n\nDo not delete me.\n\n${second}`, 'utf8');
  await restoreToAgent(passport, { agent: 'openclaw' });
  const third = await read(agentsPath);
  ok(third.includes('Do not delete me.'), 'authored content outside the block is preserved');
});

test('an unconfigured agent is skipped rather than failing the run', async () => {
  const { passport } = await signedInPassport('missing');
  let message = '';
  try {
    await importFromAgent(passport, { agent: 'codex' });
  } catch (error) {
    message = (error as Error).message;
  }
  ok(message.includes('no OpenAI Codex configuration'), `unexpected error: ${message}`);
});

test('dry run writes nothing', async () => {
  const { sandbox, passport } = await signedInPassport('dryrun');
  await seedClaude(sandbox);
  await importFromAgent(passport, { agent: 'claude' });

  const outcome = await restoreToAgent(passport, {
    agent: 'openclaw',
    dryRun: true,
  });

  ok(outcome.plan.changes.length > 0, 'a plan is still produced');
  strictEqual(outcome.written.length, 0);
  strictEqual(
    await readIfExists(join(sandbox.home, '.openclaw', 'openclaw.json')),
    undefined,
    'no file should exist after a dry run',
  );
});
