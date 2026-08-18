import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function readJsonIfExists<T>(path: string): Promise<T | undefined> {
  const text = await readTextIfExists(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
}

export async function exists(path: string): Promise<boolean> {
  return (await readTextIfExists(path)) !== undefined;
}

/**
 * Write via a temporary file and rename.
 *
 * Agent config files are the user's irreplaceable state; a half-written `settings.json`
 * from an interrupted export would break the agent Agent Passport is meant to set up.
 */
export async function writeFileAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.agentpass-${process.pid}-${Date.now()}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, path);
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Resolve a `~`-rooted path against the context home rather than the real one. */
export function resolveHome(home: string, ...segments: string[]): string {
  return join(home, ...segments);
}
