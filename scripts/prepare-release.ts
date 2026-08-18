/**
 * Prepare every workspace package for publishing.
 *
 * Workspace dependencies are written as `*` during development, which npm cannot resolve
 * once a package is installed from the registry. This rewrites them to the real version and
 * fills in the metadata npm needs, so releasing is one command rather than a checklist
 * someone has to remember to follow.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GROUPS = ['packages', 'adapters', 'integrations', 'apps'];
const REPOSITORY = 'https://github.com/agentpassport/agentpassport';
const DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const;

interface PackageJson {
  name: string;
  version?: string;
  private?: boolean;
  [key: string]: unknown;
}

const rootPackage = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as PackageJson;
const version = rootPackage.version ?? '0.1.0';

const files: string[] = [];
for (const group of GROUPS) {
  let entries: string[];
  try {
    entries = await readdir(join(ROOT, group));
  } catch {
    continue;
  }
  for (const entry of entries) files.push(join(ROOT, group, entry, 'package.json'));
}

let changed = 0;
for (const file of files) {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    continue;
  }

  const pkg = JSON.parse(raw) as PackageJson;
  pkg.version = version;

  if (!pkg.private) {
    pkg.license ??= 'Apache-2.0';
    pkg.repository = { type: 'git', url: `git+${REPOSITORY}.git` };
    pkg.homepage = REPOSITORY;
    pkg.bugs = { url: `${REPOSITORY}/issues` };
    pkg.publishConfig = { access: 'public' };
    pkg.engines ??= { node: '>=22' };
  }

  for (const field of DEPENDENCY_FIELDS) {
    const deps = pkg[field] as Record<string, string> | undefined;
    if (!deps) continue;
    for (const [name, range] of Object.entries(deps)) {
      // Only workspace-internal ranges are rewritten; real ranges are left alone.
      if (range === '*' && name.startsWith('@agentpassport/')) deps[name] = `^${version}`;
    }
  }

  const next = `${JSON.stringify(pkg, null, 2)}\n`;
  if (next !== raw) {
    await writeFile(file, next);
    changed += 1;
  }
}

process.stdout.write(`Prepared ${changed} package(s) at version ${version}\n`);
