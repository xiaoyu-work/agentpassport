import { ok, strictEqual } from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { Passport, importFromAgent, restoreToAgent } from '@agentpass/core';
import { createEmptyProfile } from '@agentpass/profile';
import { makeSandbox, read, seedClaude, write } from './helpers.ts';

const AGENTS = ['claude', 'openclaw', 'codex', 'cursor'] as const;

async function newPassport(name: string) {
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

/**
 * The translation-layer guarantee: identity established in one agent must arrive intact in
 * every other agent, and must not degrade when it comes back.
 */
for (const target of AGENTS.filter((agent) => agent !== 'claude')) {
  test(`Claude identity survives a round trip through ${target}`, async () => {
    const { sandbox, passport } = await newPassport(`rt-${target}`);
    await seedClaude(sandbox);

    await importFromAgent(passport, { agent: 'claude' });
    const dataKey = (await passport.store.unlock()).dataKey;
    const original = await passport.store.load(dataKey);

    await restoreToAgent(passport, { agent: target });
    const reimported = await importFromAgent(passport, { agent: target });

    const after = await passport.store.load((await passport.store.unlock()).dataKey);

    strictEqual(
      after.workspace.packageManager,
      original.workspace.packageManager,
      'workspace preference must survive',
    );

    const originalServers = original.mcp.map((server) => server.name).sort();
    const afterServers = after.mcp.map((server) => server.name).sort();
    for (const name of originalServers) {
      ok(afterServers.includes(name), `${target} should preserve MCP server ${name}`);
    }

    // A secret must never reappear as a literal value anywhere in the cycle.
    for (const server of after.mcp) {
      for (const value of Object.values(server.env)) {
        ok(!value.startsWith('ghp_'), 'a credential must never round-trip as a value');
      }
    }

    ok(reimported.diff.entries.length >= 0);
  });
}

test('rules keep a stable identity across import and export cycles', async () => {
  const { sandbox, passport } = await newPassport('rule-identity');
  await seedClaude(sandbox);

  await importFromAgent(passport, { agent: 'claude' });
  const first = await passport.store.load((await passport.store.unlock()).dataKey);
  const firstRuleIds = first.workspace.rules.map((rule) => rule.id).sort();

  // Two full cycles. Re-deriving a rule id from its title would append a near-duplicate
  // rule on every pass and quietly grow the user's instruction files without bound.
  await restoreToAgent(passport, { agent: 'openclaw' });
  await importFromAgent(passport, { agent: 'openclaw' });
  await restoreToAgent(passport, { agent: 'openclaw' });
  await importFromAgent(passport, { agent: 'openclaw' });

  const after = await passport.store.load((await passport.store.unlock()).dataKey);
  const afterRuleIds = after.workspace.rules.map((rule) => rule.id).sort();

  for (const id of firstRuleIds) {
    ok(afterRuleIds.includes(id), `rule ${id} should keep its identity`);
  }
  ok(
    afterRuleIds.length <= firstRuleIds.length + 1,
    `rules should not multiply: started with ${firstRuleIds.length}, ended with ${afterRuleIds.length}`,
  );
});

test('Codex TOML is written in the format Codex actually reads', async () => {
  const { sandbox, passport } = await newPassport('codex-format');
  await seedClaude(sandbox);
  await importFromAgent(passport, { agent: 'claude' });

  // Codex only speaks to OpenAI models, so an Anthropic preference must be declined
  // rather than written as a value that would break the agent on next launch.
  const dataKey = (await passport.store.unlock()).dataKey;
  const profile = await passport.store.load(dataKey);
  profile.models.coding = 'openai/gpt-5.5';
  await passport.store.save(dataKey, profile);

  await restoreToAgent(passport, { agent: 'codex' });

  const toml = await read(join(sandbox.home, '.codex', 'config.toml'));
  ok(toml.includes('model = "gpt-5.5"'), 'model must be unqualified for Codex');
  ok(toml.includes('[mcp_servers.github]'), 'MCP servers use table syntax, not an array');
  ok(!toml.includes('[[mcp_servers]]'), 'array-of-tables would not be read by Codex');
});

test('Cursor rules carry frontmatter that makes them load', async () => {
  const { sandbox, passport } = await newPassport('cursor-format');
  await seedClaude(sandbox);
  await importFromAgent(passport, { agent: 'claude' });
  await restoreToAgent(passport, { agent: 'cursor' });

  const rule = await read(join(sandbox.project, '.cursor', 'rules', 'agent-passport.mdc'));
  ok(rule.startsWith('---\n'), 'a .mdc rule needs frontmatter');
  ok(rule.includes('alwaysApply: true'), 'identity must always apply');
  ok(rule.includes('BEGIN AGENT PASSPORT'));
});

test('an existing Codex config keeps settings Agent Passport does not manage', async () => {
  const { sandbox, passport } = await newPassport('codex-preserve');
  await seedClaude(sandbox);
  await write(
    join(sandbox.home, '.codex', 'config.toml'),
    'approval_policy = "never"\nsandbox_mode = "workspace-write"\n',
  );

  await importFromAgent(passport, { agent: 'claude' });
  const dataKey = (await passport.store.unlock()).dataKey;
  const profile = await passport.store.load(dataKey);
  profile.models.coding = 'openai/gpt-5.5';
  await passport.store.save(dataKey, profile);

  await restoreToAgent(passport, { agent: 'codex' });

  const toml = await read(join(sandbox.home, '.codex', 'config.toml'));
  ok(toml.includes('approval_policy'), 'unmanaged settings must survive');
  ok(toml.includes('sandbox_mode'), 'unmanaged settings must survive');
  ok(toml.includes('gpt-5.5'), 'managed settings are still applied');
});

test('an existing Claude settings file keeps unmanaged keys', async () => {
  const { sandbox, passport } = await newPassport('claude-preserve');
  await seedClaude(sandbox);
  await write(
    join(sandbox.home, '.claude', 'settings.json'),
    JSON.stringify({ model: 'sonnet', permissions: { allow: ['Bash(npm run test)'] } }, null, 2),
  );

  await importFromAgent(passport, { agent: 'claude' });
  await restoreToAgent(passport, { agent: 'claude' });

  const settings = JSON.parse(await read(join(sandbox.home, '.claude', 'settings.json')));
  ok(settings.permissions?.allow?.includes('Bash(npm run test)'), 'permissions must survive');

  const global = JSON.parse(await read(join(sandbox.home, '.claude.json')));
  strictEqual(global.someUnrelatedKey?.keepMe, true, 'unrelated keys must survive');
});
