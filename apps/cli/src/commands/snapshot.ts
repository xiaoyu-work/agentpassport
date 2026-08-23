import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import type { Passport } from '@agentpassport/core';
import {
  collectFiles,
  diffSnapshots,
  snapshotHash,
  writeFiles,
  type Snapshot,
} from '@agentpassport/adapter-sdk';
import { openEnvelope, sealEnvelope, type EncryptedEnvelope } from '@agentpassport/crypto';
import {
  openclawPaths,
  snapshotEntries as openclawSnapshotEntries,
} from '@agentpassport/adapter-openclaw';
import {
  claudePaths,
  snapshotEntries as claudeSnapshotEntries,
} from '@agentpassport/adapter-claude';
import {
  codexPaths,
  snapshotEntries as codexSnapshotEntries,
} from '@agentpassport/adapter-codex';
import {
  cursorPaths,
  snapshotEntries as cursorSnapshotEntries,
} from '@agentpassport/adapter-cursor';
import { bullet, cyan, dim, heading, line, ok, warn, yellow } from '../ui.js';

const exec = promisify(execFile);

/**
 * Per-agent identity manifests.
 *
 * Each agent gets its own folder inside the passport home. Files stored verbatim,
 * encrypted at rest with the vault data key. No universal profile, no memory
 * extraction, no translation.
 *
 * openclaw is wired up here. Other adapters can register later without needing
 * a translation layer \u2014 they just need to declare a root and a list of paths.
 */
interface Manifest {
  root: string;
  entries: string[];
}

function agentManifest(
  agent: string,
  context: { home: string; cwd: string; env: NodeJS.ProcessEnv; device: string; deviceId: string },
): Manifest | undefined {
  const ctx = {
    home: context.home,
    cwd: context.cwd,
    env: context.env as Record<string, string | undefined>,
    device: context.device,
    deviceId: context.deviceId,
  } as never;
  if (agent === 'openclaw') {
    const p = openclawPaths(ctx);
    return { root: p.stateDir, entries: openclawSnapshotEntries(p) };
  }
  if (agent === 'claude') {
    const p = claudePaths(ctx);
    return { root: context.home, entries: claudeSnapshotEntries(p) };
  }
  if (agent === 'codex') {
    const p = codexPaths(ctx);
    return { root: p.home, entries: codexSnapshotEntries(p) };
  }
  if (agent === 'cursor') {
    const p = cursorPaths(ctx);
    return { root: context.home, entries: cursorSnapshotEntries(p) };
  }
  return undefined;
}

const KNOWN_AGENTS = ['openclaw', 'claude', 'codex', 'cursor'] as const;

interface VaultLayout {
  agentDir: string;
  encFile: string;
  metaFile: string;
}

function vaultLayout(passportHome: string, agent: string): VaultLayout {
  const agentDir = join(passportHome, 'agents', agent);
  return {
    agentDir,
    encFile: join(agentDir, 'snapshot.enc.json'),
    metaFile: join(agentDir, 'meta.json'),
  };
}

