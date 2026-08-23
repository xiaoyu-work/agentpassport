import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { makeSandbox, write } from './helpers.ts';
import { collectFiles, writeFiles, snapshotHash, type Snapshot } from '@agentpassport/adapter-sdk';

test('snapshot roundtrip: collect → write to disk → read back → identical bytes', async () => {
  const src = await makeSandbox('snap-src');
  const dst = await makeSandbox('snap-dst');

  await write(join(src.home, 'AGENTS.md'), '# hello\n\npnpm > npm\n');
  await write(join(src.home, 'memory/2026-08-23.md'), 'kept a note today\n');
  await write(join(src.home, 'config.json'), '{"model":"sonnet"}\n');

  const files = await collectFiles(src.home, [
    join(src.home, 'AGENTS.md'),
    join(src.home, 'memory'),
    join(src.home, 'config.json'),
  ]);
  assert.equal(files.length, 3);
  const snapshot: Snapshot = {
    agent: 'test',
    capturedAt: new Date().toISOString(),
    files,
  };

  // Persist as plain-text file tree + JSON manifest, then read it back.
  const written = await writeFiles(dst.home, snapshot.files);
  assert.equal(written.length, 3);
  for (const rel of ['AGENTS.md', 'memory/2026-08-23.md', 'config.json']) {
    const a = await readFile(join(src.home, rel), 'utf8');
    const b = await readFile(join(dst.home, rel), 'utf8');
    assert.equal(a, b, `mismatch on ${rel}`);
  }

  // Hash is deterministic on identical content.
  assert.equal(snapshotHash(snapshot), snapshotHash({ ...snapshot }));
});

test('collectFiles honors excludeDirs option', async () => {
  const s = await makeSandbox('snap-exclude');
  await write(join(s.home, 'keep.md'), 'ok\n');
  await write(join(s.home, '.git/HEAD'), 'ref: refs/heads/main\n');
  await write(join(s.home, 'node_modules/foo/pkg.json'), '{}\n');

  const files = await collectFiles(s.home, [s.home], {
    excludeDirs: ['.git', 'node_modules'],
  });
  const paths = files.map((f) => f.path);
  assert.ok(paths.some((p) => p.endsWith('keep.md')));
  assert.ok(!paths.some((p) => p.includes('.git')), '.git should be excluded');
  assert.ok(!paths.some((p) => p.includes('node_modules')), 'node_modules should be excluded');
});
