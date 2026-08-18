import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert/strict';
import { test } from 'node:test';
import {
  addDeviceSlot,
  addRecoverySlot,
  createKeyring,
  generateRecoveryCode,
  isRecoveryCodeShaped,
  mergeKeyrings,
  normalizeRecoveryCode,
  openEnvelope,
  openText,
  randomKey,
  seal,
  sealEnvelope,
  unlockWithDeviceKey,
  unlockWithRecoveryCode,
} from '@agentpassport/crypto';
import {
  appliesToAgent,
  classify,
  isSyncable,
  looksLikeSecret,
  restrictToAgents,
  selectForAgent,
  share,
  summarizeSharing,
  MemoryRecordSchema,
  type MemoryRecord,
} from '@agentpassport/memory';
import { createEmptyProfile } from '@agentpassport/profile';
import { diffProfiles, mergeProfiles } from '@agentpassport/sync';

function memory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return MemoryRecordSchema.parse({
    id: overrides.id ?? 'mem_1',
    content: overrides.content ?? 'User prefers pnpm over npm',
    category: 'preference',
    provenance: 'user_explicit',
    status: 'active',
    ...overrides,
  });
}

test('sealed data survives a round trip and rejects tampering', () => {
  const { dataKey } = createKeyring();
  const box = seal(dataKey, 'sensitive profile', 'ctx');
  strictEqual(openText(dataKey, box, 'ctx'), 'sensitive profile');

  throws(() => openText(dataKey, box, 'different-context'), /decryption failed/);

  const tampered = { ...box, ct: Buffer.from('evil').toString('base64') };
  throws(() => openText(dataKey, tampered, 'ctx'), /decryption failed/);
});

test('a device slot unlocks with no user input at all', () => {
  const { keyring, dataKey } = createKeyring();
  const deviceKey = randomKey();
  const withDevice = addDeviceSlot(keyring, dataKey, deviceKey, 'MacBook', 'dev-1');

  deepStrictEqual(unlockWithDeviceKey(withDevice, deviceKey, 'dev-1'), dataKey);

  // Another machine's key must not open this slot.
  throws(() => unlockWithDeviceKey(withDevice, randomKey(), 'dev-1'), /no longer works/);
  throws(() => unlockWithDeviceKey(withDevice, deviceKey, 'dev-2'), /not set up/);
});

test('a recovery code unlocks the same key and tolerates sloppy typing', () => {
  const { keyring, dataKey } = createKeyring();
  const { keyring: withRecovery, code } = addRecoverySlot(keyring, dataKey);

  deepStrictEqual(unlockWithRecoveryCode(withRecovery, code), dataKey);

  // People retype codes from paper: lowercase, no dashes, and lookalike characters.
  const sloppy = code.toLowerCase().replace(/-/g, ' ');
  deepStrictEqual(unlockWithRecoveryCode(withRecovery, sloppy), dataKey);
  throws(() => unlockWithRecoveryCode(withRecovery, 'ABCD-EFGH-JKMN-PQRS-TVWX'), /not correct/);
});

test('recovery codes avoid characters people confuse', () => {
  const code = generateRecoveryCode();
  ok(isRecoveryCodeShaped(code), `unexpected shape: ${code}`);
  strictEqual(/[ILOU]/.test(code), false, `ambiguous character in ${code}`);
  strictEqual(code.split('-').length, 5);

  // A code read back with I/O/L substituted still works.
  strictEqual(normalizeRecoveryCode('I0LO-U'), '101 0V'.replace(' ', ''));
});