async function readEncryptedSnapshot(
  dataKey: Buffer,
  encFile: string,
): Promise<Snapshot | undefined> {
  try {
    const raw = await readFile(encFile, 'utf8');
    const envelope = JSON.parse(raw) as EncryptedEnvelope;
    return JSON.parse(openEnvelope(dataKey, envelope)) as Snapshot;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeEncryptedSnapshot(
  dataKey: Buffer,
  userId: string,
  keyId: string,
  revision: number,
  snapshot: Snapshot,
  encFile: string,
): Promise<void> {
  const envelope = sealEnvelope(dataKey, {
    userId,
    keyId,
    revision,
    plaintext: JSON.stringify(snapshot),
  });
  await mkdir(join(encFile, '..'), { recursive: true });
  await writeFile(encFile, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
}

/**
 * List every file that currently exists under the manifest\u2019s declared entries.
 * Used by hydrate to find \u201corphans\u201d \u2014 files on disk that the snapshot no longer
 * knows about \u2014 so a restore is a real mirror, not an additive copy.
 */
async function listExistingFiles(manifest: Manifest): Promise<string[]> {
  const out: string[] = [];
  async function visit(abs: string): Promise<void> {
    let s;
    try {
      s = await stat(abs);
    } catch {
      return;
    }
    if (s.isDirectory()) {
      for (const child of await readdir(abs)) await visit(join(abs, child));
      return;
    }
    if (s.isFile()) {
      out.push(relative(manifest.root, abs).split(sep).join('/'));
    }
  }
  for (const entry of manifest.entries) await visit(entry);
  return out.sort();
}

export async function snapshotCommand(
  passport: Passport,
  agent: string | undefined,
  args: Map<string, string>,
): Promise<number> {
  const dryRun = args.has('dry-run');
  const showDiff = args.has('diff') || dryRun;
  const push = args.has('push');
  const targets = agent ? [agent] : KNOWN_AGENTS;

  const { dataKey } = await passport.store.unlock();
  const session = await passport.store.session();
  const keyring = await passport.store.keyring();
  const history = await passport.store.history();
  const revision = (history[history.length - 1]?.revision ?? 0) + 1;

  const context = {
    home: passport.agentHome,
    cwd: passport.cwd,
    env: passport.env,
    device: passport.device,
    deviceId: passport.deviceId,
  };

  let anyWritten = false;

  for (const target of targets) {
    const manifest = agentManifest(target, context);
    if (!manifest) {
      warn(`no snapshot manifest for ${target}`);
      continue;
    }

    heading(cyan(target));

    const files = await collectFiles(manifest.root, manifest.entries, {
      excludeDirs: ['sessions', 'logs', 'node_modules', '.git', '.secrets'],
      excludeFiles: ['.tmp', '.bak.', 'gh-token'],
    });

    if (files.length === 0) {
      warn(`no files captured for ${target}`);
      continue;
    }

    const snapshot: Snapshot = {
      agent: target,
      capturedAt: new Date().toISOString(),
      files,
    };
    const hash = snapshotHash(snapshot);
    const totalBytes = files.reduce(
      (n, f) => n + Buffer.byteLength(f.contentBase64, 'base64'),
      0,
    );

    const { encFile, metaFile } = vaultLayout(passport.home, target);
    const previous = await readEncryptedSnapshot(dataKey, encFile);

    ok(`${files.length} files, ${humanBytes(totalBytes)}, sha256:${hash.slice(0, 12)}`);

    if (showDiff && previous) {
      const d = diffSnapshots(previous, snapshot);
      for (const p of d.added) line(dim(`  + ${p}`));
      for (const p of d.changed) line(yellow(`  ~ ${p}`));
      for (const p of d.removed) line(dim(`  - ${p}`));
      if (d.added.length + d.changed.length + d.removed.length === 0) {
        line(dim('  (no changes since last snapshot)'));
      }
    } else if (showDiff) {
      for (const f of files) line(dim(`  + ${f.path}`));
    }

    if (dryRun) {
      line(dim('dry run: nothing written'));
      continue;
    }

    if (previous && snapshotHash(previous) === hash) {
      line(dim('  unchanged; skipping write'));
      continue;
    }

    await writeEncryptedSnapshot(
      dataKey,
      session?.userId ?? 'anonymous',
      keyring.keyId,
      revision,
      snapshot,
      encFile,
    );
    await writeFile(
      metaFile,
      `${JSON.stringify({ agent: target, capturedAt: snapshot.capturedAt, hash, files: files.length, bytes: totalBytes }, null, 2)}\n`,
    );
    line(dim(`  wrote ${encFile}`));
    anyWritten = true;
  }

  if (push && anyWritten && !dryRun) {
    return await gitPush(passport.home);
  }
  if (push && !anyWritten) {
    line(dim('nothing new to push'));
  }
  return 0;
}

export async function hydrateCommand(
  passport: Passport,
  agent: string | undefined,
  args: Map<string, string>,
): Promise<number> {
  const dryRun = args.has('dry-run');
  const prune = args.has('prune');
  const targets = agent ? [agent] : KNOWN_AGENTS;

  const { dataKey } = await passport.store.unlock();

  const context = {
    home: passport.agentHome,
    cwd: passport.cwd,
    env: passport.env,
    device: passport.device,
    deviceId: passport.deviceId,
  };

  for (const target of targets) {
    const manifest = agentManifest(target, context);
    if (!manifest) {
      warn(`no snapshot manifest for ${target}`);
      continue;
    }
    const { encFile } = vaultLayout(passport.home, target);
    const snapshot = await readEncryptedSnapshot(dataKey, encFile);
    if (!snapshot) {
      warn(`no snapshot for ${target} at ${encFile}`);
      continue;
    }

    heading(cyan(target));
    ok(`snapshot ${snapshot.capturedAt}, ${snapshot.files.length} files`);

    const onDisk = new Set(await listExistingFiles(manifest));
    const inSnap = new Set(snapshot.files.map((f) => f.path));
    const orphans = [...onDisk].filter((p) => !inSnap.has(p));

    if (orphans.length > 0) {
      warn(`${orphans.length} file(s) on disk are not in the snapshot:`);
      for (const p of orphans) line(dim(`  ? ${p}`));
      if (prune) {
        if (dryRun) {
          line(dim(`  would delete ${orphans.length} orphan(s)`));
        } else {
          for (const p of orphans) {
            try {
              await unlink(join(manifest.root, p));
              line(dim(`  deleted ${p}`));
            } catch (error) {
              warn(`  failed to delete ${p}: ${(error as Error).message}`);
            }
          }
        }
      } else {
        line(dim('  (use --prune to delete orphans)'));
      }
    }

    if (dryRun) {
      for (const f of snapshot.files) line(dim(`  would write ${join(manifest.root, f.path)}`));
      continue;
    }

    const written = await writeFiles(manifest.root, snapshot.files);
    ok(`restored ${written.length} files`);
  }
  return 0;
}

async function gitPush(passportHome: string): Promise<number> {
  try {
    await stat(join(passportHome, '.git'));
  } catch {
    warn(`no git repo at ${passportHome} \u2014 initialise with:`);
    line(
      dim(
        `  git -C ${passportHome} init && git -C ${passportHome} remote add origin git@github.com:you/your-passport.git`,
      ),
    );
    return 1;
  }
  try {
    await exec('git', ['-C', passportHome, 'add', '.']);
    const status = await exec('git', ['-C', passportHome, 'status', '--porcelain']);
    if (!status.stdout.trim()) {
      line(dim('nothing to commit'));
      return 0;
    }
    await exec('git', [
      '-C',
      passportHome,
      'commit',
      '-m',
      `snapshot ${new Date().toISOString()}`,
    ]);
    await exec('git', ['-C', passportHome, 'push']);
    ok('pushed to remote');
    return 0;
  } catch (error) {
    warn(`git push failed: ${(error as Error).message}`);
    return 1;
  }
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
