import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Passport } from '@agentpassport/core';
import { bullet, cyan, dim, fail, heading, line, ok, warn } from '../ui.js';

const exec = promisify(execFile);

/**
 * Bind (or rebind) the passport home to a git remote.
 *
 * The user creates the repo themselves — GitHub, GitLab, self-hosted, whatever —
 * and hands the URL here. We take care of `git init`, wiring `origin`, and doing
 * the first push so `agentpass snapshot --push` just works from then on.
 *
 *   agentpass remote git@github.com:me/99-passport.git
 *   agentpass remote https://gitlab.com/me/passport.git --branch main
 *   agentpass remote                                     (show current)
 */
export async function remoteCommand(
  passport: Passport,
  url: string | undefined,
  args: Map<string, string>,
): Promise<number> {
  const home = passport.home;

  // No URL → just show what's bound.
  if (!url) {
    return await showCurrent(home);
  }

  const branch = args.get('branch') ?? 'main';
  const initialised = await isGitRepo(home);

  heading(`Binding ${cyan(home)}`);

  if (!initialised) {
    await exec('git', ['-C', home, 'init', '-b', branch]);
    ok(`git init (${branch})`);
  } else {
    // Make sure the branch name matches so the first push doesn't stall on
    // 'master' vs 'main'.
    try {
      await exec('git', ['-C', home, 'branch', '-M', branch]);
    } catch {
      /* branch already correct or no commits yet — either is fine */
    }
  }

  // Set or replace origin.
  const existing = await getRemote(home, 'origin');
  if (existing && existing !== url) {
    await exec('git', ['-C', home, 'remote', 'set-url', 'origin', url]);
    ok(`origin  ${existing} → ${url}`);
  } else if (!existing) {
    await exec('git', ['-C', home, 'remote', 'add', 'origin', url]);
    ok(`origin  ${url}`);
  } else {
    bullet(dim(`origin already set to ${url}`));
  }

  // First commit if the working tree has anything and no HEAD yet.
  const hasHead = await hasCommit(home);
  if (!hasHead) {
    await exec('git', ['-C', home, 'add', '-A']);
    const { stdout: dirty } = await exec('git', ['-C', home, 'status', '--porcelain']);
    if (dirty.trim()) {
      await exec('git', [
        '-C',
        home,
        '-c',
        'user.name=agentpass',
        '-c',
        'user.email=agentpass@localhost',
        'commit',
        '-m',
        'init passport',
      ]);
      ok('committed initial passport state');
    }
  }

  // Push. Fall back gracefully — the remote may be empty (no HEAD to fetch),
  // or it may already have a history we need to pull.
  try {
    await exec('git', ['-C', home, 'push', '-u', 'origin', branch]);
    ok(`pushed to ${url} (${branch})`);
  } catch (e) {
    const msg = (e as Error).message;
    if (/rejected|non-fast-forward/i.test(msg)) {
      warn('remote already has history — pull first, then re-run push');
      line(dim(`  git -C ${home} pull --rebase origin ${branch}`));
      line(dim(`  git -C ${home} push -u origin ${branch}`));
      return 1;
    }
    fail(`git push failed: ${msg.split('\n')[0]}`);
    return 1;
  }

  line('');
  line(dim(`From now on: ${cyan('agentpass snapshot --push')} auto-commits and pushes.`));
  return 0;
}

async function showCurrent(home: string): Promise<number> {
  if (!(await isGitRepo(home))) {
    warn(`${home} is not a git repo yet`);
    line(`Bind one with ${cyan('agentpass remote <git-url>')}`);
    return 1;
  }
  const url = await getRemote(home, 'origin');
  heading('Passport remote');
  if (url) bullet(`origin  ${url}`);
  else bullet(dim('no origin set'));
  return 0;
}

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await access(join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

async function getRemote(dir: string, name: string): Promise<string | undefined> {
  try {
    const { stdout } = await exec('git', ['-C', dir, 'remote', 'get-url', name]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function hasCommit(dir: string): Promise<boolean> {
  try {
    await exec('git', ['-C', dir, 'rev-parse', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}