test('every slot opens the one data key, and slots merge across devices', () => {
  const { keyring, dataKey } = createKeyring();
  const laptopKey = randomKey();
  const deskKey = randomKey();

  const { keyring: withRecovery, code } = addRecoverySlot(keyring, dataKey);
  const laptop = addDeviceSlot(withRecovery, dataKey, laptopKey, 'Laptop', 'laptop');
  const desktop = addDeviceSlot(withRecovery, dataKey, deskKey, 'Desktop', 'desktop');

  // Each machine only knows its own slot until they sync.
  throws(() => unlockWithDeviceKey(laptop, deskKey, 'desktop'), /not set up/);

  const merged = mergeKeyrings(laptop, desktop);
  deepStrictEqual(unlockWithDeviceKey(merged, laptopKey, 'laptop'), dataKey);
  deepStrictEqual(unlockWithDeviceKey(merged, deskKey, 'desktop'), dataKey);
  deepStrictEqual(unlockWithRecoveryCode(merged, code), dataKey);
});

test('an envelope is bound to its revision, so rollback is detectable', () => {
  const { keyring, dataKey } = createKeyring();
  const envelope = sealEnvelope(dataKey, {
    userId: 'user_1',
    keyId: keyring.keyId,
    revision: 5,
    plaintext: '{"hello":"world"}',
  });
  strictEqual(openEnvelope(dataKey, envelope), '{"hello":"world"}');
  throws(() => openEnvelope(dataKey, { ...envelope, revision: 4 }), /decryption failed/);
});

test('external content may never become identity memory on its own', () => {
  const fromWeb = classify({
    provenance: 'external_content',
    category: 'identity',
    confidence: 0.99,
    sensitivity: 'private',
  });
  strictEqual(fromWeb.status, 'quarantined');
  strictEqual(fromWeb.requiresReview, true);

  const confirmed = classify(
    {
      provenance: 'external_content',
      category: 'identity',
      confidence: 0.99,
      sensitivity: 'private',
    },
    { userConfirmed: true },
  );
  strictEqual(confirmed.status, 'active', 'a human can still approve it');
});

test('low-confidence inferences wait, high-confidence ones do not', () => {
  const low = classify({
    provenance: 'agent_inferred',
    category: 'preference',
    confidence: 0.4,
    sensitivity: 'private',
  });
  strictEqual(low.status, 'pending_review');

  const high = classify({
    provenance: 'agent_inferred',
    category: 'preference',
    confidence: 0.95,
    sensitivity: 'private',
  });
  strictEqual(high.status, 'active');
});

test('credential material is detected and never synced', () => {
  ok(looksLikeSecret('my key is sk-abcdefghijklmnopqrstuvwxyz123456'));
  ok(looksLikeSecret('token ghp_abcdefghijklmnopqrstuvwxyz1234'));
  ok(!looksLikeSecret('I prefer pnpm over npm'));

  strictEqual(isSyncable(memory({ sensitivity: 'secret' })), false);
  strictEqual(isSyncable(memory({ status: 'quarantined' })), false);
  strictEqual(isSyncable(memory({ syncEnabled: false })), false);
  strictEqual(isSyncable(memory()), true);
});

test('memory is shared with every agent by default', () => {
  const record = memory();
  strictEqual(record.sharing, 'shared');
  for (const agent of ['claude', 'openclaw', 'codex', 'cursor']) {
    ok(appliesToAgent(record, agent), `${agent} should see a shared memory`);
  }
});

test('an agent-specific memory reaches only its agents', () => {
  const pinned = restrictToAgents(memory(), ['claude']);
  ok(appliesToAgent(pinned, 'claude'));
  ok(!appliesToAgent(pinned, 'cursor'));

  const widened = share(pinned);
  ok(appliesToAgent(widened, 'cursor'), 'sharing restores universal visibility');

  // A memory narrowed to nobody would be invisible everywhere; treat it as shared.
  const empty = restrictToAgents(memory(), []);
  ok(appliesToAgent(empty, 'cursor'));
});

