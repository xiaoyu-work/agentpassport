import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

/**
 * A single file captured from an agent's on-disk state.
 *
 * `path` is relative to the agent's root (whatever the adapter declared as its base).
 * `content` is base64 so binaries (skills assets, images) survive the JSON round-trip
 * without corruption.
 */
export interface SnapshotFile {
  path: string;
  contentBase64: string;
  mode?: number;
}

export interface Snapshot {
  agent: string;
  capturedAt: string;
  files: SnapshotFile[];
}

export interface WalkOptions {
  /** Directory names to skip entirely (matched anywhere in the tree). */
  excludeDirs?: string[];
  /** File-path glob-ish suffixes/segments to skip. Kept simple: substring match on posix path. */
  excludeFiles?: string[];
  /** Cap total bytes captured to avoid dragging in gigabyte artefacts by accident. */
  maxTotalBytes?: number;
  /** Skip any single file bigger than this. */
  maxFileBytes?: number;
}

const DEFAULT_MAX_TOTAL = 32 * 1024 * 1024; // 32 MB — personal-config sized
const DEFAULT_MAX_FILE = 4 * 1024 * 1024;

/**
 * Walk a set of files/directories rooted at `base` and return their contents as a
 * flat list. Both files and directories may be listed; missing entries are silently
 * skipped so an adapter can declare "these paths, if present" without prechecking.
 */
export async function collectFiles(
  base: string,
  entries: string[],
  options: WalkOptions = {},
): Promise<SnapshotFile[]> {
  const excludeDirs = new Set(options.excludeDirs ?? []);
  const excludeFiles = options.excludeFiles ?? [];
  const maxTotal = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL;
  const maxFile = options.maxFileBytes ?? DEFAULT_MAX_FILE;

  const out: SnapshotFile[] = [];
  let total = 0;

  async function visit(abs: string): Promise<void> {
    let s;
    try {
      s = await stat(abs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }

    if (s.isDirectory()) {
      const name = abs.split(sep).pop() ?? '';
      if (excludeDirs.has(name)) return;
      const children = await readdir(abs);
      for (const child of children) await visit(join(abs, child));
      return;
    }

    if (!s.isFile()) return;
    const rel = relative(base, abs).split(sep).join('/');
    if (excludeFiles.some((needle) => rel.includes(needle))) return;
    if (s.size > maxFile) return;
    if (total + s.size > maxTotal) {
      throw new Error(
        `snapshot exceeded ${maxTotal} bytes; raise maxTotalBytes or narrow the manifest`,
      );
    }
    const buf = await readFile(abs);
    total += buf.byteLength;
    out.push({
      path: rel,
      contentBase64: buf.toString('base64'),
      mode: s.mode & 0o777,
    });
  }

  for (const entry of entries) await visit(entry);
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/**
 * Write files back to disk under `base`, atomically per file. Existing files are
 * overwritten. Returns the list of absolute paths written.
 *
 * Refuses paths that would escape `base` — a hostile or corrupted snapshot cannot
 * write into `/etc/passwd`.
 */
export async function writeFiles(base: string, files: SnapshotFile[]): Promise<string[]> {
  const written: string[] = [];
  const normalizedBase = join(base) + sep;

  for (const file of files) {
    const abs = join(base, file.path);
    if (!(abs + sep).startsWith(normalizedBase) && abs !== base.replace(/\/$/, '')) {
      throw new Error(`refusing to write outside snapshot root: ${file.path}`);
    }
    await mkdir(dirname(abs), { recursive: true });
    const buf = Buffer.from(file.contentBase64, 'base64');
    const tmp = `${abs}.agentpass-${process.pid}-${Date.now()}.tmp`;
    await writeFile(tmp, buf, { mode: file.mode ?? 0o600 });
    const { rename } = await import('node:fs/promises');
    await rename(tmp, abs);
    written.push(abs);
  }
  return written;
}

/** Deterministic hash of a snapshot's contents, ignoring capturedAt. */
export function snapshotHash(snapshot: Snapshot): string {
  const h = createHash('sha256');
  h.update(snapshot.agent);
  for (const f of snapshot.files) {
    h.update('\0');
    h.update(f.path);
    h.update('\0');
    h.update(f.contentBase64);
  }
  return h.digest('hex');
}

/** Diff two snapshots by path/content. Returns added/removed/changed relative paths. */
export function diffSnapshots(
  before: Snapshot | undefined,
  after: Snapshot,
): { added: string[]; removed: string[]; changed: string[] } {
  const beforeMap = new Map((before?.files ?? []).map((f) => [f.path, f.contentBase64]));
  const afterMap = new Map(after.files.map((f) => [f.path, f.contentBase64]));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [path, content] of afterMap) {
    if (!beforeMap.has(path)) added.push(path);
    else if (beforeMap.get(path) !== content) changed.push(path);
  }
  for (const path of beforeMap.keys()) {
    if (!afterMap.has(path)) removed.push(path);
  }
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}
