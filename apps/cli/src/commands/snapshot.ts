import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import type { Passport } from '@agentpassport/core';
import {
  collectFiles,
  diffSnapshots,
  snapshotHash,
  type Snapshot,
} from '@agentpassport/adapter-sdk';
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
 * Per-agent snapshot storage.
 *
 * Files are stored **verbatim, in plain text**, under
 * `<passport-home>/agents/<agent>/files/<original-relative-path>`. A sibling
 * `snapshot.json` records what was captured (hash, size, timestamps).
 *
 * Rationale: the intended sync target is a user-owned private git repo. Adding
 * a second encryption layer on top of that just makes backups un-inspectable,
 * un-diff-able, and dependent on a recovery code the user can lose. If you
 * don't trust your sync target, use a different sync target.
 */
interface Manifest {
  root: string;
  entries: string[];
}

function agentManifest(
  agent: string,
  ctx: {
    home: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    device: string;
    deviceId: string;
  },
): Manifest | undefined {
  switch (agent) {
    case 'openclaw': {
      const p = openclawPaths(ctx);
      return { root: p.stateDir, entries: openclawSnapshotEntries(p) };
    }
    case 'claude': {
      const p = claudePaths(ctx);
      return { root: ctx.home, entries: claudeSnapshotEntries(p) };
    }
    case 'codex': {
      const p = codexPaths(ctx);
      return { root: p.home, entries: codexSnapshotEntries(p) };
    }
    case 'cursor': {
      const p = cursorPaths(ctx);
      return { root: ctx.home, entries: cursorSnapshotEntries(p) };
    }
    default:
      return undefined;
  }
}

const KNOWN_AGENTS = ['openclaw', 'claude', 'codex', 'cursor'];

interface Layout {
  agentDir: string;
  filesDir: string;
  metaFile: string;
}

function layout(passportHome: string, agent: string): Layout {
  const agentDir = join(passportHome, 'agents', agent);
  return {
    agentDir,
    filesDir: join(agentDir, 'files'),
    metaFile: join(agentDir, 'snapshot.json'),
  };
}

/** Read a previous snapshot's manifest and reconstitute file contents from disk. */
async function readSnapshot(l: Layout): Promise<Snapshot | undefined> {
  try {
    const raw = await readFile(l.metaFile, 'utf8');
    const meta = JSON.parse(raw) as {
      agent: string;
      capturedAt: string;
      files: { path: string; mode?: number }[];
    };
    const files = await Promise.all(
      meta.files.map(async (f) => {
        const buf = await readFile(join(l.filesDir, f.path));
        return { path: f.path, contentBase64: buf.toString('base64'), mode: f.mode };
      }),
    );
    return { agent: meta.agent, capturedAt: meta.capturedAt, files };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Write a snapshot as a plain file tree + a JSON manifest sibling. */
async function writeSnapshot(snapshot: Snapshot, l: Layout): Promise<number> {
  // Clean the files dir so removals show up as git deletions, not stale files.
  await rm(l.filesDir, { recursive: true, force: true });
  await mkdir(l.filesDir, { recursive: true });
  let total = 0;
  for (const f of snapshot.files) {
    const dest = join(l.filesDir, f.path);
    await mkdir(join(dest, '..'), { recursive: true });
    const buf = Buffer.from(f.contentBase64, 'base64');
    await writeFile(dest, buf, { mode: f.mode ?? 0o644 });
    total += buf.length;
  }
  const meta = {
    agent: snapshot.agent,
    capturedAt: snapshot.capturedAt,
    hash: snapshotHash(snapshot),
    bytes: total,
    files: snapshot.files.map((f) => ({ path: f.path, mode: f.mode })),
  };
  await writeFile(l.metaFile, `${JSON.stringify(meta, null, 2)}\n`);
  return total;
}

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
    if (s.isFile()) out.push(relative(manifest.root, abs).split(sep).join('/'));
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

    const l = layout(passport.home, target);
    const previous = await readSnapshot(l);

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

    await writeSnapshot(snapshot, l);
    line(dim(`  wrote ${l.filesDir}/ + ${l.metaFile}`));
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

    const l = layout(passport.home, target);
    const snapshot = await readSnapshot(l);
    if (!snapshot) {
      warn(`no snapshot for ${target}`);
      continue;
    }

    heading(cyan(target));
    ok(`snapshot ${snapshot.capturedAt}, ${snapshot.files.length} files`);

    const wantPaths = new Set(snapshot.files.map((f) => f.path));
    const existing = await listExistingFiles(manifest);
    const orphans = existing.filter((p) => !wantPaths.has(p));

    for (const f of snapshot.files) {
      const dest = join(manifest.root, f.path);
      if (dryRun) {
        line(dim(`  would write ${dest}`));
        continue;
      }
      await mkdir(join(dest, '..'), { recursive: true });
      await writeFile(dest, Buffer.from(f.contentBase64, 'base64'), {
        mode: f.mode ?? 0o644,
      });
    }

    if (prune) {
      for (const rel of orphans) {
        const dest = join(manifest.root, rel);
        if (dryRun) line(dim(`  would remove ${dest}`));
        else {
          try {
            await unlink(dest);
          } catch {
            /* ignore */
          }
        }
      }
    } else if (orphans.length > 0) {
      line(dim(`  ${orphans.length} orphan file(s) on disk (use --prune to remove)`));
    }
  }
  return 0;
}

async function gitPush(passportHome: string): Promise<number> {
  try {
    await exec('git', ['-C', passportHome, 'rev-parse', '--is-inside-work-tree']);
  } catch {
    warn(`${passportHome} is not a git repo; run 'git init' + 'git remote add origin ...' first`);
    return 1;
  }
  try {
    await exec('git', ['-C', passportHome, 'add', '-A']);
    const { stdout } = await exec('git', [
      '-C',
      passportHome,
      'status',
      '--porcelain',
    ]);
    if (!stdout.trim()) {
      line(dim('nothing to commit'));
      return 0;
    }
    const msg = `snapshot ${new Date().toISOString()}`;
    await exec('git', ['-C', passportHome, 'commit', '-m', msg]);
    await exec('git', ['-C', passportHome, 'push']);
    ok(`pushed: ${msg}`);
    return 0;
  } catch (e) {
    warn(`git push failed: ${(e as Error).message}`);
    return 1;
  }
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