test('selection combines status, agent, and project scope', () => {
  const records = [
    memory({ id: 'a', content: 'shared fact' }),
    restrictToAgents(memory({ id: 'b', content: 'claude only' }), ['claude']),
    memory({ id: 'c', content: 'held', status: 'pending_review' }),
    memory({ id: 'd', content: 'session note', scope: 'session' }),
    memory({ id: 'e', content: 'project note', scope: 'project', project: '/repo/one' }),
    memory({ id: 'f', content: 'other project', scope: 'project', project: '/repo/two' }),
  ];

  const forCursor = selectForAgent(records, 'cursor', { project: '/repo/one' }).map((m) => m.id);
  deepStrictEqual(forCursor, ['a', 'e'], 'cursor gets shared plus its current project');

  const forClaude = selectForAgent(records, 'claude', { project: '/repo/one' }).map((m) => m.id);
  deepStrictEqual(forClaude, ['a', 'b', 'e'], 'claude additionally gets its pinned memory');
});

test('sharing summary counts each agent audience', () => {
  const summary = summarizeSharing([
    memory({ id: 'a' }),
    restrictToAgents(memory({ id: 'b' }), ['claude', 'codex']),
    memory({ id: 'c', status: 'revoked' }),
  ]);
  strictEqual(summary.total, 2);
  strictEqual(summary.shared, 1);
  strictEqual(summary.agentSpecific, 1);
  strictEqual(summary.byAgent['claude'], 1);
  strictEqual(summary.byAgent['codex'], 1);
});

test('non-conflicting edits from two devices both survive', () => {
  const ancestor = createEmptyProfile('user_1');

  const laptop = structuredClone(ancestor);
  laptop.preferences.timezone = 'America/Los_Angeles';
  laptop.meta['preferences.timezone'] = {
    version: 1,
    updatedAt: '2026-01-01T00:00:00Z',
    sourceDevice: 'laptop',
    sourceAgent: 'claude',
  };

  const desktop = structuredClone(ancestor);
  desktop.workspace.packageManager = 'pnpm';
  desktop.meta['workspace.packageManager'] = {
    version: 1,
    updatedAt: '2026-01-02T00:00:00Z',
    sourceDevice: 'desktop',
    sourceAgent: 'codex',
  };

  const merged = mergeProfiles(laptop, desktop, { ancestor });
  strictEqual(merged.conflicts.length, 0, 'different fields must not conflict');
  strictEqual(merged.profile.preferences.timezone, 'America/Los_Angeles');
  strictEqual(merged.profile.workspace.packageManager, 'pnpm');
});

test('the same field changed on both sides is reported, never guessed', () => {
  const ancestor = createEmptyProfile('user_1');
  ancestor.workspace.packageManager = 'npm';

  const laptop = structuredClone(ancestor);
  laptop.workspace.packageManager = 'pnpm';

  const desktop = structuredClone(ancestor);
  desktop.workspace.packageManager = 'bun';

  const merged = mergeProfiles(laptop, desktop, { ancestor });
  strictEqual(merged.conflicts.length, 1);
  strictEqual(merged.conflicts[0]?.local, 'pnpm');
  strictEqual(merged.conflicts[0]?.remote, 'bun');
  strictEqual(
    merged.profile.workspace.packageManager,
    'pnpm',
    'local is kept until the user decides',
  );

  const resolved = mergeProfiles(laptop, desktop, {
    ancestor,
    resolutions: { 'workspace.packageManager': 'remote' },
  });
  strictEqual(resolved.conflicts.length, 0);
  strictEqual(resolved.profile.workspace.packageManager, 'bun');
});

test('diff reports additions, updates, and removals', () => {
  const before = createEmptyProfile('user_1');
  before.mcp.push({
    name: 'github',
    transport: 'stdio',
    command: 'npx',
    args: [],
    env: {},
    headers: {},
    secretRefs: {},
    enabled: true,
    scope: 'global',
  });

  const after = structuredClone(before);
  after.mcp = [];
  after.workspace.packageManager = 'pnpm';

  const diff = diffProfiles(before, after);
  strictEqual(diff.added, 1);
  strictEqual(diff.removed, 1);
  ok(diff.entries.some((entry) => entry.kind === 'MCP' && entry.op === 'removed'));
});
