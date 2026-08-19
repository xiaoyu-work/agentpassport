import { ok, strictEqual } from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { Passport, importFromAgent, restoreToAgent } from '@agentpassport/core';
import { scrub } from '@agentpassport/adapter-sdk';
import { createEmptyProfile } from '@agentpassport/profile';
import { makeSandbox, read, readIfExists, write } from './helpers.ts';

async function machine(name: string) {
  const sandbox = await makeSandbox(name);
  const passport = await Passport.open({
    home: sandbox.passportHome,
    agentHome: sandbox.home,
    cwd: sandbox.project,
    env: sandbox.env,
    device: name,
  });
  await passport.store.initialize({
    session: { userId: 'user_test' },
    profile: createEmptyProfile('user_test'),
  });
  return { sandbox, passport };
}

/** A settings file using features the universal schema deliberately does not model. */
const RICH_SETTINGS = JSON.stringify(
  {
    model: 'sonnet',
    permissions: { allow: ['Bash(npm run test)'], deny: ['Read(./.env)'] },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './audit.sh' }] }],
    },
    env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1' },
    statusLine: { type: 'command', command: '~/bin/statusline.sh' },
  },
  null,
  2,
);

test('settings this schema cannot model still reach a new machine', async () => {
  const a = await machine('artifacts-a');
  await write(join(a.sandbox.home, '.claude', 'settings.json'), RICH_SETTINGS);
  await write(join(a.sandbox.home, '.claude', 'CLAUDE.md'), 'I prefer pnpm over npm.');

  await importFromAgent(a.passport, { agent: 'claude' });
  const { dataKey } = await a.passport.store.unlock();
  const profile = await a.passport.store.load(dataKey);

  ok(profile.artifacts.length > 0, 'originals should be captured');

  // Restore into a machine that has no Claude configuration at all.
  const b = await machine('artifacts-b');
  await b.passport.store.save((await b.passport.store.unlock()).dataKey, profile);
  await restoreToAgent(b.passport, { agent: 'claude' });

  const restored = JSON.parse(
    await read(join(b.sandbox.home, '.claude', 'settings.json')),
  ) as Record<string, unknown>;

  // These are precisely the fields the normalized profile has no representation for.
  ok(restored['permissions'], 'permissions must survive the trip');
  ok(restored['hooks'], 'hooks must survive the trip');
  ok(restored['env'], 'env must survive the trip');
  ok(restored['statusLine'], 'statusLine must survive the trip');
  strictEqual(
    (restored['permissions'] as { allow: string[] }).allow[0],
    'Bash(npm run test)',
    'permission rules must arrive intact',
  );
});

test('an original never overwrites a file the machine already has', async () => {
  const a = await machine('artifacts-keep-a');
  await write(join(a.sandbox.home, '.claude', 'settings.json'), RICH_SETTINGS);
  await importFromAgent(a.passport, { agent: 'claude' });
  const profile = await a.passport.store.load((await a.passport.store.unlock()).dataKey);

  const b = await machine('artifacts-keep-b');
  const local = JSON.stringify({ model: 'opus', myOwnSetting: true }, null, 2);
  await write(join(b.sandbox.home, '.claude', 'settings.json'), local);

  await b.passport.store.save((await b.passport.store.unlock()).dataKey, profile);
  await restoreToAgent(b.passport, { agent: 'claude' });

  const after = JSON.parse(await read(join(b.sandbox.home, '.claude', 'settings.json'))) as Record<
    string,
    unknown
  >;
  strictEqual(after['myOwnSetting'], true, "the machine's own settings must be kept");
});

test('captured originals carry no credentials', async () => {
  const a = await machine('artifacts-secrets');
  await write(
    join(a.sandbox.home, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        github: {
          type: 'stdio',
          command: 'npx',
          env: { GITHUB_TOKEN: 'ghp_verysecrettokenvalue123456', LOG_LEVEL: 'debug' },
        },
      },
    }),
  );
  await write(join(a.sandbox.home, '.claude', 'CLAUDE.md'), 'I prefer pnpm.');

  await importFromAgent(a.passport, { agent: 'claude' });
  const profile = await a.passport.store.load((await a.passport.store.unlock()).dataKey);

  const captured = profile.artifacts.find((artifact) => artifact.path.endsWith('.claude.json'));
  ok(captured, 'the MCP file should be captured');
  strictEqual(
    captured.content.includes('ghp_verysecrettokenvalue123456'),
    false,
    'a verbatim copy must not carry the token',
  );
  ok(captured.content.includes('LOG_LEVEL'), 'non-secret settings must survive');
  strictEqual(captured.redacted, true, 'the capture should be marked as redacted');

  // And nothing leaks into the encrypted vault on disk either.
  const vault = await read(a.passport.store.path);
  strictEqual(vault.includes('ghp_verysecrettokenvalue123456'), false);
});

test('scrubbing preserves structure and replaces only secrets', () => {
  const raw = JSON.stringify({
    apiKey: 'sk-abcdefghijklmnopqrstuvwxyz012345',
    logLevel: 'debug',
    nested: { PASSWORD: 'hunter2', port: 8080, alreadyIndirect: '${MY_VAR}' },
  });

  const { content, redacted } = scrub(raw);
  strictEqual(redacted, true);

  const parsed = JSON.parse(content) as Record<string, unknown>;
  strictEqual(parsed['apiKey'], '${apiKey}', 'secrets become resolvable indirection');
  strictEqual(parsed['logLevel'], 'debug', 'ordinary values are untouched');

  const nested = parsed['nested'] as Record<string, unknown>;
  strictEqual(nested['PASSWORD'], '${PASSWORD}');
  strictEqual(nested['port'], 8080, 'non-strings are untouched');
  strictEqual(nested['alreadyIndirect'], '${MY_VAR}', 'existing indirection is left alone');
});

test('a file with no secrets is stored byte for byte', () => {
  const raw = '{\n  "model": "sonnet",\n  "permissions": { "allow": ["Bash(ls)"] }\n}';
  const { content, redacted } = scrub(raw);
  strictEqual(redacted, false);
  strictEqual(content, raw, 'an untouched file must not be reformatted');
});

test('originals are captured for every configured agent', async () => {
  const a = await machine('artifacts-multi');
  await write(join(a.sandbox.home, '.claude', 'settings.json'), RICH_SETTINGS);
  await write(
    join(a.sandbox.home, '.codex', 'config.toml'),
    'model = "gpt-5.5"\napproval_policy = "never"\n',
  );
  await write(
    join(a.sandbox.project, '.cursor', 'rules', 'api.mdc'),
    '---\nalwaysApply: true\n---\n\nUse zod.',
  );

  for (const agent of ['claude', 'codex', 'cursor']) {
    await importFromAgent(a.passport, { agent });
  }

  const profile = await a.passport.store.load((await a.passport.store.unlock()).dataKey);
  for (const agent of ['claude', 'codex', 'cursor']) {
    ok(
      profile.artifacts.some((artifact) => artifact.agent === agent),
      `${agent} should contribute an original`,
    );
  }

  // Codex settings that the schema does not model must come back on a fresh machine.
  const b = await machine('artifacts-multi-b');
  await b.passport.store.save((await b.passport.store.unlock()).dataKey, profile);
  await restoreToAgent(b.passport, { agent: 'codex' });

  const toml = await readIfExists(join(b.sandbox.home, '.codex', 'config.toml'));
  ok(toml?.includes('approval_policy'), 'an unmodelled Codex setting must survive');
});
